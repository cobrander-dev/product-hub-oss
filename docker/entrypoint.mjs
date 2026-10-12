const required = [
  "DATABASE_URL",
  "APP_DOMAIN",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "STORAGE_DRIVER",
  "LOCAL_STORAGE_ROOT",
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(
      `Missing required production environment variable: ${name}`,
    );
  }
}

if (process.env.BETTER_AUTH_SECRET.length < 32) {
  throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
}

const authUrl = new URL(process.env.BETTER_AUTH_URL);
if (
  authUrl.protocol !== "https:" ||
  authUrl.username ||
  authUrl.password ||
  authUrl.pathname !== "/" ||
  authUrl.search ||
  authUrl.hash
) {
  throw new Error("BETTER_AUTH_URL must be an HTTPS origin");
}

if (process.env.BETTER_AUTH_TRUSTED_ORIGINS !== authUrl.origin) {
  throw new Error(
    "BETTER_AUTH_TRUSTED_ORIGINS must contain only BETTER_AUTH_URL origin",
  );
}

if (
  !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::[1-9][0-9]{0,4})?$/i.test(
    process.env.APP_DOMAIN,
  ) ||
  process.env.APP_DOMAIN !== authUrl.host
) {
  throw new Error("APP_DOMAIN must exactly match BETTER_AUTH_URL host");
}

if (process.env.STORAGE_DRIVER !== "local") {
  throw new Error("Production STORAGE_DRIVER must be local");
}

if (
  !process.env.LOCAL_STORAGE_ROOT.startsWith("/") ||
  process.env.LOCAL_STORAGE_ROOT.includes("\0")
) {
  throw new Error("LOCAL_STORAGE_ROOT must be an absolute POSIX path");
}

await import("../server.js");
