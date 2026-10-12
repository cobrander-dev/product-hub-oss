import { Prisma } from "@/generated/prisma/client";

import { normalizeName, parseInput } from "@/features/master-data/shared";
import {
  createMaterialSchema,
  setMaterialStatusSchema,
  updateMaterialSchema,
} from "@/features/materials/validation";
import {
  ApplicationError,
  isUniqueConstraintError,
} from "@/lib/application/errors";
import { writeUserActivity } from "@/features/activity/writer";
import { requireAdminFromHeaders } from "@/lib/auth/context-core";
import { prisma } from "@/lib/db/prisma";

function materialDto<T extends { nameNormalized: string }>(value: T) {
  const { nameNormalized, ...dto } = value;
  void nameNormalized;
  return dto;
}

export async function createMaterial(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(createMaterialSchema, input);
  try {
    return materialDto(
      await prisma.$transaction(async (tx) => {
        const created = await tx.material.create({
          data: { name: data.name, nameNormalized: normalizeName(data.name) },
        });
        await writeUserActivity(tx, {
          eventType: "MATERIAL_CREATED",
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
      throw new ApplicationError("CONFLICT", "材质名称已存在");
    }
    throw error;
  }
}

export async function listMaterials(headers: Headers) {
  await requireAdminFromHeaders(headers);
  return (
    await prisma.material.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
    })
  ).map(materialDto);
}

export async function updateMaterial(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(updateMaterialSchema, input);
  try {
    return materialDto(
      await prisma.$transaction(async (tx) => {
        const current = await tx.material.findUnique({
          where: { id: data.id },
        });
        if (!current) throw new ApplicationError("NOT_FOUND", "材质不存在");
        if (current.name === data.name) return current;
        const updated = await tx.material.update({
          where: { id: data.id },
          data: { name: data.name, nameNormalized: normalizeName(data.name) },
        });
        await writeUserActivity(tx, {
          eventType: "MATERIAL_UPDATED",
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
      throw new ApplicationError("CONFLICT", "材质名称已存在");
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new ApplicationError("NOT_FOUND", "材质不存在");
    }
    throw error;
  }
}

export async function setMaterialStatus(headers: Headers, input: unknown) {
  const actor = await requireAdminFromHeaders(headers);
  const data = parseInput(setMaterialStatusSchema, input);
  try {
    return materialDto(
      await prisma.$transaction(async (tx) => {
        const current = await tx.material.findUnique({
          where: { id: data.id },
        });
        if (!current) throw new ApplicationError("NOT_FOUND", "材质不存在");
        if (current.status === data.status) return current;
        const updated = await tx.material.update({
          where: { id: data.id },
          data: { status: data.status },
        });
        await writeUserActivity(tx, {
          eventType:
            updated.status === "ACTIVE"
              ? "MATERIAL_ENABLED"
              : "MATERIAL_DISABLED",
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
      throw new ApplicationError("NOT_FOUND", "材质不存在");
    }
    throw error;
  }
}
