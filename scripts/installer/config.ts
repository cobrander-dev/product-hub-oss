import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { ReleaseManifest } from "../release/manifest";
import { repositoryRoot } from "./paths";

export class ConfigFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function reject(code: string): never {
  throw new ConfigFailure(code);
}

type Values = Record<string, string>;
type RoleName = "admin" | "migration" | "app" | "worker";

export interface ProductionConfig {
  inputFile: string;
  runtimeFile: string;
  releaseFile: string;
  domain: string;
  authUrl: string;
  authSecret: string;
  dbName: string;
  dbHost: string;
  dbPort: number;
  roles: Record<RoleName, { user: string; password: string; url: string }>;
  appPort: number;
  projectName: string;
  configRoot: string;
  initDir: string;
  backupRoot?: string;
  workerSecretFile?: string;
}

function parseEnvFile(contents: string): Values {
  const values: Values = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) reject("ENV_SYNTAX");
    const key = match[1]!;
    if (Object.hasOwn(values, key)) reject(`DUPLICATE_${key}`);
    let value = match[2]!;
    if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) reject(`INVALID_${key}`);
      value = value.slice(1, -1).replaceAll("\\'", "'");
    } else if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) reject(`INVALID_${key}`);
      try {
        value = JSON.parse(value) as string;
      } catch {
        reject(`INVALID_${key}`);
      }
    }
    if (/[\r\n\0]/.test(value)) reject(`INVALID_${key}`);
    values[key] = value;
  }
  return values;
}

function field(
  values: Values,
  canonical: string,
  legacy?: string,
  fallback?: string,
) {
  const modern = values[canonical];
  const old = legacy ? values[legacy] : undefined;
  if (modern && old && modern !== old) reject(`CONFLICT_${canonical}`);
  return modern || old || fallback || "";
}

function required(value: string, name: string) {
  if (!value || value.includes("REPLACE_AT_RUNTIME")) reject(`MISSING_${name}`);
  return value;
}

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;
const hostnamePattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const domainPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::[1-9][0-9]{0,4})?$/i;

function validateOrigin(domain: string, authUrl: string, trusted: string) {
  // A literal IPv4 host is allowed for installs without a domain; it is still
  // served only over HTTPS (ACME IP certificate or the local-CA fallback).
  if (
    !(domainPattern.test(domain) || isIP(domain) === 4) ||
    domain.includes("*")
  )
    reject("INVALID_APP_DOMAIN");
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    reject("INVALID_BETTER_AUTH_URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== authUrl ||
    parsed.host.toLowerCase() !== domain.toLowerCase() ||
    trusted !== authUrl
  )
    reject("AUTH_ORIGIN_MISMATCH");
}

function validateHost(value: string) {
  if (/^\[[^\]]+\]$/.test(value)) {
    if (isIP(value.slice(1, -1)) !== 6) reject("INVALID_POSTGRES_HOST");
    return value;
  }
  if (
    isIP(value) === 4 ||
    hostnamePattern.test(value) ||
    /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)
  )
    return value;
  reject("INVALID_POSTGRES_HOST");
}

function port(value: string, label: string) {
  if (!/^[0-9]{1,5}$/.test(value)) reject(`INVALID_${label}`);
  const result = Number(value);
  if (result < 1 || result > 65535) reject(`INVALID_${label}`);
  return result;
}

function absolutePath(value: string, label: string) {
  if (!isAbsolute(value) || value.includes("\0") || value === "/")
    reject(`INVALID_${label}`);
  return resolve(value);
}

function insideRepository(path: string, repositoryRoot: string) {
  return path === repositoryRoot || path.startsWith(`${repositoryRoot}${sep}`);
}

