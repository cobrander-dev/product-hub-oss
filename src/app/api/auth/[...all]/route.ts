import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth/auth";
import { getAuthContextFromHeaders } from "@/lib/auth/context-core";
import { recordAuthSecurityEvent } from "@/lib/auth/security-log";
import { parseAuthEnv } from "@/lib/env";

export const runtime = "nodejs";

const handler = toNextJsHandler(auth);
const trustedOrigins = new Set(parseAuthEnv().BETTER_AUTH_TRUSTED_ORIGINS);

function isUsernameSignIn(request: Request) {
  return new URL(request.url).pathname.endsWith("/sign-in/username");
}

async function sanitizeAuthResponse(response: Response) {
  const type = response.headers.get("content-type");
  if (!type?.includes("application/json")) {
    return response;
  }

  const payload = (await response.clone().json()) as unknown;
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          key === "email" ? [] : [[key, scrub(item)]],
        ),
      );
    }
    return value;
  };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(scrub(payload)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function GET(request: Request) {
  return sanitizeAuthResponse(await handler.GET(request));
}

export async function POST(request: Request) {
  const pathname = new URL(request.url).pathname;
  const origin = request.headers.get("origin");
  if (!origin || !trustedOrigins.has(origin)) {
    return Response.json(
      { message: "Request origin is not allowed." },
      { status: 403 },
    );
  }
  const actor = pathname.endsWith("/change-password")
    ? await getAuthContextFromHeaders(request.headers)
    : null;
  const response = await handler.POST(request);
  if (isUsernameSignIn(request)) {
    recordAuthSecurityEvent({
      type: response.ok ? "login_success" : "login_failure",
      result: response.ok ? "success" : "failure",
    });
  }
  if (pathname.endsWith("/change-password")) {
    recordAuthSecurityEvent({
      type: "password_change",
      result: response.ok ? "success" : "failure",
      actorId: actor?.userId,
      factoryId: actor?.factoryId ?? undefined,
    });
  }
  return sanitizeAuthResponse(response);
}
