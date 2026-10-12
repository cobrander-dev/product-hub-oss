import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  ConfigFailure,
  databaseUrl,
  loadProductionConfig,
  validateWorkerPermissionFacts,
  writeReleaseFiles,
} from "../../scripts/installer/config";

const projectRoot = resolve(import.meta.dirname, "../..");
const cli = join(projectRoot, "scripts/installer/cli.ts");
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const secretMarker = "UNIQUE-TEST-SECRET-DO-NOT-PRINT";
function isolatedEnvironment(extra: Record<string, string> = {}) {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const name of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
  ])
    if (process.env[name]) environment[name] = process.env[name];
  return { ...environment, ...extra };
}

function fixture(overrides: Record<string, string> = {}) {
  const exampleFields = Object.fromEntries(
    readFileSync(join(projectRoot, ".env.production.example"), "utf8")
      .split(/\r?\n/)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const root = mkdtempSync(join(tmpdir(), "product-hub-installer-"));
  const configRoot = join(root, "config");
  const initDir = join(configRoot, "postgres/init-production");
  const releaseDir = join(root, "releases");
  mkdirSync(initDir, { recursive: true, mode: 0o700 });
  mkdirSync(releaseDir, { mode: 0o700 });
  chmodSync(configRoot, 0o700);
  chmodSync(dirname(initDir), 0o700);
  chmodSync(initDir, 0o700);
  const input = join(configRoot, "product-hub.env");
  const release = join(releaseDir, "compose.release.yaml");
  const fields: Record<string, string> = {
    ...exampleFields,
    APP_DOMAIN: "product-hub.example.com",
    BETTER_AUTH_URL: "https://product-hub.example.com",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://product-hub.example.com",
    BETTER_AUTH_SECRET: `${secretMarker}-long-enough`,
    POSTGRES_DB: "product_hub",
    POSTGRES_ADMIN_USER: "fixture_admin",
    POSTGRES_ADMIN_PASSWORD: `${secretMarker}-admin`,
    POSTGRES_MIGRATION_USER: "fixture_migration",
    POSTGRES_MIGRATION_PASSWORD: `${secretMarker}-migration`,
    POSTGRES_APP_USER: "fixture_app",
    POSTGRES_APP_PASSWORD: `${secretMarker}-app@:#$%/'\\tail`,
    HARD_DELETE_WORKER_DB_USER: "fixture_worker",
    HARD_DELETE_WORKER_DB_PASSWORD: `${secretMarker}-worker`,
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: "5432",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: "/data/uploads",
    APP_PORT: "3000",
    PRODUCT_HUB_CONFIG_ROOT: configRoot,
    PRODUCT_HUB_POSTGRES_INIT_DIR: initDir,
    PRODUCT_HUB_RELEASE_FILE: release,
    ...overrides,
  };
  const save = () => {
    writeFileSync(
      input,
      Object.entries(fields)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    chmodSync(input, 0o600);
  };
  save();
  return {
    root,
    input,
    release,
    fields,
    save,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function invoke(
  input: string,
  command: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [tsx, cli, command, ...args], {
    cwd: projectRoot,
    env: isolatedEnvironment({ PRODUCT_HUB_ENV_FILE: input, ...extraEnv }),
    encoding: "utf8",
  });
}

const imageArgs = [
  "--runner-image",
  "product-hub:fixture",
  "--migrator-image",
  "product-hub-migrator:fixture",
  "--worker-image",
  "product-hub-hard-delete-worker:fixture",
];

test("runtime env preserves passwords ending in a backslash through real Compose parsing", () => {
  const sample = fixture({
    POSTGRES_APP_PASSWORD: `${secretMarker}@:$EXPAND_MUST_NOT%'\\`,
  });
  try {
    const config = loadProductionConfig(sample.input);
    writeReleaseFiles(
      config,
      {
        runner: "product-hub:fixture",
        migrator: "product-hub-migrator:fixture",
        worker: "product-hub-hard-delete-worker:fixture",
      },
      readFileSync(
        join(projectRoot, "deploy/templates/compose.release.yaml.template"),
        "utf8",
      ),
      false,
    );
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        config.runtimeFile,
        "-f",
        join(projectRoot, "compose.yaml"),
        "-f",
        join(projectRoot, "compose.production.yaml"),
        "-f",
        config.releaseFile,
        "--profile",
        "operations",
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8", env: isolatedEnvironment() },
    );
    assert.equal(result.status, 0, "Compose parsing must succeed");
    const actual = JSON.parse(result.stdout).services.postgres.environment
      .APP_DB_PASSWORD as string;
    assert.ok(
      actual === config.roles.app.password ||
        actual === config.roles.app.password.split("$").join("$$"),
      "Compose must preserve exact credential bytes; values suppressed",
    );
  } finally {
    sample.cleanup();
  }
});

test("valid structured config derives encoded URLs and preserves role overrides", () => {
  const sample = fixture();
  try {
    const config = loadProductionConfig(sample.input);
    assert.equal(config.roles.app.user, "fixture_app");
    assert.ok(config.roles.app.url.includes("%40%3A%23%24%25%2F"));
    assert.equal(invoke(sample.input, "preflight").status, 0);
    assert.ok(
      databaseUrl("app", "p@:#$%/'", "[2001:db8::1]", 5432, "db").includes(
        "p%40%3A%23%24%25%2F%27@[2001:db8::1]",
      ),
    );
    sample.fields.POSTGRES_HOST = "[2001:db8::1]";
    sample.save();
    assert.equal(loadProductionConfig(sample.input).dbHost, "[2001:db8::1]");
  } finally {
    sample.cleanup();
  }
});

test("legacy explicit URLs remain compatible but conflicting aliases and URLs fail closed", () => {
  const sample = fixture();
  try {
    for (const [modern, legacy] of [
      ["POSTGRES_ADMIN_USER", "POSTGRES_USER"],
      ["POSTGRES_ADMIN_PASSWORD", "POSTGRES_PASSWORD"],
      ["POSTGRES_MIGRATION_USER", "MIGRATION_DB_USER"],
      ["POSTGRES_MIGRATION_PASSWORD", "MIGRATION_DB_PASSWORD"],
      ["POSTGRES_APP_USER", "APP_DB_USER"],
      ["POSTGRES_APP_PASSWORD", "APP_DB_PASSWORD"],
    ]) {
      sample.fields[legacy] = sample.fields[modern]!;
      delete sample.fields[modern];
    }
    const roles = [
      ["ADMIN_DATABASE_URL", "POSTGRES_USER", "POSTGRES_PASSWORD"],
      ["MIGRATION_DATABASE_URL", "MIGRATION_DB_USER", "MIGRATION_DB_PASSWORD"],
      ["APP_DATABASE_URL", "APP_DB_USER", "APP_DB_PASSWORD"],
    ];
    for (const [urlKey, userKey, passwordKey] of roles)
      sample.fields[urlKey] = databaseUrl(
        sample.fields[userKey]!,
        sample.fields[passwordKey]!,
        "postgres",
        5432,
        "product_hub",
      );
    sample.save();
    assert.equal(invoke(sample.input, "preflight").status, 0);
    sample.fields.POSTGRES_APP_USER = "different_app";
    sample.save();
    assert.equal(invoke(sample.input, "preflight").status, 1);
    delete sample.fields.POSTGRES_APP_USER;
    sample.fields.APP_DATABASE_URL = sample.fields.ADMIN_DATABASE_URL;
    sample.save();
    assert.equal(invoke(sample.input, "preflight").status, 1);
    sample.fields.APP_DATABASE_URL = databaseUrl(
      sample.fields.APP_DB_USER!,
      sample.fields.APP_DB_PASSWORD!,
      "postgres",
      5432,
      "product_hub",
    );
    sample.fields.PRODUCT_HUB_RELEASE_FILE = join(projectRoot, "unsafe.yaml");
    sample.save();
    assert.equal(invoke(sample.input, "preflight").status, 1);
    sample.fields.PRODUCT_HUB_RELEASE_FILE = join(
      projectRoot,
      "compose.release.fixture.yaml",
    );
    sample.save();
    assert.equal(invoke(sample.input, "preflight").status, 0);
  } finally {
    sample.cleanup();
  }
});

test("missing, HTTP, wildcard, mismatched origin and duplicate roles fail without secrets", () => {
  const cases: Record<string, string>[] = [
    { BETTER_AUTH_SECRET: "" },
    { APP_DOMAIN: "*.example.com" },
    { BETTER_AUTH_URL: "http://product-hub.example.com" },
    { BETTER_AUTH_TRUSTED_ORIGINS: "https://other.example.com" },
    { POSTGRES_APP_USER: "fixture_admin" },
    { POSTGRES_HOST: "database.example.com:5432" },
    { POSTGRES_APP_PASSWORD: `${secretMarker}-admin` },
  ];
  for (const change of cases) {
    const sample = fixture(change);
    try {
      const result = invoke(sample.input, "preflight");
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("FAIL:"));
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secretMarker));
    } finally {
      sample.cleanup();
    }
  }
});

