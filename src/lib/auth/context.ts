import { cache } from "react";
import { headers as nextHeaders } from "next/headers";

import {
  AuthorizationError,
  getAuthContextFromHeaders,
} from "@/lib/auth/context-core";

export * from "@/lib/auth/context-core";

export const getAuthContext = cache(async () => {
  return getAuthContextFromHeaders(await nextHeaders());
});

export async function requireUser() {
  const actor = await getAuthContext();
  if (!actor) {
    throw new AuthorizationError("UNAUTHENTICATED");
  }
  return actor;
}

export async function requireAdmin() {
  const actor = await requireUser();
  if (actor.role !== "ADMIN") {
    throw new AuthorizationError("FORBIDDEN");
  }
  return actor;
}

export async function requireFactoryUser() {
  const actor = await requireUser();
  if (actor.role !== "FACTORY") {
    throw new AuthorizationError("FORBIDDEN");
  }
  return actor;
}
