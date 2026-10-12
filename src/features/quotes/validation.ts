import { z } from "zod";

import {
  idSchema,
  pageSchema,
  pageSizeSchema,
} from "@/features/master-data/shared";
import { ApplicationError } from "@/lib/application/errors";

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

const nullableText = z
  .string()
  .trim()
  .max(5000, "厂家备注不能超过 5000 个字符")
  .optional()
  .nullable()
  .transform((value) => value || null);

function optionalPositiveInteger(label: string) {
  return z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.coerce
      .number({ error: `${label}必须是正整数` })
      .int(`${label}必须是正整数`)
      .positive(`${label}必须大于 0`)
      .max(2_147_483_647, `${label}超出允许范围`)
      .optional(),
  );
}

function optionalPositiveDecimal(label: string) {
  return z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z
      .string({ error: `${label}格式无效` })
      .trim()
      .regex(/^\d{1,9}(?:\.\d{1,3})?$/, `${label}最多保留 3 位小数`)
      .refine((value) => !/^0+(?:\.0+)?$/.test(value), `${label}必须大于 0`)
      .optional(),
  );
}

export const quoteValuesSchema = z
  .object({
    price: z
      .string({ error: "价格不能为空" })
      .trim()
      .regex(/^\d+(?:\.\d{1,2})?$/, "价格最多保留 2 位小数"),
    moq: optionalPositiveInteger("MOQ"),
    packingLengthCm: optionalPositiveDecimal("包装长度"),
    packingWidthCm: optionalPositiveDecimal("包装宽度"),
    packingHeightCm: optionalPositiveDecimal("包装高度"),
    netWeightKg: optionalPositiveDecimal("净重"),
    grossWeightKg: optionalPositiveDecimal("毛重"),
    pcsPerCarton: optionalPositiveInteger("每箱数量"),
    factoryNotes: nullableText,
  })
  .strict();

export const submitQuoteSchema = quoteValuesSchema.extend({
  assignmentId: idSchema,
  expectedVersion: z
    .number({ error: "报价版本无效" })
    .int("报价版本无效")
    .positive("报价版本无效")
    .optional()
    .nullable(),
});

export const quoteIdSchema = z.object({ quoteId: idSchema });

export const historyListSchema = z.object({
  quoteId: idSchema,
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export const adminQuoteListSchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
  search: z.string().trim().max(160).optional().default(""),
  productId: idSchema.optional(),
  factoryId: idSchema.optional(),
});

export function parsePriceToCents(price: string) {
  const [yuan, fraction = ""] = price.split(".");
  const cents = BigInt(yuan!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n) {
    throw new ApplicationError("VALIDATION", "价格必须大于 0");
  }
  if (cents > POSTGRES_BIGINT_MAX) {
    throw new ApplicationError("VALIDATION", "价格超出允许范围");
  }
  return cents;
}
