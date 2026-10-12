import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url().startsWith("postgresql://").optional(),
  ),
  BETTER_AUTH_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  BETTER_AUTH_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url().optional(),
  ),
  STORAGE_DRIVER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["local", "s3"]).default("local"),
  ),
  LOCAL_STORAGE_ROOT: optionalText,
});

const authEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.url().startsWith("postgresql://"),
  APP_DOMAIN: optionalText,
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_TRUSTED_ORIGINS: z
    .string()
    .min(1)
    .transform((value, context) => {
      const origins = value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

      for (const origin of origins) {
        const parsed = z.url().safeParse(origin);
        if (!parsed.success || new URL(origin).origin !== origin) {
          context.addIssue({
            code: "custom",
            message: "Trusted origins must be comma-separated URL origins.",
          });
          return z.NEVER;
        }
      }

      return origins;
    }),
});

const productionRuntimeEnvSchema = authEnvSchema
  .extend({
    NODE_ENV: z.literal("production"),
    APP_DOMAIN: z.string().min(1),
    STORAGE_DRIVER: z.literal("local"),
    LOCAL_STORAGE_ROOT: z.string().min(1),
  })
  .superRefine((value, context) => {
    const authUrl = new URL(value.BETTER_AUTH_URL);
    if (
      authUrl.protocol !== "https:" ||
      authUrl.username ||
      authUrl.password ||
      authUrl.pathname !== "/" ||
      authUrl.search ||
      authUrl.hash
    ) {
      context.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "Production BETTER_AUTH_URL must be an HTTPS origin.",
      });
    }

    if (
      value.APP_DOMAIN !== authUrl.host ||
      value.APP_DOMAIN.includes("*") ||
      value.APP_DOMAIN.includes("://") ||
      value.APP_DOMAIN.includes("/")
    ) {
      context.addIssue({
        code: "custom",
        path: ["APP_DOMAIN"],
        message:
          "Production APP_DOMAIN must exactly match BETTER_AUTH_URL host.",
      });
    }

    if (
      value.BETTER_AUTH_TRUSTED_ORIGINS.length !== 1 ||
      value.BETTER_AUTH_TRUSTED_ORIGINS[0] !== authUrl.origin
    ) {
      context.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_TRUSTED_ORIGINS"],
        message:
          "Production trusted origins must contain only BETTER_AUTH_URL origin.",
      });
    }

    if (
      !value.LOCAL_STORAGE_ROOT.startsWith("/") ||
      value.LOCAL_STORAGE_ROOT.includes("\0")
    ) {
      context.addIssue({
        code: "custom",
        path: ["LOCAL_STORAGE_ROOT"],
        message:
          "Production LOCAL_STORAGE_ROOT must be an absolute POSIX path.",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type AuthEnv = z.infer<typeof authEnvSchema>;
export type ProductionRuntimeEnv = z.infer<typeof productionRuntimeEnvSchema>;

export function parseServerEnv(
  source: NodeJS.ProcessEnv = process.env,
): ServerEnv {
  return serverEnvSchema.parse(source);
}

export function parseAuthEnv(source: NodeJS.ProcessEnv = process.env): AuthEnv {
  return authEnvSchema.parse(source);
}

export function parseProductionRuntimeEnv(
  source: NodeJS.ProcessEnv = process.env,
): ProductionRuntimeEnv {
  return productionRuntimeEnvSchema.parse(source);
}
