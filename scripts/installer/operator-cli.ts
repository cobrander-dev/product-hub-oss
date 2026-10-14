import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  backup,
  bootstrapAdmin,
  BootstrapFailure,
  boundedLogs,
  doctor,
  install,
  loadInstallation,
  status,
  updateInstallation,
} from "./bootstrap";
import {
  atomicWrite,
  ConfigFailure,
  loadProductionConfig,
  writeManifestReleaseFiles,
} from "./config";
import {
  httpsEnabled,
  httpsPaths,
  httpsStatus,
  parseAccessHost,
  parseHttpsSettings,
  publicOrigin,
  readAccessFile,
  renderAccessFile,
  startHttps,
  writeCaddyfile,
  type AccessHost,
  type HttpsSettings,
} from "./https";
import { hiddenInput } from "./tty";
import {
  parseReleaseManifest,
  ReleaseManifestFailure,
  renderReleaseManifest,
  type ReleaseManifest,
} from "../release/manifest";
import { verifyLocalReleaseImages } from "../release/verify-manifest";

const defaultRoot = "/opt/product-hub";
function demand(condition: unknown, code: string): asserts condition {
  if (!condition) throw new BootstrapFailure(code);
}

function rootPath() {
  const root = resolve(process.env.PRODUCT_HUB_ROOT || defaultRoot);
  demand(root !== "/" && root.startsWith("/"), "INVALID_INSTALL_ROOT");
  return root;
}

function installationPaths(manifest: ReleaseManifest) {
  const root = rootPath();
  return {
    root,
    config: join(root, "config"),
    env: join(root, "config/product-hub.env"),
    release: join(root, "releases/compose.release.yaml"),
    currentManifest: join(root, "releases/current.manifest"),
    targetManifest: join(root, "releases/target.manifest"),
    backup: join(root, "backups"),
    bundle: join(root, "releases", manifest.sourceCommit, "bundle"),
    proxy: join(root, "proxy"),
  };
}

function docker(args: string[], timeout = 10 * 60 * 1000) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    env: {
      NODE_ENV: "production",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    },
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  demand(result.status === 0, "DOCKER_COMMAND_FAILED");
  return result.stdout.trim();
}

function pullAndVerify(manifest: ReleaseManifest) {
  for (const reference of Object.values(manifest.images))
    docker(["pull", "--platform", manifest.platform, reference]);
  verifyLocalReleaseImages(manifest);
}

function copyFromImage(image: string, source: string, destination: string) {
  const id = docker([
    "create",
    "--platform",
    "linux/amd64",
    "--entrypoint",
    "/bin/true",
    image,
  ]);
  demand(/^[0-9a-f]{12,64}$/.test(id), "BUNDLE_CONTAINER_ID");
  try {
    docker(["cp", `${id}:/app/${source}`, destination]);
  } finally {
    spawnSync("docker", ["rm", "-f", id], {
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
        DOCKER_HOST: process.env.DOCKER_HOST,
      },
    });
  }
}

export function installSoftwareBundle(manifest: ReleaseManifest) {
  const paths = installationPaths(manifest);
  demand(!existsSync(paths.bundle), "RELEASE_BUNDLE_EXISTS");
  const parent = dirname(paths.bundle);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.bundle-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    copyFromImage(manifest.images.migrator, "distribution-bundle/.", temporary);
    renameSync(temporary, paths.bundle);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return paths.bundle;
}

function secret() {
  return randomBytes(48).toString("base64url");
}

