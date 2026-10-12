import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/db/prisma";
import { parseServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const env = parseServerEnv();
    if (env.STORAGE_DRIVER !== "local" || !env.LOCAL_STORAGE_ROOT) {
      throw new Error("Storage is not configured");
    }
    const objectsDirectory = path.join(env.LOCAL_STORAGE_ROOT, "objects");
    await Promise.all([
      prisma.$queryRaw`SELECT 1`,
      mkdir(objectsDirectory, { recursive: true, mode: 0o750 }).then(() =>
        access(objectsDirectory, constants.R_OK | constants.W_OK),
      ),
    ]);
    return Response.json({ status: "ok" }, { status: 200, headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
