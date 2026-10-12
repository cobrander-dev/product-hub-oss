import type { Readable } from "node:stream";

import { Prisma } from "@/generated/prisma/client";
import {
  assignmentLabel,
  productLabel,
  writeUserActivity,
} from "@/features/activity/writer";
import { ApplicationError } from "@/lib/application/errors";
import {
  requireAdminFromHeaders,
  requireFactoryUserFromHeaders,
  requireUserFromHeaders,
} from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";
import {
  type ImageUploadInput,
  normalizeImageUpload,
} from "@/lib/storage/image-normalization";
import { getStorageProvider, type StorageProvider } from "@/lib/storage";
import { createImageStorageKey } from "@/lib/storage/local";

type Dependencies = {
  storage?: StorageProvider;
};

type ObjectRecord = {
  id: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: bigint;
  width: number;
  height: number;
  checksumSha256: string;
};

type AuthorizedImage = {
  imageId: string;
  productId: string;
  assignmentId: string | null;
  updatedAt: Date;
  object: ObjectRecord;
};

function storageFrom(dependencies?: Dependencies) {
  return dependencies?.storage ?? getStorageProvider();
}

function imageDto(value: AuthorizedImage) {
  return {
    id: value.imageId,
    productId: value.productId,
    assignmentId: value.assignmentId,
    url:
      value.assignmentId === null
        ? `/api/images/products/${value.productId}/main`
        : `/api/images/factory-private/${value.imageId}`,
    mimeType: value.object.mimeType,
    sizeBytes: value.object.sizeBytes.toString(),
    width: value.object.width,
    height: value.object.height,
    checksumSha256: value.object.checksumSha256,
    updatedAt: value.updatedAt,
  };
}

async function lockProduct(tx: Prisma.TransactionClient, productId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${productId}::uuid FOR UPDATE`;
}

async function lockAssignment(
  tx: Prisma.TransactionClient,
  assignmentId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "ProductFactoryAssignment" WHERE "id" = ${assignmentId}::uuid FOR UPDATE`;
}

async function compensateNewFile(storage: StorageProvider, storageKey: string) {
  try {
    await storage.delete(storageKey);
  } catch {
    // A filesystem-only orphan is discoverable by comparing the objects prefix
    // with StoredObject rows. Do not hide the original database failure.
  }
}

async function cleanupOldObject(
  storage: StorageProvider,
  object: ObjectRecord | null,
) {
  if (!object) return;
  try {
    await storage.delete(object.storageKey);
  } catch {
    // Keep the unreferenced StoredObject as a durable cleanup candidate.
    return;
  }
  try {
    await prisma.storedObject.deleteMany({
      where: {
        id: object.id,
        productMainImage: null,
        factoryPrivateImage: null,
      },
    });
  } catch {
    // The committed replacement remains authoritative. A later reconciliation
    // can detect this row because it has no business reference/file.
  }
}

function storedObjectCreateData(
  actorUserId: string,
  storageKey: string,
  image: Awaited<ReturnType<typeof normalizeImageUpload>>,
) {
  return {
    storageProvider: "LOCAL" as const,
    storageKey,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
    checksumSha256: image.checksumSha256,
    originalFilename: image.originalFilename,
    createdByUserId: actorUserId,
  };
}