// The public origin carries a non-standard HTTPS port, and APP_DOMAIN is then
// host:port so Host, X-Forwarded-Host and Origin are matched exactly.
export function renderSourceEnvironment(
  domain: string,
  root = rootPath(),
  port = 443,
) {
  const auth = publicOrigin(domain, port);
  const fields = {
    APP_DOMAIN: new URL(auth).host,
    BETTER_AUTH_URL: auth,
    BETTER_AUTH_TRUSTED_ORIGINS: auth,
    BETTER_AUTH_SECRET: secret(),
    POSTGRES_DB: "product_hub",
    POSTGRES_ADMIN_USER: "product_hub_db_admin",
    POSTGRES_ADMIN_PASSWORD: secret(),
    POSTGRES_MIGRATION_USER: "product_hub_migration",
    POSTGRES_MIGRATION_PASSWORD: secret(),
    POSTGRES_APP_USER: "product_hub_app",
    POSTGRES_APP_PASSWORD: secret(),
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: "5432",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: "/data/uploads",
    APP_PORT: "3000",
    PRODUCT_HUB_COMPOSE_PROJECT: "product-hub",
    PRODUCT_HUB_CONFIG_ROOT: join(root, "config"),
    PRODUCT_HUB_POSTGRES_INIT_DIR: join(
      root,
      "config/postgres/init-production",
    ),
    PRODUCT_HUB_RELEASE_FILE: join(root, "releases/compose.release.yaml"),
    PRODUCT_HUB_BACKUP_ROOT: join(root, "backups"),
    HARD_DELETE_WORKER_DB_USER: "product_hub_hard_delete_worker",
    HARD_DELETE_WORKER_DB_PASSWORD: secret(),
  };
  return (
    "# Product Hub generated production configuration. Never commit or print.\n" +
    Object.entries(fields)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n") +
    "\n"
  );
}

function prepareDirectories(paths: ReturnType<typeof installationPaths>) {
  for (const [path, mode] of [
    [paths.config, 0o700],
    [join(paths.config, "postgres/init-production"), 0o700],
    [dirname(paths.release), 0o700],
    [paths.backup, 0o700],
    [paths.proxy, 0o700],
  ] as const)
    mkdirSync(path, { recursive: true, mode });
}

function configureEnvironment(manifest: ReleaseManifest, force: boolean) {
  const paths = installationPaths(manifest);
  process.env.PRODUCT_HUB_ENV_FILE = paths.env;
  process.env.PRODUCT_HUB_RELEASE_FILE = paths.release;
  process.env.PRODUCT_HUB_RELEASE_REVISION = manifest.sourceCommit;
  process.env.PRODUCT_HUB_REPOSITORY_ROOT = paths.bundle;
  const config = loadProductionConfig(paths.env);
  const template = readFileSync(
    "/app/deploy/templates/compose.manifest.yaml.template",
    "utf8",
  );
  writeManifestReleaseFiles(config, manifest, template, force);
  return config;
}

async function question(label: string) {
  demand(process.stdin.isTTY && process.stdout.isTTY, "TTY_REQUIRED");
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await reader.question(label)).trim();
  } finally {
    reader.close();
  }
}

function writeProxySnippets(
  manifest: ReleaseManifest,
  domain: string,
  appPort: number,
) {
  const paths = installationPaths(manifest);
  const source = "/app/deploy";
  const caddy = readFileSync(join(source, "caddy/Caddyfile.example"), "utf8")
    .replace("{$APP_DOMAIN}", domain)
    .replaceAll("127.0.0.1:3000", `127.0.0.1:${appPort}`);
  const nginx = readFileSync(
    join(source, "nginx/product-hub.conf.example"),
    "utf8",
  )
    .replaceAll("product-hub.example.com", domain)
    .replaceAll("127.0.0.1:3000", `127.0.0.1:${appPort}`);
  const headers = readFileSync(
    join(source, "nginx/product-hub-proxy-headers.conf.example"),
    "utf8",
  );
  atomicWrite(join(paths.proxy, "Caddyfile.snippet"), caddy, 0o644);
  atomicWrite(join(paths.proxy, "nginx-product-hub.conf"), nginx, 0o644);
  atomicWrite(join(paths.proxy, "nginx-proxy-headers.conf"), headers, 0o644);
}

function promoteManifest(manifest: ReleaseManifest) {
  const paths = installationPaths(manifest);
  const rendered = renderReleaseManifest(manifest);
  const versioned = join(
    dirname(paths.currentManifest),
    `${manifest.version}.manifest`,
  );
  if (!existsSync(versioned)) atomicWrite(versioned, rendered, 0o644);
  atomicWrite(paths.currentManifest, rendered, 0o644);
}

