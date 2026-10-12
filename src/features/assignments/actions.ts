"use server";

import { headers } from "next/headers";

import {
  assignProductToFactory,
  reactivateAssignment,
  revokeAssignment,
} from "@/features/assignments/service";
import { toSafeActionError } from "@/lib/application/errors";

async function run(operation: (requestHeaders: Headers) => Promise<unknown>) {
  try {
    return { ok: true as const, data: await operation(await headers()) };
  } catch (error) {
    return toSafeActionError(error);
  }
}

export async function assignProductToFactoryAction(input: unknown) {
  return run((requestHeaders) => assignProductToFactory(requestHeaders, input));
}

export async function revokeAssignmentAction(input: unknown) {
  return run((requestHeaders) => revokeAssignment(requestHeaders, input));
}

export async function reactivateAssignmentAction(input: unknown) {
  return run((requestHeaders) => reactivateAssignment(requestHeaders, input));
}
