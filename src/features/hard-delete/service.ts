import { Prisma } from "@/generated/prisma/client";
import { z } from "zod";

import { parseInput } from "@/features/master-data/shared";
import {
  buildHardDeletePreview,
  safePreviewSummary,
} from "@/features/hard-delete/planner";
import {
  confirmHardDeleteSchema,
  createHardDeletePreviewSchema,
  type HardDeleteInternalPreview,
  type AuthorizedHardDeleteTargetType,
} from "@/features/hard-delete/types";
import { ApplicationError } from "@/lib/application/errors";
import {
  requireAdminFromHeaders,
  type AdminActor,
} from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";
import { getStorageProvider } from "@/lib/storage";
import type { StorageProvider } from "@/lib/storage/provider";

const STALE = "数据在确认期间发生了变化，请重新检查删除影响。";
async function phrase(
  target: { type: AuthorizedHardDeleteTargetType; id: string; label: string },
  database: Pick<typeof prisma, "product">,
) {
  if (target.type === "PRODUCT") {
    const product = await database.product.findUnique({
      where: { id: target.id },
      select: { sku: true },
    });
    if (!product) throw new ApplicationError("NOT_FOUND", "永久删除目标不存在");
    return `DELETE ${product.sku ?? target.id.slice(-8)}`;
  }
  if (target.type === "USER") return `DELETE ${target.label}`;
  if (["FACTORY", "CATEGORY", "MATERIAL"].includes(target.type))
    return `永久删除 ${target.label}`;
  return `DELETE ${target.id.slice(-8)}`;
}
function safeConflict(error: unknown): never {
  const adapterFailure = z
    .object({
      driverAdapterError: z
        .object({
          cause: z.object({
            originalCode: z.string().optional(),
            kind: z.string().optional(),
          }),
        })
        .optional(),
    })
    .safeParse(
      error instanceof Prisma.PrismaClientKnownRequestError
        ? error.meta
        : undefined,
    );
  const cause = adapterFailure.success
    ? adapterFailure.data.driverAdapterError?.cause
    : undefined;
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" ||
      error.code === "P2034" ||
      error.meta?.code === "40001" ||
      cause?.originalCode === "40001" ||
      cause?.kind === "TransactionWriteConflict")
  )
    throw new ApplicationError("CONFLICT", STALE);
  if (error instanceof Error && error.message.includes("target not found"))
    throw new ApplicationError("CONFLICT", STALE);
  throw error;
}

type Dependencies = {
  database?: typeof prisma;
  storage?: StorageProvider;
  now?: () => Date;
};

function dependencies(input: Dependencies) {
  return {
    database: input.database ?? prisma,
    storage: input.storage ?? getStorageProvider(),
    now: input.now ?? (() => new Date()),
  };
}

export async function createHardDeletePreviewForAdmin(
  actor: AdminActor,
  unsafeInput: unknown,
  injected: Dependencies = {},
) {
  const input = parseInput(createHardDeletePreviewSchema, unsafeInput);
  const dependency = dependencies(injected);
  const existing = await dependency.database.hardDeleteOperation.findFirst({
    where: {
      targetType: input.targetType,
      targetId: input.targetId,
      status: { in: ["CONFIRMED", "EXECUTING", "FILES_PENDING"] },
    },
    select: { id: true },
  });
  if (existing) return { operationId: existing.id, status: "ACTIVE" as const };
  let planned;
  try {
    planned = await buildHardDeletePreview(
      input.targetType,
      input.targetId,
      dependency.storage,
      dependency.database,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("target not found")) {
      throw new ApplicationError("NOT_FOUND", "永久删除目标不存在");
    }
    throw error;
  }
  if (input.targetType === "USER" && input.targetId === actor.userId) {
    planned.preview.databasePlan.blockers.push("CURRENT_ADMIN");
  }
  const summary = safePreviewSummary(planned.preview);
  const deletedUsers = planned.preview.databasePlan.delete.users ?? [];
  if (deletedUsers.length) {
    const [accounts, sessions, history] = await Promise.all([
      dependency.database.account.count({
        where: { userId: { in: deletedUsers } },
      }),
      dependency.database.session.count({
        where: { userId: { in: deletedUsers } },
      }),
      dependency.database.activityLog.count({
        where: {
          actorUserId: { in: deletedUsers },
          id: { notIn: planned.preview.databasePlan.delete.activityLogs ?? [] },
        },
      }),
    ]);
    summary.counts.accounts = accounts;
    summary.counts.sessions = sessions;
    summary.preservation.otherBusinessHistory = history;
  }
  const [mainRelations, privateRelations] = await Promise.all([
    dependency.database.productMainImage.findMany({
      where: {
        id: { in: planned.preview.databasePlan.delete.mainImages ?? [] },
      },
      select: { storedObjectId: true },
    }),
    dependency.database.factoryPrivateImage.findMany({
      where: {
        id: { in: planned.preview.databasePlan.delete.privateImages ?? [] },
      },
      select: { storedObjectId: true },
    }),
  ]);
  summary.preservation.sharedStoredObjects = new Set(
    [...mainRelations, ...privateRelations]
      .map((item) => item.storedObjectId)
      .filter(
        (id) =>
          !(planned.preview.databasePlan.delete.storedObjects ?? []).includes(
            id,
          ),
      ),
  ).size;
  const referenceCount =
    input.targetType === "CATEGORY"
      ? await dependency.database.product.count({
          where: { categoryId: input.targetId },
        })
      : input.targetType === "MATERIAL"
        ? await dependency.database.product.count({
            where: { materialId: input.targetId },
          })
        : 0;
  if (summary.blockers.length > 0) {
    return {
      operationId: null,
      status: "BLOCKED" as const,
      referenceCount,
      ...summary,
    };
  }
  try {
    const rows = await dependency.database.$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`
      SELECT public.refresh_hard_delete_preview(
        CAST(${input.targetType} AS public."HardDeleteTargetType"), ${input.targetId}, ${actor.userId},
        CAST(${JSON.stringify(planned.preview)} AS JSONB), ${planned.previewSha256}
      ) AS id
    `);
    const operation =
      await dependency.database.hardDeleteOperation.findUniqueOrThrow({
        where: { id: rows[0].id },
        select: { id: true, status: true, version: true, expiresAt: true },
      });
    if (operation.status !== "PREVIEWED")
      return { operationId: operation.id, status: "ACTIVE" as const };
    return {
      operationId: operation.id,
      status: "PREVIEWED" as const,
      previewSha256: planned.previewSha256,
      version: operation.version,
      expiresAt: operation.expiresAt,
      confirmationPhrase: await phrase(summary.target, dependency.database),
      referenceCount,
      ...summary,
    };
  } catch (error) {
    safeConflict(error);
  }
}

