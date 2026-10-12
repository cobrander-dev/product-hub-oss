import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { connectionEnvironment } = await import(
  pathToFileURL(
    resolve(import.meta.dirname, "../../scripts/backup-connection.mjs"),
  ).href
);
test("backup decodes URI parameters without putting a URI in PGDATABASE", () => {
  const password = "test-only:@$%\\'password";
  const result = connectionEnvironment(
    `postgresql://fixture_migration:${encodeURIComponent(password)}@postgres:5432/fixture_test`,
  );
  assert.deepEqual(result.fields, {
    PGHOST: "postgres",
    PGPORT: "5432",
    PGDATABASE: "fixture_test",
    PGUSER: "fixture_migration",
  });
  assert.equal(
    result.passfile,
    "postgres:5432:fixture_test:fixture_migration:" +
      password.replaceAll("\\", "\\\\").replaceAll(":", "\\:") +
      "\n",
  );
  assert.ok(!("PGPASSWORD" in result.fields));
});
test("backup handles IPv6 and explicit TLS options without silent fallback", () => {
  const result = connectionEnvironment(
    "postgresql://fixture_migration:fixture-password@[::1]:5432/fixture_test?sslmode=verify-full&connect_timeout=10",
  );
  assert.equal(result.fields.PGHOST, "::1");
  assert.equal(result.fields.PGSSLMODE, "verify-full");
  assert.equal(result.fields.PGCONNECT_TIMEOUT, "10");
  assert.ok(result.passfile.startsWith("\\:\\:1:5432:"));
});
test("backup rejects malformed and unrecognized connection options", () => {
  for (const value of [
    "not-a-uri",
    "https://example.com",
    "postgresql://user:password@host/db?constructor=value",
    "postgresql://user:password@host/db?sslmode=require&sslmode=disable",
    "postgresql://user:password%0Asecond@host/db",
  ]) {
    assert.throws(() => connectionEnvironment(value));
  }
});