function encode(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function databaseUrl(
  user: string,
  password: string,
  host: string,
  dbPort: number,
  database: string,
) {
  return `postgresql://${encode(user)}:${encode(password)}@${host}:${dbPort}/${encode(database)}`;
}

function validateExplicitUrl(
  value: string,
  user: string,
  password: string,
  host: string,
  dbPort: number,
  database: string,
  label: string,
) {
  let parsed: URL;
  try {
    parsed = new URL(value);
    if (
      parsed.protocol !== "postgresql:" ||
      parsed.search ||
      parsed.hash ||
      decodeURIComponent(parsed.username) !== user ||
      decodeURIComponent(parsed.password) !== password ||
      decodeURIComponent(parsed.pathname.slice(1)) !== database ||
      parsed.hostname.toLowerCase() !== host.toLowerCase() ||
      Number(parsed.port || "5432") !== dbPort
    )
      reject(`MISMATCH_${label}`);
  } catch {
    reject(`MISMATCH_${label}`);
  }
  return value;
}

function fileInfo(path: string, label: string) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) reject(`SYMLINK_${label}`);
    return stat;
  } catch (error) {
    if (error instanceof ConfigFailure) throw error;
    reject(`MISSING_${label}`);
  }
}

function privateDirectory(path: string, label: string) {
  const stat = fileInfo(path, label);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    (stat.uid !== 0 && stat.uid !== process.getuid?.())
  )
    reject(`UNSAFE_${label}`);
}

export function validateWorkerPermissionFacts(
  parent: { uid: number; gid: number; mode: number },
  file: { uid: number; gid: number; mode: number },
) {
  return (
    parent.uid === 0 &&
    parent.gid === 0 &&
    (parent.mode & 0o777) === 0o700 &&
    file.uid === 1001 &&
    file.gid === 1001 &&
    (file.mode & 0o777) === 0o400
  );
}

export function checkFilesystem(config: ProductionConfig) {
  const source = fileInfo(config.inputFile, "ENV_FILE");
  if (
    !source.isFile() ||
    ![0o400, 0o600].includes(source.mode & 0o777) ||
    (source.uid !== 0 && source.uid !== process.getuid?.())
  )
    reject("UNSAFE_ENV_FILE");
  privateDirectory(config.configRoot, "CONFIG_ROOT");
  privateDirectory(config.initDir, "POSTGRES_INIT_DIR");
  privateDirectory(dirname(config.releaseFile), "RELEASE_DIRECTORY");
  if (config.backupRoot) privateDirectory(config.backupRoot, "BACKUP_ROOT");
  if (config.workerSecretFile) {
    const parent = fileInfo(
      dirname(config.workerSecretFile),
      "WORKER_SECRET_PARENT",
    );
    const secret = fileInfo(config.workerSecretFile, "WORKER_SECRET_FILE");
    if (
      !parent.isDirectory() ||
      !secret.isFile() ||
      !validateWorkerPermissionFacts(parent, secret)
    )
      reject("UNSAFE_WORKER_SECRET_PERMISSIONS");
    let workerUrl: string;
    try {
      workerUrl = readFileSync(config.workerSecretFile, "utf8").trim();
    } catch {
      reject("UNREADABLE_WORKER_SECRET");
    }
    validateExplicitUrl(
      workerUrl,
      config.roles.worker.user,
      config.roles.worker.password,
      config.dbHost,
      config.dbPort,
      config.dbName,
      "WORKER_SECRET_URL",
    );
  }
}

