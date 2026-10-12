import { z } from "zod";

import { ApplicationError } from "@/lib/application/errors";

export const idSchema = z.uuid("记录 ID 无效");

export const dictionaryStatusSchema = z.enum(["ACTIVE", "DISABLED"], {
  error: "状态无效",
});

export const productStatusSchema = z.enum(["ENABLED", "DISABLED"], {
  error: "状态无效",
});

export const nameSchema = z
  .string({ error: "名称不能为空" })
  .trim()
  .min(1, "名称不能为空")
  .max(160, "名称不能超过 160 个字符");

export const notesSchema = z
  .string()
  .trim()
  .max(5000, "备注不能超过 5000 个字符")
  .optional()
  .nullable()
  .transform((value) => value || null);

export const pageSchema = z.coerce.number().int().min(1).default(1);
export const pageSizeSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20);

export function normalizeName(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApplicationError(
      "VALIDATION",
      result.error.issues[0]?.message ?? "提交的数据无效",
    );
  }
  return result.data;
}
