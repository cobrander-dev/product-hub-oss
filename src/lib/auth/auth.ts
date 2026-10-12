import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, username } from "better-auth/plugins";

import { authAccessControl, authRoles } from "@/lib/auth/access-control";
import { prisma } from "@/lib/db/prisma";
import { parseAuthEnv } from "@/lib/env";

const env = parseAuthEnv();
const isProduction = env.NODE_ENV === "production";

const disabledHttpPaths = [
  "/sign-up/email",
  "/sign-in/email",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/verify-email",
  "/is-username-available",
  "/update-user",
  "/change-email",
  "/delete-user",
  "/admin/create-user",
  "/admin/set-role",
  "/admin/update-user",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/set-user-password",
  "/admin/remove-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
] as const;

export const auth = betterAuth({
  appName: "Product Hub",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
  },
  account: {
    accountLinking: {
      enabled: false,
    },
  },
  user: {
    changeEmail: {
      enabled: false,
    },
    deleteUser: {
      enabled: false,
    },
    additionalFields: {
      factoryId: {
        type: "string",
        required: false,
        input: false,
        returned: true,
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 60,
    cookieCache: {
      enabled: false,
    },
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/username": {
        window: 60,
        max: 5,
      },
    },
  },
  advanced: {
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
    },
    database: {
      joins: true,
      validateSchema: true,
    },
  },
  disabledPaths: [...disabledHttpPaths],
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            include: { factory: true },
          });

          if (!user || user.banned) {
            throw new APIError("FORBIDDEN", {
              message: "Authentication is not available.",
            });
          }

          if (user.role === "ADMIN" && user.factoryId === null) {
            return;
          }

          if (
            user.role === "FACTORY" &&
            user.factoryId !== null &&
            user.factory?.status === "ACTIVE"
          ) {
            return;
          }

          throw new APIError("FORBIDDEN", {
            message: "Authentication is not available.",
          });
        },
      },
    },
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
      usernameNormalization: (value) => value.trim().toLowerCase(),
      immutableUsername: true,
      displayUsername: false,
    }),
    admin({
      ac: authAccessControl,
      roles: authRoles,
      defaultRole: "FACTORY",
      adminRoles: ["ADMIN"],
      bannedUserMessage: "Authentication is not available.",
    }),
    nextCookies(),
  ],
  telemetry: {
    enabled: false,
  },
});

export type AuthSession = typeof auth.$Infer.Session;
