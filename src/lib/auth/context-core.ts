import { auth } from "@/lib/auth/auth";
import { ApplicationError } from "@/lib/application/errors";
import { prisma } from "@/lib/db/prisma";

export type AdminActor = {
  userId: string;
  username: string;
  role: "ADMIN";
  factoryId: null;
};

export type FactoryActor = {
  userId: string;
  username: string;
  role: "FACTORY";
  factoryId: string;
  factoryName: string;
};

export type AuthActor = AdminActor | FactoryActor;

export class AuthorizationError extends ApplicationError {
  constructor(
    public readonly kind: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND",
  ) {
    super(kind);
    this.name = "AuthorizationError";
  }
}

export async function getAuthContextFromHeaders(
  requestHeaders: Headers,
): Promise<AuthActor | null> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: { factory: true },
  });
  if (!user || user.banned || !user.username) return null;

  if (user.role === "ADMIN" && user.factoryId === null) {
    return {
      userId: user.id,
      username: user.username,
      role: "ADMIN",
      factoryId: null,
    };
  }

  if (
    user.role === "FACTORY" &&
    user.factoryId !== null &&
    user.factory?.status === "ACTIVE"
  ) {
    return {
      userId: user.id,
      username: user.username,
      role: "FACTORY",
      factoryId: user.factoryId,
      factoryName: user.factory.name,
    };
  }

  return null;
}

export async function requireUserFromHeaders(requestHeaders: Headers) {
  const actor = await getAuthContextFromHeaders(requestHeaders);
  if (!actor) throw new AuthorizationError("UNAUTHENTICATED");
  return actor;
}

export async function requireAdminFromHeaders(requestHeaders: Headers) {
  const actor = await requireUserFromHeaders(requestHeaders);
  if (actor.role !== "ADMIN") throw new AuthorizationError("FORBIDDEN");
  return actor;
}

export async function requireFactoryUserFromHeaders(requestHeaders: Headers) {
  const actor = await requireUserFromHeaders(requestHeaders);
  if (actor.role !== "FACTORY") throw new AuthorizationError("FORBIDDEN");
  return actor;
}
