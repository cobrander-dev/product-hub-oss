import { z } from "zod";

import { idSchema, productStatusSchema } from "@/features/master-data/shared";

const optionalDate = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.date().optional(),
);

export const exportFormatSchema = z.enum(["csv", "xlsx"]);

export const productExportSchema = z
  .object({
    search: z.string().trim().max(160).optional().default(""),
    status: productStatusSchema.optional(),
    categoryId: idSchema.optional(),
    materialId: idSchema.optional(),
    sortBy: z.enum(["updatedAt", "name", "sku"]).default("updatedAt"),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
    hasMainImage: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const quoteExportSchema = z
  .object({
    search: z.string().trim().max(160).optional().default(""),
    factoryId: idSchema.optional(),
    productId: idSchema.optional(),
    assignmentStatus: z.enum(["ACTIVE", "REVOKED"]).optional(),
    quoteStatus: z.enum(["PENDING", "SUBMITTED"]).optional(),
    submittedFrom: optionalDate,
    submittedTo: optionalDate,
    updatedFrom: optionalDate,
    updatedTo: optionalDate,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.submittedFrom &&
      value.submittedTo &&
      value.submittedFrom > value.submittedTo
    ) {
      context.addIssue({ code: "custom", message: "提交时间范围无效" });
    }
    if (
      value.updatedFrom &&
      value.updatedTo &&
      value.updatedFrom > value.updatedTo
    ) {
      context.addIssue({ code: "custom", message: "更新时间范围无效" });
    }
  });