export function loadProductionConfig(inputFile: string): ProductionConfig {
  const source = absolutePath(inputFile, "ENV_FILE");
  const repository = realpathSync(repositoryRoot());
  const sourceStat = fileInfo(source, "ENV_FILE");
  if (!sourceStat.isFile()) reject("INVALID_ENV_FILE");
  if (insideRepository(realpathSync(source), repository))
    reject("ENV_INSIDE_REPOSITORY");
  let contents: string;
  try {
    contents = readFileSync(source, "utf8");
  } catch {
    reject("UNREADABLE_ENV_FILE");
  }
  const values = parseEnvFile(contents);
  if (values.BOOTSTRAP_ADMIN_PASSWORD)
    reject("ADMIN_PASSWORD_NOT_ALLOWED_IN_ENV");
  if (values.PRODUCT_HUB_RELEASE_COMPOSE)
    reject("UNSUPPORTED_RELEASE_PATH_ALIAS");
  const domain = required(values.APP_DOMAIN || "", "APP_DOMAIN");
  const authUrl = required(values.BETTER_AUTH_URL || "", "BETTER_AUTH_URL");
  validateOrigin(
    domain,
    authUrl,
    required(
      values.BETTER_AUTH_TRUSTED_ORIGINS || "",
      "BETTER_AUTH_TRUSTED_ORIGINS",
    ),
  );
  const authSecret = required(
    values.BETTER_AUTH_SECRET || "",
    "BETTER_AUTH_SECRET",
  );
  if (Buffer.byteLength(authSecret, "utf8") < 32)
    reject("WEAK_BETTER_AUTH_SECRET");
  const dbName = required(values.POSTGRES_DB || "", "POSTGRES_DB");
  if (!rolePattern.test(dbName)) reject("INVALID_POSTGRES_DB");
  const dbHost = validateHost(values.POSTGRES_HOST || "postgres");
  const dbPort = port(values.POSTGRES_PORT || "5432", "POSTGRES_PORT");
  const roleFields = {
    admin: [
      "POSTGRES_ADMIN_USER",
      "POSTGRES_USER",
      "POSTGRES_ADMIN_PASSWORD",
      "POSTGRES_PASSWORD",
      "product_hub_db_admin",
      "ADMIN_DATABASE_URL",
    ],
    migration: [
      "POSTGRES_MIGRATION_USER",
      "MIGRATION_DB_USER",
      "POSTGRES_MIGRATION_PASSWORD",
      "MIGRATION_DB_PASSWORD",
      "product_hub_migration",
      "MIGRATION_DATABASE_URL",
    ],
    app: [
      "POSTGRES_APP_USER",
      "APP_DB_USER",
      "POSTGRES_APP_PASSWORD",
      "APP_DB_PASSWORD",
      "product_hub_app",
      "APP_DATABASE_URL",
    ],
    worker: [
      "HARD_DELETE_WORKER_DB_USER",
      "",
      "HARD_DELETE_WORKER_DB_PASSWORD",
      "",
      "product_hub_hard_delete_worker",
      "",
    ],
  } as const;
  const roles = {} as ProductionConfig["roles"];
  for (const name of Object.keys(roleFields) as RoleName[]) {
    const [
      userField,
      oldUser,
      passwordField,
      oldPassword,
      defaultUser,
      urlField,
    ] = roleFields[name];
    const user = field(values, userField, oldUser || undefined, defaultUser);
    const password = required(
      field(values, passwordField, oldPassword || undefined),
      passwordField,
    );
    if (!rolePattern.test(user)) reject(`INVALID_${userField}`);
    if (password.length > 512 || /[\r\n\0]/.test(password))
      reject(`INVALID_${passwordField}`);
    const derived = databaseUrl(user, password, dbHost, dbPort, dbName);
    roles[name] = {
      user,
      password,
      url:
        urlField && values[urlField]
          ? validateExplicitUrl(
              values[urlField],
              user,
              password,
              dbHost,
              dbPort,
              dbName,
              urlField,
            )
          : derived,
    };
  }
  if (
    new Set(Object.values(roles).map((role) => role.user)).size !== 4 ||
    new Set(Object.values(roles).map((role) => role.password)).size !== 4
  )
    reject("DUPLICATE_DB_IDENTITY");
  if (values.STORAGE_DRIVER !== "local") reject("INVALID_STORAGE_DRIVER");
  if (values.LOCAL_STORAGE_ROOT !== "/data/uploads")
    reject("INVALID_STORAGE_ROOT");
  const appPort = port(values.APP_PORT || "3000", "APP_PORT");
  const projectName = values.PRODUCT_HUB_COMPOSE_PROJECT || "product-hub";
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(projectName))
    reject("INVALID_COMPOSE_PROJECT");
  const configRoot = absolutePath(
    values.PRODUCT_HUB_CONFIG_ROOT || "/opt/product-hub/config",
    "CONFIG_ROOT",
  );
  const initDir = absolutePath(
    values.PRODUCT_HUB_POSTGRES_INIT_DIR ||
      join(configRoot, "postgres/init-production"),
    "POSTGRES_INIT_DIR",
  );
  const releaseFile = absolutePath(
    process.env.PRODUCT_HUB_RELEASE_FILE ||
      values.PRODUCT_HUB_RELEASE_FILE ||
      join(repository, "compose.release.yaml"),
    "RELEASE_FILE",
  );
  const backupRoot = values.PRODUCT_HUB_BACKUP_ROOT
    ? absolutePath(values.PRODUCT_HUB_BACKUP_ROOT, "BACKUP_ROOT")
    : undefined;
  const workerSecretFile = values.HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE
    ? absolutePath(
        values.HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE,
        "WORKER_SECRET_FILE",
      )
    : undefined;
  if (workerSecretFile) {
    fileInfo(workerSecretFile, "WORKER_SECRET_FILE");
    if (insideRepository(realpathSync(workerSecretFile), repository))
      reject("WORKER_SECRET_INSIDE_REPOSITORY");
  }
  try {
    const releaseActualPath = join(
      realpathSync(dirname(releaseFile)),
      basename(releaseFile),
    );
    if (
      insideRepository(releaseActualPath, repository) &&
      !/^compose\.release.*\.yaml$/.test(basename(releaseFile))
    )
      reject("UNTRACKED_RELEASE_PATH_REQUIRED");
  } catch (error) {
    if (error instanceof ConfigFailure) throw error;
    reject("MISSING_RELEASE_DIRECTORY");
  }
  const runtimeFile = join(dirname(source), "product-hub.resolved.env");
  if (
    source === runtimeFile ||
    releaseFile === source ||
    releaseFile === runtimeFile
  )
    reject("OUTPUT_PATH_COLLISION");
  const config = {
    inputFile: source,
    runtimeFile,
    releaseFile,
    domain,
    authUrl,
    authSecret,
    dbName,
    dbHost,
    dbPort,
    roles,
    appPort,
    projectName,
    configRoot,
    initDir,
    backupRoot,
    workerSecretFile,
  };
  checkFilesystem(config);
  return config;
}

