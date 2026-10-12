import { Prisma } from "@/generated/prisma/client";

import {
  idSchema,
  normalizeName,
  parseInput,
} from "@/features/master-data/shared";
import {
  createFactorySchema,
  factoryListSchema,
  setFactoryStatusSchema,
  updateFactorySchema,
} from "@/features/factories/validation";
import {
  ApplicationError,
  isUniqueConstraintError,
} from "@/lib/application/errors";
import { auditText, writeUserActivity } from "@/features/activity/writer";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

function factoryDto<T extends { nameNormalized: string }>(value: T) {
  const { nameNormalized, ...dto } = value;
  void nameNormalized;
  return dto;
}

export async function createFactory(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(createFactorySchema, input);
  try {
    return factoryDto(
      await prisma.$transaction(async (tx) => {
        const created = await tx.factory.create({
          data: { ...data, nameNormalized: normalizeName(data.name) },
        });
        await writeUserActivity(tx, {
          eventType: "FACTORY_CREATED",
          actor,
          entityId: created.id,
          entityLabelSnapshot: created.name,
          factoryId: created.id,
          before: {
            name: null,
            contactName: null,
            phone: null,
            notes: null,
            status: null,
          },
          after: {
            name: created.name,
            contactName: created.contactName,
            phone: created.phone,
            notes: auditText(created.notes),
            status: created.status,
          },
          metadata: {},
        });
        return created;
      }),
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplicationError("CONFLICT", "厂家名称已存在");
    }
    throw error;
  }
}

export async function getFactory(headers: Headers, idInput: unknown) {
  await requireAdminFromHeaders(headers);
  const id = parseInput(idSchema, idInput);
  const factory = await prisma.factory.findUnique({ where: { id } });
  if (!factory) throw new ApplicationError("NOT_FOUND", "厂家不存在");
  return factoryDto(factory);
}

export async function listFactories(headers: Headers, input: unknown = {}) {
  await requireAdminFromHeaders(headers);
  const query = parseInput(factoryListSchema, input);
  const where: Prisma.FactoryWhereInput = {
    status: query.status,
    ...(query.search
      ? { name: { contains: query.search, mode: "insensitive" } }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.factory.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.factory.count({ where }),
  ]);
  return {
    items: items.map(factoryDto),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

export async function updateFactory(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(updateFactorySchema, input);
  try {
    return factoryDto(
      await prisma.$transaction(async (tx) => {
        const current = await tx.factory.findUnique({ where: { id: data.id } });
        if (!current) throw new ApplicationError("NOT_FOUND", "厂家不存在");
        const changed =
          current.name !== data.name ||
          current.contactName !== data.contactName ||
          current.phone !== data.phone ||
          current.notes !== data.notes;
        if (!changed) return current;
        const updated = await tx.factory.update({
          where: { id: data.id },
          data: {
            name: data.name,
            nameNormalized: normalizeName(data.name),
            contactName: data.contactName,
            phone: data.phone,
            notes: data.notes,
          },
        });
        await writeUserActivity(tx, {
          eventType: "FACTORY_UPDATED",
          actor,
          entityId: updated.id,
          entityLabelSnapshot: updated.name,
          factoryId: updated.id,
          before: {
            name: current.name,
            contactName: current.contactName,
            phone: current.phone,
            notes: auditText(current.notes),
          },
          after: {
            name: updated.name,
            contactName: updated.contactName,
            phone: updated.phone,
            notes: auditText(updated.notes),
          },
          metadata: {},
        });
        return updated;
      }),
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplicationError("CONFLICT", "厂家名称已存在");
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new ApplicationError("NOT_FOUND", "厂家不存在");
    }
    throw error;
  }
}

export async function setFactoryStatus(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(setFactoryStatusSchema, input);
  const updated = await prisma.$transaction(async (tx) => {
    const factory = await tx.factory.findUnique({ where: { id: data.id } });
    if (!factory) throw new ApplicationError("NOT_FOUND", "厂家不存在");
    if (factory.status === data.status) {
      if (data.status === "DISABLED") {
        await tx.session.deleteMany({
          where: { user: { factoryId: data.id } },
        });
      }
      return factory;
    }
    const result = await tx.factory.update({
      where: { id: data.id },
      data: { status: data.status },
    });
    if (data.status === "DISABLED") {
      await tx.session.deleteMany({ where: { user: { factoryId: data.id } } });
    }
    await writeUserActivity(tx, {
      eventType:
        result.status === "ACTIVE" ? "FACTORY_ENABLED" : "FACTORY_DISABLED",
      actor,
      entityId: result.id,
      entityLabelSnapshot: result.name,
      factoryId: result.id,
      before: { status: factory.status },
      after: { status: result.status },
      metadata: {},
    });
    return result;
  });
  return factoryDto(updated);
}
