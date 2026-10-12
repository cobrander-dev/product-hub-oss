import { Prisma } from "@/generated/prisma/client";

import { idSchema, parseInput } from "@/features/master-data/shared";
import {
  createProductSchema,
  productListSchema,
  setProductStatusSchema,
  updateProductSchema,
} from "@/features/products/validation";
import {
  createProductInTransaction,
  productInclude,
  updateProductInTransaction,
} from "@/features/products/mutations";
import {
  ApplicationError,
  isUniqueConstraintError,
} from "@/lib/application/errors";
import { productLabel, writeUserActivity } from "@/features/activity/writer";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

function productDto<T extends { skuNormalized: string | null }>(value: T) {
  const { skuNormalized, ...dto } = value;
  void skuNormalized;
  return dto;
}

export async function createProduct(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(createProductSchema, input);
  try {
    return productDto(
      await prisma.$transaction(async (tx) => {
        return createProductInTransaction(tx, actor, data);
      }),
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplicationError("CONFLICT", "SKU 已存在");
    }
    throw error;
  }
}

export async function getProduct(headers: Headers, idInput: unknown) {
  await requireAdminFromHeaders(headers);
  const id = parseInput(idSchema, idInput);
  const product = await prisma.product.findUnique({
    where: { id },
    include: productInclude,
  });
  if (!product) throw new ApplicationError("NOT_FOUND", "产品不存在");
  return productDto(product);
}

export async function listProducts(headers: Headers, input: unknown = {}) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(productListSchema, input);
  const where: Prisma.ProductWhereInput = {
    status: query.status,
    categoryId: query.categoryId,
    materialId: query.materialId,
    ...(query.search
      ? {
          OR: [
            { sku: { contains: query.search, mode: "insensitive" } },
            { name: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const orderBy = {
    [query.sortBy]: query.sortDirection,
  } as Prisma.ProductOrderByWithRelationInput;
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: productInclude,
      orderBy: [orderBy, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.product.count({ where }),
  ]);
  return {
    items: items.map(productDto),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function updateProduct(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(updateProductSchema, input);
  try {
    return productDto(
      await prisma.$transaction(async (tx) => {
        const current = await tx.product.findUnique({
          where: { id: data.id },
          include: productInclude,
        });
        if (!current) throw new ApplicationError("NOT_FOUND", "产品不存在");
        const { id: _id, ...values } = data;
        void _id;
        return updateProductInTransaction(tx, actor, current, values);
      }),
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplicationError("CONFLICT", "SKU 已存在");
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new ApplicationError("NOT_FOUND", "产品不存在");
    }
    throw error;
  }
}

export async function setProductStatus(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(setProductStatusSchema, input);
  try {
    return productDto(
      await prisma.$transaction(async (tx) => {
        const current = await tx.product.findUnique({
          where: { id: data.id },
          include: productInclude,
        });
        if (!current) throw new ApplicationError("NOT_FOUND", "产品不存在");
        if (current.status === data.status) return current;
        const updated = await tx.product.update({
          where: { id: data.id },
          data: { status: data.status },
          include: productInclude,
        });
        await writeUserActivity(tx, {
          eventType:
            updated.status === "ENABLED"
              ? "PRODUCT_ENABLED"
              : "PRODUCT_DISABLED",
          actor,
          entityId: updated.id,
          entityLabelSnapshot: productLabel(updated),
          factoryId: null,
          before: { status: current.status },
          after: { status: updated.status },
          metadata: {},
        });
        return updated;
      }),
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new ApplicationError("NOT_FOUND", "产品不存在");
    }
    throw error;
  }
}
