"use server";

import { headers } from "next/headers";

import {
  createFactory,
  setFactoryStatus,
  updateFactory,
} from "@/features/factories/service";
import { toSafeActionError } from "@/lib/application/errors";

async function run(operation: (requestHeaders: Headers) => Promise<unknown>) {
  try {
    return { ok: true as const, data: await operation(await headers()) };
  } catch (error) {
    return toSafeActionError(error);
  }
}

export async function createFactoryAction(input: unknown) {
  return run((requestHeaders) => createFactory(requestHeaders, input));
}

export async function updateFactoryAction(input: unknown) {
  return run((requestHeaders) => updateFactory(requestHeaders, input));
}

export async function setFactoryStatusAction(input: unknown) {
  return run((requestHeaders) => setFactoryStatus(requestHeaders, input));
}