test("unsafe env modes and Worker secret permission facts are rejected", () => {
  const sample = fixture();
  try {
    chmodSync(sample.input, 0o644);
    assert.throws(() => loadProductionConfig(sample.input), ConfigFailure);
    assert.equal(invoke(sample.input, "preflight").status, 1);
    assert.equal(
      validateWorkerPermissionFacts(
        { uid: 0, gid: 0, mode: 0o700 },
        { uid: 1001, gid: 1001, mode: 0o400 },
      ),
      true,
    );
    for (const [parent, file] of [
      [
        { uid: 0, gid: 0, mode: 0o755 },
        { uid: 1001, gid: 1001, mode: 0o400 },
      ],
      [
        { uid: 1001, gid: 1001, mode: 0o700 },
        { uid: 1001, gid: 1001, mode: 0o400 },
      ],
      [
        { uid: 0, gid: 0, mode: 0o700 },
        { uid: 1001, gid: 1001, mode: 0o444 },
      ],
    ])
      assert.equal(validateWorkerPermissionFacts(parent, file), false);
    chmodSync(sample.input, 0o600);
    const workerParent = join(sample.root, "worker-secret");
    mkdirSync(workerParent, { mode: 0o700 });
    const workerSecret = join(workerParent, "database-url");
    writeFileSync(workerSecret, "placeholder", { mode: 0o400 });
    sample.fields.HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE = workerSecret;
    sample.save();
    const workerResult = invoke(sample.input, "preflight");
    assert.equal(workerResult.status, 1);
    assert.ok(workerResult.stderr.includes("UNSAFE_WORKER_SECRET_PERMISSIONS"));
    assert.ok(!workerResult.stderr.includes(secretMarker));
  } finally {
    sample.cleanup();
  }
});

