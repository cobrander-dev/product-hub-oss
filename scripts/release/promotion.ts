import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  parseReleaseManifest,
  releaseIdentity,
  ReleaseManifestFailure,
} from "./manifest";
import { verifyManifestChecksum } from "./verify-manifest";
import { products, scanArchives, copyScannedArchives } from "./staged-images";

function run(program: string, args: string[]) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 30 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new ReleaseManifestFailure("PROMOTION_COMMAND_FAILED");
  return result.stdout;
}

export function promote(
  directory: string,
  source: string,
  version: string,
  runId: string,
) {
  const identity = releaseIdentity("release", source, version, runId);
  const repo = "cobrander-dev/product-hub-oss";
  const workflow = ".github/workflows/release-images.yml";
  const runInfo = z
    .object({
      conclusion: z.literal("success"),
      status: z.literal("completed"),
      event: z.literal("workflow_dispatch"),
      path: z.literal(workflow),
      head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .parse(
      JSON.parse(run("gh", ["api", `repos/${repo}/actions/runs/${runId}`])),
    );
  const previous = join(directory, "previous");
  run("gh", [
    "run",
    "download",
    runId,
    "--repo",
    repo,
    "--name",
    `product-hub-verification-${source}`,
    "--dir",
    previous,
  ]);
  const path = join(previous, "product-hub-release.manifest");
  verifyManifestChecksum(path);
  const manifest = parseReleaseManifest(readFileSync(path, "utf8"));
  if (
    manifest.workflowRun !== runId ||
    manifest.sourceCommit !== source ||
    manifest.distributionCommit !== runInfo.head_sha ||
    manifest.version !== `verification-${source}`
  )
    throw new ReleaseManifestFailure("VERIFICATION_RUN_MISMATCH");
  const policy = [
    "--repo",
    repo,
    "--signer-workflow",
    `${repo}/${workflow}`,
    "--signer-digest",
    manifest.distributionCommit,
    "--deny-self-hosted-runners",
  ];
  run("gh", ["attestation", "verify", path, ...policy]);
  const postgres = readFileSync(
    process.env.POSTGRES_PIN_FILE ||
      "source/deploy/releases/postgres-linux-amd64.txt",
    "utf8",
  ).trim();
  if (postgres !== manifest.images.postgres)
    throw new ReleaseManifestFailure("POSTGRES_DIGEST_CHANGED");
  for (const name of Object.keys(products) as (keyof typeof products)[]) {
    const reference = manifest.images[name];
    run("gh", ["attestation", "verify", `oci://${reference}`, ...policy]);
    run("skopeo", [
      "copy",
      "--all",
      "--preserve-digests",
      `docker://${reference}`,
      `oci-archive:${join(directory, `${name}.tar`)}`,
    ]);
  }
  scanArchives(directory, source);
  // Reconfirm archived digests are exactly those authenticated by the signed manifest.
  const scanned = JSON.parse(
    readFileSync(join(directory, "scan-pass.json"), "utf8"),
  );
  for (const name of Object.keys(products) as (keyof typeof products)[]) {
    if (
      `ghcr.io/cobrander-dev/${products[name]}@${scanned.entries[name].digest}` !==
      manifest.images[name]
    )
      throw new ReleaseManifestFailure("PROMOTION_DIGEST_MISMATCH");
  }
  return copyScannedArchives(directory, source, identity.tag);
}

if (process.argv[1] === import.meta.filename) {
  try {
    const [directory, source, version, runId] = process.argv.slice(2);
    if (
      !directory ||
      !source ||
      !version ||
      !runId ||
      process.argv.length !== 6
    )
      throw new ReleaseManifestFailure("INVALID_ARGUMENT");
    promote(resolve(directory), source, version, runId);
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof ReleaseManifestFailure ? error.code : "PROMOTION_FAILED"}\n`,
    );
    process.exitCode = 1;
  }
}
