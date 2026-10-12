import { Prisma } from "@/generated/prisma/client";

import { parseInput } from "@/features/master-data/shared";
import {
  assignProductSchema,
  assignmentIdSchema,
  factoryProductListSchema,
  listFactoriesForProductSchema,
  listProductsForFactorySchema,
} from "@/features/assignments/validation";
import {
  ApplicationError,
  isUniqueConstraintError,
} from "@/lib/application/errors";
import { assignmentLabel, writeUserActivity } from "@/features/activity/writer";
import type { AdminActor } from "@/lib/auth/context-core";
import {
  requireAdminFromHeaders,
  requireFactoryUserFromHeaders,
} from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

const assignmentInclude = {
  product: {
    select: { id: true, sku: true, name: true, status: true, updatedAt: true },
  },
  factory: { select: { id: true, name: true, status: true } },
} satisfies Prisma.ProductFactoryAssignmentInclude;

type AssignmentWithRelations = Prisma.ProductFactoryAssignmentGetPayload<{
  include: typeof assignmentInclude;
}>;

const factoryProductSelect = {
  id: true,
  sku: true,
  name: true,
  status: true,
  updatedAt: true,
  category: { select: { id: true, name: true } },
  material: { select: { id: true, name: true } },
} satisfies Prisma.ProductSelect;

async function requireAssignablePair(
  tx: Prisma.TransactionClient,
  productId: string,
  factoryId: string,
) {
  const [product, factory] = await Promise.all([
    tx.product.findUnique({
      where: { id: productId },
      select: { id: true, status: true },
    }),
    tx.factory.findUnique({
      where: { id: factoryId },
      select: { id: true, status: true },
    }),
  ]);

  if (!product) throw new ApplicationError("NOT_FOUND", "产品不存在");
  if (product.status !== "ENABLED") {
    throw new ApplicationError("CONFLICT", "已停用的产品不能分配");
  }
  if (!factory) throw new ApplicationError("NOT_FOUND", "厂家不存在");
  if (factory.status !== "ACTIVE") {
    throw new ApplicationError("CONFLICT", "已停用的厂家不能分配产品");
  }
}

async function getAssignmentOrThrow(
  tx: Prisma.TransactionClient,
  assignmentId: string,
) {
  const assignment = await tx.productFactoryAssignment.findUnique({
    where: { id: assignmentId },
    include: assignmentInclude,
  });
  if (!assignment) throw new ApplicationError("NOT_FOUND", "分配关系不存在");
  return assignment;
}

async function reactivateById(
  tx: Prisma.TransactionClient,
  actor: AdminActor,
  current: AssignmentWithRelations,
) {
  const activatedAt = new Date();
  const result = await tx.productFactoryAssignment.updateMany({
    where: { id: current.id, status: "REVOKED" },
    data: { status: "ACTIVE", assignedAt: activatedAt, revokedAt: null },
  });
  const updated = await getAssignmentOrThrow(tx, current.id);
  if (result.count === 0) return updated;
  await writeUserActivity(tx, {
    eventType: "ASSIGNMENT_REACTIVATED",
    actor,
    entityId: updated.id,
    entityLabelSnapshot: assignmentLabel(updated),
    factoryId: updated.factoryId,
    before: { status: "REVOKED" },
    after: { status: "ACTIVE" },
    metadata: {
      productId: updated.productId,
      factoryId: updated.factoryId,
    },
  });
  return updated;
}

