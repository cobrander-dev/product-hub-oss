import { spawnSync } from "node:child_process";
import {
  constants,
  chownSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { z } from "zod";
import {
  atomicWrite,
  ConfigFailure,
  checkFilesystem,
  databaseUrl,
  renderRuntimeEnv,
  validateImageReference,
  type ProductionConfig,
} from "./config";
import { verifyDatabaseReadOnly, type DatabaseJobInput } from "./database-job";
import { repositoryRoot } from "./paths";

export class BootstrapFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function requireSafe(condition: unknown, code: string): asserts condition {
  if (!condition) throw new BootstrapFailure(code);
}
export async function runStages(
  stages: Array<{ name: string; run: () => unknown | Promise<unknown> }>,
  report: (value: string) => void = (value) =>
    process.stdout.write(value + "\n"),
) {
  for (const stage of stages) {
    report(`STEP: ${stage.name}`);
    try {
      await stage.run();
    } catch (error) {
      throw new BootstrapFailure(
        `${stage.name}/${error instanceof BootstrapFailure || error instanceof ConfigFailure ? error.code : "CHECK_FAILED"}`,
      );
    }
    report(`PASS: ${stage.name}`);
  }
}

const serviceSchema = z
  .object({
    image: z.string().optional(),
    environment: z.record(z.string(), z.string()).default({}),
    ports: z
      .array(
        z
          .object({
            target: z.number(),
            published: z.string().optional(),
            host_ip: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    volumes: z
      .array(
        z
          .object({
            source: z.string(),
            target: z.string(),
            type: z.string(),
            read_only: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    secrets: z.array(z.unknown()).default([]),
    user: z.string().optional(),
    read_only: z.boolean().optional(),
    cap_drop: z.array(z.string()).default([]),
    security_opt: z.array(z.string()).default([]),
    networks: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
const modelSchema = z
  .object({
    services: z.record(z.string(), serviceSchema),
    networks: z.record(
      z.string(),
      z.object({ internal: z.boolean().optional() }).passthrough(),
    ),
    "x-product-hub-release": z.object({ "worker-image": z.string() }),
  })
  .passthrough();
const containerSchema = z
  .object({
    Id: z.string(),
    Image: z.string(),
    RestartCount: z.number(),
    State: z
      .object({
        Running: z.boolean(),
        OOMKilled: z.boolean(),
        Health: z.object({ Status: z.string() }).optional(),
      })
      .passthrough(),
    Config: z.object({
      Image: z.string(),
      User: z.string(),
      Env: z.array(z.string()),
      Labels: z.record(z.string(), z.string()),
    }),
    HostConfig: z
      .object({
        ReadonlyRootfs: z.boolean(),
        Privileged: z.boolean(),
        CapDrop: z.array(z.string()).nullable(),
        SecurityOpt: z.array(z.string()).nullable(),
        Memory: z.number(),
        PidsLimit: z.number().nullable(),
        PortBindings: z
          .record(
            z.string(),
            z
              .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
              .nullable(),
          )
          .nullable(),
      })
      .passthrough(),
    Mounts: z.array(
      z
        .object({
          Type: z.string(),
          Source: z.string(),
          Destination: z.string(),
          RW: z.boolean(),
          Name: z.string().optional(),
        })
        .passthrough(),
    ),
    NetworkSettings: z
      .object({
        Networks: z.record(
          z.string(),
          z.object({ IPAddress: z.string() }).passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
type Container = z.infer<typeof containerSchema>;
type Images = {
  runner: string;
  migrator: string;
  worker: string;
  postgres: string;
};
export interface Installation {
  config: ProductionConfig;
  images: Images;
  workerFile: string;
  revision: string;
}

function processEnvironment(extra: Record<string, string> = {}) {
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
function docker(
  args: string[],
  input?: string,
  extra: Record<string, string> = {},
  timeout = 180000,
) {
  return spawnSync("docker", args, {
    cwd: repositoryRoot(),
    env: processEnvironment(extra),
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}
function checked(
  args: string[],
  input?: string,
  extra: Record<string, string> = {},
  timeout?: number,
) {
  const result = docker(args, input, extra, timeout);
  requireSafe(result.status === 0, "DOCKER_COMMAND_FAILED");
  return result.stdout.trim();
}
function composeArgs(installation: Installation, overlays = false) {
  const { config } = installation;
  return [
    "compose",
    "--env-file",
    config.runtimeFile,
    "-p",
    config.projectName,
    "-f",
    join(repositoryRoot(), "compose.yaml"),
    "-f",
    join(repositoryRoot(), "compose.production.yaml"),
    "-f",
    config.releaseFile,
    ...(overlays
      ? [
          "-f",
          join(repositoryRoot(), "compose.hard-delete.yaml"),
          "-f",
          join(repositoryRoot(), "compose.bootstrap.yaml"),
          "--profile",
          "operations-hard-delete",
          "--profile",
          "operations-bootstrap",
        ]
      : []),
    "--profile",
    "operations",
  ];
}
function composeEnvironment(installation: Installation) {
  return {
    PRODUCT_HUB_MIGRATOR_IMAGE: installation.images.migrator,
    PRODUCT_HUB_POSTGRES_IMAGE: installation.images.postgres,
    HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE: installation.workerFile,
    PRODUCT_HUB_BACKUP_ROOT:
      installation.config.backupRoot || "/opt/product-hub/backups",
    PRODUCT_HUB_RELEASE_REVISION: installation.revision,
  };
}
function compose(
  installation: Installation,
  args: string[],
  input?: string,
  overlays = false,
) {
  return checked(
    [...composeArgs(installation, overlays), ...args],
    input,
    composeEnvironment(installation),
  );
}
function inspectContainer(id: string) {
  const result = docker(["inspect", "--type", "container", id]);
  if (result.status !== 0) return undefined;
  return z.array(containerSchema).parse(JSON.parse(result.stdout))[0];
}
function serviceContainer(installation: Installation, name: string) {
  const id = compose(
    installation,
    ["ps", "--all", "--quiet", name],
    undefined,
    name === "hard-delete-worker",
  );
  requireSafe(!id.includes("\n"), "MULTIPLE_SERVICE_CONTAINERS");
  return id ? inspectContainer(id) : undefined;
}
function environment(container: Container) {
  return Object.fromEntries(
    container.Config.Env.map((value) => {
      const index = value.indexOf("=");
      return [value.slice(0, index), value.slice(index + 1)];
    }),
  );
}

export function loadInstallation(config: ProductionConfig): Installation {
  requireSafe(process.platform === "linux", "LINUX_HOST_REQUIRED");
  requireSafe(
    Number(process.versions.node.split(".")[0]) >= 24,
    "NODE_24_REQUIRED",
  );
  requireSafe(
    checked(["info", "--format", "{{.OSType}}"], undefined, {}, 10000) ===
      "linux",
    "LINUX_DOCKER_REQUIRED",
  );
  const version = checked(["compose", "version", "--short"]);
  const parts = version.replace(/^v/, "").split(".").map(Number);
  requireSafe(
    parts[0]! > 2 || (parts[0] === 2 && parts[1]! >= 24),
    "COMPOSE_VERSION",
  );
  requireSafe(
    existsSync(config.runtimeFile) && existsSync(config.releaseFile),
    "RUN_RELEASE_CONFIGURE_FIRST",
  );
  const workerFile =
    config.workerSecretFile ||
    join(config.configRoot, "worker-secrets/database-url");
  const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot(),
    encoding: "utf8",
  });
  const revision =
    process.env.PRODUCT_HUB_RELEASE_REVISION ||
    revisionResult.stdout?.trim() ||
    "0000000000000000000000000000000000000000";
  requireSafe(/^[0-9a-f]{40}$/.test(revision), "INVALID_RELEASE_REVISION");
  const placeholder: Installation = {
    config,
    images: { runner: "", migrator: "", worker: "", postgres: "" },
    workerFile,
    revision,
  };
  const model = modelSchema.parse(
    JSON.parse(compose(placeholder, ["config", "--format", "json"])),
  );
  const images = {
    runner: validateImageReference(model.services.app?.image || ""),
    migrator: validateImageReference(model.services.migration?.image || ""),
    worker: validateImageReference(
      model["x-product-hub-release"]["worker-image"],
    ),
    postgres: validateImageReference(model.services.postgres?.image || ""),
  };
  const installation = { ...placeholder, images };
  const runtimeStat = lstatSync(config.runtimeFile);
  requireSafe(
    runtimeStat.isFile() &&
      !runtimeStat.isSymbolicLink() &&
      (runtimeStat.mode & 0o777) === 0o600 &&
      [0, process.getuid?.()].includes(runtimeStat.uid),
    "UNSAFE_RUNTIME_ENV",
  );
  const actual = readFileSync(config.runtimeFile, "utf8");
  requireSafe(
    actual === renderRuntimeEnv(config, images.worker) ||
      actual ===
        renderRuntimeEnv(
          { ...config, workerSecretFile: workerFile },
          images.worker,
        ),
    "SOURCE_RUNTIME_CONFIG_MISMATCH",
  );
  for (const image of Object.values(images)) {
    const facts = z
      .array(
        z
          .object({ Os: z.string(), Architecture: z.string(), Id: z.string() })
          .passthrough(),
      )
      .parse(JSON.parse(checked(["image", "inspect", image])))[0];
    requireSafe(
      facts?.Os === "linux" && facts.Architecture === "amd64",
      "IMAGE_ARCHITECTURE",
    );
  }
  assertCompose(installation);
  return installation;
}

function assertCompose(installation: Installation) {
  const model = modelSchema.parse(
    JSON.parse(
      compose(installation, ["config", "--format", "json"], undefined, true),
    ),
  );
  const { config } = installation;
  const app = model.services.app!;
  const worker = model.services["hard-delete-worker"]!;
  const migration = model.services.migration!;
  requireSafe(
    app && worker && migration && model.services.postgres,
    "COMPOSE_SERVICES",
  );
  requireSafe(
    app.ports.length === 1 &&
      app.ports[0]?.host_ip === "127.0.0.1" &&
      app.ports[0].target === 3000 &&
      app.ports[0].published === String(config.appPort),
    "LOOPBACK_BINDING_REQUIRED",
  );
  requireSafe(
    model.services.postgres.ports.length === 0 &&
      model.networks.product_hub_backend?.internal === true,
    "DATABASE_NETWORK_BOUNDARY",
  );
  requireSafe(
    app.environment.DATABASE_URL === config.roles.app.url &&
      migration.environment.DATABASE_URL === config.roles.migration.url,
    "APP_MIGRATION_IDENTITY",
  );
  requireSafe(
    app.secrets.length === 0 &&
      migration.secrets.length === 0 &&
      !app.environment.HARD_DELETE_WORKER_DB_PASSWORD &&
      !migration.environment.HARD_DELETE_WORKER_DB_PASSWORD &&
      !migration.environment.BETTER_AUTH_SECRET,
    "APP_MIGRATION_SECRET_ISOLATION",
  );
  requireSafe(
    worker.user === "1001:1001" &&
      worker.environment.HARD_DELETE_WORKER_DB_USER ===
        config.roles.worker.user &&
      !worker.environment.DATABASE_URL &&
      !worker.environment.BETTER_AUTH_SECRET &&
      !worker.environment.HARD_DELETE_WORKER_DATABASE_URL &&
      !worker.environment.HARD_DELETE_WORKER_DB_PASSWORD &&
      worker.ports.length === 0,
    "WORKER_SECRET_ISOLATION",
  );
  for (const name of ["database-job", "admin-bootstrap"] as const) {
    const service = model.services[name];
    requireSafe(
      service &&
        service.image === installation.images.migrator &&
        service.ports.length === 0 &&
        service.secrets.length === 0 &&
        service.volumes.length === 0 &&
        Object.keys(service.environment).every((key) => key === "NODE_ENV"),
      "ONE_SHOT_CREDENTIAL_BOUNDARY",
    );
  }
  requireSafe(
    worker.read_only &&
      worker.cap_drop.includes("ALL") &&
      worker.security_opt.includes("no-new-privileges:true"),
    "WORKER_HARDENING",
  );
}

function payload(
  installation: Installation,
  action: DatabaseJobInput["action"],
): DatabaseJobInput {
  const { roles } = installation.config;
  const common = {
    action,
    adminUser: roles.admin.user,
    migrationUser: roles.migration.user,
    appUser: roles.app.user,
    workerUser: roles.worker.user,
  };
  if (action === "migrations" || action === "grants")
    return { ...common, databaseUrl: roles.migration.url };
  if (action === "worker-provision")
    return {
      ...common,
      databaseUrl: roles.admin.url,
      workerUrl: roles.worker.url,
      workerPassword: roles.worker.password,
    };
  return {
    ...common,
    databaseUrl: roles.admin.url,
    migrationUrl: roles.migration.url,
    appUrl: roles.app.url,
    ...(action === "verify" ? { workerUrl: roles.worker.url } : {}),
  };
}
function databaseJob(
  installation: Installation,
  action: DatabaseJobInput["action"],
) {
  const execution = docker(
    [
      ...composeArgs(installation, true),
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "database-job",
    ],
    JSON.stringify(payload(installation, action)),
    composeEnvironment(installation),
  );
  const safeCodes = new Set([
    "DATABASE_OWNERSHIP",
    "DATABASE_ROLE_BOUNDARY",
    "DATABASE_IDENTITY",
    "UNKNOWN_DATABASE_OBJECTS",
    "UNRECOGNIZED_DATABASE",
    "FAILED_MIGRATION",
    "MIGRATION_HISTORY_MISMATCH",
    "MIGRATIONS_INCOMPLETE",
    "MISSING_CONNECTION",
    "WORKER_IDENTITY",
    "WORKER_PRIVILEGE_BOUNDARY",
    "FUNCTION_GRANT_BOUNDARY",
    "WORKER_FUNCTIONS_MISSING",
    "DATABASE_JOB_FAILED",
    "PRIVILEGE_JOB_FAILED",
    "MIGRATION_FAILED",
    "INPUT_JSON_INVALID",
    "INPUT_VALIDATION_FAILED",
    "DATABASE_AUTHENTICATION_FAILED",
    "DATABASE_NOT_FOUND",
    "DATABASE_PERMISSION_DENIED",
    "DATABASE_RELATION_MISSING",
    "DATABASE_COLUMN_MISSING",
    "DATABASE_UNREACHABLE",
    "DATABASE_HOST_UNRESOLVED",
  ]);
  const code = execution.stderr
    .split(/\r?\n/)
    .map((line) => /^FAIL: ([A-Z_]+)$/.exec(line)?.[1])
    .find((value) => value && safeCodes.has(value));
  requireSafe(execution.status === 0, code || "DATABASE_JOB_START_FAILED");
  const result = execution.stdout.trim();
  return z
    .object({
      ok: z.literal(true),
      state: z.string().optional(),
      applied: z.number().optional(),
      pending: z.number().optional(),
      failed: z.number().optional(),
    })
    .parse(JSON.parse(result));
}

function prepareInit(config: ProductionConfig) {
  const source = join(repositoryRoot(), "docker/postgres/init-production");
  const names = readdirSync(source).sort();
  requireSafe(
    readdirSync(config.initDir).every((name) => names.includes(name)),
    "UNREVIEWED_INIT_ARTIFACT",
  );
  for (const name of names) {
    const target = join(config.initDir, name);
    if (existsSync(target)) {
      requireSafe(
        lstatSync(target).isFile() &&
          !lstatSync(target).isSymbolicLink() &&
          readFileSync(target).equals(readFileSync(join(source, name))),
        "INIT_ARTIFACT_MISMATCH",
      );
    } else copyFileSync(join(source, name), target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o644);
  }
  // Init artifacts are public software; postgres UID must read the mounted dir.
  chmodSync(config.initDir, 0o755);
}
function checkExistingPostgres(installation: Installation) {
  const container = serviceContainer(installation, "postgres");
  const volumeName = `${installation.config.projectName}_product_hub_postgres_data`;
  const volume = docker(["volume", "inspect", volumeName]);
  if (volume.status === 0) {
    const facts = z
      .array(
        z.object({ Labels: z.record(z.string(), z.string()) }).passthrough(),
      )
      .parse(JSON.parse(volume.stdout))[0];
    requireSafe(
      facts?.Labels["com.docker.compose.project"] ===
        installation.config.projectName &&
        facts.Labels["com.docker.compose.volume"] ===
          "product_hub_postgres_data",
      "DATABASE_VOLUME_OWNERSHIP",
    );
    requireSafe(container, "ORPHAN_DATABASE_VOLUME_REQUIRES_REVIEW");
  }
  if (container) {
    requireSafe(
      container.Config.Labels["com.docker.compose.project"] ===
        installation.config.projectName &&
        container.Config.Image === installation.images.postgres &&
        container.Mounts.some((mount) => mount.Name === volumeName),
      "EXISTING_POSTGRES_REQUIRES_REVIEW",
    );
    const actual = environment(container);
    const { roles, dbName } = installation.config;
    requireSafe(
      actual.POSTGRES_DB === dbName &&
        actual.POSTGRES_USER === roles.admin.user &&
        actual.POSTGRES_PASSWORD === roles.admin.password &&
        actual.MIGRATION_DB_USER === roles.migration.user &&
        actual.MIGRATION_DB_PASSWORD === roles.migration.password &&
        actual.APP_DB_USER === roles.app.user &&
        actual.APP_DB_PASSWORD === roles.app.password,
      "EXISTING_DATABASE_CONFIG_MISMATCH",
    );
  }
}
async function waitFor(
  check: () => boolean | Promise<boolean>,
  code: string,
  timeout = 90000,
) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new BootstrapFailure(code);
}
function validateSecret(installation: Installation) {
  checkFilesystem({
    ...installation.config,
    workerSecretFile: installation.workerFile,
  });
}
function prepareSecret(installation: Installation) {
  if (existsSync(installation.workerFile)) {
    validateSecret(installation);
    return;
  }
  requireSafe(process.getuid?.() === 0, "ROOT_REQUIRED_FOR_WORKER_SECRET");
  const parent = dirname(installation.workerFile);
  if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
  const parentStat = lstatSync(parent);
  requireSafe(
    !parentStat.isSymbolicLink() &&
      parentStat.isDirectory() &&
      parentStat.uid === 0 &&
      parentStat.gid === 0 &&
      (parentStat.mode & 0o777) === 0o700,
    "UNSAFE_WORKER_SECRET_PARENT",
  );
  requireSafe(
    !realpathSync(parent).startsWith(repositoryRoot() + sep),
    "WORKER_SECRET_INSIDE_REPOSITORY",
  );
  writeFileSync(
    installation.workerFile,
    installation.config.roles.worker.url + "\n",
    { flag: "wx", mode: 0o400 },
  );
  chownSync(installation.workerFile, 1001, 1001);
  validateSecret(installation);
}

function assertRunning(
  installation: Installation,
  name: "app" | "hard-delete-worker",
) {
  const container = serviceContainer(installation, name);
  requireSafe(
    container?.State.Running &&
      !container.State.OOMKilled &&
      container.RestartCount === 0,
    "PROCESS_UNHEALTHY",
  );
  const expectedImage =
    name === "app" ? installation.images.runner : installation.images.worker;
  const image = z
    .array(z.object({ Id: z.string() }).passthrough())
    .parse(JSON.parse(checked(["image", "inspect", expectedImage])))[0];
  requireSafe(
    container.Image === image?.Id &&
      container.Config.Labels["com.docker.compose.project"] ===
        installation.config.projectName &&
      container.HostConfig.ReadonlyRootfs &&
      !container.HostConfig.Privileged &&
      container.HostConfig.CapDrop?.includes("ALL") &&
      container.HostConfig.SecurityOpt?.some((option) =>
        option.startsWith("no-new-privileges"),
      ) &&
      container.HostConfig.Memory > 0 &&
      (container.HostConfig.PidsLimit || 0) > 0,
    "CONTAINER_HARDENING",
  );
  const env = environment(container);
  const { config } = installation;
  if (name === "app") {
    requireSafe(
      ["1001", "1001:1001", "nextjs"].includes(container.Config.User) &&
        env.DATABASE_URL === config.roles.app.url &&
        env.BETTER_AUTH_SECRET === config.authSecret &&
        !env.ADMIN_DATABASE_URL &&
        !env.MIGRATION_DATABASE_URL &&
        !env.HARD_DELETE_WORKER_DB_PASSWORD &&
        !env.HARD_DELETE_WORKER_DATABASE_URL,
      "APP_SECRET_ISOLATION",
    );
    const ports = container.HostConfig.PortBindings;
    requireSafe(
      ports &&
        Object.keys(ports).length === 1 &&
        ports["3000/tcp"]?.length === 1 &&
        ports["3000/tcp"][0]?.HostIp === "127.0.0.1" &&
        ports["3000/tcp"][0]?.HostPort === String(config.appPort),
      "APP_PORT_BINDING",
    );
    requireSafe(
      !container.Mounts.some((mount) =>
        mount.Destination.startsWith("/run/secrets"),
      ),
      "APP_SECRET_MOUNT",
    );
  } else {
    requireSafe(
      container.Config.User === "1001:1001" &&
        !env.DATABASE_URL &&
        !env.BETTER_AUTH_SECRET &&
        !env.ADMIN_DATABASE_URL &&
        !env.MIGRATION_DATABASE_URL &&
        !env.HARD_DELETE_WORKER_DATABASE_URL &&
        !env.HARD_DELETE_WORKER_DB_PASSWORD &&
        Object.keys(container.HostConfig.PortBindings || {}).length === 0,
      "WORKER_SECRET_ISOLATION",
    );
    requireSafe(
      container.Mounts.some(
        (mount) =>
          mount.Destination ===
            "/run/secrets/hard_delete_worker_database_url" && !mount.RW,
      ),
      "WORKER_SECRET_MOUNT",
    );
  }
  return container;
}
function assertExistingRelease(
  installation: Installation,
  name: "app" | "hard-delete-worker",
) {
  const container = serviceContainer(installation, name);
  if (!container) return;
  requireSafe(
    container.Config.Image ===
      (name === "app"
        ? installation.images.runner
        : installation.images.worker),
    "USE_RELEASE_WORKFLOW_FOR_IMAGE_CHANGE",
  );
}
async function probeApp(installation: Installation, routes: string[]) {
  if (process.env.PRODUCT_HUB_CONTROL_CONTAINER === "1") {
    const app = serviceContainer(installation, "app");
    if (!app?.State.Running) return false;
    return (
      docker([
        "exec",
        app.Id,
        "node",
        "-e",
        `Promise.all(${JSON.stringify(routes)}.map(async route => { const r = await fetch('http://127.0.0.1:3000/api/' + route, {signal: AbortSignal.timeout(5000), redirect: 'error'}); if(r.status !== 200) throw new Error('not ready'); })).catch(() => process.exit(1))`,
      ]).status === 0
    );
  }
  try {
    for (const route of routes) {
      const response = await fetch(
        `http://127.0.0.1:${installation.config.appPort}/api/${route}`,
        {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
      if (response.status !== 200) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function health(installation: Installation, wait: boolean) {
  const app = assertRunning(installation, "app");
  // /api/ready creates this directory when absent. Doctor first verifies it exists.
  checked([
    "exec",
    app.Id,
    "node",
    "-e",
    "const fs=require('node:fs');const p='/data/uploads/objects';if(!fs.statSync(p).isDirectory())process.exit(1);fs.accessSync(p,fs.constants.R_OK|fs.constants.W_OK)",
  ]);
  const check = () => probeApp(installation, ["health", "ready"]);
  if (wait) await waitFor(check, "APP_HEALTH_FAILED");
  else requireSafe(await check(), "APP_HEALTH_FAILED");
}

export async function install(installation: Installation) {
  const { config } = installation;
  requireSafe(
    config.dbHost === "postgres" && config.dbPort === 5432,
    "BUILTIN_POSTGRES_ONLY",
  );
  requireSafe(
    config.roles.worker.password.length >= 32,
    "WORKER_PASSWORD_LENGTH",
  );
  if (existsSync(installation.workerFile)) validateSecret(installation);
  else requireSafe(process.getuid?.() === 0, "ROOT_REQUIRED_FOR_WORKER_SECRET");
  const lock = join(config.configRoot, ".installation.lock");
  requireSafe(!existsSync(lock), "INSTALL_ALREADY_RUNNING_OR_STALE_LOCK");
  mkdirSync(lock, { mode: 0o700 });
  try {
    await runStages([
      {
        name: "HOST_AND_RELEASE",
        run: () => {
          assertCompose(installation);
          checkExistingPostgres(installation);
          assertExistingRelease(installation, "app");
          assertExistingRelease(installation, "hard-delete-worker");
        },
      },
      { name: "PREPARE_INIT", run: () => prepareInit(config) },
      {
        name: "POSTGRES_START",
        run: () =>
          compose(installation, [
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--no-recreate",
            "postgres",
          ]),
      },
      {
        name: "POSTGRES_READY",
        run: async () => {
          await waitFor(
            () =>
              serviceContainer(installation, "postgres")?.State.Health
                ?.Status === "healthy",
            "DATABASE_NOT_READY",
          );
          checkExistingPostgres(installation);
        },
      },
      {
        name: "DATABASE_IDENTITY_AND_HISTORY",
        run: () => {
          const result = databaseJob(installation, "database-state");
          process.stdout.write(
            `DATABASE: ${result.state}; applied=${result.applied}; pending=${result.pending}; failed=${result.failed}\n`,
          );
        },
      },
      {
        name: "PENDING_MIGRATIONS",
        run: () => {
          const result = databaseJob(installation, "migrations");
          process.stdout.write(
            `MIGRATIONS: ${result.applied} applied; ${result.pending} pending; ${result.failed} failed\n`,
          );
        },
      },
      {
        name: "RUNTIME_GRANTS",
        run: () => databaseJob(installation, "grants"),
      },
      {
        name: "WORKER_ROLE",
        run: () => databaseJob(installation, "worker-provision"),
      },
      {
        name: "WORKER_SECRET",
        run: () => {
          prepareSecret(installation);
          atomicWrite(
            config.runtimeFile,
            renderRuntimeEnv(
              { ...config, workerSecretFile: installation.workerFile },
              installation.images.worker,
            ),
            0o600,
          );
        },
      },
      {
        name: "WORKER_START",
        run: async () => {
          compose(
            installation,
            [
              "up",
              "-d",
              "--no-deps",
              "--no-build",
              "--no-recreate",
              "hard-delete-worker",
            ],
            undefined,
            true,
          );
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const worker = assertRunning(installation, "hard-delete-worker");
          checked([
            "exec",
            worker.Id,
            "node",
            "scripts/installer/worker-probe.mjs",
          ]);
        },
      },
      {
        name: "APP_START",
        run: async () => {
          compose(installation, [
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--no-recreate",
            "app",
          ]);
          await waitFor(
            () => probeApp(installation, ["ready"]),
            "APP_HEALTH_FAILED",
          );
        },
      },
      {
        name: "FINAL_VERIFICATION",
        run: async () => {
          databaseJob(installation, "verify");
          assertRunning(installation, "hard-delete-worker");
          await health(installation, true);
        },
      },
    ]);
  } finally {
    rmdirSync(lock);
  }
  process.stdout.write(
    "PASS: installation complete; create the initial Admin with production:bootstrap-admin\n",
  );
}

export async function doctor(installation: Installation) {
  await runStages([
    {
      name: "CONFIG_PATHS_COMPOSE",
      run: () => {
        validateSecret(installation);
        assertCompose(installation);
        checkExistingPostgres(installation);
      },
    },
    {
      name: "DATABASE_READ_ONLY",
      run: async () => {
        const postgres = serviceContainer(installation, "postgres");
        requireSafe(
          postgres?.State.Running &&
            postgres.State.Health?.Status === "healthy",
          "DATABASE_NOT_READY",
        );
        if (process.env.PRODUCT_HUB_CONTROL_CONTAINER === "1") {
          const result = databaseJob(installation, "verify");
          process.stdout.write(
            `MIGRATIONS: ${result.applied} applied; ${result.pending} pending; ${result.failed} failed\n`,
          );
          return;
        }
        const address =
          postgres.NetworkSettings.Networks[
            `${installation.config.projectName}_product_hub_backend`
          ]?.IPAddress;
        requireSafe(
          address && /^\d+\.\d+\.\d+\.\d+$/.test(address),
          "DATABASE_NETWORK_ADDRESS",
        );
        const input = payload(installation, "verify");
        const { roles, dbName } = installation.config;
        input.databaseUrl = databaseUrl(
          roles.admin.user,
          roles.admin.password,
          address,
          5432,
          dbName,
        );
        input.migrationUrl = databaseUrl(
          roles.migration.user,
          roles.migration.password,
          address,
          5432,
          dbName,
        );
        input.appUrl = databaseUrl(
          roles.app.user,
          roles.app.password,
          address,
          5432,
          dbName,
        );
        input.workerUrl = databaseUrl(
          roles.worker.user,
          roles.worker.password,
          address,
          5432,
          dbName,
        );
        const result = await verifyDatabaseReadOnly(input);
        process.stdout.write(
          `MIGRATIONS: ${result.applied} applied; ${result.pending} pending; ${result.failed} failed\n`,
        );
      },
    },
    {
      name: "WORKER_READ_ONLY",
      run: () => {
        const worker = assertRunning(installation, "hard-delete-worker");
        checked([
          "exec",
          worker.Id,
          "node",
          "scripts/installer/worker-probe.mjs",
        ]);
      },
    },
    { name: "APP_READ_ONLY", run: () => health(installation, false) },
  ]);
  process.stdout.write("PASS: doctor completed without state changes\n");
}

export function bootstrapAdmin(
  installation: Installation,
  input: { username: string; name: string; password: string },
) {
  return compose(
    installation,
    ["run", "--rm", "--no-deps", "-T", "admin-bootstrap"],
    JSON.stringify({
      ...input,
      databaseUrl: installation.config.roles.app.url,
    }),
    true,
  );
}
export function backup(installation: Installation) {
  requireSafe(installation.config.backupRoot, "BACKUP_ROOT_REQUIRED");
  requireSafe(
    !/^0{40}$/.test(installation.revision),
    "RELEASE_REVISION_REQUIRED",
  );
  return compose(
    installation,
    ["run", "--rm", "--no-deps", "-T", "backup"],
    [
      installation.config.dbHost,
      String(installation.config.dbPort),
      installation.config.dbName,
      installation.config.roles.migration.user,
      installation.config.roles.migration.password,
    ].join("\n") + "\n",
    true,
  );
}

export function status(installation: Installation) {
  return (["postgres", "hard-delete-worker", "app"] as const).map((name) => {
    const container = serviceContainer(installation, name);
    return {
      service: name,
      present: Boolean(container),
      running: Boolean(container?.State.Running),
      health: container?.State.Health?.Status || "none",
      restarts: container?.RestartCount || 0,
      image: container?.Config.Image || "none",
    };
  });
}

export function boundedLogs(
  installation: Installation,
  service: "app" | "postgres" | "hard-delete-worker",
  lines: number,
) {
  requireSafe(
    Number.isInteger(lines) && lines >= 1 && lines <= 500,
    "LOG_LIMIT",
  );
  return compose(
    installation,
    ["logs", "--no-color", "--tail", String(lines), service],
    undefined,
    true,
  );
}

export async function updateInstallation(installation: Installation) {
  validateSecret(installation);
  const lock = join(installation.config.configRoot, ".update.lock");
  requireSafe(!existsSync(lock), "UPDATE_ALREADY_RUNNING_OR_STALE_LOCK");
  mkdirSync(lock, { mode: 0o700 });
  try {
    await runStages([
      {
        name: "HOST_AND_RELEASE",
        run: () => {
          assertCompose(installation);
          checkExistingPostgres(installation);
        },
      },
      {
        name: "DATABASE_IDENTITY_AND_HISTORY",
        run: () => databaseJob(installation, "database-state"),
      },
      {
        name: "PENDING_MIGRATIONS",
        run: () => databaseJob(installation, "migrations"),
      },
      {
        name: "RUNTIME_GRANTS",
        run: () => databaseJob(installation, "grants"),
      },
      {
        name: "WORKER_ROLE",
        run: () => databaseJob(installation, "worker-provision"),
      },
      {
        name: "WORKER_UPDATE",
        run: async () => {
          compose(
            installation,
            [
              "up",
              "-d",
              "--no-deps",
              "--no-build",
              "--force-recreate",
              "hard-delete-worker",
            ],
            undefined,
            true,
          );
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const worker = assertRunning(installation, "hard-delete-worker");
          checked([
            "exec",
            worker.Id,
            "node",
            "scripts/installer/worker-probe.mjs",
          ]);
        },
      },
      {
        name: "APP_UPDATE",
        run: async () => {
          compose(installation, [
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--force-recreate",
            "app",
          ]);
          await health(installation, true);
        },
      },
      {
        name: "FINAL_VERIFICATION",
        run: async () => {
          databaseJob(installation, "verify");
          assertRunning(installation, "hard-delete-worker");
          await health(installation, true);
        },
      },
    ]);
  } finally {
    rmdirSync(lock);
  }
  process.stdout.write(
    "PASS: update completed without PostgreSQL recreation\n",
  );
}
