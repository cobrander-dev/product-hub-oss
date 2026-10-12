"use server";

import { headers } from "next/headers";

import {
  createMaterial,
  setMaterialStatus,
  updateMaterial,
} from "@/features/materials/service";
import { toSafeActionError } from "@/lib/application/errors";

async function run(operation: (requestHeaders: Headers) => Promise<unknown>) {
  try {
    return { ok: true as const, data: await operation(await headers()) };
  } catch (error) {
    return toSafeActionError(error);
  }
}

export async function createMaterialAction(input: unknown) {
  return run((requestHeaders) => createMaterial(requestHeaders, input));
}

export async function updateMaterialAction(input: unknown) {
  return run((requestHeaders) => updateMaterial(requestHeaders, input));
}

export async function setMaterialStatusAction(input: unknown) {
  return run((requestHeaders) => setMaterialStatus(requestHeaders, input));
}
