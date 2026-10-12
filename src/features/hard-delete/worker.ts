import { hardDeleteSecurityEvent } from "./security-event";
import { createHash } from "node:crypto";

import { Client } from "pg";
import { z } from "zod";

import { canonicalSha256 } from "@/features/hard-delete/canonical";
import {
  databasePlanSchema,
  type HardDeleteInternalPreview,
} from "@/features/hard-delete/types";
import type { StorageProvider } from "@/lib/storage/provider";

const claimSchema = z.object({
  claimed: z.boolean(),
  reason: z.string().optional(),
  operationId: z.string().uuid().optional(),
  status: z.enum(["EXECUTING", "FILES_PENDING"]).optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  preview: z.unknown().optional(),
  previewSha256: z.string().optional(),
  leaseToken: z.string().uuid().optional(),
  attempts: z.number().optional(),
});

const taskClaimSchema = z.object({
  claimed: z.boolean(),
  taskId: z.string().uuid().optional(),
  storageProvider: z.literal("LOCAL").optional(),
  storageKey: z.string().optional(),
  leaseToken: z.string().uuid().optional(),
  attempts: z.number().optional(),
  remainingTasks: z.number().optional(),
});

const internalPreviewSchema = z.object({
  schemaVersion: z.literal(2),
  databasePlan: databasePlanSchema,
  fileState: z.array(z.unknown()),
  consistency: z.object({
    unknownFileKeys: z.array(z.string()),
    missingStoredObjectKeys: z.array(z.string()),
  }),
});

export type HardDeleteFaultPoint =
  | "BEFORE_DATABASE_EXECUTION"
  | "AFTER_DATABASE_COMMIT"
  | "AFTER_FILE_DELETE"
  | "AFTER_ALL_FILES"
  | "AFTER_FINALIZE";

export class SimulatedHardDeleteCrash extends Error {
  constructor(point: HardDeleteFaultPoint) {
    super(`Simulated hard delete crash at ${point}`);
    this.name = "SimulatedHardDeleteCrash";
  }
}

type WorkerOptions = {
  operationId?: string;
  workerDatabaseUrl: string;
  workerId: string;
  storage: StorageProvider;
  leaseSeconds?: number;
  retryDelaySeconds?: number;
  faultInjector?: (point: HardDeleteFaultPoint) => void | Promise<void>;
};

async function queryJson(client: Client, text: string, values: unknown[]) {
  const result = await client.query<{ result: unknown }>(text, values);
  return result.rows[0]?.result;
}

async function buildWorkerPreview(
  client: Client,
  targetType: string,
  targetId: string,
  storage: StorageProvider,
) {
  const planResult = await client.query<{ plan: unknown }>(
    `SELECT public.plan_hard_delete($1::public."HardDeleteTargetType", $2) AS plan`,
    [targetType, targetId],
  );
  const databasePlan = databasePlanSchema.parse(planResult.rows[0]?.plan);
  const catalogResult = await client.query<{ catalog: unknown }>(
    "SELECT public.hard_delete_storage_catalog() AS catalog",
  );
  const catalog = z
    .object({
      storedKeys: z.array(z.string()),
      pendingKeys: z.array(z.string()),
    })
    .parse(catalogResult.rows[0]?.catalog);
  const physicalKeys = await storage.listKeys();
  const physical = new Set(physicalKeys);
  const stored = new Set(catalog.storedKeys);
  const pending = new Set(catalog.pendingKeys);
  const fileState = await Promise.all(
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
  );
  fileState.sort((left, right) =>
    left.storedObjectId.localeCompare(right.storedObjectId),
  );
  const preview: HardDeleteInternalPreview = {
    schemaVersion: 2,
    databasePlan,
    fileState,
    consistency: {
      unknownFileKeys: physicalKeys
        .filter((key) => !stored.has(key) && !pending.has(key))
        .sort(),
      missingStoredObjectKeys: catalog.storedKeys
        .filter((key) => !physical.has(key) && !pending.has(key))
        .sort(),
    },
  };
  return preview;
}

