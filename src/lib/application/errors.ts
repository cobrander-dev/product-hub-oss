import { Prisma } from "@/generated/prisma/client";

export type ApplicationErrorKind =
  "VALIDATION" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

const defaultMessages: Record<ApplicationErrorKind, string> = {
  VALIDATION: "提交的数据无效",
  UNAUTHENTICATED: "请先登录",
  FORBIDDEN: "没有权限执行此操作",
  NOT_FOUND: "记录不存在",
  CONFLICT: "数据已存在或已被更新",
};

export class ApplicationError extends Error {
  constructor(
    public readonly kind: ApplicationErrorKind,
    message = defaultMessages[kind],
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export function toSafeActionError(error: unknown) {
  if (error instanceof ApplicationError) {
    return { ok: false as const, error: error.kind, message: error.message };
  }

  return {
    ok: false as const,
    error: "INTERNAL" as const,
    message: "操作失败，请稍后重试",
  };
}
