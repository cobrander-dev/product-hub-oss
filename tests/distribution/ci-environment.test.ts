import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("release CI creates isolated random inputs and cleans only its owned fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "product-hub-release-ci-test-"));
  const script = resolve("scripts/release/ci-environment.mjs");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "deploy/releases"), { recursive: true });
  writeFileSync(
    join(root, "deploy/releases/postgres-linux-amd64.txt"),
    `postgres@sha256:${"a".repeat(64)}\n`,
  );
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >>"$CI_TEST_LOG"\nexit 0\n',
    { mode: 0o755 },
  );
  const env = {
    NODE_ENV: "test" as const,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
    CI_TEST_LOG: join(root, "docker.log"),
  };
  const run = (action: string, extra = {}) =>
    spawnSync(process.execPath, [script, action], {
      cwd: root,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  try {
    assert.equal(run("prepare", { GITHUB_ACTIONS: "false" }).status, 1);
    assert.equal(existsSync(join(root, ".env")), false);
    const prepared = run("prepare");
    assert.equal(prepared.status, 0);
    const config = Object.fromEntries(
      readFileSync(join(root, ".env.test"), "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    assert.ok(new URL(config.DATABASE_URL!).pathname.endsWith("_test"));
    const password = new URL(config.DATABASE_URL!).password;
    for (const text of [
      prepared.stdout,
      prepared.stderr,
      readFileSync(env.CI_TEST_LOG, "utf8"),
    ])
      assert.ok(!text.includes(password));
    assert.match(config.BETTER_AUTH_SECRET!, /^[0-9a-f]{64}$/);
    assert.notEqual(config.BETTER_AUTH_SECRET, password);
    assert.equal(run("prepare").status, 1);
    assert.equal(run("cleanup", { GITHUB_RUN_ATTEMPT: "2" }).status, 1);
    assert.equal(existsSync(join(root, ".env")), true);
    assert.equal(run("cleanup").status, 0);
    for (const file of [".env", ".env.test", ".env.ci-db", ".env.ci-owner"])
      assert.equal(existsSync(join(root, file)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release workflow prepares every clean-runner prerequisite before verification", () => {
  const workflow = readFileSync(".github/workflows/release-images.yml", "utf8");
  assert.ok(
    workflow.indexOf("ci-environment.mjs prepare") <
      workflow.indexOf("pnpm ci:check"),
  );
  assert.match(workflow, /playwright install --with-deps chromium webkit/);
  assert.match(workflow, /pnpm prisma:generate/);
  assert.ok(
    workflow.indexOf("pnpm release:build:amd64") <
      workflow.indexOf("pnpm test:domain-neutral-release"),
  );
  assert.match(
    workflow,
    /if: always\(\) && inputs.mode == 'verification'\n\s+working-directory: source\n\s+run: node ..\/tooling\/scripts\/release\/ci-environment.mjs cleanup/,
  );
});