export async function runHardDeleteOperation(options: WorkerOptions) {
  const requestedOperationId = options.operationId
    ? z.string().uuid().parse(options.operationId)
    : null;
  const workerId = z.string().trim().min(1).max(100).parse(options.workerId);
  const leaseSeconds = z
    .number()
    .int()
    .min(1)
    .max(300)
    .parse(options.leaseSeconds ?? 30);
  const retryDelaySeconds = z
    .number()
    .int()
    .min(1)
    .max(86400)
    .parse(options.retryDelaySeconds ?? 30);
  const client = new Client({ connectionString: options.workerDatabaseUrl });
  await client.connect();
  try {
    const claimed = claimSchema.parse(
      requestedOperationId
        ? await queryJson(
            client,
            "SELECT public.claim_hard_delete_operation($1::uuid,$2,$3) AS result",
            [requestedOperationId, workerId, leaseSeconds],
          )
        : await queryJson(
            client,
            "SELECT public.claim_next_hard_delete_operation($1,$2) AS result",
            [workerId, leaseSeconds],
          ),
    );
    if (!claimed.claimed) {
      return {
        operationId: requestedOperationId,
        status: "NOT_CLAIMED" as const,
        reason: claimed.reason ?? "UNKNOWN",
      };
    }
    if (!claimed.leaseToken || !claimed.status || !claimed.preview) {
      throw new Error("Worker claim returned incomplete data");
    }
    if (!claimed.operationId)
      throw new Error("Worker claim omitted operation ID");
    const operationId = claimed.operationId;
    const leaseToken = claimed.leaseToken;
    const emit = (status: string) =>
      hardDeleteSecurityEvent(
        operationId,
        claimed.targetType ?? "UNKNOWN",
        claimed.targetId ?? operationId,
        status,
      );
    emit(claimed.status);
    const preview = internalPreviewSchema.parse(
      claimed.preview,
    ) as HardDeleteInternalPreview;

    if (claimed.status === "EXECUTING") {
      if (!claimed.targetType || !claimed.targetId || !claimed.previewSha256) {
        throw new Error("Worker claim omitted planner identity");
      }
      const fresh = await buildWorkerPreview(
        client,
        claimed.targetType,
        claimed.targetId,
        options.storage,
      );
      if (canonicalSha256(fresh) !== claimed.previewSha256) {
        await client.query(
          "SELECT public.fail_hard_delete_operation($1::uuid,$2::uuid,'STALE_PREVIEW','目标、依赖或文件状态已变化')",
          [operationId, leaseToken],
        );
        emit("FAILED");
        return {
          operationId,
          status: "FAILED" as const,
          failureCode: "STALE_PREVIEW",
        };
      }
      await options.faultInjector?.("BEFORE_DATABASE_EXECUTION");
      await client.query(
        "SELECT public.execute_confirmed_hard_delete($1::uuid,$2,$3::uuid)",
        [operationId, claimed.previewSha256, leaseToken],
      );
      await options.faultInjector?.("AFTER_DATABASE_COMMIT");
    }

    let deletedFiles = 0;
    while (true) {
      await client.query(
        "SELECT public.renew_hard_delete_operation_lease($1::uuid,$2::uuid,$3)",
        [operationId, leaseToken, leaseSeconds],
      );
      const task = taskClaimSchema.parse(
        await queryJson(
          client,
          "SELECT public.claim_hard_delete_file_task($1::uuid,$2::uuid,$3,$4) AS result",
          [operationId, leaseToken, workerId, leaseSeconds],
        ),
      );
      if (!task.claimed) {
        if ((task.remainingTasks ?? 0) > 0) {
          emit("FILES_PENDING");
          return {
            operationId,
            status: "FILES_PENDING" as const,
            deletedFiles,
          };
        }
        break;
      }
      if (!task.taskId || !task.storageKey || !task.leaseToken) {
        throw new Error("File task claim returned incomplete data");
      }
      try {
        await options.storage.delete(task.storageKey);
        await options.faultInjector?.("AFTER_FILE_DELETE");
        if ((await options.storage.stat(task.storageKey)) !== null) {
          throw new Error("File remained after deletion");
        }
        await client.query(
          "SELECT public.complete_hard_delete_file_task($1::uuid,$2::uuid)",
          [task.taskId, task.leaseToken],
        );
        deletedFiles += 1;
      } catch (error) {
        if (error instanceof SimulatedHardDeleteCrash) throw error;
        await client.query(
          "SELECT public.retry_hard_delete_file_task($1::uuid,$2::uuid,'STORAGE_DELETE_FAILED','文件删除或复核失败',$3)",
          [task.taskId, task.leaseToken, retryDelaySeconds],
        );
        emit("FILES_PENDING");
        return { operationId, status: "FILES_PENDING" as const, deletedFiles };
      }
    }

    await options.faultInjector?.("AFTER_ALL_FILES");
    const physicalKeys = await options.storage.listKeys();
    const baselineUnknown = new Set(preview.consistency.unknownFileKeys);
    const candidateKeys = new Set(
      preview.databasePlan.files.map((file) => file.storageKey),
    );
    const filesAbsent = [...candidateKeys].every(
      (key) => !physicalKeys.includes(key),
    );
    const catalogResult = await client.query<{ catalog: unknown }>(
      "SELECT public.hard_delete_storage_catalog() AS catalog",
    );
    const catalog = z
      .object({
        storedKeys: z.array(z.string()),
        pendingKeys: z.array(z.string()),
      })
      .parse(catalogResult.rows[0]?.catalog);
    const known = new Set([...catalog.storedKeys, ...catalog.pendingKeys]);
    const unknownNow = physicalKeys.filter((key) => !known.has(key));
    const noNewUnknownOrphans = unknownNow.every((key) =>
      baselineUnknown.has(key),
    );
    if (!filesAbsent || !noNewUnknownOrphans) {
      emit("FILES_PENDING");
      return { operationId, status: "FILES_PENDING" as const, deletedFiles };
    }
    await client.query(
      "SELECT public.complete_hard_delete_operation($1::uuid,$2::uuid,$3::jsonb)",
      [
        operationId,
        leaseToken,
        JSON.stringify({
          filesAbsent,
          noNewUnknownOrphans,
          checkedAt: new Date().toISOString(),
        }),
      ],
    );
    await options.faultInjector?.("AFTER_FINALIZE");
    emit("COMPLETED");
    return { operationId, status: "COMPLETED" as const, deletedFiles };
  } finally {
    await client.end();
  }
}