async function setup(manifestPath: string) {
  demand(process.getuid?.() === 0, "ROOT_REQUIRED");
  const manifest = parseReleaseManifest(readFileSync(manifestPath, "utf8"));
  const paths = installationPaths(manifest);
  const access = await askAccessHost();
  const settings = askBuiltinHttps(access);
  const builtinHttps = settings !== undefined;
  const domain = access.host;
  pullAndVerify(manifest);
  installSoftwareBundle(manifest);
  prepareDirectories(paths);
  atomicWrite(
    paths.env,
    renderSourceEnvironment(domain, paths.root, settings?.port),
    0o600,
  );
  const config = configureEnvironment(manifest, false);
  const installation = loadInstallation(config);
  await install(installation);

  process.stdout.write(
    "\n创建管理员账号（用户名 3-30 位字母/数字/._-，密码至少 8 位）\n",
  );
  const username = await question("管理员用户名: ");
  const name = await question("管理员显示名称: ");
  const password = await hiddenInput("管理员密码（输入时不显示）: ");
  const confirmation = await hiddenInput("再次输入管理员密码: ");
  demand(password === confirmation, "PASSWORD_CONFIRMATION");
  const identity = z
    .object({
      username: z
        .string()
        .trim()
        .min(3)
        .max(30)
        .regex(/^[a-zA-Z0-9._-]+$/),
      name: z.string().trim().min(1).max(100),
      password: z.string().min(8).max(128),
    })
    .parse({ username, name, password });
  process.stdout.write(bootstrapAdmin(installation, identity) + "\n");
  writeProxySnippets(manifest, access.host, config.appPort);
  if (settings) {
    writeCaddyfile(paths.root, access, settings);
    const pem = process.env.PRODUCT_HUB_ACME_CA_ROOT_PEM || "";
    if (settings.acmeCa) {
      demand(pem.includes("BEGIN CERTIFICATE"), "ACME_CA_ROOT_REQUIRED");
      atomicWrite(httpsPaths(paths.root).acmeCaRoot, pem.trim() + "\n", 0o644);
    }
    startHttps({
      root: paths.root,
      bundle: paths.bundle,
      runnerImage: manifest.images.runner,
      projectName: config.projectName,
      access,
      settings,
    });
  }
  atomicWrite(
    join(paths.config, "access"),
    renderAccessFile(access, builtinHttps, settings),
    0o644,
  );
  promoteManifest(manifest);
  process.stdout.write(
    settings
      ? `PASS: setup complete\n安装完成。访问地址: ${publicOrigin(access.host, settings.port)}\n`
      : `PASS: setup complete\n安装完成。应用仅监听 127.0.0.1:${config.appPort}，请按 ${paths.proxy} 中的示例配置你自己的 HTTPS 反向代理。\n`,
  );
}

async function askAccessHost(): Promise<AccessHost> {
  const suggested = process.env.PRODUCT_HUB_SUGGESTED_IP || "";
  process.stdout.write(
    "\n访问地址：有域名请输入域名（例如 hub.example.com，需已解析到本服务器）。\n" +
      "没有域名可直接使用服务器 IP，HTTPS 证书会自动申请；申请失败时使用自签名证书。\n",
  );
  const answer = await question(
    suggested
      ? `域名或 IP（直接回车使用 ${suggested}）: `
      : "域名或服务器公网 IP: ",
  );
  return parseAccessHost(answer || suggested);
}

