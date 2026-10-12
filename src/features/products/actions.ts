"use server";

import { headers } from "next/headers";

import {
  createProduct,
  setProductStatus,
  updateProduct,
} from "@/features/products/service";
import { toSafeActionError } from "@/lib/application/errors";

async function run(operation: (requestHeaders: Headers) => Promise<unknown>) {
  try {
    return { ok: true as const, data: await operation(await headers()) };
  } catch (error) {
    return toSafeActionError(error);
  }
}

export async function createProductAction(input: unknown) {
  return run((requestHeaders) => createProduct(requestHeaders, input));
}

export async function updateProductAction(input: unknown) {
  return run((requestHeaders) => updateProduct(requestHeaders, input));
}

export async function setProductStatusAction(input: unknown) {
  return run((requestHeaders) => setProductStatus(requestHeaders, input));
}