export async function setProductMainImage(
  requestHeaders: Headers,
  productId: string,
  upload: ImageUploadInput,
  dependencies?: Dependencies,
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  const candidate = await prisma.product.findUnique({
    where: { id: productId },
  });
  if (!candidate) throw new ApplicationError("NOT_FOUND");

  const normalized = await normalizeImageUpload(upload);
  const storage = storageFrom(dependencies);
  const storageKey = createImageStorageKey();
  await storage.put(storageKey, normalized.bytes);

  let oldObject: ObjectRecord | null = null;
  let result: AuthorizedImage;
  try {
    result = await prisma.$transaction(async (tx) => {
      await lockProduct(tx, productId);
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) throw new ApplicationError("NOT_FOUND");
      const current = await tx.productMainImage.findUnique({
        where: { productId },
        include: { storedObject: true },
      });
      oldObject = current?.storedObject ?? null;
      const storedObject = await tx.storedObject.create({
        data: storedObjectCreateData(actor.userId, storageKey, normalized),
      });
      const relation = await tx.productMainImage.upsert({
        where: { productId },
        create: {
          productId,
          storedObjectId: storedObject.id,
          createdByUserId: actor.userId,
        },
        update: {
          storedObjectId: storedObject.id,
          createdByUserId: actor.userId,
        },
      });
      await writeUserActivity(tx, {
        eventType: current
          ? "PRODUCT_MAIN_IMAGE_REPLACED"
          : "PRODUCT_MAIN_IMAGE_SET",
        actor,
        entityId: product.id,
        entityLabelSnapshot: productLabel(product),
        factoryId: null,
        before: { storedObjectId: current?.storedObjectId ?? null },
        after: { storedObjectId: storedObject.id },
        metadata: { productId: product.id },
      });
      return {
        imageId: relation.id,
        productId,
        assignmentId: null,
        updatedAt: relation.updatedAt,
        object: storedObject,
      };
    });
  } catch (error) {
    await compensateNewFile(storage, storageKey);
    throw error;
  }

  await cleanupOldObject(storage, oldObject);
  return imageDto(result);
}

export async function removeProductMainImage(
  requestHeaders: Headers,
  productId: string,
  dependencies?: Dependencies,
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  const storage = storageFrom(dependencies);
  const oldObject = await prisma.$transaction(async (tx) => {
    await lockProduct(tx, productId);
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw new ApplicationError("NOT_FOUND");
    const current = await tx.productMainImage.findUnique({
      where: { productId },
      include: { storedObject: true },
    });
    if (!current) throw new ApplicationError("NOT_FOUND");
    await tx.productMainImage.delete({ where: { id: current.id } });
    await writeUserActivity(tx, {
      eventType: "PRODUCT_MAIN_IMAGE_REMOVED",
      actor,
      entityId: product.id,
      entityLabelSnapshot: productLabel(product),
      factoryId: null,
      before: { storedObjectId: current.storedObjectId },
      after: { storedObjectId: null },
      metadata: { productId: product.id },
    });
    return current.storedObject;
  });
  await cleanupOldObject(storage, oldObject);
}

export async function setOwnFactoryPrivateImage(
  requestHeaders: Headers,
  assignmentId: string,
  upload: ImageUploadInput,
  dependencies?: Dependencies,
) {
  const actor = await requireFactoryUserFromHeaders(requestHeaders);
  const candidate = await prisma.productFactoryAssignment.findFirst({
    where: {
      id: assignmentId,
      factoryId: actor.factoryId,
      status: "ACTIVE",
      product: { status: "ENABLED" },
      factory: { status: "ACTIVE" },
    },
  });
  if (!candidate) throw new ApplicationError("NOT_FOUND");

  const normalized = await normalizeImageUpload(upload);
  const storage = storageFrom(dependencies);
  const storageKey = createImageStorageKey();
  await storage.put(storageKey, normalized.bytes);

  let oldObject: ObjectRecord | null = null;
  let result: AuthorizedImage;
  try {
    result = await prisma.$transaction(async (tx) => {
      await lockAssignment(tx, assignmentId);
      const assignment = await tx.productFactoryAssignment.findFirst({
        where: {
          id: assignmentId,
          factoryId: actor.factoryId,
          status: "ACTIVE",
          product: { status: "ENABLED" },
          factory: { status: "ACTIVE" },
        },
        include: { product: true, factory: true },
      });
      if (!assignment) throw new ApplicationError("NOT_FOUND");
      const current = await tx.factoryPrivateImage.findUnique({
        where: { assignmentId },
        include: { storedObject: true },
      });
      oldObject = current?.storedObject ?? null;
      const storedObject = await tx.storedObject.create({
        data: storedObjectCreateData(actor.userId, storageKey, normalized),
      });
      const relation = await tx.factoryPrivateImage.upsert({
        where: { assignmentId },
        create: {
          assignmentId,
          storedObjectId: storedObject.id,
          uploadedByUserId: actor.userId,
        },
        update: {
          storedObjectId: storedObject.id,
          uploadedByUserId: actor.userId,
        },
      });
      await writeUserActivity(tx, {
        eventType: current
          ? "FACTORY_PRIVATE_IMAGE_REPLACED"
          : "FACTORY_PRIVATE_IMAGE_SET",
        actor,
        entityId: assignment.id,
        entityLabelSnapshot: assignmentLabel(assignment),
        factoryId: actor.factoryId,
        before: { storedObjectId: current?.storedObjectId ?? null },
        after: { storedObjectId: storedObject.id },
        metadata: {
          assignmentId: assignment.id,
          productId: assignment.productId,
          factoryId: assignment.factoryId,
        },
      });
      return {
        imageId: relation.id,
        productId: assignment.productId,
        assignmentId,
        updatedAt: relation.updatedAt,
        object: storedObject,
      };
    });
  } catch (error) {
    await compensateNewFile(storage, storageKey);
    throw error;
  }

  await cleanupOldObject(storage, oldObject);
  return imageDto(result);
}

