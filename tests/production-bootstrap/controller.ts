import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  loadProductionConfig,
  databaseUrl,
} from "../../scripts/installer/config";
import { readBoundedInput } from "../../scripts/installer/input";

const [action, root, project, tag, revision] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const domain =
  process.env.PRODUCT_HUB_BOOTSTRAP_TEST_DOMAIN || "product-hub.example.com";
assert.match(domain, /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i);
assert.match(project, /^product-hub-bootstrap-[a-f0-9]{8}$/);
assert.match(
  root,
  /^\/var\/lib\/docker\/volumes\/product-hub-bootstrap-config-[a-f0-9]{8}\/_data$/,
);
const inputFile = join(root, "config/source.env");
const logFile = join(root, "safe-output.log");
const checkout = join(root, "checkout");
let safeStageOutput = "";
const env = {
  ...process.env,
  PRODUCT_HUB_ENV_FILE: inputFile,
  PRODUCT_HUB_RELEASE_REVISION: revision,
};
function invoke(
  script: string,
  args: string[] = [],
  input?: string,
  expected = 0,
) {
  const result = spawnSync(
    process.execPath,
    ["./node_modules/tsx/dist/cli.mjs", script, ...args],
    {
      cwd: checkout,
      env,
      input,
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  const config = loadProductionConfig(inputFile);
  for (const secret of [
    config.authSecret,
    ...Object.values(config.roles).flatMap((role) => [role.password, role.url]),
  ])
    assert.ok(!output.includes(secret), "credential in output");
  writeFileSync(logFile, output, { flag: "a", mode: 0o600 });
  safeStageOutput = output
    .split(/\r?\n/)
    .filter((line) =>
      /^(STEP: [A-Z_]+|PASS:|FAIL:|DATABASE:|MIGRATIONS:)/.test(line),
    )
    .join("\n");
  assert.equal(result.status, expected, `safe stage output: ${output}`);
  return output;
}
async function concurrentBootstrap(password: string) {
  const attempts = await Promise.all(
    [1, 2].map(
      () =>
        new Promise<{ code: number | null; output: string }>(
          (resolveAttempt, reject) => {
            const child = spawn(
              process.execPath,
              [
                "./node_modules/tsx/dist/cli.mjs",
                "scripts/installer/production-cli.ts",
                "bootstrap-admin",
                "--username",
                "installer_admin",
                "--name",
                "安装测试管理员",
                "--password-stdin",
              ],
              { cwd: checkout, env, stdio: ["pipe", "pipe", "pipe"] },
            );
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => {
              output += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              output += chunk.toString();
            });
            child.once("error", reject);
            const timeout = setTimeout(() => child.kill(), 180000);
            child.once("close", (code) => {
              clearTimeout(timeout);
              resolveAttempt({ code, output });
            });
            child.stdin.end(password + "\n");
          },
        ),
    ),
  );
  const config = loadProductionConfig(inputFile);
  for (const result of attempts) {
    for (const secret of [
      password,
      config.authSecret,
      ...Object.values(config.roles).flatMap((role) => [
        role.password,
        role.url,
      ]),
    ])
      assert.ok(!result.output.includes(secret));
    writeFileSync(logFile, result.output, { flag: "a", mode: 0o600 });
  }
  assert.deepEqual(
    attempts.map((result) => result.code).sort(),
    [0, 1],
    "concurrent initial Admin creates exactly one account",
  );
}
function docker(args: string[]) {
  const result = spawnSync("docker", args, {
    cwd: checkout,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, "Docker test command failed");
  return (
    args[0] === "logs" ? result.stdout + result.stderr : result.stdout
  ).trim();
}
function containers() {
  return JSON.parse(
    docker([
      "inspect",
      ...docker([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
        .split("\n")
        .filter(Boolean),
    ]),
  ) as Array<{
    Id: string;
    State: { StartedAt: string; Health?: { Status: string } };
    Config: { Labels: Record<string, string> };
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  }>;
}
async function query<T>(work: (client: Client) => Promise<T>) {
  const config = loadProductionConfig(inputFile);
  const postgres = containers().find(
    (container) =>
      container.Config.Labels["com.docker.compose.service"] === "postgres",
  )!;
  const host =
    postgres.NetworkSettings.Networks[`${project}_product_hub_backend`]!
      .IPAddress;
  const client = new Client({
    connectionString: databaseUrl(
      config.roles.admin.user,
      config.roles.admin.password,
      host,
      5432,
      config.dbName,
    ),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
async function snapshot() {
  const ids = containers()
    .map((container) => ({
      service: container.Config.Labels["com.docker.compose.service"],
      id: container.Id,
      startedAt: container.State.StartedAt,
    }))
    .sort((a, b) => a.service!.localeCompare(b.service!));
  const counts = await query(
    async (client) =>
      (
        await client.query(
          'SELECT (SELECT count(*) FROM "User")::int AS users, (SELECT count(*) FROM "Product")::int AS products, (SELECT count(*) FROM "FactoryQuote")::int AS quotes, (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS migrations',
        )
      ).rows[0],
  );
  return { ids, counts };
}
async function main() {
  if (action === "setup") {
    mkdirSync(checkout, { mode: 0o700 });
    for (const path of [
      "scripts",
      "prisma",
      "docker/postgres/init-production",
      "deploy/templates",
      "compose.yaml",
      "compose.production.yaml",
      "compose.hard-delete.yaml",
      "compose.bootstrap.yaml",
      ".env.production.example",
      "package.json",
      "prisma.config.ts",
    ])
      cpSync(join("/app", path), join(checkout, path), { recursive: true });
    symlinkSync("/app/node_modules", join(checkout, "node_modules"), "dir");
    for (const path of [
      "config",
      "config/postgres",
      "config/postgres/init-production",
      "releases",
      "backups",
    ])
      mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
    const fields = Object.fromEntries(
      readFileSync(".env.production.example", "utf8")
        .split(/\r?\n/)
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    Object.assign(fields, {
      APP_DOMAIN: `${domain}:34443`,
      BETTER_AUTH_URL: `https://${domain}:34443`,
      BETTER_AUTH_TRUSTED_ORIGINS: `https://${domain}:34443`,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      POSTGRES_DB: `bootstrap_${project.slice(-8)}_test`,
      POSTGRES_ADMIN_USER: "bootstrap_admin",
      POSTGRES_MIGRATION_USER: "bootstrap_migration",
      POSTGRES_APP_USER: "bootstrap_app",
      HARD_DELETE_WORKER_DB_USER: "bootstrap_worker",
      POSTGRES_ADMIN_PASSWORD: randomBytes(32).toString("hex"),
      POSTGRES_MIGRATION_PASSWORD: randomBytes(32).toString("hex"),
      POSTGRES_APP_PASSWORD: randomBytes(32).toString("hex") + "@:$%'\\",
      HARD_DELETE_WORKER_DB_PASSWORD: randomBytes(32).toString("hex"),
      APP_PORT: "33443",
      PRODUCT_HUB_COMPOSE_PROJECT: project,
      PRODUCT_HUB_CONFIG_ROOT: join(root, "config"),
      PRODUCT_HUB_POSTGRES_INIT_DIR: join(
        root,
        "config/postgres/init-production",
      ),
      PRODUCT_HUB_RELEASE_FILE: join(root, "releases/compose.release.yaml"),
      PRODUCT_HUB_BACKUP_ROOT: join(root, "backups"),
    });
    writeFileSync(
      inputFile,
      Object.entries(fields)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    invoke("scripts/installer/cli.ts", ["preflight"]);
    invoke("scripts/installer/cli.ts", [
      "configure",
      "--runner-image",
      `product-hub:${tag}`,
      "--migrator-image",
      `product-hub-migrator:${tag}`,
      "--worker-image",
      `product-hub-hard-delete-worker:${tag}`,
    ]);
    // Keep the developer's native image and existing database untouched.
    const postgres = readFileSync(
      "/app/deploy/releases/postgres-linux-amd64.txt",
      "utf8",
    ).trim();
    assert.match(postgres, /^postgres@sha256:[0-9a-f]{64}$/);
    writeFileSync(
      fields.PRODUCT_HUB_RELEASE_FILE!,
      `  postgres:\n    image: ${postgres}\n    platform: linux/amd64\n`,
      { flag: "a" },
    );
  } else if (action === "install" || action === "doctor") {
    process.stdout.write(
      invoke("scripts/installer/production-cli.ts", [action]),
    );
  } else if (action === "bootstrap-admin") {
    const password = (await readBoundedInput(512)).trim();
    await concurrentBootstrap(password);
    invoke(
      "scripts/installer/production-cli.ts",
      [
        "bootstrap-admin",
        "--username",
        "other_admin",
        "--name",
        "不可重复创建",
        "--password-stdin",
      ],
      password + "\n",
      1,
    );
    assert.equal(
      (
        await query((client) =>
          client.query(
            "SELECT count(*)::int AS count FROM \"User\" WHERE role='ADMIN'",
          ),
        )
      ).rows[0].count,
      1,
    );
  } else if (action === "snapshot") {
    writeFileSync(
      join(root, "snapshot.json"),
      JSON.stringify(await snapshot()),
      { mode: 0o600 },
    );
  } else if (action === "preserved") {
    assert.deepEqual(
      await snapshot(),
      JSON.parse(readFileSync(join(root, "snapshot.json"), "utf8")),
    );
  } else if (action === "failures") {
    const before = await snapshot();
    const file = join(root, "config/worker-secrets/database-url");
    chmodSync(file, 0o444);
    const badMode = invoke(
      "scripts/installer/production-cli.ts",
      ["install"],
      undefined,
      1,
    );
    assert.ok(!badMode.includes("STEP: POSTGRES_START"));
    chmodSync(file, 0o400);
    const config = loadProductionConfig(inputFile);
    await query((client) =>
      client.query(`GRANT UPDATE ON "ActivityLog" TO ${config.roles.app.user}`),
    );
    invoke("scripts/installer/production-cli.ts", ["doctor"], undefined, 1);
    assert.equal(
      (
        await query((client) =>
          client.query(
            "SELECT has_table_privilege($1,'public.\"ActivityLog\"','UPDATE') AS allowed",
            [config.roles.app.user],
          ),
        )
      ).rows[0].allowed,
      true,
      "doctor must not repair grants",
    );
    await query((client) =>
      client.query(
        `REVOKE UPDATE ON "ActivityLog" FROM ${config.roles.app.user}`,
      ),
    );
    const worker = containers().find(
      (container) =>
        container.Config.Labels["com.docker.compose.service"] ===
        "hard-delete-worker",
    )!;
    // Explicit test-only pause/recovery prevents background restart races during a password fault.
    docker(["stop", "--time", "30", worker.Id]);
    await query(async (client) => {
      const statement = await client.query(
        "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
        [config.roles.worker.user, randomBytes(32).toString("hex")],
      );
      await client.query(statement.rows[0].sql);
    });
    invoke("scripts/installer/production-cli.ts", ["doctor"], undefined, 1);
    await query(async (client) => {
      const statement = await client.query(
        "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
        [config.roles.worker.user, config.roles.worker.password],
      );
      await client.query(statement.rows[0].sql);
    });
    docker(["start", worker.Id]);
    await new Promise((resolveReady) => setTimeout(resolveReady, 5000));
    await query((client) =>
      client.query(
        `INSERT INTO "_prisma_migrations" (id,checksum,migration_name,started_at,applied_steps_count) VALUES ('disposable-failure-probe','test','disposable_failure',now(),0)`,
      ),
    );
    const failedMigration = invoke(
      "scripts/installer/production-cli.ts",
      ["install"],
      undefined,
      1,
    );
    assert.ok(failedMigration.includes("FAILED_MIGRATION"));
    assert.ok(!failedMigration.includes("STEP: RUNTIME_GRANTS"));
    await query((client) =>
      client.query(
        "DELETE FROM \"_prisma_migrations\" WHERE id='disposable-failure-probe'",
      ),
    );
    const app = containers().find(
      (container) =>
        container.Config.Labels["com.docker.compose.service"] === "app",
    )!;
    docker(["stop", "--time", "30", app.Id]);
    const failedHealth = invoke(
      "scripts/installer/production-cli.ts",
      ["doctor"],
      undefined,
      1,
    );
    assert.ok(failedHealth.includes("APP_READ_ONLY/PROCESS_UNHEALTHY"));
    docker(["start", app.Id]);
    await new Promise((resolveReady) => setTimeout(resolveReady, 5000));
    const after = await snapshot();
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(
      after.ids.find((item) => item.service === "postgres"),
      before.ids.find((item) => item.service === "postgres"),
    );
    const host = spawnSync(
      process.execPath,
      [
        "-e",
        "require('node:fs').accessSync(process.argv[1], require('node:fs').constants.R_OK)",
        file,
      ],
      { uid: 1001, gid: 1001, encoding: "utf8" },
    );
    assert.notEqual(
      host.status,
      0,
      "host UID1001 must not traverse the original path",
    );
    assert.equal(statSync(dirnameOf(file)).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o400);
    const postgres = containers().find(
      (container) =>
        container.Config.Labels["com.docker.compose.service"] === "postgres",
    )!;
    // Deliberate test-only service stops; doctor must not start anything itself.
    docker(["stop", "--time", "30", app.Id, worker.Id]);
    docker(["stop", "--time", "30", postgres.Id]);
    const notReady = invoke(
      "scripts/installer/production-cli.ts",
      ["doctor"],
      undefined,
      1,
    );
    assert.ok(notReady.includes("DATABASE_READ_ONLY/DATABASE_NOT_READY"));
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", postgres.Id]),
      "false",
    );
    docker(["start", postgres.Id]);
    const deadline = Date.now() + 90000;
    while (
      containers().find((container) => container.Id === postgres.Id)?.State
        .Health?.Status !== "healthy"
    ) {
      assert.ok(
        Date.now() < deadline,
        "explicit test recovery must become healthy",
      );
      await new Promise((resolveReady) => setTimeout(resolveReady, 1000));
    }
    docker(["start", worker.Id, app.Id]);
    await new Promise((resolveReady) => setTimeout(resolveReady, 5000));
    assert.deepEqual((await snapshot()).counts, before.counts);
  } else if (action === "backup") {
    invoke("scripts/installer/production-cli.ts", ["backup"]);
    const sets = readdirSync(join(root, "backups"));
    assert.equal(sets.length, 1);
    const directory = join(root, "backups", sets[0]!);
    for (const name of [
      "database.dump",
      "uploads.tar.gz",
      "manifest.txt",
      "CHECKSUMS",
      "COMPLETE",
    ])
      assert.ok(statSync(join(directory, name)).isFile());
    const checksum = spawnSync("sha256sum", ["--check", "CHECKSUMS"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(checksum.status, 0);
    assert.equal(
      readFileSync(join(directory, "uploads-files.sha256"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
    assert.ok(
      readFileSync(join(directory, "manifest.txt"), "utf8").includes(
        "stored_object_count=1\n",
      ),
    );
  } else if (action === "verify-smoke") {
    const result = await query((client) =>
      client.query(
        `SELECT (SELECT count(*) FROM "User" WHERE role='ADMIN')::int AS admins, (SELECT count(*) FROM "User" WHERE role='FACTORY')::int AS users, (SELECT count(*) FROM "Product")::int AS products, (SELECT count(*) FROM "ProductFactoryAssignment")::int AS assignments, (SELECT count(*) FROM "FactoryQuote")::int AS quotes, (SELECT count(*) FROM "PriceHistory")::int AS history, (SELECT count(*) FROM "ActivityLog")::int AS activity, (SELECT count(*) FROM "HardDeleteOperation" WHERE status='COMPLETED')::int AS completed, (SELECT count(*) FROM "Category" WHERE name='安装测试待删分类')::int AS deleted`,
      ),
    );
    const { activity, ...counts } = result.rows[0];
    assert.ok(activity >= 8, "normal business writes retain ActivityLog");
    assert.deepEqual(counts, {
      admins: 1,
      users: 1,
      products: 2,
      assignments: 1,
      quotes: 1,
      history: 1,
      completed: 1,
      deleted: 0,
    });
  } else if (action === "credential-isolation") {
    const config = loadProductionConfig(inputFile);
    const list = JSON.parse(
      docker([
        "inspect",
        ...docker([
          "ps",
          "-aq",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ])
          .split("\n")
          .filter(Boolean),
      ]),
    ) as Array<{
      Id: string;
      Config: { Labels: Record<string, string>; Env: string[] };
      Mounts: Array<{ Destination: string }>;
    }>;
    for (const service of ["app", "hard-delete-worker"] as const) {
      const container = list.find(
        (item) => item.Config.Labels["com.docker.compose.service"] === service,
      )!;
      const serialized = container.Config.Env.join("\n");
      for (const role of service === "app"
        ? (["admin", "migration", "worker"] as const)
        : (["admin", "migration", "app"] as const))
        for (const value of [
          config.roles[role].password,
          config.roles[role].url,
        ])
          assert.ok(!serialized.includes(value));
      if (service === "app")
        docker([
          "exec",
          container.Id,
          "node",
          "-e",
          "if(process.getuid()!==1001||process.getgid()!==1001||require('node:fs').existsSync('/run/secrets/hard_delete_worker_database_url'))process.exit(1)",
        ]);
      else {
        assert.ok(!serialized.includes(config.authSecret));
        docker([
          "exec",
          container.Id,
          "node",
          "scripts/installer/worker-probe.mjs",
        ]);
      }
    }
    docker([
      "compose",
      "--env-file",
      config.runtimeFile,
      "-p",
      project,
      "-f",
      "compose.yaml",
      "-f",
      "compose.production.yaml",
      "-f",
      config.releaseFile,
      "--profile",
      "operations",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "migration",
      "node",
      "-e",
      "if(process.getuid()!==1000||process.env.BETTER_AUTH_SECRET||process.env.ADMIN_DATABASE_URL||process.env.HARD_DELETE_WORKER_DB_PASSWORD||process.env.HARD_DELETE_WORKER_DATABASE_URL||require('node:fs').existsSync('/run/secrets/hard_delete_worker_database_url'))process.exit(1)",
    ]);
  } else if (action === "scan") {
    const passwords = (await readBoundedInput(2048))
      .split(/\r?\n/)
      .filter(Boolean);
    const config = loadProductionConfig(inputFile);
    const logs =
      containers()
        .map((container) => docker(["logs", container.Id]))
        .join("\n") +
      readFileSync(logFile, "utf8") +
      readFileSync(config.releaseFile, "utf8");
    for (const value of [
      config.authSecret,
      ...passwords,
      ...Object.values(config.roles).flatMap((role) => [
        role.password,
        role.url,
      ]),
    ])
      assert.ok(
        !logs.includes(value),
        "credential in logs or generated Compose",
      );
  } else throw new Error("Unknown disposable action");
  process.stdout.write(`PASS: disposable ${action}\n`);
}
function dirnameOf(path: string) {
  return path.slice(0, path.lastIndexOf("/"));
}
main().catch(async () => {
  if (safeStageOutput) process.stderr.write(safeStageOutput + "\n");
  if (safeStageOutput.includes("DATABASE_AUTHENTICATION_FAILED")) {
    try {
      const config = loadProductionConfig(inputFile);
      const list = JSON.parse(
        docker([
          "inspect",
          ...docker([
            "ps",
            "-aq",
            "--filter",
            `label=com.docker.compose.project=${project}`,
            "--filter",
            "label=com.docker.compose.service=postgres",
          ])
            .split("\n")
            .filter(Boolean),
        ]),
      );
      const postgres = list[0];
      const host =
        postgres.NetworkSettings.Networks[`${project}_product_hub_backend`]
          .IPAddress;
      const actual = Object.fromEntries(
        postgres.Config.Env.map((value: string) => {
          const i = value.indexOf("=");
          return [value.slice(0, i), value.slice(i + 1)];
        }),
      );
      for (const [name, key] of [
        ["admin", "POSTGRES_PASSWORD"],
        ["migration", "MIGRATION_DB_PASSWORD"],
        ["app", "APP_DB_PASSWORD"],
      ] as const) {
        const client = new Client({
          connectionString: databaseUrl(
            config.roles[name].user,
            config.roles[name].password,
            host,
            5432,
            config.dbName,
          ),
          connectionTimeoutMillis: 5000,
        });
        let ok = false;
        try {
          await client.connect();
          ok = true;
        } catch {
          /* Credentials must never be emitted. */
        } finally {
          await client.end().catch(() => undefined);
        }
        process.stderr.write(
          `FAIL: disposable ${name} diagnostic; envMatch=${actual[key] === config.roles[name].password}; login=${ok}\n`,
        );
      }
    } catch {
      process.stderr.write(
        "FAIL: disposable identity diagnostic unavailable\n",
      );
    }
  }
  process.stderr.write(
    "FAIL: disposable controller assertion; no credential output\n",
  );
  process.exitCode = 1;
});
