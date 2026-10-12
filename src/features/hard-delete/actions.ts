"use server";
import { headers } from "next/headers";
import { createHardDeletePreview, confirmHardDelete } from "./service";
import { toSafeActionError } from "@/lib/application/errors";
export async function previewHardDeleteAction(input: unknown) {
  try {
    return {
      ok: true as const,
      data: await createHardDeletePreview(await headers(), input),
    };
  } catch (error) {
    return toSafeActionError(error);
  }
}
export async function confirmHardDeleteAction(input: unknown) {
  try {
    return {
      ok: true as const,
      data: await confirmHardDelete(await headers(), input),
    };
  } catch (error) {
    return toSafeActionError(error);
  }
}
