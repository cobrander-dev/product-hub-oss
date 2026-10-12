"use server";

import { headers } from "next/headers";

import { submitOwnQuote } from "@/features/quotes/service";
import { toSafeActionError } from "@/lib/application/errors";

export async function submitOwnQuoteAction(input: unknown) {
  try {
    return {
      ok: true as const,
      data: await submitOwnQuote(await headers(), input),
    };
  } catch (error) {
    return toSafeActionError(error);
  }
}
