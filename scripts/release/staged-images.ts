import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { releaseIdentity, ReleaseManifestFailure } from "./manifest";

export const products = {
  runner: "product-hub-oss-app",
  migrator: "product-hub-oss-migrator",
  worker: "product-hub-oss-hard-delete-worker",
} as const;
export const trivyImage =
  "aquasec/trivy@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c";
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const descriptor = z.object({
  digest,
  platform: z.object({ os: z.string(), architecture: z.string() }).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});
const indexSchema = z.object({ manifests: z.array(descriptor) });
const configSchema = z.object({
  os: z.literal("linux"),
  architecture: z.literal("amd64"),
  config: z.object({ Labels: z.record(z.string(), z.string()) }),
});
function fail(code: string): never {
  throw new ReleaseManifestFailure(code);
}
// Credentials in URLs, auth headers, key=value secrets and GitHub tokens
// never reach CI logs.
function redact(text: string) {
  return text
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[REDACTED]@")
    .replace(/\b(authorization|bearer|basic)\b[:=\s]+\S+/gi, "$1 [REDACTED]")
    .replace(
      /\b([\w-]*(?:token|password|passwd|secret|credential|api[_-]?key)[\w-]*)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g,
      "[REDACTED]",
    );
}
// Tool stderr is also bounded; finding lists are never truncated.
export function sanitizeDiagnostics(text: string) {
  return redact(text).split("\n").slice(-40).join("\n").slice(-6000);
}
function run(program: string, args: string[]) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  if (result.status !== 0) {
    const detail = sanitizeDiagnostics(
      result.error ? result.error.message : result.stderr || "",
    ).trim();
    if (detail) process.stderr.write(`${program} diagnostics:\n${detail}\n`);
    fail(`${program.toUpperCase()}_FAILED`);
  }
  return result.stdout;
}
function hash(contents: Buffer | string) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}
function archiveHash(path: string) {
  // Stream large OCI archives instead of loading multi-GB images into memory.
  const output = run("shasum", ["-a", "256", path]);
  return digest.parse(`sha256:${output.slice(0, 64)}`);
}
function inspect(reference: string, source: string) {
  const raw = run("skopeo", ["inspect", "--raw", reference]);
  const index = indexSchema.parse(JSON.parse(raw));
  const runtime = index.manifests.filter(
    (item) =>
      item.annotations?.["vnd.docker.reference.type"] !==
      "attestation-manifest",
  );
  if (
    runtime.length !== 1 ||
    runtime[0]?.platform?.os !== "linux" ||
    runtime[0]?.platform?.architecture !== "amd64"
  )
    fail("IMAGE_ARCHITECTURE");
  const attestations = index.manifests.filter(
    (item) =>
      item.annotations?.["vnd.docker.reference.type"] ===
        "attestation-manifest" &&
      item.annotations?.["vnd.docker.reference.digest"] === runtime[0]!.digest,
  );
  if (!attestations.length) fail("ATTESTATION_MISSING");
  const facts = configSchema.parse(
    JSON.parse(
      run("skopeo", [
        "--override-os",
        "linux",
        "--override-arch",
        "amd64",
        "inspect",
        "--config",
        reference,
      ]),
    ),
  );
  if (
    facts.config.Labels["org.opencontainers.image.revision"] !== source ||
    facts.config.Labels["org.opencontainers.image.version"] !==
      `verification-${source}`
  )
    fail("IMAGE_REVISION_MISMATCH");
  return { digest: hash(raw), attestations };
}
function verifyPredicates(
  reference: string,
  attestations: z.infer<typeof descriptor>[],
) {
  const predicates = new Set<string>();
  for (const item of attestations) {
    const raw = reference.startsWith("oci-archive:")
      ? run("tar", [
          "-xOf",
          reference.slice("oci-archive:".length),
          `blobs/sha256/${item.digest.slice(7)}`,
        ])
      : run("skopeo", [
          "inspect",
          "--raw",
          `${reference.split("@")[0]}@${item.digest}`,
        ]);
    if (hash(raw) !== item.digest) fail("ATTESTATION_DIGEST_MISMATCH");
    const body = z
      .object({
        layers: z.array(
          z.object({
            annotations: z.record(z.string(), z.string()).optional(),
          }),
        ),
      })
      .parse(JSON.parse(raw));
    for (const layer of body.layers)
      predicates.add(layer.annotations?.["in-toto.io/predicate-type"] || "");
  }
  if (
    !predicates.has("https://spdx.dev/Document") ||
    ![...predicates].some((type) =>
      /^https:\/\/slsa\.dev\/provenance\/v[01](?:\.\d+)?$/.test(type),
    )
  )
    fail("PROVENANCE_OR_SBOM_MISSING");
}
const entrySchema = z.object({ archive: z.string(), checksum: digest, digest });
const stateSchema = z.object({
  source: z.string().regex(/^[0-9a-f]{40}$/),
  entries: z.object({
    runner: entrySchema,
    migrator: entrySchema,
    worker: entrySchema,
  }),
});
type State = z.infer<typeof stateSchema>;

