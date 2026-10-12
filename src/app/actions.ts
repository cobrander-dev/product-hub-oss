"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth/auth";
import { getAuthContextFromHeaders } from "@/lib/auth/context";
import { recordAuthSecurityEvent } from "@/lib/auth/security-log";

export async function logoutAction() {
  const requestHeaders = await headers();
  const actor = await getAuthContextFromHeaders(requestHeaders);
  await auth.api.signOut({ headers: requestHeaders });
  recordAuthSecurityEvent({
    type: "logout",
    result: "success",
    actorId: actor?.userId,
    factoryId: actor?.factoryId ?? undefined,
  });
  redirect("/login");
}