export async function createHardDeletePreview(
  requestHeaders: Headers,
  input: unknown,
  injected: Dependencies = {},
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  return createHardDeletePreviewForAdmin(actor, input, injected);
}

export async function confirmHardDeleteForAdmin(
  actor: AdminActor,
  unsafeInput: unknown,
  injected: Dependencies = {},
) {
  const input = parseInput(confirmHardDeleteSchema, unsafeInput);
  const dependency = dependencies(injected);
  try {
    return await dependency.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<
        Array<{
          id: string;
          targetType: Parameters<typeof buildHardDeletePreview>[0];
          targetId: string;
          status: string;
          previewSha256: string;
          version: number;
          expiresAt: Date;
        }>
      >(Prisma.sql`
      SELECT "id", "targetType", "targetId", "status", "previewSha256", "version", "expiresAt"
      FROM public."HardDeleteOperation"
      WHERE "id" = CAST(${input.operationId} AS UUID)
    `);
      const operation = rows[0];
      if (!operation)
        throw new ApplicationError("NOT_FOUND", "永久删除操作不存在");
      if (
        operation.status !== "PREVIEWED" ||
        operation.version !== input.expectedVersion ||
        operation.previewSha256 !== input.previewSha256
      ) {
        throw new ApplicationError("CONFLICT", STALE);
      }
      if (operation.expiresAt <= dependency.now()) {
        throw new ApplicationError("CONFLICT", STALE);
      }
      const fresh = await buildHardDeletePreview(
        operation.targetType,
        operation.targetId,
        dependency.storage,
        transaction as unknown as typeof prisma,
      );
      if (
        fresh.previewSha256 !== operation.previewSha256 ||
        fresh.preview.databasePlan.blockers.length > 0
      ) {
        throw new ApplicationError("CONFLICT", STALE);
      }
      const requiredPhrase = await phrase(
        fresh.preview.databasePlan.target,
        transaction,
      );
      if (input.confirmationPhrase !== requiredPhrase)
        throw new ApplicationError(
          "VALIDATION",
          "确认短语不匹配；大小写与每个空格必须完全一致。",
        );
      await transaction.$executeRaw(Prisma.sql`
      SELECT public.confirm_hard_delete_operation(
        CAST(${operation.id} AS UUID),
        ${actor.userId},
        ${input.previewSha256},
        ${input.expectedVersion}
      )
    `);
      return { operationId: operation.id, status: "CONFIRMED" as const };
    });
  } catch (error) {
    safeConflict(error);
  }
}

export async function confirmHardDelete(
  requestHeaders: Headers,
  input: unknown,
  injected: Dependencies = {},
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  return confirmHardDeleteForAdmin(actor, input, injected);
}

export async function readHardDeleteOperation(
  requestHeaders: Headers,
  operationId: string,
  injected: Dependencies = {},
) {
  await requireAdminFromHeaders(requestHeaders);
  const id = parseInput(z.string().uuid(), operationId);
  const dependency = dependencies(injected);
  const operation = await dependency.database.hardDeleteOperation.findUnique({
    where: { id },
    select: {
      id: true,
      targetType: true,
      targetLabelSnapshot: true,
      status: true,
      requestedAt: true,
      expiresAt: true,
      confirmedAt: true,
      startedAt: true,
      databaseCommittedAt: true,
      completedAt: true,
      failedAt: true,
      preview: true,
      fileTasks: { select: { status: true, attempts: true } },
    },
  });
  if (!operation) throw new ApplicationError("NOT_FOUND", "永久删除操作不存在");
  const { preview, fileTasks, ...safe } = operation;
  return {
    ...safe,
    preview: safePreviewSummary(preview as HardDeleteInternalPreview),
    files: {
      total: fileTasks.length,
      completed: fileTasks.filter((item) => item.status === "DELETED").length,
      retrying: fileTasks.filter((item) =>
        ["RETRYABLE", "FAILED"].includes(item.status),
      ).length,
      attempts: fileTasks.reduce((sum, item) => sum + item.attempts, 0),
    },
    failureMessage:
      operation.status === "FAILED"
        ? "任务未通过安全验证，已停止。请联系管理员检查，勿重复提交。"
        : null,
  };
}
