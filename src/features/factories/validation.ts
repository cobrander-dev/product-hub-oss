import { z } from "zod";

import {
  idSchema,
  nameSchema,
  notesSchema,
  pageSchema,
  pageSizeSchema,
} from "@/features/master-data/shared";

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label}不能超过 ${max} 个字符`)
    .optional()
    .nullable()
    .transform((value) => value || null);

export const createFactorySchema = z.object({
  name: nameSchema,
  contactName: optionalText("联系人", 100),
  phone: optionalText("电话", 50),
  notes: notesSchema,
});

export const updateFactorySchema = createFactorySchema.extend({ id: idSchema });

export const setFactoryStatusSchema = z.object({
  id: idSchema,
  status: z.enum(["ACTIVE", "DISABLED"], { error: "状态无效" }),
});

export const factoryListSchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
  search: z.string().trim().max(160).optional().default(""),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});