// The port and the certificate path were chosen on the host by setup.sh, which
// can see host ports; only the access-kind specific rules are applied here.
export function askBuiltinHttps(
  access: AccessHost,
  env: Record<string, string | undefined> = process.env,
): HttpsSettings | undefined {
  if (env.PRODUCT_HUB_HTTPS_MODE === "external") {
    demand(access.kind === "domain", "IP_ACCESS_REQUIRES_BUILTIN_HTTPS");
    process.stdout.write(
      "不启用内置 HTTPS；安装后请用现有的 Nginx/Caddy 反向代理。\n",
    );
    return undefined;
  }
  demand(env.PRODUCT_HUB_HTTPS_MODE === "builtin", "HTTPS_MODE_REQUIRED");
  let settings = parseHttpsSettings({
    port: env.PRODUCT_HUB_HTTPS_PORT,
    httpBind: env.PRODUCT_HUB_HTTP_BIND,
    role: env.PRODUCT_HUB_RELAY_ROLE,
    issuer: env.PRODUCT_HUB_TLS_ISSUER,
    acmeCa: env.PRODUCT_HUB_ACME_CA,
  });
  // The shared port-80 relay routes by hostname, so IP access cannot use it.
  if (access.kind === "ip" && settings.role === "member")
    settings = { ...settings, role: "none" };
  if (
    access.kind === "ip" &&
    settings.role === "none" &&
    settings.port !== 443 &&
    settings.issuer !== "internal"
  ) {
    process.stdout.write(
      "IP 访问使用自定义端口且 80 端口不可用：无法自动申请公网证书，将使用本机 CA 证书（浏览器会提示不受信任，可通过 product-hub https 导出根证书）。\n",
    );
    settings = { ...settings, issuer: "internal" };
  }
  return settings;
}

function loadCurrent() {
  const path = join(rootPath(), "releases/current.manifest");
  const manifest = parseReleaseManifest(readFileSync(path, "utf8"));
  const paths = installationPaths(manifest);
  process.env.PRODUCT_HUB_ENV_FILE = paths.env;
  process.env.PRODUCT_HUB_RELEASE_FILE = paths.release;
  process.env.PRODUCT_HUB_RELEASE_REVISION = manifest.sourceCommit;
  process.env.PRODUCT_HUB_REPOSITORY_ROOT = paths.bundle;
  const config = loadProductionConfig(paths.env);
  return { manifest, paths, config, installation: loadInstallation(config) };
}

export function verifyBackupResult(output: string, backupRoot: string) {
  const path = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"))
    .at(-1);
  demand(path && path.startsWith(resolve(backupRoot) + sep), "BACKUP_PATH");
  const stat = lstatSync(path);
  demand(stat.isDirectory() && !stat.isSymbolicLink(), "BACKUP_DIRECTORY");
  const required = ["manifest.txt", "CHECKSUMS", "COMPLETE"];
  for (const name of required)
    demand(existsSync(join(path, name)), "BACKUP_INCOMPLETE");
  const checksumLines = readFileSync(join(path, "CHECKSUMS"), "utf8")
    .trim()
    .split("\n");
  const expected = new Set([
    "database.dump",
    "uploads.tar.gz",
    "uploads-files.sha256",
    "manifest.txt",
  ]);
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    demand(match, "BACKUP_CHECKSUM_FORMAT");
    demand(expected.delete(match[2]!), "BACKUP_CHECKSUM_FILE");
  }
  demand(expected.size === 0, "BACKUP_CHECKSUM_FILES_MISSING");
  const verification = spawnSync(
    "sha256sum",
    ["--check", "--strict", "CHECKSUMS"],
    {
      cwd: path,
      encoding: "utf8",
      env: { NODE_ENV: "production", PATH: process.env.PATH },
      timeout: 30 * 60 * 1000,
    },
  );
  demand(verification.status === 0, "BACKUP_CHECKSUM_MISMATCH");
  return {
    path,
    manifest: join(path, "manifest.txt"),
    checksums: join(path, "CHECKSUMS"),
    complete: join(path, "COMPLETE"),
  };
}

function versionParts(version: string) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  demand(match, "INVALID_RELEASE_VERSION");
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") || [],
  };
}

function compareVersions(left: string, right: string) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index]! - b.numbers[index]!;
  }
  if (!a.prerelease.length && b.prerelease.length) return 1;
  if (a.prerelease.length && !b.prerelease.length) return -1;
  for (
    let index = 0;
    index < Math.max(a.prerelease.length, b.prerelease.length);
    index++
  ) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftValue = BigInt(leftPart);
      const rightValue = BigInt(rightPart);
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