const trivyReportSchema = z.object({
  Results: z
    .array(
      z.object({
        Target: z.string(),
        Vulnerabilities: z
          .array(
            z.object({
              VulnerabilityID: z.string(),
              PkgName: z.string(),
              InstalledVersion: z.string().optional(),
              FixedVersion: z.string().optional(),
              Status: z.string().optional(),
              Severity: z.string(),
            }),
          )
          .nullish(),
        Secrets: z
          .array(z.object({ RuleID: z.string(), Severity: z.string() }))
          .nullish(),
      }),
    )
    .nullish(),
});
const severe = (severity: string) => /^(CRITICAL|HIGH)$/.test(severity);

// "Fixable" mirrors Trivy --ignore-unfixed: a published fixed version exists.
export function summarizeTrivy(raw: string) {
  let report: z.infer<typeof trivyReportSchema>;
  try {
    report = trivyReportSchema.parse(JSON.parse(raw));
  } catch {
    fail("TRIVY_REPORT_INVALID");
  }
  const counts: Record<string, number> = {};
  const findings = [];
  const secrets = [];
  for (const result of report.Results ?? []) {
    for (const item of result.Vulnerabilities ?? []) {
      counts[item.Severity] = (counts[item.Severity] ?? 0) + 1;
      if (severe(item.Severity))
        findings.push({
          severity: item.Severity,
          id: item.VulnerabilityID,
          pkg: item.PkgName,
          installed: item.InstalledVersion ?? "",
          fixed: item.FixedVersion ?? "",
          status: item.Status ?? "",
          target: result.Target,
        });
    }
    for (const item of result.Secrets ?? [])
      if (severe(item.Severity))
        // Rule and file only; never the matched secret content.
        secrets.push({ rule: item.RuleID, target: result.Target });
  }
  return {
    counts,
    findings,
    fixable: findings.filter((item) => item.fixed),
    unfixed: findings.filter((item) => !item.fixed),
    secrets,
  };
}
function printFindings(
  name: string,
  label: string,
  summary: ReturnType<typeof summarizeTrivy>,
) {
  const counts = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]
    .map((severity) => `${severity}=${summary.counts[severity] ?? 0}`)
    .join(" ");
  const lines = [
    `[${name}] ${label}: ${counts}; Critical/High fixable=${summary.fixable.length} unfixed=${summary.unfixed.length}; Critical/High secret findings ${summary.secrets.length}`,
    ...summary.findings.map(
      (item) =>
        `  ${item.severity} ${item.id} ${item.pkg} ${item.installed} -> ${item.fixed || `no fix (${item.status || "unknown"})`} [${item.target}]`,
    ),
    ...summary.secrets.map((item) => `  SECRET ${item.rule} [${item.target}]`),
  ];
  process.stdout.write(`${redact(lines.join("\n"))}\n`);
}
// Retained report keeps every vulnerability; secret findings keep only
// rule/severity/location, never Trivy's Match or Code excerpts.
export function retainableReport(raw: string) {
  const report = JSON.parse(raw) as {
    Results?: { Secrets?: Record<string, unknown>[] }[];
  };
  for (const result of report.Results ?? [])
    if (result.Secrets)
      result.Secrets = result.Secrets.map((item) => ({
        RuleID: item.RuleID,
        Category: item.Category,
        Severity: item.Severity,
        Title: item.Title,
        StartLine: item.StartLine,
        EndLine: item.EndLine,
      }));
  return JSON.stringify(report);
}
function trivy(directory: string, name: string, args: string[]) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--mount",
      `type=bind,source=${directory},target=/work,readonly`,
      "--mount",
      "type=volume,source=product-hub-trivy-cache,target=/root/.cache/trivy",
      trivyImage,
      "image",
      "--platform",
      "linux/amd64",
      "--input",
      `/work/${name}-layout`,
      "--scanners",
      "vuln,secret",
      "--format",
      "json",
      "--quiet",
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 },
  );
}
export function scanImage(directory: string, name: string) {
  // 1. Complete inventory: every severity, nothing filtered, never gates alone.
  const full = trivy(directory, name, ["--exit-code", "0"]);
  if (full.status !== 0) {
    process.stderr.write(
      `trivy diagnostics:\n${sanitizeDiagnostics(full.error?.message || full.stderr || "")}\n`,
    );
    fail("TRIVY_FULL_SCAN_FAILED");
  }
  const inventory = summarizeTrivy(full.stdout);
  writeFileSync(
    join(directory, "scan-reports", `${name}.full.json`),
    retainableReport(full.stdout),
    { flag: "wx" },
  );
  printFindings(name, "full inventory", inventory);
  // 2. Official gate on the same DB: any fixable Critical/High or any
  // Critical/High secret blocks every push.
  const gate = trivy(directory, name, [
    "--severity",
    "CRITICAL,HIGH",
    "--ignore-unfixed",
    "--skip-db-update",
    "--exit-code",
    "1",
  ]);
  let gated: ReturnType<typeof summarizeTrivy>;
  try {
    gated = summarizeTrivy(gate.stdout);
  } catch {
    process.stderr.write(
      `trivy diagnostics:\n${sanitizeDiagnostics(gate.error?.message || gate.stderr || "")}\n`,
    );
    fail("TRIVY_GATE_FAILED");
  }
  if (gate.status !== 0 || gated.findings.length || gated.secrets.length) {
    printFindings(name, "BLOCKING fixable Critical/High or secret", gated);
    fail("FIXABLE_CRITICAL_HIGH_OR_SECRET");
  }
  if (inventory.fixable.length || inventory.secrets.length)
    fail("SCAN_GATE_INCONSISTENT");
}