test("clean temporary installation simulation generates deterministic secret-free Compose", () => {
  const sample = fixture();
  try {
    const bin = join(sample.root, "bin");
    mkdirSync(bin, { mode: 0o700 });
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      '#!/bin/sh\n[ "$1 $2" = "image inspect" ] || exit 1\nprintf \'sha256:fixture|linux|%s\\n\' "${FAKE_IMAGE_ARCHITECTURE:-amd64}"\n',
      { mode: 0o700 },
    );
    const fakeDocker = { PATH: `${bin}:${process.env.PATH || ""}` };
    assert.equal(invoke(sample.input, "preflight").status, 0);
    const mutable = invoke(
      sample.input,
      "configure",
      [...imageArgs.slice(0, -1), "product-hub:latest"],
      fakeDocker,
    );
    assert.equal(mutable.status, 1);
    assert.ok(mutable.stderr.includes("INVALID_IMAGE_REFERENCE"));
    const rejected = invoke(sample.input, "configure", imageArgs, {
      ...fakeDocker,
      FAKE_IMAGE_ARCHITECTURE: "arm64",
    });
    assert.equal(rejected.status, 1);
    assert.ok(rejected.stderr.includes("IMAGE_ARCHITECTURE"));
    const first = invoke(sample.input, "configure", imageArgs, fakeDocker);
    assert.equal(first.status, 0);
    assert.ok(!`${first.stdout}${first.stderr}`.includes(secretMarker));
    const compose = readFileSync(sample.release, "utf8");
    const runtimeFile = join(dirname(sample.input), "product-hub.resolved.env");
    const runtime = readFileSync(runtimeFile, "utf8");
    assert.equal(statSync(runtimeFile).mode & 0o777, 0o600);
    assert.ok(compose.includes("DO NOT EDIT"));
    assert.ok(!compose.includes(secretMarker));
    assert.ok(runtime.includes("APP_DATABASE_URL="));
    assert.ok(!runtime.includes("HARD_DELETE_WORKER_DATABASE_URL="));
    assert.equal(
      invoke(sample.input, "configure", imageArgs, fakeDocker).status,
      1,
    );
    assert.equal(
      invoke(sample.input, "configure", [...imageArgs, "--force"], fakeDocker)
        .status,
      0,
    );
    assert.equal(readFileSync(sample.release, "utf8"), compose);
    assert.equal(readFileSync(runtimeFile, "utf8"), runtime);
    const ignored = spawnSync("git", ["check-ignore", "compose.release.yaml"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(ignored.status, 0);
    assert.equal(
      spawnSync("git", ["check-ignore", "product-hub.resolved.env"], {
        cwd: projectRoot,
        encoding: "utf8",
      }).status,
      0,
    );
    const composeResult = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        runtimeFile,
        "-p",
        "product-hub",
        "-f",
        join(projectRoot, "compose.yaml"),
        "-f",
        join(projectRoot, "compose.production.yaml"),
        "-f",
        sample.release,
        "--profile",
        "operations",
        "config",
        "--format",
        "json",
      ],
      { cwd: projectRoot, encoding: "utf8", env: isolatedEnvironment() },
    );
    assert.equal(composeResult.status, 0);
    const model = JSON.parse(composeResult.stdout) as {
      services: Record<
        string,
        {
          image?: string;
          platform?: string;
          environment?: Record<string, string>;
        }
      >;
    };
    assert.equal(model.services.app?.image, "product-hub:fixture");
    assert.equal(
      model.services.migration?.image,
      "product-hub-migrator:fixture",
    );
    assert.equal(model.services.app?.platform, "linux/amd64");
    assert.equal(model.services.migration?.platform, "linux/amd64");
    assert.equal(
      model.services.app?.environment?.HARD_DELETE_WORKER_DB_PASSWORD,
      undefined,
    );
    assert.equal(
      model.services.migration?.environment?.HARD_DELETE_WORKER_DB_PASSWORD,
      undefined,
    );
    assert.equal(
      model.services.app?.environment?.DATABASE_URL,
      loadProductionConfig(sample.input).roles.app.url,
    );
    // Compose's normalized config escapes a literal dollar as $$ for replay.
    assert.ok(
      model.services.postgres?.environment?.APP_DB_PASSWORD ===
        sample.fields.POSTGRES_APP_PASSWORD ||
        model.services.postgres?.environment?.APP_DB_PASSWORD ===
          sample.fields.POSTGRES_APP_PASSWORD?.split("$").join("$$"),
    );
    const workerModelResult = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        runtimeFile,
        "-p",
        "product-hub",
        "-f",
        join(projectRoot, "compose.yaml"),
        "-f",
        join(projectRoot, "compose.production.yaml"),
        "-f",
        sample.release,
        "-f",
        join(projectRoot, "compose.hard-delete.yaml"),
        "--profile",
        "operations-hard-delete",
        "config",
        "--format",
        "json",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: isolatedEnvironment({
          HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE: join(
            sample.root,
            "fixture-worker-secret",
          ),
        }),
      },
    );
    assert.equal(workerModelResult.status, 0);
    const workerModel = JSON.parse(workerModelResult.stdout) as {
      services: Record<
        string,
        {
          image?: string;
          platform?: string;
          environment?: Record<string, string>;
        }
      >;
    };
    assert.equal(
      workerModel.services["hard-delete-worker"]?.image,
      "product-hub-hard-delete-worker:fixture",
    );
    assert.equal(
      workerModel.services["hard-delete-worker"]?.platform,
      "linux/amd64",
    );
    assert.equal(
      workerModel.services["hard-delete-worker"]?.environment
        ?.BETTER_AUTH_SECRET,
      undefined,
    );
    assert.equal(
      workerModel.services["hard-delete-worker"]?.environment
        ?.HARD_DELETE_WORKER_DB_PASSWORD,
      undefined,
    );
  } finally {
    sample.cleanup();
  }
});
