const legacyKeys = [
  "schema",
  "version",
  "source_commit",
  "distribution_commit",
  "platform",
  "runner",
  "migrator",
  "worker",
  "postgres",
  "workflow_run",
  "published_at",
] as const;
const keys = [
  "schema_version",
  "version",
  "source_commit",
  "distribution_commit",
  "platform",
  "runner",
  "migrator",
  "worker",
  "postgres",
  "workflow_run_id",
  "created_at",
] as const;

type ManifestKey = (typeof legacyKeys)[number];

export interface ReleaseManifest {
  schema: "product-hub-release/v1";
  version: string;
  sourceCommit: string;
  distributionCommit: string;
  platform: "linux/amd64";
  images: {
    runner: string;
    migrator: string;
    worker: string;
    postgres: string;
  };
  workflowRun: string;
  publishedAt: string;
}

export class ReleaseManifestFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function reject(code: string): never {
  throw new ReleaseManifestFailure(code);
}

const sha = /^[0-9a-f]{40}$/;
const digest = "sha256:[0-9a-f]{64}";
const semver =
  /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isSemanticVersion(value: string) {
  if (!semver.test(value)) return false;
  const prerelease = value.indexOf("-");
  return (
    prerelease < 0 ||
    value
      .slice(prerelease + 1)
      .split(".")
      .every((part) => !/^0[0-9]+$/.test(part))
  );
}

export function releaseIdentity(
  mode: string,
  sourceCommit: string,
  version = "",
  verificationRun = "",
) {
  if (!sha.test(sourceCommit)) reject("INVALID_RELEASE_COMMIT");
  if (mode === "verification") {
    if (version || verificationRun) reject("VERIFICATION_INPUT_FORBIDDEN");
    return {
      version: `verification-${sourceCommit}`,
      tag: `sha-${sourceCommit}`,
    };
  }
  if (mode !== "release" || !isSemanticVersion(version))
    reject("INVALID_RELEASE_MODE_OR_VERSION");
  if (!/^[1-9][0-9]{0,19}$/.test(verificationRun))
    reject("VERIFICATION_RUN_REQUIRED");
  return { version, tag: version };
}

function productImage(value: string, repository: string) {
  if (
    !new RegExp(`^ghcr\\.io/cobrander-dev/${repository}@${digest}$`).test(value)
  )
    reject("INVALID_PRODUCT_IMAGE");
  return value;
}

function postgresImage(value: string) {
  if (!new RegExp(`^postgres@${digest}$`).test(value))
    reject("INVALID_POSTGRES_IMAGE");
  return value;
}

function parseLines(contents: string) {
  if (
    Buffer.byteLength(contents, "utf8") > 16 * 1024 ||
    contents.includes("\0") ||
    contents.includes("\r") ||
    !contents.endsWith("\n")
  )
    reject("INVALID_MANIFEST_ENCODING");
  const lines = contents.slice(0, -1).split("\n");
  const canonical = lines[0] === "schema_version=1";
  const expectedKeys = canonical ? keys : legacyKeys;
  if (lines.length !== expectedKeys.length) reject("INVALID_MANIFEST_SHAPE");
  const values = {} as Record<ManifestKey, string>;
  for (const [index, expected] of expectedKeys.entries()) {
    const match = /^([a-z][a-z0-9_]*)=([!-~]+)$/.exec(lines[index] || "");
    if (!match || match[1] !== expected) reject("INVALID_MANIFEST_SHAPE");
    values[legacyKeys[index]!] = match[2]!;
  }
  if (canonical) values.schema = "product-hub-release/v1";
  return values;
}

export function parseReleaseManifest(contents: string): ReleaseManifest {
  const values = parseLines(contents);
  if (values.schema !== "product-hub-release/v1")
    reject("UNSUPPORTED_MANIFEST_SCHEMA");
  if (
    !isSemanticVersion(values.version) &&
    !/^verification-[0-9a-f]{40}$/.test(values.version)
  )
    reject("INVALID_RELEASE_VERSION");
  if (!sha.test(values.source_commit) || !sha.test(values.distribution_commit))
    reject("INVALID_RELEASE_COMMIT");
  if (
    values.version.startsWith("verification-") &&
    values.version !== `verification-${values.source_commit}`
  )
    reject("VERIFICATION_SOURCE_MISMATCH");
  if (values.platform !== "linux/amd64") reject("INVALID_RELEASE_PLATFORM");
  if (!/^[1-9][0-9]{0,19}$/.test(values.workflow_run))
    reject("INVALID_WORKFLOW_RUN");
  let publishedAt: string;
  try {
    publishedAt = new Date(values.published_at).toISOString();
  } catch {
    reject("INVALID_PUBLISHED_AT");
  }
  if (publishedAt !== values.published_at) reject("INVALID_PUBLISHED_AT");
  return {
    schema: values.schema,
    version: values.version,
    sourceCommit: values.source_commit,
    distributionCommit: values.distribution_commit,
    platform: values.platform,
    images: {
      runner: productImage(values.runner, "product-hub-oss-app"),
      migrator: productImage(values.migrator, "product-hub-oss-migrator"),
      worker: productImage(values.worker, "product-hub-oss-hard-delete-worker"),
      postgres: postgresImage(values.postgres),
    },
    workflowRun: values.workflow_run,
    publishedAt,
  };
}

export function renderReleaseManifest(manifest: ReleaseManifest) {
  const values: Record<ManifestKey, string> = {
    schema: manifest.schema,
    version: manifest.version,
    source_commit: manifest.sourceCommit,
    distribution_commit: manifest.distributionCommit,
    platform: manifest.platform,
    runner: manifest.images.runner,
    migrator: manifest.images.migrator,
    worker: manifest.images.worker,
    postgres: manifest.images.postgres,
    workflow_run: manifest.workflowRun,
    published_at: manifest.publishedAt,
  };
  return (
    keys
      .map(
        (key, index) =>
          `${key}=${index === 0 ? "1" : values[legacyKeys[index]!]}`,
      )
      .join("\n") + "\n"
  );
}

export const releaseManifestKeys = [...keys];
