import { Prisma } from "@/generated/prisma/client";
import { z } from "zod";

import {
  idSchema,
  pageSchema,
  pageSizeSchema,
  parseInput,
} from "@/features/master-data/shared";
import { ApplicationError } from "@/lib/application/errors";
import { requireFactoryUserFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

const factoryProductQuerySchema = z
  .object({
    page: pageSchema,
    pageSize: pageSizeSchema,
    search: z.string().trim().max(160).optional().default(""),
    quoteStatus: z.enum(["pending", "submitted"]).optional(),
    categoryId: idSchema.optional(),
    materialId: idSchema.optional(),
  })
  .strict();

function decimalString(value: Prisma.Decimal | null) {
  return value?.toString() ?? null;
}

function computeCbm(quote: {
  packingLengthCm: Prisma.Decimal | null;
  packingWidthCm: Prisma.Decimal | null;
  packingHeightCm: Prisma.Decimal | null;
}) {
  if (
    !quote.packingLengthCm ||
    !quote.packingWidthCm ||
    !quote.packingHeightCm
  ) {
    return null;
  }
  return quote.packingLengthCm
    .mul(quote.packingWidthCm)
    .mul(quote.packingHeightCm)
    .div(1_000_000)
    .toDecimalPlaces(9)
    .toString();
}

function quoteDto(quote: {
  id: string;
  priceCents: bigint;
  moq: number | null;
  packingLengthCm: Prisma.Decimal | null;
  packingWidthCm: Prisma.Decimal | null;
  packingHeightCm: Prisma.Decimal | null;
  netWeightKg: Prisma.Decimal | null;
  grossWeightKg: Prisma.Decimal | null;
  pcsPerCarton: number | null;
  factoryNotes: string | null;
  submittedAt: Date;
  updatedAt: Date;
  version: number;
}) {
  return {
    ...quote,
    priceCents: quote.priceCents.toString(),
    packingLengthCm: decimalString(quote.packingLengthCm),
    packingWidthCm: decimalString(quote.packingWidthCm),
    packingHeightCm: decimalString(quote.packingHeightCm),
    cbmM3: computeCbm(quote),
    netWeightKg: decimalString(quote.netWeightKg),
    grossWeightKg: decimalString(quote.grossWeightKg),
  };
}

const activeAssignmentWhere = (factoryId: string) =>
  ({
    factoryId,
    status: "ACTIVE",
    product: { status: "ENABLED" },
  }) satisfies Prisma.ProductFactoryAssignmentWhereInput;

export async function getFactoryDashboard(requestHeaders: Headers) {
  const actor = await requireFactoryUserFromHeaders(requestHeaders);
  const base = activeAssignmentWhere(actor.factoryId);
  const [total, pending, submitted, recent] = await Promise.all([
    prisma.productFactoryAssignment.count({ where: base }),
    prisma.productFactoryAssignment.count({
      where: { ...base, quote: { is: null } },
    }),
    prisma.productFactoryAssignment.count({
      where: { ...base, quote: { isNot: null } },
    }),
    prisma.productFactoryAssignment.findMany({
      where: { ...base, quote: { isNot: null } },
      select: {
        id: true,
        product: { select: { id: true, sku: true, name: true } },
        quote: {
          select: { priceCents: true, updatedAt: true },
        },
      },
      orderBy: [{ quote: { updatedAt: "desc" } }, { id: "asc" }],
      take: 5,
    }),
  ]);
  return {
    factoryName: actor.factoryName,
    total,
    pending,
    submitted,
    recent: recent.map((item) => ({
      assignmentId: item.id,
      product: item.product,
      priceCents: item.quote!.priceCents.toString(),
      updatedAt: item.quote!.updatedAt,
    })),
  };
}

export async function getFactoryProductFilters(requestHeaders: Headers) {
  const actor = await requireFactoryUserFromHeaders(requestHeaders);
  const productWhere = {
    status: "ENABLED" as const,
    assignments: {
      some: { factoryId: actor.factoryId, status: "ACTIVE" as const },
    },
  };
  const [categories, materials] = await Promise.all([
    prisma.category.findMany({
      where: { products: { some: productWhere } },
      select: { id: true, name: true },
      orderBy: [{ nameNormalized: "asc" }, { id: "asc" }],
    }),
    prisma.material.findMany({
      where: { products: { some: productWhere } },
      select: { id: true, name: true },
      orderBy: [{ nameNormalized: "asc" }, { id: "asc" }],
    }),
  ]);
  return { categories, materials };
}

export async function listFactoryProducts(
  requestHeaders: Headers,
  input: unknown = {},
) {
  const actor = await requireFactoryUserFromHeaders(requestHeaders);
  const query = parseInput(factoryProductQuerySchema, input);
  const where: Prisma.ProductFactoryAssignmentWhereInput = {
    ...activeAssignmentWhere(actor.factoryId),
    quote:
      query.quoteStatus === "pending"
        ? { is: null }
        : query.quoteStatus === "submitted"
          ? { isNot: null }
          : undefined,
    product: {
      status: "ENABLED",
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
    },
  };
  const [items, total] = await Promise.all([
    prisma.productFactoryAssignment.findMany({
      where,
      select: {
        id: true,
        assignedAt: true,
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            category: { select: { id: true, name: true } },
            material: { select: { id: true, name: true } },
            mainImage: { select: { id: true, updatedAt: true } },
          },
        },
        quote: {
          select: { priceCents: true, updatedAt: true },
        },
      },
      orderBy: [{ product: { updatedAt: "desc" } }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.productFactoryAssignment.count({ where }),
  ]);
  return {
    items: items.map((item) => ({
      ...item,
      imageUrl: item.product.mainImage
        ? `/api/images/products/${item.product.id}/main`
        : null,
      quote: item.quote
        ? {
            priceCents: item.quote.priceCents.toString(),
            updatedAt: item.quote.updatedAt,
          }
        : null,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function getFactoryProduct(
  requestHeaders: Headers,
  productIdInput: unknown,
) {
  const actor = await requireFactoryUserFromHeaders(requestHeaders);
  const productId = parseInput(idSchema, productIdInput);
  const assignment = await prisma.productFactoryAssignment.findFirst({
    where: {
      productId,
      ...activeAssignmentWhere(actor.factoryId),
    },
    select: {
      id: true,
      assignedAt: true,
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          category: { select: { id: true, name: true } },
          material: { select: { id: true, name: true } },
          mainImage: {
            select: {
              id: true,
              updatedAt: true,
              storedObject: {
                select: { width: true, height: true },
              },
            },
          },
        },
      },
      privateImage: {
        select: {
          id: true,
          updatedAt: true,
          storedObject: {
            select: { width: true, height: true },
          },
        },
      },
      quote: {
        select: {
          id: true,
          priceCents: true,
          moq: true,
          packingLengthCm: true,
          packingWidthCm: true,
          packingHeightCm: true,
          netWeightKg: true,
          grossWeightKg: true,
          pcsPerCarton: true,
          factoryNotes: true,
          submittedAt: true,
          updatedAt: true,
          version: true,
          priceHistory: {
            select: {
              id: true,
              oldPriceCents: true,
              newPriceCents: true,
              changedAt: true,
              changedByUser: {
                select: { id: true, username: true, name: true },
              },
            },
            orderBy: [{ changedAt: "desc" }, { id: "desc" }],
            take: 20,
          },
          _count: { select: { priceHistory: true } },
        },
      },
    },
  });
  if (!assignment) {
    throw new ApplicationError("NOT_FOUND", "该产品当前不可访问");
  }
  return {
    ...assignment,
    product: {
      ...assignment.product,
      imageUrl: assignment.product.mainImage
        ? `/api/images/products/${assignment.product.id}/main`
        : null,
    },
    privateImage: assignment.privateImage
      ? {
          ...assignment.privateImage,
          url: `/api/images/factory-private/${assignment.privateImage.id}`,
        }
      : null,
    quote: assignment.quote
      ? {
          ...quoteDto(assignment.quote),
          history: assignment.quote.priceHistory.map((item) => ({
            ...item,
            oldPriceCents: item.oldPriceCents?.toString() ?? null,
            newPriceCents: item.newPriceCents.toString(),
          })),
          historyTotal: assignment.quote._count.priceHistory,
        }
      : null,
  };
}

export async function getFactoryProfile(requestHeaders: Headers) {
  const actor = await requireFactoryUserFromHeaders(requestHeaders);
  return {
    username: actor.username,
    factoryName: actor.factoryName,
  };
}
