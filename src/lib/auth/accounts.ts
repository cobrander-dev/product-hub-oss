import { randomUUID } from "node:crypto";

import { z } from "zod";

import { auth } from "@/lib/auth/auth";
import {
  AuthorizationError,
  requireAdminFromHeaders,
  requireFactoryUserFromHeaders,
} from "@/lib/auth/context-core";
import { recordAuthSecurityEvent } from "@/lib/auth/security-log";
import { prisma } from "@/lib/db/prisma";
import { writeUserActivity } from "@/features/activity/writer";
import { ApplicationError } from "@/lib/application/errors";

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9._-]+$/)
  .transform((value) => value.toLowerCase());

const passwordSchema = z.string().min(8).max(128);

export async function createFactoryUser(
  requestHeaders: Headers,
  input: {
    factoryId: string;
    username: string;
    password: string;
    name: string;
  },
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  const username = usernameSchema.parse(input.username);
  const password = passwordSchema.parse(input.password);
  const [factory, existingUser] = await Promise.all([
    prisma.factory.findUnique({ where: { id: input.factoryId } }),
    prisma.user.findUnique({ where: { username } }),
  ]);

  if (!factory || factory.status !== "ACTIVE") {
    throw new AuthorizationError("NOT_FOUND");
  }
  if (existingUser) {
    throw new ApplicationError("CONFLICT", "用户名已存在");
  }

  const result = await auth.api.createUser({
    headers: requestHeaders,
    body: {
      email: `${randomUUID()}@users.invalid`,
      password,
      name: z.string().trim().min(1).max(100).parse(input.name),
      role: "FACTORY",
      data: { username, factoryId: factory.id },
    },
  });

  recordAuthSecurityEvent({
    type: "factory_user_create",
    result: "success",
    actorId: actor.userId,
    targetUserId: result.user.id,
    factoryId: factory.id,
  });

  await prisma.$transaction((tx) =>
    writeUserActivity(tx, {
      eventType: "USER_CREATED",
      actor,
      entityId: result.user.id,
      entityLabelSnapshot: username,
      factoryId: factory.id,
      before: { username: null, status: null, factoryId: null },
      after: { username, status: "ENABLED", factoryId: factory.id },
      metadata: {},
    }),
  );

  return {
    id: result.user.id,
    username,
    factoryId: factory.id,
  };
}

export async function resetFactoryUserPassword(
  requestHeaders: Headers,
  input: { userId: string; newPassword: string },
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  const target = await prisma.user.findUnique({ where: { id: input.userId } });

  if (!target || target.role !== "FACTORY" || !target.factoryId) {
    throw new AuthorizationError("NOT_FOUND");
  }

  await auth.api.setUserPassword({
    headers: requestHeaders,
    body: {
      userId: target.id,
      newPassword: passwordSchema.parse(input.newPassword),
    },
  });
  await auth.api.revokeUserSessions({
    headers: requestHeaders,
    body: { userId: target.id },
  });

  recordAuthSecurityEvent({
    type: "admin_password_reset",
    result: "success",
    actorId: actor.userId,
    targetUserId: target.id,
    factoryId: target.factoryId,
  });
}

export async function setFactoryUserEnabled(
  requestHeaders: Headers,
  input: { userId: string; enabled: boolean },
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  const target = await prisma.user.findUnique({ where: { id: input.userId } });

  if (
    !target ||
    target.role !== "FACTORY" ||
    !target.factoryId ||
    !target.username
  ) {
    throw new AuthorizationError("NOT_FOUND");
  }
  const targetFactoryId = target.factoryId;
  const targetUsername = target.username;

  await prisma.$transaction(async (tx) => {
    const currentStatus = target.banned ? "DISABLED" : "ENABLED";
    const nextStatus = input.enabled ? "ENABLED" : "DISABLED";
    if (currentStatus === nextStatus) return;

    const updated = await tx.user.updateMany({
      where: {
        id: target.id,
        role: "FACTORY",
        factoryId: targetFactoryId,
        ...(input.enabled
          ? { banned: true }
          : { OR: [{ banned: false }, { banned: null }] }),
      },
      data: input.enabled
        ? { banned: false, banReason: null, banExpires: null }
        : {
            banned: true,
            banReason: "Disabled by administrator",
            banExpires: null,
          },
    });
    if (updated.count === 0) return;

    if (!input.enabled) {
      await tx.session.deleteMany({ where: { userId: target.id } });
    }

    await writeUserActivity(tx, {
      eventType: input.enabled ? "USER_ENABLED" : "USER_DISABLED",
      actor,
      entityId: target.id,
      entityLabelSnapshot: targetUsername,
      factoryId: targetFactoryId,
      before: { status: currentStatus },
      after: { status: nextStatus },
      metadata: {},
    });
  });

  recordAuthSecurityEvent({
    type: input.enabled ? "user_enable" : "user_disable",
    result: "success",
    actorId: actor.userId,
    targetUserId: target.id,
    factoryId: target.factoryId,
  });
}

export async function setFactoryEnabled(
  requestHeaders: Headers,
  input: { factoryId: string; enabled: boolean },
) {
  const actor = await requireAdminFromHeaders(requestHeaders);
  const factory = await prisma.factory.findUnique({
    where: { id: input.factoryId },
  });

  if (!factory) {
    throw new AuthorizationError("NOT_FOUND");
  }

  await prisma.$transaction(async (tx) => {
    const current = await tx.factory.findUnique({ where: { id: factory.id } });
    if (!current) throw new AuthorizationError("NOT_FOUND");
    const status = input.enabled ? "ACTIVE" : "DISABLED";
    if (current.status !== status) {
      await tx.factory.update({
        where: { id: current.id },
        data: { status },
      });
      await writeUserActivity(tx, {
        eventType: status === "ACTIVE" ? "FACTORY_ENABLED" : "FACTORY_DISABLED",
        actor,
        entityId: current.id,
        entityLabelSnapshot: current.name,
        factoryId: current.id,
        before: { status: current.status },
        after: { status },
        metadata: {},
      });
    }

    if (!input.enabled) {
      await tx.session.deleteMany({
        where: { user: { factoryId: factory.id } },
      });
    }
  });

  recordAuthSecurityEvent({
    type: input.enabled ? "factory_enable" : "factory_disable",
    result: "success",
    actorId: actor.userId,
    factoryId: factory.id,
  });
}

export async function changeOwnPassword(
  requestHeaders: Headers,
  input: { currentPassword: string; newPassword: string },
) {
  const actor = await requireFactoryUserFromHeaders(requestHeaders);

  await auth.api.changePassword({
    headers: requestHeaders,
    body: {
      currentPassword: passwordSchema.parse(input.currentPassword),
      newPassword: passwordSchema.parse(input.newPassword),
      revokeOtherSessions: true,
    },
  });

  recordAuthSecurityEvent({
    type: "password_change",
    result: "success",
    actorId: actor.userId,
    factoryId: actor.factoryId,
  });
}