export async function assignProductToFactory(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(assignProductSchema, input);

  try {
    return await prisma.$transaction(async (tx) => {
      await requireAssignablePair(tx, data.productId, data.factoryId);
      const existing = await tx.productFactoryAssignment.findUnique({
        where: {
          productId_factoryId: {
            productId: data.productId,
            factoryId: data.factoryId,
          },
        },
        include: assignmentInclude,
      });
      if (existing?.status === "ACTIVE") return existing;
      if (existing) return reactivateById(tx, actor, existing);

      const created = await tx.productFactoryAssignment.create({
        data,
        include: assignmentInclude,
      });
      await writeUserActivity(tx, {
        eventType: "ASSIGNMENT_ASSIGNED",
        actor,
        entityId: created.id,
        entityLabelSnapshot: assignmentLabel(created),
        factoryId: created.factoryId,
        before: { productId: null, factoryId: null, status: null },
        after: {
          productId: created.productId,
          factoryId: created.factoryId,
          status: created.status,
        },
        metadata: {
          productId: created.productId,
          factoryId: created.factoryId,
        },
      });
      return created;
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await prisma.productFactoryAssignment.findUnique({
      where: {
        productId_factoryId: {
          productId: data.productId,
          factoryId: data.factoryId,
        },
      },
      include: assignmentInclude,
    });
    if (!concurrent) {
      throw new ApplicationError("CONFLICT", "产品分配发生冲突，请重试");
    }
    return concurrent.status === "REVOKED"
      ? reactivateAssignment(headers, { assignmentId: concurrent.id })
      : concurrent;
  }
}

export async function revokeAssignment(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const { assignmentId } = parseInput(assignmentIdSchema, input);
  return prisma.$transaction(async (tx) => {
    const current = await getAssignmentOrThrow(tx, assignmentId);
    if (current.status === "REVOKED") return current;
    const changed = await tx.productFactoryAssignment.updateMany({
      where: { id: assignmentId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    const updated = await getAssignmentOrThrow(tx, assignmentId);
    if (changed.count === 0) return updated;
    await writeUserActivity(tx, {
      eventType: "ASSIGNMENT_REVOKED",
      actor,
      entityId: updated.id,
      entityLabelSnapshot: assignmentLabel(updated),
      factoryId: updated.factoryId,
      before: { status: "ACTIVE" },
      after: { status: "REVOKED" },
      metadata: {
        productId: updated.productId,
        factoryId: updated.factoryId,
      },
    });
    return updated;
  });
}

export async function reactivateAssignment(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const { assignmentId } = parseInput(assignmentIdSchema, input);
  return prisma.$transaction(async (tx) => {
    const current = await getAssignmentOrThrow(tx, assignmentId);
    if (current.status === "ACTIVE") return current;
    await requireAssignablePair(tx, current.productId, current.factoryId);
    return reactivateById(tx, actor, current);
  });
}

export async function listFactoriesForProduct(
  headers: Headers,
  input: unknown,
) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(listFactoriesForProductSchema, input);
  const product = await prisma.product.findUnique({
    where: { id: query.productId },
    select: { id: true },
  });
  if (!product) throw new ApplicationError("NOT_FOUND", "产品不存在");

  const where: Prisma.ProductFactoryAssignmentWhereInput = {
    productId: query.productId,
    status: query.status,
    ...(query.search
      ? { factory: { name: { contains: query.search, mode: "insensitive" } } }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.productFactoryAssignment.findMany({
      where,
      include: assignmentInclude,
      orderBy: [{ assignedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.productFactoryAssignment.count({ where }),
  ]);
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function listProductsForFactory(headers: Headers, input: unknown) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(listProductsForFactorySchema, input);
  const factory = await prisma.factory.findUnique({
    where: { id: query.factoryId },
    select: { id: true },
  });
  if (!factory) throw new ApplicationError("NOT_FOUND", "厂家不存在");

  const where: Prisma.ProductFactoryAssignmentWhereInput = {
    factoryId: query.factoryId,
    status: query.status,
    ...(query.search
      ? {
          product: {
            OR: [
              { sku: { contains: query.search, mode: "insensitive" } },
              { name: { contains: query.search, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.productFactoryAssignment.findMany({
      where,
      include: assignmentInclude,
      orderBy: [{ assignedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.productFactoryAssignment.count({ where }),
  ]);
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function listAssignedProducts(
  headers: Headers,
  input: unknown = {},
) {
  const actor = await requireFactoryUserFromHeaders(headers);
  const query = parseInput(factoryProductListSchema, input);
  const where: Prisma.ProductWhereInput = {
    status: "ENABLED",
    categoryId: query.categoryId,
    materialId: query.materialId,
    assignments: {
      some: { factoryId: actor.factoryId, status: "ACTIVE" },
    },
    ...(query.search
      ? {
          OR: [
            { sku: { contains: query.search, mode: "insensitive" } },
            { name: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: factoryProductSelect,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.product.count({ where }),
  ]);
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function getAssignedProduct(
  headers: Headers,
  productIdInput: unknown,
) {
  const actor = await requireFactoryUserFromHeaders(headers);
  const productId = parseInput(
    assignProductSchema.shape.productId,
    productIdInput,
  );
  const product = await prisma.product.findFirst({
    where: {
      id: productId,
      status: "ENABLED",
      assignments: {
        some: { factoryId: actor.factoryId, status: "ACTIVE" },
      },
    },
    select: factoryProductSelect,
  });
  if (!product) throw new ApplicationError("NOT_FOUND", "产品不存在");
  return product;
}
