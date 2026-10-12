import { z } from "zod";

import {
  idSchema,
  pageSchema,
  pageSizeSchema,
} from "@/features/master-data/shared";

export const assignProductSchema = z.object({
  productId: idSchema,
  factoryId: idSchema,
});

export const assignmentIdSchema = z.object({ assignmentId: idSchema });

export const listFactoriesForProductSchema = z.object({
  productId: idSchema,
  page: pageSchema,
  pageSize: pageSizeSchema,
  search: z.string().trim().max(160).optional().default(""),
  status: z.enum(["ACTIVE", "REVOKED"]).optional(),
});

export const listProductsForFactorySchema = z.object({
  factoryId: idSchema,
  page: pageSchema,
  pageSize: pageSizeSchema,
  search: z.string().trim().max(160).optional().default(""),
  status: z.enum(["ACTIVE", "REVOKED"]).optional(),
});

export const factoryProductListSchema = z
  .object({
    page: pageSchema,
    pageSize: pageSizeSchema,
    search: z.string().trim().max(160).optional().default(""),
    categoryId: idSchema.optional(),
    materialId: idSchema.optional(),
  })
  .strict();