export async function removeOwnFactoryPrivateImage(
  requestHeaders: Headers,
  assignmentId: string,
  dependencies?: Dependencies,
) {
  const actor = await requireFactoryUserFromHeaders(requestHeaders);
  const storage = storageFrom(dependencies);
  const oldObject = await prisma.$transaction(async (tx) => {
    await lockAssignment(tx, assignmentId);
    const assignment = await tx.productFactoryAssignment.findFirst({
      where: {
        id: assignmentId,
        factoryId: actor.factoryId,
        status: "ACTIVE",
        product: { status: "ENABLED" },
        factory: { status: "ACTIVE" },
      },
      include: { product: true, factory: true },
    });
    if (!assignment) throw new ApplicationError("NOT_FOUND");
    const current = await tx.factoryPrivateImage.findUnique({
      where: { assignmentId },
      include: { storedObject: true },
    });
    if (!current) throw new ApplicationError("NOT_FOUND");
    await tx.factoryPrivateImage.delete({ where: { id: current.id } });
    await writeUserActivity(tx, {
      eventType: "FACTORY_PRIVATE_IMAGE_REMOVED",
      actor,
      entityId: assignment.id,
      entityLabelSnapshot: assignmentLabel(assignment),
      factoryId: actor.factoryId,
      before: { storedObjectId: current.storedObjectId },
      after: { storedObjectId: null },
      metadata: {
        assignmentId: assignment.id,
        productId: assignment.productId,
        factoryId: assignment.factoryId,
      },
    });
    return current.storedObject;
  });
  await cleanupOldObject(storage, oldObject);
}

export async function promoteFactoryPrivateImage(
  requestHeaders: Headers,
  productId: string,
  factoryImageId: string,
  dependencies?: Dependencies,
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  const source = await prisma.factoryPrivateImage.findFirst({
    where: { id: factoryImageId, assignment: { productId } },
    include: { storedObject: true },
  });
  if (!source) throw new ApplicationError("NOT_FOUND");

  const storage = storageFrom(dependencies);
  const storageKey = createImageStorageKey();
  await storage.copy(source.storedObject.storageKey, storageKey);

  let oldObject: ObjectRecord | null = null;
  let result: AuthorizedImage;
  try {
    result = await prisma.$transaction(async (tx) => {
      await lockProduct(tx, productId);
      const sourceImage = await tx.factoryPrivateImage.findFirst({
        where: { id: factoryImageId, assignment: { productId } },
        include: {
          storedObject: true,
          assignment: { include: { product: true, factory: true } },
        },
      });
      if (!sourceImage) throw new ApplicationError("NOT_FOUND");
      const current = await tx.productMainImage.findUnique({
        where: { productId },
        include: { storedObject: true },
      });
      oldObject = current?.storedObject ?? null;
      const storedObject = await tx.storedObject.create({
        data: {
          storageProvider: sourceImage.storedObject.storageProvider,
          storageKey,
          mimeType: sourceImage.storedObject.mimeType,
          sizeBytes: sourceImage.storedObject.sizeBytes,
          width: sourceImage.storedObject.width,
          height: sourceImage.storedObject.height,
          checksumSha256: sourceImage.storedObject.checksumSha256,
          originalFilename: sourceImage.storedObject.originalFilename,
          createdByUserId: actor.userId,
        },
      });
      const relation = await tx.productMainImage.upsert({
        where: { productId },
        create: {
          productId,
          storedObjectId: storedObject.id,
          createdByUserId: actor.userId,
        },
        update: {
          storedObjectId: storedObject.id,
          createdByUserId: actor.userId,
        },
      });
      await writeUserActivity(tx, {
        eventType: "PRODUCT_MAIN_IMAGE_PROMOTED",
        actor,
        entityId: productId,
        entityLabelSnapshot: productLabel(sourceImage.assignment.product),
        factoryId: null,
        before: { storedObjectId: current?.storedObjectId ?? null },
        after: { storedObjectId: storedObject.id },
        metadata: {
          productId,
          assignmentId: sourceImage.assignmentId,
          factoryId: sourceImage.assignment.factoryId,
          sourceFactoryImageId: sourceImage.id,
        },
      });
      return {
        imageId: relation.id,
        productId,
        assignmentId: null,
        updatedAt: relation.updatedAt,
        object: storedObject,
      };
    });
  } catch (error) {
    await compensateNewFile(storage, storageKey);
    throw error;
  }

  await cleanupOldObject(storage, oldObject);
  return imageDto(result);
}

