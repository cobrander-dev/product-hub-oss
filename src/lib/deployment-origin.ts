import { z } from "zod";

const productionDomain = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::(?:[1-9][0-9]{0,4}))?$/i,
    "APP_DOMAIN must be a DNS hostname with an optional port.",
  )
  .refine((value) => !value.includes("*"), "Wildcards are not allowed.");

const optionalValue = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function parseHttpsOrigin(value: string, field: string) {
  const parsed = z.url().safeParse(value);
  if (!parsed.success) throw new Error(`${field} must be a valid URL origin.`);

  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    throw new Error(`${field} must be an exact HTTPS origin.`);
  }
  if (url.hostname.includes("*"))
    throw new Error(`${field} must not contain a wildcard.`);
  return url;
}

export function resolveProductionDeploymentOrigin(
  source: NodeJS.ProcessEnv = process.env,
): { host: string; origin: string } | undefined {
  if (source.NODE_ENV !== "production") return undefined;

  const appDomainInput = optionalValue(source.APP_DOMAIN);
  const authUrlInput = optionalValue(source.BETTER_AUTH_URL);
  const trustedOriginsInput = optionalValue(source.BETTER_AUTH_TRUSTED_ORIGINS);

  if (!appDomainInput || !authUrlInput || !trustedOriginsInput) {
    throw new Error(
      "APP_DOMAIN, BETTER_AUTH_URL and BETTER_AUTH_TRUSTED_ORIGINS are required in production.",
    );
  }

  const authUrl = parseHttpsOrigin(authUrlInput, "BETTER_AUTH_URL");
  const trustedOrigins = trustedOriginsInput
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    trustedOrigins.length !== 1 ||
    parseHttpsOrigin(trustedOrigins[0] ?? "", "BETTER_AUTH_TRUSTED_ORIGINS")
      .origin !== authUrl.origin
  ) {
    throw new Error(
      "BETTER_AUTH_TRUSTED_ORIGINS must contain only BETTER_AUTH_URL.",
    );
  }

  const appDomain = productionDomain.parse(appDomainInput);
  if (appDomain.toLowerCase() !== authUrl.host.toLowerCase()) {
    throw new Error("APP_DOMAIN must match the BETTER_AUTH_URL host.");
  }

  return { host: authUrl.host, origin: authUrl.origin };
}

export function isTrustedProductionRequest(
  input: {
    host: string | null;
    forwardedHost: string | null;
    forwardedProto: string | null;
    forwarded: string | null;
    origin: string | null;
    method: string;
    pathname: string;
  },
  deployment: { host: string; origin: string },
): boolean {
  const localHealth =
    (input.pathname === "/api/health" || input.pathname === "/api/ready") &&
    (input.method === "GET" || input.method === "HEAD") &&
    /^(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(input.host ?? "") &&
    input.forwardedHost === input.host &&
    input.forwardedProto === "http" &&
    !input.forwarded;
  if (localHealth) return true;

  if (
    input.host !== deployment.host ||
    input.forwardedHost !== deployment.host ||
    input.forwardedProto !== "https" ||
    input.forwarded !== null
  ) {
    return false;
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(input.method)) {
    return input.origin === deployment.origin;
  }
  return input.origin === null || input.origin === deployment.origin;
}