export function assertUpdateTarget(
  current: ReleaseManifest,
  target: ReleaseManifest,
) {
  demand(
    target.sourceCommit !== current.sourceCommit,
    "RELEASE_ALREADY_CURRENT",
  );
  demand(
    compareVersions(target.version, current.version) > 0,
    "RELEASE_DOWNGRADE",
  );
  demand(
    target.images.postgres === current.images.postgres,
    "POSTGRES_UPDATE_REQUIRES_SEPARATE_ROLLOUT",
  );
}

function targetPath(args: string[]) {
  const index = args.indexOf("--manifest");
  if (index < 0) return join(rootPath(), "releases/target.manifest");
  demand(index + 1 < args.length, "MISSING_TARGET_MANIFEST");
  return resolve(args[index + 1]!);
}

async function update(args: string[]) {
  const check = args.includes("--check");
  const allowed = new Set(["--check", "--manifest"]);
  for (let index = 0; index < args.length; index++) {
    demand(allowed.has(args[index]!), "INVALID_ARGUMENT");
    if (args[index] === "--manifest") index++;
  }
  const current = loadCurrent();
  const targetManifestPath = targetPath(args);
  if (check) {
    const target = parseReleaseManifest(
      readFileSync(targetManifestPath, "utf8"),
    );
    assertUpdateTarget(current.manifest, target);
    process.stdout.write(
      `UPDATE_AVAILABLE=${target.version}\nSOURCE_COMMIT=${target.sourceCommit}\n`,
    );
    return;
  }
  demand(process.getuid?.() === 0, "ROOT_REQUIRED");
  const lock = join(current.paths.config, ".update-orchestration.lock");
  demand(!existsSync(lock), "UPDATE_ALREADY_RUNNING_OR_STALE_LOCK");
  mkdirSync(lock, { mode: 0o700 });
  try {
    await doctor(current.installation);
    const target = parseReleaseManifest(
      readFileSync(targetManifestPath, "utf8"),
    );
    assertUpdateTarget(current.manifest, target);
    pullAndVerify(target);
    const backupOutput = backup(current.installation);
    verifyBackupResult(backupOutput, current.paths.backup);
    installSoftwareBundle(target);
    const targetPaths = installationPaths(target);
    process.env.PRODUCT_HUB_REPOSITORY_ROOT = targetPaths.bundle;
    process.env.PRODUCT_HUB_RELEASE_REVISION = target.sourceCommit;
    const config = configureEnvironment(target, true);
    const installation = loadInstallation(config);
    await updateInstallation(installation);
    await doctor(installation);
    // Keep the optional proxy on the same verified Runner digest as the App.
    // Installations with custom-port settings get the current Caddyfile
    // template; older ones keep their file and the 80/443 defaults.
    if (httpsEnabled(current.paths.root)) {
      const recorded = readAccessFile(current.paths.root);
      if (recorded?.settings)
        writeCaddyfile(current.paths.root, recorded.access, recorded.settings);
      startHttps({
        root: current.paths.root,
        bundle: targetPaths.bundle,
        runnerImage: target.images.runner,
        projectName: config.projectName,
        access: recorded?.settings ? recorded.access : undefined,
        settings: recorded?.settings,
      });
    }
    promoteManifest(target);
  } finally {
    rmSync(lock, { recursive: true, force: false });
  }
}

