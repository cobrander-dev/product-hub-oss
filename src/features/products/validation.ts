import { z } from "zod";

import {
  idSchema,
  nameSchema,
  notesSchema,
  pageSchema,
  pageSizeSchema,
  productStatusSchema,
} from "@/features/master-data/shared";

const skuSchema = z
  .string()
  .trim()
  .max(100, "SKU 不能超过 100 个字符")
  .optional()
  .nullable()
  .transform((value) => value || null);

export const createProductSchema = z.object({
  sku: skuSchema,
  name: nameSchema,
  categoryId: idSchema,
  materialId: idSchema,
  status: productStatusSchema.default("ENABLED"),
  notes: notesSchema,
});

export const updateProductSchema = createProductSchema.extend({ id: idSchema });

export const setProductStatusSchema = z.object({
  id: idSchema,
  status: productStatusSchema,
});

export const productListSchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
  search: z.string().trim().max(160).optional().default(""),
  status: productStatusSchema.optional(),
  categoryId: idSchema.optional(),
  materialId: idSchema.optional(),
  sortBy: z.enum(["updatedAt", "name", "sku"]).default("updatedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
});

export function normalizeSku(value: string | null) {
  return value?.toLocaleUpperCase("en-US") ?? null;
}
