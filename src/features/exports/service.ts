import { Prisma } from "@/generated/prisma/client";

import { IMPORT_HEADERS } from "@/features/imports/validation";
import { parseInput } from "@/features/master-data/shared";
import {
  exportFormatSchema,
  productExportSchema,
  quoteExportSchema,
} from "@/features/exports/validation";
import {
  createCsv,
  createXlsx,
  type ExportCell,
  type ExportColumn,
} from "@/features/exports/spreadsheet";
import { ApplicationError } from "@/lib/application/errors";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

const MAX_EXPORT_ROWS = 10_000;

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

async function fileResult(
  formatInput: unknown,
  prefix: string,
  sheet: string,
  columns: ExportColumn[],
  rows: ExportCell[][],
) {
  const format = parseInput(exportFormatSchema, formatInput);
  const bytes =
    format === "csv"
      ? createCsv(columns, rows)
      : await createXlsx(sheet, columns, rows);
  return {
    bytes,
    filename: `${prefix}-${dateStamp()}.${format}`,
    contentType:
      format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

function assertExportLimit(length: number) {
  if (length > MAX_EXPORT_ROWS) {
    throw new ApplicationError(
      "VALIDATION",
      "导出结果超过 10000 行，请缩小筛选范围",
    );
  }
}

const productColumns: ExportColumn[] = [
  { header: "product_id", width: 38 },
  { header: "SKU", width: 20 },
  { header: "产品名称", width: 28 },
  { header: "分类", width: 18 },
  { header: "材质", width: 18 },
  { header: "状态", width: 12 },
  { header: "内部备注", width: 36 },
  { header: "是否有主图", width: 14 },
  { header: "创建时间", width: 24 },
  { header: "更新时间", width: 24 },
];

export async function exportProducts(
  headers: Headers,
  format: unknown,
  input: unknown,
) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(productExportSchema, input);
  const where: Prisma.ProductWhereInput = {
    status: query.status,
    categoryId: query.categoryId,
    materialId: query.materialId,
    mainImage:
      query.hasMainImage === undefined
        ? undefined
        : query.hasMainImage
          ? { isNot: null }
          : { is: null },
    ...(query.search
      ? {
          OR: [
            { sku: { contains: query.search, mode: "insensitive" as const } },
            { name: { contains: query.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const orderBy = {
    [query.sortBy]: query.sortDirection,
  } as Prisma.ProductOrderByWithRelationInput;
  const products = await prisma.product.findMany({
    where,
    select: {
      id: true,
      sku: true,
      name: true,
      status: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      category: { select: { name: true } },
      material: { select: { name: true } },
      mainImage: { select: { id: true } },
    },
    orderBy: [orderBy, { id: "asc" }],
    take: MAX_EXPORT_ROWS + 1,
  });
  assertExportLimit(products.length);
  const rows = products.map((product): ExportCell[] => [
    product.id,
    product.sku,
    product.name,
    product.category.name,
    product.material.name,
    product.status === "ENABLED" ? "启用" : "停用",
    product.notes,
    product.mainImage ? "是" : "否",
    product.createdAt.toISOString(),
    product.updatedAt.toISOString(),
  ]);
  return fileResult(format, "products", "Products", productColumns, rows);
}

function yuan(priceCents: bigint) {
  const whole = priceCents / 100n;
  const fraction = (priceCents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

function cbm(quote: {
  packingLengthCm: Prisma.Decimal | null;
  packingWidthCm: Prisma.Decimal | null;
  packingHeightCm: Prisma.Decimal | null;
}) {
  if (!quote.packingLengthCm || !quote.packingWidthCm || !quote.packingHeightCm)
    return null;
  return quote.packingLengthCm
    .mul(quote.packingWidthCm)
    .mul(quote.packingHeightCm)
    .div(1_000_000)
    .toDecimalPlaces(4)
    .toFixed(4);
}

const quoteColumns: ExportColumn[] = [
  { header: "product_id", width: 38 },
  { header: "SKU", width: 20 },
  { header: "产品名称", width: 28 },
  { header: "厂家", width: 24 },
  { header: "厂家状态", width: 14 },
  { header: "报价人民币", width: 16, numberFormat: "0.00" },
  { header: "MOQ", width: 12, numberFormat: "0" },
  { header: "包装长(cm)", width: 14, numberFormat: "0.000" },
  { header: "包装宽(cm)", width: 14, numberFormat: "0.000" },
  { header: "包装高(cm)", width: 14, numberFormat: "0.000" },
  { header: "CBM(m³)", width: 14, numberFormat: "0.0000" },
  { header: "净重(kg)", width: 14, numberFormat: "0.000" },
  { header: "毛重(kg)", width: 14, numberFormat: "0.000" },
  { header: "PCS/箱", width: 12, numberFormat: "0" },
  { header: "厂家备注", width: 36 },
  { header: "分配状态", width: 14 },
  { header: "提交时间", width: 24 },
  { header: "更新时间", width: 24 },
];

export async function exportFactoryQuotes(
  headers: Headers,
  format: unknown,
  input: unknown,
) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(quoteExportSchema, input);
  if (query.quoteStatus === "PENDING") {
    return fileResult(
      format,
      "factory-quotes",
      "Factory Quotes",
      quoteColumns,
      [],
    );
  }
  const quotes = await prisma.factoryQuote.findMany({
    where: {
      submittedAt: { gte: query.submittedFrom, lte: query.submittedTo },
      updatedAt: { gte: query.updatedFrom, lte: query.updatedTo },
      assignment: {
        factoryId: query.factoryId,
        productId: query.productId,
        status: query.assignmentStatus,
        ...(query.search
          ? {
              OR: [
                {
                  product: {
                    sku: {
                      contains: query.search,
                      mode: "insensitive" as const,
                    },
                  },
                },
                {
                  product: {
                    name: {
                      contains: query.search,
                      mode: "insensitive" as const,
                    },
                  },
                },
                {
                  factory: {
                    name: {
                      contains: query.search,
                      mode: "insensitive" as const,
                    },
                  },
                },
              ],
            }
          : {}),
      },
    },
    include: {
      assignment: {
        include: {
          product: { select: { id: true, sku: true, name: true } },
          factory: { select: { name: true, status: true } },
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: MAX_EXPORT_ROWS + 1,
  });
  assertExportLimit(quotes.length);
  const rows = quotes.map((quote): ExportCell[] => [
    quote.assignment.product.id,
    quote.assignment.product.sku,
    quote.assignment.product.name,
    quote.assignment.factory.name,
    quote.assignment.factory.status === "ACTIVE" ? "启用" : "停用",
    yuan(quote.priceCents),
    quote.moq,
    quote.packingLengthCm?.toString() ?? null,
    quote.packingWidthCm?.toString() ?? null,
    quote.packingHeightCm?.toString() ?? null,
    cbm(quote),
    quote.netWeightKg?.toString() ?? null,
    quote.grossWeightKg?.toString() ?? null,
    quote.pcsPerCarton,
    quote.factoryNotes,
    quote.assignment.status === "ACTIVE" ? "已分配" : "已撤销",
    quote.submittedAt.toISOString(),
    quote.updatedAt.toISOString(),
  ]);
  return fileResult(
    format,
    "factory-quotes",
    "Factory Quotes",
    quoteColumns,
    rows,
  );
}

const templateColumns: ExportColumn[] = IMPORT_HEADERS.map((header) => ({
  header,
  width:
    header === "product_id"
      ? 38
      : header === "内部备注"
        ? 36
        : header === "产品名称"
          ? 28
          : 18,
}));

export async function downloadProductImportTemplate(
  headers: Headers,
  format: unknown,
) {
  await requireAdminFromHeaders(headers);
  return fileResult(
    format,
    "product-import-template",
    "Products",
    templateColumns,
    [],
  );
}