// Re-decides certificate validation for the current server (role and port-80
// binding computed on the host by scripts/product-hub) and recreates only the
// product-hub-https proxy. Port, access host, data and certificates are kept.
function httpsApply(current: ReturnType<typeof loadCurrent>) {
  demand(process.getuid?.() === 0, "ROOT_REQUIRED");
  const recorded = readAccessFile(current.paths.root);
  demand(recorded?.builtin, "BUILTIN_HTTPS_NOT_ENABLED");
  let settings = parseHttpsSettings({
    port: String(recorded.settings?.port ?? 443),
    httpBind: process.env.PRODUCT_HUB_HTTP_BIND,
    role: process.env.PRODUCT_HUB_RELAY_ROLE,
    issuer: recorded.settings?.issuer ?? "auto",
    acmeCa: recorded.settings?.acmeCa,
  });
  if (recorded.access.kind === "ip" && settings.role === "member")
    settings = { ...settings, role: "none" };
  demand(
    !(settings.role === "none" && settings.port !== 443) ||
      settings.issuer === "internal",
    "ACME_HTTP_PORT_UNAVAILABLE",
  );
  writeCaddyfile(current.paths.root, recorded.access, settings);
  startHttps({
    root: current.paths.root,
    bundle: current.paths.bundle,
    runnerImage: current.manifest.images.runner,
    projectName: current.config.projectName,
    access: recorded.access,
    settings,
    recreate: true,
  });
  atomicWrite(
    join(current.paths.config, "access"),
    renderAccessFile(recorded.access, true, settings),
    0o644,
  );
  process.stdout.write(`HTTPS_ROLE=${settings.role}\n`);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  if (command === "setup") {
    demand(args.length === 2 && args[0] === "--manifest", "INVALID_ARGUMENT");
    await setup(resolve(args[1]!));
    return;
  }
  const current = loadCurrent();
  if (command === "status") {
    demand(args.length === 0, "UNEXPECTED_ARGUMENT");
    process.stdout.write(
      `VERSION=${current.manifest.version}\nSOURCE_COMMIT=${current.manifest.sourceCommit}\n`,
    );
    for (const item of status(current.installation))
      process.stdout.write(
        `${item.service}: present=${item.present} running=${item.running} health=${item.health} restarts=${item.restarts} image=${item.image}\n`,
      );
    if (httpsEnabled(current.paths.root))
      process.stdout.write(`https: ${httpsStatus() || "missing"}\n`);
  } else if (command === "doctor") {
    demand(args.length === 0, "UNEXPECTED_ARGUMENT");
    await doctor(current.installation);
  } else if (command === "backup") {
    demand(args.length === 0, "UNEXPECTED_ARGUMENT");
    const result = verifyBackupResult(
      backup(current.installation),
      current.paths.backup,
    );
    process.stdout.write(
      `BACKUP_PATH=${result.path}\nMANIFEST=${result.manifest}\nCHECKSUMS=${result.checksums}\nCOMPLETE=${result.complete}\n`,
    );
  } else if (command === "update") {
    await update(args);
  } else if (command === "https-apply") {
    demand(args.length === 0, "UNEXPECTED_ARGUMENT");
    httpsApply(current);
  } else if (command === "https-settings") {
    demand(args.length === 0, "UNEXPECTED_ARGUMENT");
    const recorded = readAccessFile(current.paths.root);
    const settings = recorded?.settings;
    process.stdout.write(
      `PORT=${settings?.port ?? 443}\nROLE=${settings?.role ?? ""}\nISSUER=${settings?.issuer ?? "auto"}\n`,
    );
  } else if (command === "logs") {
    let service: "app" | "postgres" | "hard-delete-worker" = "app";
    let lines = 100;
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      demand(
        value && ["--service", "--lines"].includes(flag || ""),
        "INVALID_ARGUMENT",
      );
      if (flag === "--service") {
        demand(
          ["app", "postgres", "hard-delete-worker"].includes(value),
          "INVALID_LOG_SERVICE",
        );
        service = value as typeof service;
      } else {
        demand(/^[0-9]{1,3}$/.test(value), "INVALID_LOG_LIMIT");
        lines = Number(value);
      }
    }
    process.stdout.write(
      boundedLogs(current.installation, service, lines) + "\n",
    );
  } else throw new BootstrapFailure("INVALID_COMMAND");
}

if (process.argv[1] && import.meta.filename === process.argv[1])
  main().catch((error: unknown) => {
    const code =
      error instanceof ConfigFailure ||
      error instanceof BootstrapFailure ||
      error instanceof ReleaseManifestFailure
        ? error.code
        : error instanceof z.ZodError
          ? "INPUT_VALIDATION_FAILED"
          : "OPERATOR_COMMAND_FAILED";
    process.stderr.write(
      `FAIL: ${code}\nNo destructive rollback was performed. PostgreSQL and volumes were preserved.\n未执行任何破坏性回滚，数据库和数据卷均已保留。\n`,
    );
    process.exitCode = 1;
  });
