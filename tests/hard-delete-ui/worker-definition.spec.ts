import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { hardDeleteSecurityEvent } from "../../src/features/hard-delete/security-event";
test("production overlay isolates identities, secrets and networks", async () => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "compose.yaml",
      "-f",
      "compose.production.yaml",
      "-f",
      "compose.hard-delete.yaml",
      "--profile",
      "operations",
      "--profile",
      "operations-hard-delete",
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        APP_DOMAIN: "product-hub.invalid",
        APP_DATABASE_URL:
          "postgresql://product_hub_app:dummy@postgres/product_hub",
        MIGRATION_DATABASE_URL:
          "postgresql://product_hub_migration:dummy@postgres/product_hub",
        BETTER_AUTH_SECRET: "dummy-auth-secret-only-for-web-app-32-bytes",
        BETTER_AUTH_URL: "https://product-hub.invalid",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://product-hub.invalid",
        POSTGRES_DB: "product_hub",
        POSTGRES_USER: "product_hub_db_admin",
        POSTGRES_PASSWORD: "dummy",
        MIGRATION_DB_USER: "product_hub_migration",
        MIGRATION_DB_PASSWORD: "dummy",
        APP_DB_USER: "product_hub_app",
        APP_DB_PASSWORD: "dummy",
        HARD_DELETE_WORKER_IMAGE: "product-hub-hard-delete-worker:phase3",
        HARD_DELETE_WORKER_DB_USER: "custom_hard_delete_worker",
        HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE:
          "/tmp/phase3-dummy-worker-secret",
      },
    },
  );
  expect(result.status).toBe(0);
  const config = JSON.parse(result.stdout);
  const worker = config.services["hard-delete-worker"];
  expect(worker.platform).toBe("linux/amd64");
  expect(worker.user).toBe("1001:1001");
  expect(worker.read_only).toBe(true);
  expect(worker.cap_drop).toEqual(["ALL"]);
  expect(worker.security_opt).toContain("no-new-privileges:true");
  expect(worker.ports ?? []).toHaveLength(0);
  expect(Object.keys(worker.networks)).toEqual(["product_hub_backend"]);
  expect(worker.environment.DATABASE_URL).toBeUndefined();
  expect(worker.environment.BETTER_AUTH_SECRET).toBeUndefined();
  expect(worker.environment.HARD_DELETE_WORKER_DATABASE_URL).toBeUndefined();
  expect(worker.environment.HARD_DELETE_WORKER_DATABASE_URL_FILE).toBe(
    "/run/secrets/hard_delete_worker_database_url",
  );
  expect(worker.environment.HARD_DELETE_WORKER_DB_USER).toBe(
    "custom_hard_delete_worker",
  );
  for (const name of ["app", "migration"]) {
    expect(config.services[name].secrets ?? []).toHaveLength(0);
    for (const key of Object.keys(config.services[name].environment))
      expect(key).not.toContain("WORKER");
  }
  expect(config.services.app.environment.DATABASE_URL).toContain(
    "product_hub_app:",
  );
  expect(config.services.migration.environment.DATABASE_URL).toContain(
    "product_hub_migration:",
  );
  expect(config.networks.product_hub_backend.internal).toBe(true);
  expect(
    worker.volumes.some(
      (v: { target: string; read_only?: boolean }) =>
        v.target === "/data/uploads" && !v.read_only,
    ),
  ).toBe(true);
  const dockerfile = await readFile("Dockerfile", "utf8");
  expect(dockerfile.split("AS hard-delete-worker")[1]).toContain("USER worker");
});
test("worker configuration failures never echo credentials or paths", () => {
  const marker = "PRIVATE_DO_NOT_LOG";
  for (const env of [
    {
      HARD_DELETE_WORKER_DATABASE_URL: "invalid-" + marker,
      LOCAL_STORAGE_ROOT: "/" + marker,
    },
    {
      HARD_DELETE_WORKER_DATABASE_URL:
        "postgresql://product_hub_app:" + marker + "@127.0.0.1/db",
      HARD_DELETE_WORKER_DB_USER: "custom_hard_delete_worker",
      LOCAL_STORAGE_ROOT: "/" + marker,
    },
    {
      HARD_DELETE_WORKER_DATABASE_URL_FILE: "/missing/" + marker,
      LOCAL_STORAGE_ROOT: "/" + marker,
    },
  ]) {
    const result = spawnSync(
      process.execPath,
      ["./node_modules/tsx/dist/cli.mjs", "scripts/run-hard-delete-worker.ts"],
      {
        encoding: "utf8",
        env: { NODE_ENV: "production", PATH: process.env.PATH, ...env },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(result.stderr).toContain("Hard Delete Worker stopped");
  }
});
test("Hard Delete security event exact allowlist and opaque fingerprint", () => {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof original;
  try {
    hardDeleteSecurityEvent(
      "0fe76ccd-0491-4140-8732-8382f826dd99",
      "USER",
      "secret-user-identity",
      "COMPLETED",
    );
  } finally {
    process.stdout.write = original;
  }
  const event = JSON.parse(output);
  expect(Object.keys(event).sort()).toEqual([
    "entityType",
    "fingerprint",
    "operationId",
    "status",
    "timestamp",
  ]);
  expect(event.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(output).not.toContain("secret-user-identity");
});
