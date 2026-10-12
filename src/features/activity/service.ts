import { Prisma } from "@/generated/prisma/client";

import { parseInput } from "@/features/master-data/shared";
import { activityListSchema } from "@/features/activity/validation";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

export async function listActivityLogs(headers: Headers, input: unknown = {}) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(activityListSchema, input);
  const where: Prisma.ActivityLogWhereInput = {
    eventType: query.eventType,
    entityType: query.entityType,
    actorUserId: query.actorUserId,
    factoryId: query.factoryId,
    createdAt:
      query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.activityLog.count({ where }),
  ]);
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}
