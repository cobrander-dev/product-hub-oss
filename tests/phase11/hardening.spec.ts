import { expect } from "@playwright/test";
import { test } from "../support/diagnostic-test";

import {
  isTrustedProductionRequest,
  resolveProductionDeploymentOrigin,
} from "@/lib/deployment-origin";
import { parseProductionRuntimeEnv } from "@/lib/env";

const validProductionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_DOMAIN: "product-hub.example.com",
  DATABASE_URL: "postgresql://app:password@postgres:5432/product_hub",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "https://product-hub.example.com",
  BETTER_AUTH_TRUSTED_ORIGINS: "https://product-hub.example.com",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_ROOT: "/data/uploads",
};

test("production environment fails closed for unsafe auth and storage configuration", () => {
  expect(() => parseProductionRuntimeEnv(validProductionEnv)).not.toThrow();
  expect(() =>
    parseProductionRuntimeEnv({
      ...validProductionEnv,
      APP_DOMAIN: "*.example.com",
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_TRUSTED_ORIGINS: "*",
      LOCAL_STORAGE_ROOT: "./uploads",
    }),
  ).toThrow();
});

test("production instance accepts one exact runtime deployment origin", () => {
  expect(
    resolveProductionDeploymentOrigin({
      NODE_ENV: "production",
      APP_DOMAIN: "hub.company.example",
      BETTER_AUTH_URL: "https://hub.company.example",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://hub.company.example",
    }),
  ).toEqual({
    host: "hub.company.example",
    origin: "https://hub.company.example",
  });

  expect(
    resolveProductionDeploymentOrigin({ NODE_ENV: "development" }),
  ).toBeUndefined();
  expect(() =>
    resolveProductionDeploymentOrigin({ NODE_ENV: "production" }),
  ).toThrow();
});

test("production runtime rejects wildcard, malformed, and mismatched origins", () => {
  const base: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    APP_DOMAIN: "hub.company.example",
    BETTER_AUTH_URL: "https://hub.company.example",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://hub.company.example",
  };
  const invalidEnvironments: NodeJS.ProcessEnv[] = [
    {
      NODE_ENV: "production",
      APP_DOMAIN: "hub.company.example",
    },
    { ...base, APP_DOMAIN: "*.company.example" },
    { ...base, BETTER_AUTH_URL: "https://hub.company.example/path" },
    {
      ...base,
      BETTER_AUTH_TRUSTED_ORIGINS:
        "https://hub.company.example,https://other.company.example",
    },
    { ...base, APP_DOMAIN: "other.company.example" },
    { ...base, BETTER_AUTH_URL: "http://hub.company.example" },
  ];
  for (const invalid of invalidEnvironments) {
    expect(() => resolveProductionDeploymentOrigin(invalid)).toThrow();
  }
});

test("production request gate rejects wrong origins and forwarded headers", () => {
  const deployment = {
    host: "hub.company.example",
    origin: "https://hub.company.example",
  };
  const valid = {
    host: deployment.host,
    forwardedHost: deployment.host,
    forwardedProto: "https",
    forwarded: null,
    origin: deployment.origin,
    method: "POST",
    pathname: "/admin/settings",
  };
  expect(isTrustedProductionRequest(valid, deployment)).toBe(true);
  expect(
    isTrustedProductionRequest(
      {
        ...valid,
        host: "127.0.0.1:33443",
        forwardedHost: "127.0.0.1:33443",
        forwardedProto: "http",
        origin: null,
        method: "GET",
        pathname: "/api/ready",
      },
      deployment,
    ),
  ).toBe(true);
  for (const invalid of [
    { origin: null },
    { origin: "https://other.example" },
    { host: "other.example" },
    { forwardedHost: "other.example" },
    { forwardedHost: "hub.company.example, other.example" },
    { forwardedProto: "http" },
    { forwardedProto: "https, http" },
    { forwarded: "host=hub.company.example" },
  ]) {
    expect(
      isTrustedProductionRequest({ ...valid, ...invalid }, deployment),
    ).toBe(false);
  }
});

test("liveness stays dependency-free while readiness verifies database and storage", async ({
  request,
}) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });

  const ready = await request.get("/api/ready");
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toEqual({ status: "ok" });
  expect(ready.headers()["cache-control"]).toBe("no-store");
});

test("application responses carry the production security-header contract", async ({
  request,
}) => {
  const response = await request.get("/login");
  const headers = response.headers();
  expect(headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(headers["content-security-policy"]).toContain("object-src 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["strict-transport-security"]).toBeUndefined();
});
