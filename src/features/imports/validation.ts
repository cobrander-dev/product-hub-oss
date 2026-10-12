import { z } from "zod";

import { idSchema, pageSchema } from "@/features/master-data/shared";

export const IMPORT_HEADERS = [
  "product_id",
  "SKU",
  "产品名称",
  "分类",
  "材质",
  "状态",
  "内部备注",
] as const;

export type ImportHeader = (typeof IMPORT_HEADERS)[number];

export const importJobIdSchema = idSchema;

export const importRowListSchema = z
  .object({
    page: pageSchema,
    pageSize: z.coerce.number().int().min(1).max(200).default(100),
    action: z.enum(["CREATE", "UPDATE", "NO_CHANGE", "ERROR"]).optional(),
  })
  .strict();

export const normalizedProductImportSchema = z
  .object({
    sku: z.string().nullable(),
    name: z.string(),
    categoryId: z.uuid(),
    categoryName: z.string(),
    materialId: z.uuid(),
    materialName: z.string(),
    status: z.enum(["ENABLED", "DISABLED"]),
    notes: z.string().nullable(),
  })
  .strict();

export type NormalizedProductImport = z.infer<
  typeof normalizedProductImportSchema
>;