export function validateImageReference(value: string) {
  const digest = value.includes("@");
  if (
    value.length > 255 ||
    value.endsWith(":latest") ||
    (digest
      ? !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(value)
      : !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*:[a-zA-Z0-9_.-]+$/.test(value))
  )
    reject("INVALID_IMAGE_REFERENCE");
  return value;
}

function quotedEnv(value: string) {
  if (/[\r\n\0]/.test(value)) reject("INVALID_ENV_VALUE");
  // Compose treats a trailing backslash before a single closing quote as an escape.
  // Double quoting supports escaped backslashes; $$ protects literal interpolation.
  if (value.endsWith("\\")) return JSON.stringify(value.split("$").join("$$"));
  return `'${value.replaceAll("'", "\\'")}'`;
}

export function renderRuntimeEnv(
  config: ProductionConfig,
  workerImage: string,
) {
  const fields: Values = {
    APP_DOMAIN: config.domain,
    BETTER_AUTH_URL: config.authUrl,
    BETTER_AUTH_TRUSTED_ORIGINS: config.authUrl,
    BETTER_AUTH_SECRET: config.authSecret,
    POSTGRES_DB: config.dbName,
    POSTGRES_USER: config.roles.admin.user,
    POSTGRES_PASSWORD: config.roles.admin.password,
    MIGRATION_DB_USER: config.roles.migration.user,
    MIGRATION_DB_PASSWORD: config.roles.migration.password,
    APP_DB_USER: config.roles.app.user,
    APP_DB_PASSWORD: config.roles.app.password,
    ADMIN_DATABASE_URL: config.roles.admin.url,
    MIGRATION_DATABASE_URL: config.roles.migration.url,
    APP_DATABASE_URL: config.roles.app.url,
    HARD_DELETE_WORKER_DB_USER: config.roles.worker.user,
    HARD_DELETE_WORKER_DB_PASSWORD: config.roles.worker.password,
    HARD_DELETE_WORKER_IMAGE: workerImage,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: "/data/uploads",
    APP_PORT: String(config.appPort),
    PRODUCT_HUB_COMPOSE_PROJECT: config.projectName,
    PRODUCT_HUB_POSTGRES_INIT_DIR: config.initDir,
  };
  if (config.workerSecretFile)
    fields.HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE =
      config.workerSecretFile;
  return (
    "# DO NOT EDIT — GENERATED by pnpm release:configure. Mode 0600; never commit.\n" +
    Object.entries(fields)
      .map(([key, value]) => `${key}=${quotedEnv(value)}`)
      .join("\n") +
    "\n"
  );
}

