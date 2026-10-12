import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import sharp from "sharp";

import {
  assignProductToFactory,
  reactivateAssignment,
  revokeAssignment,
} from "../../src/features/assignments/service";
import { createCategory } from "../../src/features/categories/service";
import { setFactoryStatus } from "../../src/features/factories/service";
import {
  authorizeFactoryPrivateImageRead,
  authorizeProductMainImageRead,
  getFactoryPrivateImage,
  getProductMainImage,
  openAuthorizedImage,
  promoteFactoryPrivateImage,
  removeOwnFactoryPrivateImage,
  removeProductMainImage,
  setOwnFactoryPrivateImage,
  setProductMainImage,
} from "../../src/features/images/service";
import { createMaterial } from "../../src/features/materials/service";
import {
  createProduct,
  setProductStatus,
} from "../../src/features/products/service";
import { prisma } from "../../src/lib/db/prisma";
import {
  MAX_IMAGE_BYTES,
  normalizeImageUpload,
} from "../../src/lib/storage/image-normalization";
import {
  createImageStorageKey,
  LocalStorageProvider,
} from "../../src/lib/storage/local";
import type { StorageProvider } from "../../src/lib/storage/provider";
import {
  newAuthRequest,
  passwords,
  requestHeaders,
  resetAuthFixtures,
  type TestFixtures,
  usernames,
} from "../auth/fixtures";

test.describe.configure({ mode: "serial" });

type AuthRequest = Awaited<ReturnType<typeof newAuthRequest>>;
type Upload = Awaited<ReturnType<typeof makeUpload>>;

const storageRoot = path.resolve("data/test-uploads");
const storage = new LocalStorageProvider(storageRoot);

let fixtures: TestFixtures;
let adminHeaders: Headers;
let factoryAHeaders: Headers;
let factoryBHeaders: Headers;
let product: Awaited<ReturnType<typeof createProduct>>;
let productB: Awaited<ReturnType<typeof createProduct>>;
let assignmentA: Awaited<ReturnType<typeof assignProductToFactory>>;
let assignmentB: Awaited<ReturnType<typeof assignProductToFactory>>;
let contexts: AuthRequest[] = [];

async function login(username: string, password: string) {
  const session = await newAuthRequest(username, password);
  expect(session.response.ok()).toBeTruthy();
  contexts.push(session);
  return { session, headers: await requestHeaders(session.context) };
}

async function makeUpload(
  format: "jpeg" | "png" | "webp" = "png",
  color = { r: 25, g: 120, b: 220, alpha: 1 },
) {
  const pipeline = sharp({
    create: { width: 32, height: 24, channels: 4, background: color },
  });
  const bytes = await pipeline[format]().toBuffer();
  return {
    bytes,
    contentType: `image/${format}`.replace("image/jpeg", "image/jpeg"),
    originalFilename: `fixture.${format === "jpeg" ? "jpg" : format}`,
  };
}

async function resetImageFixtures() {
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (
    !database.endsWith("_test") ||
    storageRoot !== path.resolve("data/test-uploads")
  ) {
    throw new Error(
      "Image fixture reset refused outside isolated test targets.",
    );
  }
  await rm(storageRoot, { recursive: true, force: true });
  await mkdir(storageRoot, { recursive: true });
  await prisma.activityLog.deleteMany();
  await prisma.productMainImage.deleteMany();
  await prisma.factoryPrivateImage.deleteMany();
  await prisma.storedObject.deleteMany();
  await prisma.priceHistory.deleteMany();
  await prisma.factoryQuote.deleteMany();
  await prisma.productFactoryAssignment.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.material.deleteMany();
  fixtures = await resetAuthFixtures();

  adminHeaders = (await login(usernames.admin, passwords.admin)).headers;
  factoryAHeaders = (await login(usernames.factoryA, passwords.factoryA))
    .headers;
  factoryBHeaders = (await login(usernames.factoryB, passwords.factoryB))
    .headers;
  const category = await createCategory(adminHeaders, {
    name: "Image Test 分类",
  });
  const material = await createMaterial(adminHeaders, {
    name: "Image Test 材质",
  });
  product = await createProduct(adminHeaders, {
    sku: "IMG-A",
    name: "Image Test Product A",
    categoryId: category.id,
    materialId: material.id,
  });
  productB = await createProduct(adminHeaders, {
    sku: "IMG-B",
    name: "Image Test Product B",
    categoryId: category.id,
    materialId: material.id,
  });
  assignmentA = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryAId,
  });
  assignmentB = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryBId,
  });
  await prisma.activityLog.deleteMany();
}