export function scanArchives(directory: string, source: string) {
  releaseIdentity("verification", source);
  const entries = {} as State["entries"];
  mkdirSync(join(directory, "scan-reports"), { recursive: true });
  for (const name of Object.keys(products) as (keyof typeof products)[]) {
    const archive = join(directory, `${name}.tar`);
    const reference = `oci-archive:${archive}`;
    const facts = inspect(reference, source);
    verifyPredicates(reference, facts.attestations);
    const before = archiveHash(archive);
    // Trivy accepts OCI layout directories, not OCI tarballs. Preserve the
    // exact index and all attestations when materializing the scan input.
    const layout = `oci:${join(directory, `${name}-layout`)}`;
    run("skopeo", ["copy", "--all", "--preserve-digests", reference, layout]);
    if (inspect(layout, source).digest !== facts.digest)
      fail("SCAN_LAYOUT_DIGEST_CHANGED");
    scanImage(directory, name);
    if (archiveHash(archive) !== before) fail("SCANNED_ARCHIVE_CHANGED");
    entries[name] = {
      archive: `${name}.tar`,
      checksum: before,
      digest: facts.digest,
    };
  }
  writeFileSync(
    join(directory, "scan-pass.json"),
    JSON.stringify({ source, entries }),
    { flag: "wx" },
  );
}

export function publishArchives(
  directory: string,
  source: string,
  tag: string,
) {
  if (tag !== releaseIdentity("verification", source).tag) {
    // Formal promotion is a separate entry point which validates its signed run.
    fail("INVALID_VERIFICATION_TAG");
  }
  return copyScannedArchives(directory, source, tag);
}

export function copyScannedArchives(
  directory: string,
  source: string,
  tag: string,
) {
  const state = stateSchema.parse(
    JSON.parse(readFileSync(join(directory, "scan-pass.json"), "utf8")),
  );
  if (state.source !== source) fail("SCAN_SOURCE_MISMATCH");
  // Check ALL three before making the first registry write.
  for (const name of Object.keys(products) as (keyof typeof products)[]) {
    const item = state.entries[name];
    if (
      item.archive !== `${name}.tar` ||
      archiveHash(join(directory, item.archive)) !== item.checksum
    )
      fail("SCANNED_ARCHIVE_CHANGED");
  }
  const images = {} as Record<keyof typeof products, string>;
  for (const name of Object.keys(products) as (keyof typeof products)[]) {
    const repository = `ghcr.io/cobrander-dev/${products[name]}`;
    const item = state.entries[name];
    const digestFile = join(directory, `${name}.digest`);
    run("skopeo", [
      "copy",
      "--all",
      "--preserve-digests",
      "--digestfile",
      digestFile,
      `oci-archive:${join(directory, item.archive)}`,
      `docker://${repository}:${tag}`,
    ]);
    if (readFileSync(digestFile, "utf8").trim() !== item.digest)
      fail("REGISTRY_DIGEST_CHANGED");
    const reference = `${repository}@${item.digest}`;
    const actual = inspect(`docker://${reference}`, source);
    if (actual.digest !== item.digest) fail("REGISTRY_DIGEST_MISMATCH");
    verifyPredicates(`docker://${reference}`, actual.attestations);
    images[name] = reference;
  }
  writeFileSync(join(directory, "registry.json"), JSON.stringify(images), {
    flag: "wx",
  });
  if (process.env.GITHUB_OUTPUT)
    for (const name of Object.keys(products) as (keyof typeof products)[])
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `${name}=${state.entries[name].digest}\n`,
      );
  return images;
}

function main() {
  const [command, directoryArg, source] = process.argv.slice(2);
  if (!directoryArg || !source || process.argv.length !== 5)
    fail("INVALID_ARGUMENT");
  const directory = resolve(directoryArg);
  if (command === "scan") scanArchives(directory, source);
  else if (command === "publish")
    publishArchives(
      directory,
      source,
      releaseIdentity("verification", source).tag,
    );
  else fail("INVALID_ARGUMENT");
}
if (process.argv[1] === import.meta.filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof ReleaseManifestFailure ? error.code : "STAGED_RELEASE_FAILED"}\n`,
    );
    process.exitCode = 1;
  }
}