export function renderReleaseCompose(
  template: string,
  images: { runner: string; migrator: string; worker: string },
) {
  const replacements: Record<string, string> = {
    RUNNER_IMAGE: JSON.stringify(validateImageReference(images.runner)),
    MIGRATOR_IMAGE: JSON.stringify(validateImageReference(images.migrator)),
    WORKER_IMAGE: JSON.stringify(validateImageReference(images.worker)),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(replacements, key)) reject("INVALID_RELEASE_TEMPLATE");
    return replacements[key]!;
  });
}

export function renderManifestReleaseCompose(
  template: string,
  manifest: ReleaseManifest,
) {
  const replacements: Record<string, string> = {
    VERSION: JSON.stringify(manifest.version),
    SOURCE_COMMIT: JSON.stringify(manifest.sourceCommit),
    DISTRIBUTION_COMMIT: JSON.stringify(manifest.distributionCommit),
    RUNNER_IMAGE: JSON.stringify(manifest.images.runner),
    MIGRATOR_IMAGE: JSON.stringify(manifest.images.migrator),
    WORKER_IMAGE: JSON.stringify(manifest.images.worker),
    POSTGRES_IMAGE: JSON.stringify(manifest.images.postgres),
  };
  const rendered = template.replace(
    /\{\{([A-Z_]+)\}\}/g,
    (_match, key: string) => {
      if (!Object.hasOwn(replacements, key)) reject("INVALID_RELEASE_TEMPLATE");
      return replacements[key]!;
    },
  );
  if (/\{\{[A-Z_]+\}\}/.test(rendered)) reject("INVALID_RELEASE_TEMPLATE");
  return rendered;
}

function assertWritableTarget(path: string, force: boolean) {
  if (!existsSync(path)) return;
  const stat = fileInfo(path, "OUTPUT_FILE");
  if (!force || !stat.isFile()) reject("OUTPUT_EXISTS_USE_FORCE");
}

export function atomicWrite(path: string, content: string, mode: number) {
  const temp = join(dirname(path), `.product-hub-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
    reject("OUTPUT_WRITE_FAILED");
  }
}

export function writeReleaseFiles(
  config: ProductionConfig,
  images: { runner: string; migrator: string; worker: string },
  template: string,
  force: boolean,
) {
  const compose = renderReleaseCompose(template, images);
  const runtime = renderRuntimeEnv(config, images.worker);
  assertWritableTarget(config.runtimeFile, force);
  assertWritableTarget(config.releaseFile, force);
  atomicWrite(config.runtimeFile, runtime, 0o600);
  atomicWrite(config.releaseFile, compose, 0o644);
}

export function writeManifestReleaseFiles(
  config: ProductionConfig,
  manifest: ReleaseManifest,
  template: string,
  force: boolean,
) {
  const compose = renderManifestReleaseCompose(template, manifest);
  const runtime = renderRuntimeEnv(config, manifest.images.worker);
  assertWritableTarget(config.runtimeFile, force);
  assertWritableTarget(config.releaseFile, force);
  atomicWrite(config.runtimeFile, runtime, 0o600);
  atomicWrite(config.releaseFile, compose, 0o644);
}
