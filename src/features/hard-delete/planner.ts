import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";

import { canonicalSha256 } from "@/features/hard-delete/canonical";
import {
  databasePlanSchema,
  type AuthorizedHardDeleteTargetType,
  type HardDeleteInternalPreview,
} from "@/features/hard-delete/types";
import { prisma } from "@/lib/db/prisma";
import type { StorageProvider } from "@/lib/storage/provider";

type Database = Pick<
  typeof prisma,
  "$queryRaw" | "storedObject" | "hardDeleteFileTask"
>;

export async function readDatabasePlan(
  targetType: AuthorizedHardDeleteTargetType,
  targetId: string,
  database: Database = prisma,
) {
  const rows = await database.$queryRaw<Array<{ plan: unknown }>>(Prisma.sql`
    SELECT public.plan_hard_delete(
      CAST(${targetType} AS public."HardDeleteTargetType"),
      ${targetId}
    ) AS plan
  `);
  return databasePlanSchema.parse(rows[0]?.plan);
}

export async function readStorageConsistency(
  storage: StorageProvider,
  database: Database = prisma,
) {
  const [physicalKeys, storedObjects, pendingTasks] = await Promise.all([
    storage.listKeys(),
    database.storedObject.findMany({ select: { storageKey: true } }),
    database.hardDeleteFileTask.findMany({
      where: { status: { not: "DELETED" } },
      select: { storageKey: true },
    }),
  ]);
  const storedKeys = new Set(storedObjects.map((item) => item.storageKey));
  const pendingKeys = new Set(pendingTasks.map((item) => item.storageKey));
  const physical = new Set(physicalKeys);
  return {
    unknownFileKeys: physicalKeys
      .filter((key) => !storedKeys.has(key) && !pendingKeys.has(key))
      .sort(),
    missingStoredObjectKeys: [...storedKeys]
      .filter((key) => !physical.has(key) && !pendingKeys.has(key))
      .sort(),
  };
}

export async function buildHardDeletePreview(
  targetType: AuthorizedHardDeleteTargetType,
  targetId: string,
  storage: StorageProvider,
  database: Database = prisma,
) {
  const databasePlan = await readDatabasePlan(targetType, targetId, database);
  const [fileState, consistency] = await Promise.all([
    Promise.all(
      databasePlan.files.map(async (file) => {
        const fileStat = await storage.stat(file.storageKey);
        const actualChecksumSha256 = fileStat
          ? createHash("sha256")
              .update(await storage.read(file.storageKey))
              .digest("hex")
          : null;
        return {
          storedObjectId: file.storedObjectId,
          exists: fileStat !== null,
          actualSizeBytes: fileStat?.sizeBytes ?? null,
          actualChecksumSha256,
          expectedSizeBytes: file.sizeBytes,
          checksumSha256: file.checksumSha256,
        };
      }),
    ),
    readStorageConsistency(storage, database),
  ]);
  fileState.sort((left, right) =>
    left.storedObjectId.localeCompare(right.storedObjectId),
  );
  const preview: HardDeleteInternalPreview = {
    schemaVersion: 2,
    databasePlan,
    fileState,
    consistency,
  };
  return { preview, previewSha256: canonicalSha256(preview) };
}

export function safePreviewSummary(preview: HardDeleteInternalPreview) {
  const counts = Object.fromEntries(
    Object.entries(preview.databasePlan.delete).map(([name, ids]) => [
      name,
      ids.length,
    ]),
  );
  return {
    target: preview.databasePlan.target,
    blockers: preview.databasePlan.blockers,
    counts,
    fileCount: preview.fileState.length,
    preservation: Object.fromEntries(
      Object.entries(preview.databasePlan.preserve).map(([name, items]) => [
        name,
        Array.isArray(items) ? items.length : 0,
      ]),
    ),
  };
}
