"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  createFactoryUser,
  resetFactoryUserPassword,
  setFactoryUserEnabled,
} from "@/lib/auth/accounts";
import { toSafeActionError } from "@/lib/application/errors";

const username = z
  .string()
  .trim()
  .min(3, "用户名至少 3 位")
  .max(30)
  .regex(/^[a-zA-Z0-9._-]+$/, "用户名只能包含字母、数字、点、下划线和连字符");
const password = z
  .string()
  .min(8, "密码至少 8 位")
  .max(128, "密码不能超过 128 位");
const createSchema = z.object({
  factoryId: z.string().uuid("请选择厂家"),
  username,
  password,
});
const resetSchema = z.object({
  userId: z.string().min(1),
  newPassword: password,
});
const statusSchema = z.object({
  userId: z.string().min(1),
  enabled: z.boolean(),
});

async function run(operation: (requestHeaders: Headers) => Promise<unknown>) {
  try {
    const data = await operation(await headers());
    revalidatePath("/admin/users");
    return { ok: true as const, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false as const,
        error: "VALIDATION" as const,
        message: error.issues[0]?.message ?? "提交的数据无效",
      };
    }
    return toSafeActionError(error);
  }
}

export async function createFactoryUserAction(input: unknown) {
  return run(async (requestHeaders) => {
    const value = createSchema.parse(input);
    return createFactoryUser(requestHeaders, {
      ...value,
      name: value.username,
    });
  });
}

export async function resetFactoryUserPasswordAction(input: unknown) {
  return run((requestHeaders) =>
    resetFactoryUserPassword(requestHeaders, resetSchema.parse(input)),
  );
}

export async function setFactoryUserEnabledAction(input: unknown) {
  return run((requestHeaders) =>
    setFactoryUserEnabled(requestHeaders, statusSchema.parse(input)),
  );
}
