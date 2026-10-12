import { Prisma } from "@/generated/prisma/client";

import { normalizeName, parseInput } from "@/features/master-data/shared";
import {
  createCategorySchema,
  setCategoryStatusSchema,
  updateCategorySchema,
} from "@/features/categories/validation";
import {
  ApplicationError,
  isUniqueConstraintError,
} from "@/lib/application/errors";
import { writeUserActivity } from "@/features/activity/writer";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

function categoryDto<T extends { nameNormalized: string }>(value: T) {
  const { nameNormalized, ...dto } = value;
  void nameNormalized;
  return dto;
}

export async function createCategory(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(createCategorySchema, input);
  try {
    return categoryDto(
      await prisma.$transaction(async (tx) => {
        const created = await tx.category.create({
          data: { name: data.name, nameNormalized: normalizeName(data.name) },
        });
        await writeUserActivity(tx, {
          eventType: "CATEGORY_CREATED",
          actor,
          entityId: created.id,
          entityLabelSnapshot: created.name,
          factoryId: null,
          before: { name: null, status: null },
          after: { name: created.name, status: created.status },
          metadata: {},
        });
        return created;
      }),
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplicationError("CONFLICT", "分类名称已存在");
    }
    throw error;
  }
}

export async function listCategories(headers: Headers) {
  await requireAdminFromHeaders(headers);
  return (
    await prisma.category.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
    })
  ).map(categoryDto);
}

export async function updateCategory(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(updateCategorySchema, input);
  try {
    return categoryDto(
      await prisma.$transaction(async (tx) => {
        const current = await tx.category.findUnique({
          where: { id: data.id },
        });
        if (!current) throw new ApplicationError("NOT_FOUND", "分类不存在");
        if (current.name === data.name) return current;
        const updated = await tx.category.update({
          where: { id: data.id },
          data: { name: data.name, nameNormalized: normalizeName(data.name) },
        });
        await writeUserActivity(tx, {
          eventType: "CATEGORY_UPDATED",
          actor,
          entityId: updated.id,
          entityLabelSnapshot: updated.name,
          factoryId: null,
          before: { name: current.name },
          after: { name: updated.name },
          metadata: {},
        });
        return updated;
      }),
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplicationError("CONFLICT", "分类名称已存在");
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new ApplicationError("NOT_FOUND", "分类不存在");
    }
    throw error;
  }
}

export async function setCategoryStatus(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(setCategoryStatusSchema, input);
  try {
    return categoryDto(
      await prisma.$transaction(async (tx) => {
        const current = await tx.category.findUnique({
          where: { id: data.id },
        });
        if (!current) throw new ApplicationError("NOT_FOUND", "分类不存在");
        if (current.status === data.status) return current;
        const updated = await tx.category.update({
          where: { id: data.id },
          data: { status: data.status },
        });
        await writeUserActivity(tx, {
          eventType:
            updated.status === "ACTIVE"
              ? "CATEGORY_ENABLED"
              : "CATEGORY_DISABLED",
          actor,
          entityId: updated.id,
          entityLabelSnapshot: updated.name,
          factoryId: null,
          before: { status: current.status },
          after: { status: updated.status },
          metadata: {},
        });
        return updated;
      }),
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new ApplicationError("NOT_FOUND", "分类不存在");
    }
    throw error;
  }
}
