import { z } from "zod";

import {
  idSchema,
  pageSchema,
  pageSizeSchema,
} from "@/features/master-data/shared";

export const activityEventTypes = [
  "PRODUCT_CREATED",
  "PRODUCT_UPDATED",
  "PRODUCT_ENABLED",
  "PRODUCT_DISABLED",
  "CATEGORY_CREATED",
  "CATEGORY_UPDATED",
  "CATEGORY_ENABLED",
  "CATEGORY_DISABLED",
  "MATERIAL_CREATED",
  "MATERIAL_UPDATED",
  "MATERIAL_ENABLED",
  "MATERIAL_DISABLED",
  "FACTORY_CREATED",
  "FACTORY_UPDATED",
  "FACTORY_ENABLED",
  "FACTORY_DISABLED",
  "ASSIGNMENT_ASSIGNED",
  "ASSIGNMENT_REVOKED",
  "ASSIGNMENT_REACTIVATED",
  "QUOTE_SUBMITTED",
  "QUOTE_UPDATED",
  "PRODUCT_MAIN_IMAGE_SET",
  "PRODUCT_MAIN_IMAGE_REPLACED",
  "PRODUCT_MAIN_IMAGE_REMOVED",
  "FACTORY_PRIVATE_IMAGE_SET",
  "FACTORY_PRIVATE_IMAGE_REPLACED",
  "FACTORY_PRIVATE_IMAGE_REMOVED",
  "PRODUCT_MAIN_IMAGE_PROMOTED",
  "USER_CREATED",
  "USER_ENABLED",
  "USER_DISABLED",
] as const;

export const activityEntityTypes = [
  "PRODUCT",
  "CATEGORY",
  "MATERIAL",
  "FACTORY",
  "ASSIGNMENT",
  "QUOTE",
  "USER",
] as const;

const optionalDate = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .optional();

export const activityListSchema = z
  .object({
    page: pageSchema,
    pageSize: pageSizeSchema,
    eventType: z.enum(activityEventTypes).optional(),
    entityType: z.enum(activityEntityTypes).optional(),
    actorUserId: z.string().min(1).max(255).optional(),
    factoryId: idSchema.optional(),
    from: optionalDate,
    to: optionalDate,
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "开始时间不能晚于结束时间",
    path: ["from"],
  });
