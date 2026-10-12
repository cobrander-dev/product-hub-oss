import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";

import { parseInput, normalizeName } from "@/features/master-data/shared";
import { parseProductImportFile } from "@/features/imports/parser";
import {
  importJobIdSchema,
  importRowListSchema,
  normalizedProductImportSchema,
  type NormalizedProductImport,
} from "@/features/imports/validation";
import {
  createProductInTransaction,
  productInclude,
  updateProductInTransaction,
} from "@/features/products/mutations";
import {
  createProductSchema,
  normalizeSku,
} from "@/features/products/validation";
import {
  ApplicationError,
  isUniqueConstraintError,
} from "@/lib/application/errors";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

type RowError = { field: string; message: string };
type Candidate = {
  rowNumber: number;
  productId: string | null;
  normalized: NormalizedProductImport | null;
  errors: RowError[];
};

function error(field: string, message: string): RowError {
  return { field, message };
}

function productValues(product: {
  sku: string | null;
  name: string;
  categoryId: string;
  materialId: string;
  status: "ENABLED" | "DISABLED";
  notes: string | null;
}) {
  return {
    sku: product.sku,
    name: product.name,
    categoryId: product.categoryId,
    materialId: product.materialId,
    status: product.status,
    notes: product.notes,
  };
}

function mutationValues(product: NormalizedProductImport) {
  return productValues(product);
}

function valuesEqual(
  left: ReturnType<typeof productValues>,
  right: ReturnType<typeof productValues>,
) {
  return (Object.keys(left) as (keyof typeof left)[]).every(
    (key) => left[key] === right[key],
  );
}

function previewChanges(
  current: Prisma.ProductGetPayload<{ include: typeof productInclude }>,
  next: NormalizedProductImport,
) {
  const before = {
    sku: current.sku,
    name: current.name,
    category: current.category.name,
    material: current.material.name,
    status: current.status === "ENABLED" ? "启用" : "停用",
    notes: current.notes,
  };
  const after = {
    sku: next.sku,
    name: next.name,
    category: next.categoryName,
    material: next.materialName,
    status: next.status === "ENABLED" ? "启用" : "停用",
    notes: next.notes,
  };
  return Object.fromEntries(
    (Object.keys(before) as (keyof typeof before)[])
      .filter((key) => before[key] !== after[key])
      .map((key) => [key, { before: before[key], after: after[key] }]),
  );
}

async function buildCandidates(
  rows: Awaited<ReturnType<typeof parseProductImportFile>>["rows"],
) {
  const [categories, materials] = await Promise.all([
    prisma.category.findMany({
      select: { id: true, name: true, nameNormalized: true, status: true },
    }),
    prisma.material.findMany({
      select: { id: true, name: true, nameNormalized: true, status: true },
    }),
  ]);
  const categoryByName = new Map(
    categories.map((item) => [item.nameNormalized, item]),
  );
  const materialByName = new Map(
    materials.map((item) => [item.nameNormalized, item]),
  );

  const candidates: Candidate[] = rows.map((row) => {
    const errors: RowError[] = [];
    const rawId = row.values.product_id.trim();
    const parsedId = rawId ? importJobIdSchema.safeParse(rawId) : null;
    if (parsedId && !parsedId.success)
      errors.push(error("product_id", "product_id 必须是有效 UUID"));

    const categoryName = row.values["分类"].trim();
    const materialName = row.values["材质"].trim();
    const category = categoryByName.get(normalizeName(categoryName));
    const material = materialByName.get(normalizeName(materialName));
    if (!category) errors.push(error("分类", "分类不存在"));
    else if (category.status !== "ACTIVE")
      errors.push(error("分类", "分类已停用"));
    if (!material) errors.push(error("材质", "材质不存在"));
    else if (material.status !== "ACTIVE")
      errors.push(error("材质", "材质已停用"));

    const statusText = row.values["状态"].trim();
    const status =
      statusText === "启用"
        ? "ENABLED"
        : statusText === "停用"
          ? "DISABLED"
          : null;
    if (!status) errors.push(error("状态", "状态只能填写“启用”或“停用”"));

    let normalized: NormalizedProductImport | null = null;
    if (category && material && status) {
      const result = createProductSchema.safeParse({
        sku: row.values.SKU,
        name: row.values["产品名称"],
        categoryId: category.id,
        materialId: material.id,
        status,
        notes: row.values["内部备注"],
      });
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push(error(issue.path[0]?.toString() ?? "row", issue.message));
        }
      } else {
        normalized = {
          ...result.data,
          categoryName: category.name,
          materialName: material.name,
        };
      }
    }
    return {
      rowNumber: row.rowNumber,
      productId: parsedId?.success ? parsedId.data : null,
      normalized,
      errors,
    };
  });

  const idCounts = new Map<string, number>();
  const skuCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.productId)
      idCounts.set(
        candidate.productId,
        (idCounts.get(candidate.productId) ?? 0) + 1,
      );
    const sku = candidate.normalized?.sku
      ? normalizeSku(candidate.normalized.sku)
      : null;
    if (sku) skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if (candidate.productId && (idCounts.get(candidate.productId) ?? 0) > 1) {
      candidate.errors.push(error("product_id", "同一文件中 product_id 重复"));
    }
    const sku = candidate.normalized?.sku
      ? normalizeSku(candidate.normalized.sku)
      : null;
    if (sku && (skuCounts.get(sku) ?? 0) > 1) {
      candidate.errors.push(error("SKU", "同一文件中 SKU 重复"));
    }
  }
  return candidates;
}

