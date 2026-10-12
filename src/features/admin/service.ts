import { Prisma } from "@/generated/prisma/client";
import { z } from "zod";

import { parseInput } from "@/features/master-data/shared";
import { ApplicationError } from "@/lib/application/errors";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

const optionalId = z.string().uuid().optional();
export async function getAdminQuoteRecordAssignmentId(
  headers: Headers,
  input: unknown,
) {
  await requireAdminFromHeaders(headers);
  const id = parseInput(z.string().uuid(), input);
  const quote = await prisma.factoryQuote.findUnique({
    where: { id },
    select: { assignmentId: true },
  });
  if (!quote) throw new ApplicationError("NOT_FOUND", "报价记录不存在");
  return quote.assignmentId;
}
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).default(""),
});

const productQuery = pageQuery.extend({
  status: z.enum(["ENABLED", "DISABLED"]).optional(),
  categoryId: optionalId,
  materialId: optionalId,
  hasMainImage: z.enum(["true", "false"]).optional(),
  sortBy: z.enum(["updatedAt", "name", "sku"]).default("updatedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});

const factoryQuery = pageQuery.extend({
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

const quoteQuery = pageQuery.extend({
  factoryId: optionalId,
  productId: optionalId,
  assignmentStatus: z.enum(["ACTIVE", "REVOKED"]).optional(),
  quoteStatus: z.enum(["PENDING", "SUBMITTED"]).optional(),
  submittedFrom: z.coerce.date().optional(),
  submittedTo: z.coerce.date().optional(),
});

function imageDto(
  image: {
    id: string;
    updatedAt: Date;
    storedObject: {
      width: number;
      height: number;
      sizeBytes: bigint;
    };
  } | null,
  url: string | null,
) {
  return image
    ? {
        id: image.id,
        url,
        width: image.storedObject.width,
        height: image.storedObject.height,
        sizeBytes: image.storedObject.sizeBytes.toString(),
        updatedAt: image.updatedAt,
      }
    : null;
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
  const decimal = (value: Prisma.Decimal | null) => value?.toString() ?? null;
  const cbm =
    quote.packingLengthCm && quote.packingWidthCm && quote.packingHeightCm
      ? quote.packingLengthCm
          .mul(quote.packingWidthCm)
          .mul(quote.packingHeightCm)
          .div(1_000_000)
          .toDecimalPlaces(9)
          .toString()
      : null;
  return {
    ...quote,
    priceCents: quote.priceCents.toString(),
    packingLengthCm: decimal(quote.packingLengthCm),
    packingWidthCm: decimal(quote.packingWidthCm),
    packingHeightCm: decimal(quote.packingHeightCm),
    netWeightKg: decimal(quote.netWeightKg),
    grossWeightKg: decimal(quote.grossWeightKg),
    cbmM3: cbm,
  };
}

export async function getAdminDashboard(headers: Headers) {
  await requireAdminFromHeaders(headers);
  const [
    products,
    enabledProducts,
    factories,
    activeAssignments,
    submittedQuotes,
    pendingQuotes,
    missingPackaging,
    missingWeight,
    recentProducts,
    pendingAssignments,
    recentPrices,
  ] = await Promise.all([
    prisma.product.count(),
    prisma.product.count({ where: { status: "ENABLED" } }),
    prisma.factory.count(),
    prisma.productFactoryAssignment.count({ where: { status: "ACTIVE" } }),
    prisma.factoryQuote.count(),
    prisma.productFactoryAssignment.count({
      where: { status: "ACTIVE", quote: null },
    }),
    prisma.productFactoryAssignment.count({
      where: {
        status: "ACTIVE",
        OR: [
          { quote: null },
          { quote: { packingLengthCm: null } },
          { quote: { packingWidthCm: null } },
          { quote: { packingHeightCm: null } },
        ],
      },
    }),
    prisma.productFactoryAssignment.count({
      where: {
        status: "ACTIVE",
        OR: [
          { quote: null },
          { quote: { netWeightKg: null } },
          { quote: { grossWeightKg: null } },
        ],
      },
    }),
    prisma.product.findMany({
      take: 6,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      include: { category: true, material: true, mainImage: true },
    }),
    prisma.productFactoryAssignment.findMany({
      where: { status: "ACTIVE", quote: null },
      take: 6,
      orderBy: [{ assignedAt: "desc" }, { id: "asc" }],
      include: { product: true, factory: true },
    }),
    prisma.priceHistory.findMany({
      take: 6,
      orderBy: [{ changedAt: "desc" }, { id: "desc" }],
      include: {
        factoryQuote: {
          include: {
            assignment: { include: { product: true, factory: true } },
          },
        },
      },
    }),
  ]);
  return {
    metrics: {
      products,
      enabledProducts,
      factories,
      activeAssignments,
      submittedQuotes,
      pendingQuotes,
      missingPackaging,
      missingWeight,
    },
    recentProducts,
    pendingAssignments,
    recentPrices: recentPrices.map((item) => ({
      id: item.id,
      oldPriceCents: item.oldPriceCents?.toString() ?? null,
      newPriceCents: item.newPriceCents.toString(),
      changedAt: item.changedAt,
      quoteId: item.factoryQuote.id,
      assignmentId: item.factoryQuote.assignmentId,
      product: item.factoryQuote.assignment.product,
      factory: item.factoryQuote.assignment.factory,
    })),
  };
}

export async function getAdminPicklists(headers: Headers) {
  await requireAdminFromHeaders(headers);
  const [categories, materials, factories, products] = await Promise.all([
    prisma.category.findMany({
      select: { id: true, name: true, status: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.material.findMany({
      select: { id: true, name: true, status: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.factory.findMany({
      select: { id: true, name: true, status: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.product.findMany({
      select: { id: true, sku: true, name: true, status: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
  ]);
  return { categories, materials, factories, products };
}

export async function listAdminProducts(headers: Headers, input: unknown = {}) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(productQuery, input);
  const where: Prisma.ProductWhereInput = {
    status: query.status,
    categoryId: query.categoryId,
    materialId: query.materialId,
    mainImage:
      query.hasMainImage === "true"
        ? { isNot: null }
        : query.hasMainImage === "false"
          ? null
          : undefined,
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
      orderBy: [orderBy, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        category: true,
        material: true,
        mainImage: { include: { storedObject: true } },
        assignments: {
          where: { status: "ACTIVE" },
          select: { id: true, quote: { select: { priceCents: true } } },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return {
    items: items.map((item) => {
      const { skuNormalized: _skuNormalized, ...safeItem } = item;
      void _skuNormalized;
      const prices = item.assignments
        .flatMap((assignment) => assignment.quote?.priceCents ?? [])
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        ...safeItem,
        category: {
          id: item.category.id,
          name: item.category.name,
          status: item.category.status,
        },
        material: {
          id: item.material.id,
          name: item.material.name,
          status: item.material.status,
        },
        image: imageDto(
          item.mainImage,
          item.mainImage ? `/api/images/products/${item.id}/main` : null,
        ),
        mainImage: undefined,
        assignmentCount: item.assignments.length,
        quotedCount: prices.length,
        priceMinCents: prices[0]?.toString() ?? null,
        priceMaxCents: prices.at(-1)?.toString() ?? null,
        assignments: undefined,
      };
    }),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function getAdminProduct(headers: Headers, id: string) {
  await requireAdminFromHeaders(headers);
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      category: true,
      material: true,
      mainImage: { include: { storedObject: true } },
      assignments: {
        orderBy: [{ status: "asc" }, { assignedAt: "desc" }],
        include: {
          factory: true,
          quote: true,
          privateImage: { include: { storedObject: true } },
        },
      },
    },
  });
  if (!product) throw new ApplicationError("NOT_FOUND", "产品不存在");
  const { skuNormalized: _skuNormalized, ...safeProduct } = product;
  void _skuNormalized;
  return {
    ...safeProduct,
    category: {
      id: product.category.id,
      name: product.category.name,
      status: product.category.status,
    },
    material: {
      id: product.material.id,
      name: product.material.name,
      status: product.material.status,
    },
    image: imageDto(
      product.mainImage,
      product.mainImage ? `/api/images/products/${product.id}/main` : null,
    ),
    mainImage: undefined,
    assignments: product.assignments.map((assignment) => ({
      ...assignment,
      quote: assignment.quote ? quoteDto(assignment.quote) : null,
      privateImage: imageDto(
        assignment.privateImage,
        assignment.privateImage
          ? `/api/images/factory-private/${assignment.privateImage.id}`
          : null,
      ),
    })),
  };
}

export async function listAdminFactories(
  headers: Headers,
  input: unknown = {},
) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(factoryQuery, input);
  const where: Prisma.FactoryWhereInput = {
    status: query.status,
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { contactName: { contains: query.search, mode: "insensitive" } },
            { phone: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.factory.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        _count: {
          select: {
            assignments: { where: { status: "ACTIVE" } },
            users: true,
          },
        },
        assignments: {
          where: { status: "ACTIVE", quote: { isNot: null } },
          select: { id: true },
        },
      },
    }),
    prisma.factory.count({ where }),
  ]);
  return {
    items: items.map((item) => {
      const { nameNormalized: _nameNormalized, ...safeItem } = item;
      void _nameNormalized;
      return {
        ...safeItem,
        activeAssignmentCount: item._count.assignments,
        userCount: item._count.users,
        quotedCount: item.assignments.length,
        _count: undefined,
        assignments: undefined,
      };
    }),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function getAdminFactory(headers: Headers, id: string) {
  await requireAdminFromHeaders(headers);
  const factory = await prisma.factory.findUnique({
    where: { id },
    include: {
      users: {
        select: {
          id: true,
          username: true,
          name: true,
          banned: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
      assignments: {
        orderBy: [{ status: "asc" }, { assignedAt: "desc" }],
        include: {
          product: { include: { category: true, material: true } },
          quote: true,
        },
      },
    },
  });
  if (!factory) throw new ApplicationError("NOT_FOUND", "厂家不存在");
  const { nameNormalized: _nameNormalized, ...safeFactory } = factory;
  void _nameNormalized;
  return {
    ...safeFactory,
    assignments: factory.assignments.map((assignment) => ({
      ...assignment,
      quote: assignment.quote ? quoteDto(assignment.quote) : null,
    })),
  };
}

export async function listAdminQuoteWorkspace(
  headers: Headers,
  input: unknown = {},
) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(quoteQuery, input);
  const quoteDate =
    query.submittedFrom || query.submittedTo
      ? { submittedAt: { gte: query.submittedFrom, lte: query.submittedTo } }
      : {};
  const where: Prisma.ProductFactoryAssignmentWhereInput = {
    factoryId: query.factoryId,
    productId: query.productId,
    status: query.assignmentStatus,
    ...(query.quoteStatus === "PENDING"
      ? { quote: null }
      : query.quoteStatus === "SUBMITTED" || Object.keys(quoteDate).length
        ? { quote: { is: quoteDate } }
        : {}),
    ...(query.search
      ? {
          OR: [
            {
              product: { sku: { contains: query.search, mode: "insensitive" } },
            },
            {
              product: {
                name: { contains: query.search, mode: "insensitive" },
              },
            },
            {
              factory: {
                name: { contains: query.search, mode: "insensitive" },
              },
            },
          ],
        }
      : {}),
  };
  const exportableWhere: Prisma.ProductFactoryAssignmentWhereInput =
    query.quoteStatus === "PENDING"
      ? { id: { in: [] } }
      : query.quoteStatus === "SUBMITTED" || Object.keys(quoteDate).length
        ? where
        : { ...where, quote: { isNot: null } };
  const [items, total, exportableTotal] = await Promise.all([
    prisma.productFactoryAssignment.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        product: { include: { mainImage: true } },
        factory: true,
        quote: true,
        privateImage: true,
      },
    }),
    prisma.productFactoryAssignment.count({ where }),
    prisma.productFactoryAssignment.count({ where: exportableWhere }),
  ]);
  return {
    items: items.map((item) => ({
      ...item,
      quote: item.quote ? quoteDto(item.quote) : null,
      product: {
        ...item.product,
        imageUrl: item.product.mainImage
          ? `/api/images/products/${item.product.id}/main`
          : null,
        mainImage: undefined,
      },
      privateImageUrl: item.privateImage
        ? `/api/images/factory-private/${item.privateImage.id}`
        : null,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    exportableTotal,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function getAdminQuoteWorkspace(
  headers: Headers,
  assignmentId: string,
) {
  await requireAdminFromHeaders(headers);
  const assignment = await prisma.productFactoryAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      product: { include: { category: true, material: true, mainImage: true } },
      factory: true,
      quote: {
        include: {
          priceHistory: {
            include: {
              changedByUser: {
                select: { id: true, username: true, name: true },
              },
            },
            orderBy: [{ changedAt: "desc" }, { id: "desc" }],
          },
        },
      },
      privateImage: { include: { storedObject: true } },
    },
  });
  if (!assignment) throw new ApplicationError("NOT_FOUND", "报价任务不存在");
  return {
    ...assignment,
    product: {
      ...assignment.product,
      imageUrl: assignment.product.mainImage
        ? `/api/images/products/${assignment.product.id}/main`
        : null,
      mainImage: undefined,
    },
    quote: assignment.quote
      ? {
          ...quoteDto(assignment.quote),
          priceHistory: assignment.quote.priceHistory.map((item) => ({
            ...item,
            oldPriceCents: item.oldPriceCents?.toString() ?? null,
            newPriceCents: item.newPriceCents.toString(),
          })),
        }
      : null,
    privateImage: imageDto(
      assignment.privateImage,
      assignment.privateImage
        ? `/api/images/factory-private/${assignment.privateImage.id}`
        : null,
    ),
  };
}

export async function getAdminDictionaries(headers: Headers) {
  await requireAdminFromHeaders(headers);
  const [categories, materials] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: { _count: { select: { products: true } } },
    }),
    prisma.material.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: { _count: { select: { products: true } } },
    }),
  ]);
  return {
    categories: categories.map(
      ({ nameNormalized: _nameNormalized, ...item }) => {
        void _nameNormalized;
        return item;
      },
    ),
    materials: materials.map(({ nameNormalized: _nameNormalized, ...item }) => {
      void _nameNormalized;
      return item;
    }),
  };
}
