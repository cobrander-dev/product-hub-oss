"use server";

import { headers } from "next/headers";

import {
  createCategory,
  setCategoryStatus,
  updateCategory,
} from "@/features/categories/service";
import { toSafeActionError } from "@/lib/application/errors";

async function run(operation: (requestHeaders: Headers) => Promise<unknown>) {
  try {
    return { ok: true as const, data: await operation(await headers()) };
  } catch (error) {
    return toSafeActionError(error);
  }
}

export async function createCategoryAction(input: unknown) {
  return run((requestHeaders) => createCategory(requestHeaders, input));
}

export async function updateCategoryAction(input: unknown) {
  return run((requestHeaders) => updateCategory(requestHeaders, input));
}

export async function setCategoryStatusAction(input: unknown) {
  return run((requestHeaders) => setCategoryStatus(requestHeaders, input));
}