export async function previewProductImport(
  headers: Headers,
  input: { bytes: Buffer; filename: string },
) {
  const actor = await requireAdminFromHeaders(headers);
  const parsed = await parseProductImportFile(input);
  const candidates = await buildCandidates(parsed.rows);
  const ids = candidates.flatMap((row) =>
    row.productId ? [row.productId] : [],
  );
  const skus = candidates.flatMap((row) => {
    const sku = row.normalized?.sku ? normalizeSku(row.normalized.sku) : null;
    return sku ? [sku] : [];
  });
  const products = await prisma.product.findMany({
    where: { OR: [{ id: { in: ids } }, { skuNormalized: { in: skus } }] },
    include: productInclude,
  });
  const productById = new Map(products.map((product) => [product.id, product]));
  const productBySku = new Map(
    products.flatMap((product) =>
      product.skuNormalized ? [[product.skuNormalized, product] as const] : [],
    ),
  );

  const stagedRows = candidates.map((candidate) => {
    const current = candidate.productId
      ? productById.get(candidate.productId)
      : undefined;
    if (candidate.productId && !current) {
      candidate.errors.push(error("product_id", "产品不存在"));
    }
    const sku = candidate.normalized?.sku
      ? normalizeSku(candidate.normalized.sku)
      : null;
    const skuOwner = sku ? productBySku.get(sku) : undefined;
    if (!candidate.productId && skuOwner) {
      candidate.errors.push(error("SKU", "新建行的 SKU 已存在"));
    }
    if (
      candidate.productId &&
      skuOwner &&
      skuOwner.id !== candidate.productId
    ) {
      candidate.errors.push(error("SKU", "SKU 已被其他产品使用"));
    }
    if (candidate.errors.length || !candidate.normalized) {
      return {
        rowNumber: candidate.rowNumber,
        action: "ERROR" as const,
        targetProductId: current?.id ?? null,
        normalizedData: candidate.normalized ?? Prisma.DbNull,
        changes: Prisma.DbNull,
        errors: candidate.errors,
        targetUpdatedAtSnapshot: current?.updatedAt ?? null,
      };
    }
    if (!current) {
      return {
        rowNumber: candidate.rowNumber,
        action: "CREATE" as const,
        targetProductId: null,
        normalizedData: candidate.normalized,
        changes: Prisma.DbNull,
        errors: [],
        targetUpdatedAtSnapshot: null,
      };
    }
    const nextValues = productValues(candidate.normalized);
    const noChange = valuesEqual(productValues(current), nextValues);
    return {
      rowNumber: candidate.rowNumber,
      action: noChange ? ("NO_CHANGE" as const) : ("UPDATE" as const),
      targetProductId: current.id,
      normalizedData: candidate.normalized,
      changes: noChange
        ? Prisma.DbNull
        : previewChanges(current, candidate.normalized),
      errors: [],
      targetUpdatedAtSnapshot: current.updatedAt,
    };
  });
  const count = (action: (typeof stagedRows)[number]["action"]) =>
    stagedRows.filter((row) => row.action === action).length;
  const counts = {
    totalRows: stagedRows.length,
    createRows: count("CREATE"),
    updateRows: count("UPDATE"),
    noChangeRows: count("NO_CHANGE"),
    errorRows: count("ERROR"),
  };
  const checksumSha256 = createHash("sha256").update(input.bytes).digest("hex");

  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.importJob.create({
      data: {
        originalFilename: parsed.originalFilename,
        checksumSha256,
        createdByUserId: actor.userId,
        ...counts,
      },
    });
    for (let offset = 0; offset < stagedRows.length; offset += 500) {
      await tx.importRow.createMany({
        data: stagedRows.slice(offset, offset + 500).map((row) => ({
          jobId: created.id,
          ...row,
        })),
      });
    }
    return created;
  });
  return { ...job, counts };
}

async function requireOwnedJob(actorUserId: string, jobId: string) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, createdByUserId: actorUserId, type: "PRODUCT" },
  });
  if (!job) throw new ApplicationError("NOT_FOUND", "导入任务不存在");
  return job;
}

export async function getProductImportJob(
  headers: Headers,
  jobIdInput: unknown,
) {
  const actor = await requireAdminFromHeaders(headers);
  const jobId = parseInput(importJobIdSchema, jobIdInput);
  return requireOwnedJob(actor.userId, jobId);
}

