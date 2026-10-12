import { Prisma } from "@/generated/prisma/client";
import { z } from "zod";

import { parseInput } from "@/features/master-data/shared";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

const userListSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(160).default(""),
    factoryId: z.string().uuid().optional(),
    status: z.enum(["ENABLED", "DISABLED"]).optional(),
  })
  .strict();

export async function listAdminFactoryUsers(
  requestHeaders: Headers,
  input: unknown = {},
) {
  await requireAdminFromHeaders(requestHeaders);
  const query = parseInput(userListSchema, input);
  const where: Prisma.UserWhereInput = {
    role: "FACTORY",
    factoryId: query.factoryId,
    banned:
      query.status === "DISABLED"
        ? true
        : query.status === "ENABLED"
          ? false
          : undefined,
    ...(query.search
      ? { username: { contains: query.search, mode: "insensitive" } }
      : {}),
  };
  const [items, total, factories] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        banned: true,
        createdAt: true,
        updatedAt: true,
        factory: { select: { id: true, name: true, status: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.user.count({ where }),
    prisma.factory.findMany({
      select: { id: true, name: true, status: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
  ]);
  return {
    items,
    factories,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function getActivityFilterOptions(requestHeaders: Headers) {
  await requireAdminFromHeaders(requestHeaders);
  const [actors, factoryRefs] = await Promise.all([
    prisma.user.findMany({
      where: { activityLogs: { some: {} } },
      select: { id: true, username: true, name: true },
      orderBy: [{ username: "asc" }, { id: "asc" }],
    }),
    prisma.activityLog.findMany({
      where: { factoryId: { not: null } },
      select: { factoryId: true },
      distinct: ["factoryId"],
    }),
  ]);
  const factories = await prisma.factory.findMany({
    where: {
      id: { in: factoryRefs.flatMap((item) => item.factoryId ?? []) },
    },
    select: { id: true, name: true, status: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return { actors, factories };
}

export async function listRecentProductImports(requestHeaders: Headers) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  return prisma.importJob.findMany({
    where: { type: "PRODUCT", createdByUserId: actor.userId },
    select: {
      id: true,
      originalFilename: true,
      status: true,
      totalRows: true,
      createRows: true,
      updateRows: true,
      noChangeRows: true,
      errorRows: true,
      createdAt: true,
      confirmedAt: true,
      createdByUser: { select: { username: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 8,
  });
}