test.beforeEach(async () => {
  await resetImageFixtures();
});

test.afterEach(async () => {
  await Promise.all(contexts.map(({ context }) => context.dispose()));
  contexts = [];
});

test("validates format, size, pixels and strips metadata while normalizing to WebP", async () => {
  for (const format of ["jpeg", "png", "webp"] as const) {
    const normalized = await normalizeImageUpload(await makeUpload(format));
    expect(normalized.mimeType).toBe("image/webp");
    expect(normalized.width).toBe(32);
    expect(normalized.height).toBe(24);
    expect(normalized.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  }

  const withMetadata = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .withMetadata({ exif: { IFD0: { Copyright: "private-camera-data" } } })
    .jpeg()
    .toBuffer();
  expect((await sharp(withMetadata).metadata()).exif).toBeTruthy();
  const stripped = await normalizeImageUpload({
    bytes: withMetadata,
    contentType: "image/jpeg",
    originalFilename: "metadata.jpg",
  });
  const strippedMetadata = await sharp(stripped.bytes).metadata();
  expect(strippedMetadata.exif).toBeUndefined();
  expect(strippedMetadata.icc).toBeUndefined();

  const invalid: Array<
    Upload | { bytes: Buffer; contentType: string; originalFilename: string }
  > = [
    {
      bytes: Buffer.from("not-an-image"),
      contentType: "image/jpeg",
      originalFilename: "fake.jpg",
    },
    {
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      contentType: "image/jpeg",
      originalFilename: "corrupt.jpg",
    },
    {
      bytes: Buffer.from("<svg><script/></svg>"),
      contentType: "image/svg+xml",
      originalFilename: "active.svg",
    },
    {
      // A raster MIME/extension must not admit SVG to the native decoder.
      bytes: Buffer.from(
        '\uFEFF<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
      contentType: "image/png",
      originalFilename: "disguised.png",
    },
    {
      bytes: Buffer.from("GIF89a"),
      contentType: "image/gif",
      originalFilename: "animated.gif",
    },
    {
      bytes: Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.alloc(MAX_IMAGE_BYTES),
      ]),
      contentType: "image/jpeg",
      originalFilename: "huge.jpg",
    },
  ];
  for (const upload of invalid) {
    await expect(normalizeImageUpload(upload)).rejects.toMatchObject({
      kind: "VALIDATION",
    });
  }

  const tooWide = await sharp({
    create: {
      width: 8001,
      height: 1,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  await expect(
    normalizeImageUpload({
      bytes: tooWide,
      contentType: "image/png",
      originalFilename: "wide.png",
    }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });

  const tooManyPixels = await sharp({
    create: {
      width: 6000,
      height: 5000,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  await expect(
    normalizeImageUpload({
      bytes: tooManyPixels,
      contentType: "image/png",
      originalFilename: "pixels.png",
    }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });

  const normalLarge = await sharp({
    create: {
      width: 4000,
      height: 4000,
      channels: 3,
      background: { r: 5, g: 10, b: 15 },
    },
  })
    .png()
    .toBuffer();
  await expect(
    normalizeImageUpload({
      bytes: normalLarge,
      contentType: "image/png",
      originalFilename: "large.png",
    }),
  ).resolves.toMatchObject({ width: 4000, height: 4000 });
});

test("local provider confines opaque keys to its root", async () => {
  const bytes = Buffer.from("safe-test-bytes");
  const key = createImageStorageKey();
  await storage.put(key, bytes);
  expect(await storage.read(key)).toEqual(bytes);
  await expect(storage.put("../../escape.webp", bytes)).rejects.toThrow(
    "Invalid opaque storage key",
  );
  await expect(storage.read("/tmp/absolute.webp")).rejects.toThrow(
    "Invalid opaque storage key",
  );
  await expect(storage.put("objects/user-name.webp", bytes)).rejects.toThrow(
    "Invalid opaque storage key",
  );
});

test("upload mutation routes accept only file-derived metadata and enforce roles", async () => {
  const upload = await makeUpload("png");
  const adminContext = contexts[0]!.context;
  const factoryAContext = contexts[1]!.context;
  const factoryBContext = contexts[2]!.context;

  const deniedMain = await factoryAContext.put(
    `/api/images/products/${product.id}/main`,
    {
      multipart: {
        file: {
          name: "../../client-name.png",
          mimeType: "image/png",
          buffer: upload.bytes,
        },
        storageKey: "../../must-not-be-trusted",
        checksum: "client-value",
      },
    },
  );
  expect(deniedMain.status()).toBe(404);

  const mainResponse = await adminContext.put(
    `/api/images/products/${product.id}/main`,
    {
      multipart: {
        file: {
          name: "../../display-name.png",
          mimeType: "image/png",
          buffer: upload.bytes,
        },
      },
    },
  );
  expect(mainResponse.status()).toBe(200);
  const mainBody = await mainResponse.json();
  expect(mainBody).not.toHaveProperty("storageKey");
  const mainRelation = await prisma.productMainImage.findUniqueOrThrow({
    where: { productId: product.id },
  });
  const storedMain = await prisma.storedObject.findUniqueOrThrow({
    where: { id: mainRelation.storedObjectId },
  });
  expect(storedMain.storageKey).toMatch(/^objects\/[0-9a-f-]+\.webp$/);
  expect(storedMain.originalFilename).toBe("display-name.png");

  const privateResponse = await factoryAContext.put(
    `/api/images/assignments/${assignmentA.id}/private`,
    {
      multipart: {
        file: {
          name: "factory.png",
          mimeType: "image/png",
          buffer: upload.bytes,
        },
      },
    },
  );
  expect(privateResponse.status()).toBe(200);
  expect(await privateResponse.json()).not.toHaveProperty("storageKey");
  const deniedDelete = await factoryBContext.delete(
    `/api/images/assignments/${assignmentA.id}/private`,
  );
  expect(deniedDelete.status()).toBe(404);
  expect(await prisma.factoryPrivateImage.count()).toBe(1);
});

test("main image upload, replacement, HTTP delivery and lifecycle authorization are safe", async () => {
  const first = await setProductMainImage(
    adminHeaders,
    product.id,
    await makeUpload("jpeg"),
    { storage },
  );
  expect(first).not.toHaveProperty("storageKey");
  await expect(
    getProductMainImage(factoryAHeaders, product.id),
  ).resolves.toMatchObject({ id: first.id });
  await expect(
    getProductMainImage(factoryAHeaders, productB.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });

  const factoryAContext = contexts[1]!.context;
  const http = await factoryAContext.get(first.url);
  expect(http.status()).toBe(200);
  expect(http.headers()["content-type"]).toBe("image/webp");
  expect(http.headers()["cache-control"]).toBe("private, no-store");
  expect(http.headers()["x-content-type-options"]).toBe("nosniff");
  expect(http.headers().etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
  const notModified = await factoryAContext.get(first.url, {
    headers: { "if-none-match": http.headers().etag! },
  });
  expect(notModified.status()).toBe(304);

  const before = await prisma.productMainImage.findUniqueOrThrow({
    where: { productId: product.id },
    include: { storedObject: true },
  });
  const replacement = await setProductMainImage(
    adminHeaders,
    product.id,
    await makeUpload("png", { r: 200, g: 30, b: 20, alpha: 1 }),
    { storage },
  );
  const after = await prisma.productMainImage.findUniqueOrThrow({
    where: { productId: product.id },
    include: { storedObject: true },
  });
  expect(after.id).toBe(before.id);
  expect(after.storedObjectId).not.toBe(before.storedObjectId);
  expect(await storage.stat(before.storedObject.storageKey)).toBeNull();
  expect(
    await prisma.storedObject.findUnique({
      where: { id: before.storedObjectId },
    }),
  ).toBeNull();
  expect(replacement.id).toBe(first.id);

  await setProductStatus(adminHeaders, { id: product.id, status: "DISABLED" });
  await expect(
    getProductMainImage(factoryAHeaders, product.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(
    getProductMainImage(adminHeaders, product.id),
  ).resolves.toMatchObject({ id: first.id });
  await setProductStatus(adminHeaders, { id: product.id, status: "ENABLED" });

  await setFactoryStatus(adminHeaders, {
    id: fixtures.factoryAId,
    status: "DISABLED",
  });
  await expect(
    getProductMainImage(factoryAHeaders, product.id),
  ).rejects.toMatchObject({ kind: "UNAUTHENTICATED" });
  await setFactoryStatus(adminHeaders, {
    id: fixtures.factoryAId,
    status: "ACTIVE",
  });
  factoryAHeaders = (await login(usernames.factoryA, passwords.factoryA))
    .headers;
  await expect(
    getProductMainImage(factoryAHeaders, product.id),
  ).resolves.toMatchObject({ id: first.id });

  await removeProductMainImage(adminHeaders, product.id, { storage });
  expect(await prisma.productMainImage.count()).toBe(0);
  expect(await prisma.storedObject.count()).toBe(0);
  await expect(
    getProductMainImage(adminHeaders, product.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  expect(
    (
      await prisma.activityLog.findMany({
        where: { entityId: product.id },
        orderBy: { createdAt: "asc" },
      })
    ).map(({ eventType }) => eventType),
  ).toEqual([
    "PRODUCT_MAIN_IMAGE_SET",
    "PRODUCT_MAIN_IMAGE_REPLACED",
    "PRODUCT_DISABLED",
    "PRODUCT_ENABLED",
    "PRODUCT_MAIN_IMAGE_REMOVED",
  ]);
});

test("factory private image enforces tenant and assignment lifecycle without false audit", async () => {
  const image = await setOwnFactoryPrivateImage(
    factoryAHeaders,
    assignmentA.id,
    await makeUpload("webp"),
    { storage },
  );
  await expect(
    getFactoryPrivateImage(factoryAHeaders, image.id),
  ).resolves.toMatchObject({ id: image.id });
  await expect(
    getFactoryPrivateImage(adminHeaders, image.id),
  ).resolves.toMatchObject({ id: image.id });
  await expect(
    getFactoryPrivateImage(factoryBHeaders, image.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(
    setOwnFactoryPrivateImage(
      factoryBHeaders,
      assignmentA.id,
      await makeUpload(),
      { storage },
    ),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(
    removeOwnFactoryPrivateImage(factoryBHeaders, assignmentA.id, { storage }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  expect(
    await prisma.activityLog.count({
      where: {
        eventType: {
          in: [
            "FACTORY_PRIVATE_IMAGE_SET",
            "FACTORY_PRIVATE_IMAGE_REPLACED",
            "FACTORY_PRIVATE_IMAGE_REMOVED",
          ],
        },
      },
    }),
  ).toBe(1);

  await revokeAssignment(adminHeaders, { assignmentId: assignmentA.id });
  await expect(
    getFactoryPrivateImage(factoryAHeaders, image.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(
    removeOwnFactoryPrivateImage(factoryAHeaders, assignmentA.id, { storage }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(
    getFactoryPrivateImage(adminHeaders, image.id),
  ).resolves.toMatchObject({ id: image.id });
  await reactivateAssignment(adminHeaders, { assignmentId: assignmentA.id });
  await expect(
    getFactoryPrivateImage(factoryAHeaders, image.id),
  ).resolves.toMatchObject({ id: image.id });

  await setProductStatus(adminHeaders, { id: product.id, status: "DISABLED" });
  await expect(
    getFactoryPrivateImage(factoryAHeaders, image.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await setProductStatus(adminHeaders, { id: product.id, status: "ENABLED" });
  const replaced = await setOwnFactoryPrivateImage(
    factoryAHeaders,
    assignmentA.id,
    await makeUpload("png", { r: 44, g: 55, b: 66, alpha: 1 }),
    { storage },
  );
  expect(replaced.id).toBe(image.id);
  await removeOwnFactoryPrivateImage(factoryAHeaders, assignmentA.id, {
    storage,
  });
  expect(await prisma.factoryPrivateImage.count()).toBe(0);
});

test("promotion creates an independent main object that survives private replacement and removal", async () => {
  const privateImage = await setOwnFactoryPrivateImage(
    factoryAHeaders,
    assignmentA.id,
    await makeUpload("png"),
    { storage },
  );
  const source = await prisma.factoryPrivateImage.findUniqueOrThrow({
    where: { id: privateImage.id },
    include: { storedObject: true },
  });
  const main = await promoteFactoryPrivateImage(
    adminHeaders,
    product.id,
    privateImage.id,
    { storage },
  );
  const promoted = await prisma.productMainImage.findUniqueOrThrow({
    where: { productId: product.id },
    include: { storedObject: true },
  });
  expect(promoted.storedObjectId).not.toBe(source.storedObjectId);
  expect(promoted.storedObject.checksumSha256).toBe(
    source.storedObject.checksumSha256,
  );
  expect(promoted.storedObject.storageKey).not.toBe(
    source.storedObject.storageKey,
  );
  await expect(
    promoteFactoryPrivateImage(adminHeaders, productB.id, privateImage.id, {
      storage,
    }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });

  await setOwnFactoryPrivateImage(
    factoryAHeaders,
    assignmentA.id,
    await makeUpload("jpeg", { r: 80, g: 90, b: 100, alpha: 1 }),
    { storage },
  );
  await removeOwnFactoryPrivateImage(factoryAHeaders, assignmentA.id, {
    storage,
  });
  await expect(
    getProductMainImage(factoryAHeaders, product.id),
  ).resolves.toMatchObject({ id: main.id });
  expect(await storage.stat(promoted.storedObject.storageKey)).not.toBeNull();
  const event = await prisma.activityLog.findFirstOrThrow({
    where: { eventType: "PRODUCT_MAIN_IMAGE_PROMOTED" },
  });
  expect(event.metadata).toMatchObject({
    assignmentId: assignmentA.id,
    factoryId: fixtures.factoryAId,
    sourceFactoryImageId: privateImage.id,
  });
});

test("database failure compensates new files and cleanup failure preserves the committed replacement", async () => {
  await setProductMainImage(adminHeaders, product.id, await makeUpload(), {
    storage,
  });
  const original = await prisma.productMainImage.findUniqueOrThrow({
    where: { productId: product.id },
    include: { storedObject: true },
  });
  const filesBefore = await readdir(path.join(storageRoot, "objects"));

  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION "phase08_fail_activity"() RETURNS trigger AS $$
    BEGIN
      IF NEW."eventType" IN ('PRODUCT_MAIN_IMAGE_REPLACED', 'PRODUCT_MAIN_IMAGE_SET') THEN
        RAISE EXCEPTION 'phase08 forced activity failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER "phase08_fail_activity_trigger"
      BEFORE INSERT ON "ActivityLog"
      FOR EACH ROW EXECUTE FUNCTION "phase08_fail_activity"();
  `);
  try {
    await expect(
      setProductMainImage(
        adminHeaders,
        product.id,
        await makeUpload("jpeg", { r: 255, g: 0, b: 0, alpha: 1 }),
        { storage },
      ),
    ).rejects.toThrow("phase08 forced activity failure");
  } finally {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS "phase08_fail_activity_trigger" ON "ActivityLog";
      DROP FUNCTION IF EXISTS "phase08_fail_activity"();
    `);
  }
  const afterFailure = await prisma.productMainImage.findUniqueOrThrow({
    where: { productId: product.id },
    include: { storedObject: true },
  });
  expect(afterFailure.storedObjectId).toBe(original.storedObjectId);
  expect(await readdir(path.join(storageRoot, "objects"))).toEqual(filesBefore);
  expect(await storage.stat(original.storedObject.storageKey)).not.toBeNull();

  const deleteFailingStorage: StorageProvider = {
    name: "LOCAL",
    put: (...args) => storage.put(...args),
    open: (...args) => storage.open(...args),
    read: (...args) => storage.read(...args),
    copy: (...args) => storage.copy(...args),
    stat: (...args) => storage.stat(...args),
    listKeys: () => storage.listKeys(),
    delete: async () => {
      throw new Error("forced old-file cleanup failure");
    },
  };
  const replacement = await setProductMainImage(
    adminHeaders,
    product.id,
    await makeUpload("webp", { r: 0, g: 255, b: 0, alpha: 1 }),
    { storage: deleteFailingStorage },
  );
  const active = await prisma.productMainImage.findUniqueOrThrow({
    where: { productId: product.id },
    include: { storedObject: true },
  });
  expect(active.id).toBe(replacement.id);
  expect(active.storedObjectId).not.toBe(original.storedObjectId);
  expect(await storage.stat(active.storedObject.storageKey)).not.toBeNull();
  expect(await storage.stat(original.storedObject.storageKey)).not.toBeNull();
  expect(
    await prisma.storedObject.findUnique({
      where: { id: original.storedObjectId },
    }),
  ).not.toBeNull();

  const authorized = await authorizeProductMainImageRead(
    adminHeaders,
    product.id,
  );
  await expect(
    openAuthorizedImage(authorized, { storage }),
  ).resolves.toMatchObject({
    contentLength: Number(active.storedObject.sizeBytes),
  });
  const privateImage = await setOwnFactoryPrivateImage(
    factoryBHeaders,
    assignmentB.id,
    await makeUpload(),
    { storage },
  );
  await expect(
    authorizeFactoryPrivateImageRead(factoryAHeaders, privateImage.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
});
