import { Prisma } from "@/generated/prisma/client";

import {
  auditText,
  productLabel,
  writeUserActivity,
} from "@/features/activity/writer";
import { normalizeSku } from "@/features/products/validation";
import { ApplicationError } from "@/lib/application/errors";
import type { AdminActor } from "@/lib/auth/context-core";

export const productInclude = {
  category: { select: { id: true, name: true, status: true } },
  material: { select: { id: true, name: true, status: true } },
} satisfies Prisma.ProductInclude;

export type ProductMutationData = {
  sku: string | null;
  name: string;
  categoryId: string;
  materialId: string;
  status: "ENABLED" | "DISABLED";
  notes: string | null;
};

export async function requireActiveProductReferences(
  tx: Prisma.TransactionClient,
  categoryId: string,
  materialId: string,
) {
  const [category, material] = await Promise.all([
    tx.category.findFirst({ where: { id: categoryId, status: "ACTIVE" } }),
    tx.material.findFirst({ where: { id: materialId, status: "ACTIVE" } }),
  ]);
  if (!category) throw new ApplicationError("NOT_FOUND", "分类不存在或已停用");
  if (!material) throw new ApplicationError("NOT_FOUND", "材质不存在或已停用");
}

export async function createProductInTransaction(
  tx: Prisma.TransactionClient,
  actor: AdminActor,
  data: ProductMutationData,
) {
  await requireActiveProductReferences(tx, data.categoryId, data.materialId);
  const created = await tx.product.create({
    data: { ...data, skuNormalized: normalizeSku(data.sku) },
    include: productInclude,
  });
  await writeUserActivity(tx, {
    eventType: "PRODUCT_CREATED",
    actor,
    entityId: created.id,
    entityLabelSnapshot: productLabel(created),
    factoryId: null,
    before: {
      sku: null,
      name: null,
      categoryId: null,
      materialId: null,
      status: null,
      notes: null,
    },
    after: {
      sku: created.sku,
      name: created.name,
      categoryId: created.categoryId,
      materialId: created.materialId,
      status: created.status,
      notes: auditText(created.notes),
    },
    metadata: {},
  });
  return created;
}

export async function updateProductInTransaction(
  tx: Prisma.TransactionClient,
  actor: AdminActor,
  current: Prisma.ProductGetPayload<{ include: typeof productInclude }>,
  data: ProductMutationData,
) {
  await requireActiveProductReferences(tx, data.categoryId, data.materialId);
  const changed =
    current.sku !== data.sku ||
    current.name !== data.name ||
    current.categoryId !== data.categoryId ||
    current.materialId !== data.materialId ||
    current.status !== data.status ||
    current.notes !== data.notes;
  if (!changed) return current;

  const updated = await tx.product.update({
    where: { id: current.id },
    data: {
      sku: data.sku,
      skuNormalized: normalizeSku(data.sku),
      name: data.name,
      categoryId: data.categoryId,
      materialId: data.materialId,
      status: data.status,
      notes: data.notes,
    },
    include: productInclude,
  });
  await writeUserActivity(tx, {
    eventType: "PRODUCT_UPDATED",
    actor,
    entityId: updated.id,
    entityLabelSnapshot: productLabel(updated),
    factoryId: null,
    before: {
      sku: current.sku,
      name: current.name,
      categoryId: current.categoryId,
      materialId: current.materialId,
      notes: auditText(current.notes),
    },
    after: {
      sku: updated.sku,
      name: updated.name,
      categoryId: updated.categoryId,
      materialId: updated.materialId,
      notes: auditText(updated.notes),
    },
    metadata: {},
  });
  if (current.status !== updated.status) {
    await writeUserActivity(tx, {
      eventType:
        updated.status === "ENABLED" ? "PRODUCT_ENABLED" : "PRODUCT_DISABLED",
      actor,
      entityId: updated.id,
      entityLabelSnapshot: productLabel(updated),
      factoryId: null,
      before: { status: current.status },
      after: { status: updated.status },
      metadata: {},
    });
  }
  return updated;
}