export async function listProductImportRows(
  headers: Headers,
  jobIdInput: unknown,
  input: unknown,
) {
  const actor = await requireAdminFromHeaders(headers);
  const jobId = parseInput(importJobIdSchema, jobIdInput);
  const query = parseInput(importRowListSchema, input);
  await requireOwnedJob(actor.userId, jobId);
  const where: Prisma.ImportRowWhereInput = { jobId, action: query.action };
  const [items, total] = await Promise.all([
    prisma.importRow.findMany({
      where,
      orderBy: { rowNumber: "asc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.importRow.count({ where }),
  ]);
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function confirmProductImport(
  headers: Headers,
  jobIdInput: unknown,
) {
  const actor = await requireAdminFromHeaders(headers);
  const jobId = parseInput(importJobIdSchema, jobIdInput);
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ImportJob" WHERE "id" = ${jobId}::uuid FOR UPDATE`;
        const job = await tx.importJob.findFirst({
          where: { id: jobId, createdByUserId: actor.userId, type: "PRODUCT" },
        });
        if (!job) throw new ApplicationError("NOT_FOUND", "导入任务不存在");
        if (job.status !== "PREVIEW_READY") {
          throw new ApplicationError("CONFLICT", "该导入任务已经确认");
        }
        if (job.errorRows > 0) {
          throw new ApplicationError("CONFLICT", "导入预览包含错误，不能确认");
        }
        const rows = await tx.importRow.findMany({
          where: { jobId },
          orderBy: { rowNumber: "asc" },
        });
        if (rows.length !== job.totalRows)
          throw new Error("Import staging row count mismatch");

        const targetIds = [
          ...new Set(
            rows.flatMap((row) =>
              row.targetProductId ? [row.targetProductId] : [],
            ),
          ),
        ].sort();
        if (targetIds.length) {
          const values = Prisma.join(
            targetIds.map((id) => Prisma.sql`${id}::uuid`),
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "Product" WHERE "id" IN (${values}) ORDER BY "id" FOR UPDATE`,
          );
        }
        const currentProducts = await tx.product.findMany({
          where: { id: { in: targetIds } },
          include: productInclude,
        });
        const currentById = new Map(
          currentProducts.map((product) => [product.id, product]),
        );
        const resolvedProducts: Array<{ rowId: string; productId: string }> =
          [];

        for (const row of rows) {
          const normalized = normalizedProductImportSchema.parse(
            row.normalizedData,
          );
          if (row.action === "CREATE") {
            const created = await createProductInTransaction(
              tx,
              actor,
              mutationValues(normalized),
            );
            resolvedProducts.push({ rowId: row.id, productId: created.id });
            continue;
          }
          if (
            row.action === "ERROR" ||
            !row.targetProductId ||
            !row.targetUpdatedAtSnapshot
          ) {
            throw new Error("Invalid persisted import row state");
          }
          const current = currentById.get(row.targetProductId);
          if (
            !current ||
            current.updatedAt.getTime() !==
              row.targetUpdatedAtSnapshot.getTime()
          ) {
            throw new ApplicationError(
              "CONFLICT",
              `第 ${row.rowNumber} 行产品已在预览后更新，请重新预览`,
            );
          }
          if (row.action === "NO_CHANGE") {
            if (
              !valuesEqual(productValues(current), productValues(normalized))
            ) {
              throw new ApplicationError(
                "CONFLICT",
                `第 ${row.rowNumber} 行产品已在预览后更新，请重新预览`,
              );
            }
            resolvedProducts.push({
              rowId: row.id,
              productId: current.id,
            });
            continue;
          }
          const updated = await updateProductInTransaction(
            tx,
            actor,
            current,
            mutationValues(normalized),
          );
          resolvedProducts.push({ rowId: row.id, productId: updated.id });
        }
        if (resolvedProducts.length !== rows.length) {
          throw new Error("Import resolution row count mismatch");
        }
        const resolvedValues = Prisma.join(
          resolvedProducts.map(
            ({ rowId, productId }) =>
              Prisma.sql`(${rowId}::uuid, ${productId}::uuid)`,
          ),
        );
        await tx.$executeRaw(
          Prisma.sql`UPDATE "ImportRow" AS row
            SET "resolvedProductId" = resolved."productId"
            FROM (VALUES ${resolvedValues}) AS resolved("rowId", "productId")
            WHERE row."id" = resolved."rowId"`,
        );
        return tx.importJob.update({
          where: { id: job.id },
          data: { status: "CONFIRMED", confirmedAt: new Date() },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 120_000,
      },
    );
  } catch (caught) {
    if (isUniqueConstraintError(caught)) {
      throw new ApplicationError(
        "CONFLICT",
        "SKU 已被其他操作占用，请重新预览",
      );
    }
    throw caught;
  }
}