export async function authorizeProductMainImageRead(
  requestHeaders: Headers,
  productId: string,
): Promise<AuthorizedImage> {
  const actor = await requireUserFromHeaders(requestHeaders);
  const relation = await prisma.productMainImage.findFirst({
    where:
      actor.role === "ADMIN"
        ? { productId }
        : {
            productId,
            product: {
              status: "ENABLED",
              assignments: {
                some: {
                  factoryId: actor.factoryId,
                  status: "ACTIVE",
                  factory: { status: "ACTIVE" },
                },
              },
            },
          },
    include: { storedObject: true },
  });
  if (!relation) throw new ApplicationError("NOT_FOUND");
  return {
    imageId: relation.id,
    productId: relation.productId,
    assignmentId: null,
    updatedAt: relation.updatedAt,
    object: relation.storedObject,
  };
}

export async function authorizeFactoryPrivateImageRead(
  requestHeaders: Headers,
  imageId: string,
): Promise<AuthorizedImage> {
  const actor = await requireUserFromHeaders(requestHeaders);
  const relation = await prisma.factoryPrivateImage.findFirst({
    where:
      actor.role === "ADMIN"
        ? { id: imageId }
        : {
            id: imageId,
            assignment: {
              factoryId: actor.factoryId,
              status: "ACTIVE",
              product: { status: "ENABLED" },
              factory: { status: "ACTIVE" },
            },
          },
    include: { storedObject: true, assignment: true },
  });
  if (!relation) throw new ApplicationError("NOT_FOUND");
  return {
    imageId: relation.id,
    productId: relation.assignment.productId,
    assignmentId: relation.assignmentId,
    updatedAt: relation.updatedAt,
    object: relation.storedObject,
  };
}

export async function getProductMainImage(
  requestHeaders: Headers,
  productId: string,
) {
  return imageDto(
    await authorizeProductMainImageRead(requestHeaders, productId),
  );
}

export async function getFactoryPrivateImage(
  requestHeaders: Headers,
  imageId: string,
) {
  return imageDto(
    await authorizeFactoryPrivateImageRead(requestHeaders, imageId),
  );
}

export async function openAuthorizedImage(
  value: AuthorizedImage,
  dependencies?: Dependencies,
): Promise<{ stream: Readable; contentLength: number; etag: string }> {
  const storage = storageFrom(dependencies);
  const file = await storage.stat(value.object.storageKey);
  if (!file || file.sizeBytes !== Number(value.object.sizeBytes)) {
    throw new ApplicationError("NOT_FOUND");
  }
  return {
    stream: await storage.open(value.object.storageKey),
    contentLength: file.sizeBytes,
    etag: `"sha256-${value.object.checksumSha256}"`,
  };
}
