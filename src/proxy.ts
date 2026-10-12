import { NextResponse, type NextRequest } from "next/server";

import {
  isTrustedProductionRequest,
  resolveProductionDeploymentOrigin,
} from "@/lib/deployment-origin";

export function proxy(request: NextRequest) {
  const deployment = resolveProductionDeploymentOrigin();
  if (!deployment) return NextResponse.next();

  const headers = request.headers;
  if (
    !isTrustedProductionRequest(
      {
        host: headers.get("host"),
        forwardedHost: headers.get("x-forwarded-host"),
        forwardedProto: headers.get("x-forwarded-proto"),
        forwarded: headers.get("forwarded"),
        origin: headers.get("origin"),
        method: request.method,
        pathname: request.nextUrl.pathname,
      },
      deployment,
    )
  ) {
    return new NextResponse(null, { status: 403 });
  }

  return NextResponse.next();
}
