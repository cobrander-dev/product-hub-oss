import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import {
  parseReleaseManifest,
  ReleaseManifestFailure,
  type ReleaseManifest,
  isSemanticVersion,
} from "./manifest";

const inspectSchema = z
  .array(
    z
      .object({
        Id: z.string().min(1),
        Os: z.string(),
        Architecture: z.string(),
        RepoDigests: z.array(z.string()).default([]),
        Config: z
          .object({ Labels: z.record(z.string(), z.string()).nullable() })
          .passthrough(),
      })
      .passthrough(),
  )
  .length(1);

function fail(code: string): never {
  throw new ReleaseManifestFailure(code);
}

export function verifyManifestChecksum(path: string) {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (
    readFileSync(`${path}.sha256`, "utf8") !== `${actual}  ${basename(path)}\n`
  )
    fail("MANIFEST_CHECKSUM_MISMATCH");
}

export function verifyImageLabels(
  manifest: ReleaseManifest,
  labels: Record<string, string>,
) {
  const version = labels["org.opencontainers.image.version"];
  if (
    labels["org.opencontainers.image.revision"] !== manifest.sourceCommit ||
    !(
      version === manifest.version ||
      (isSemanticVersion(manifest.version) &&
        version === `verification-${manifest.sourceCommit}`)
    )
  )
    fail("IMAGE_REVISION_MISMATCH");
}

function docker(args: string[]) {
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
    timeout: 10 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) fail("DOCKER_COMMAND_FAILED");
  return result.stdout.trim();
}

export function verifyLocalReleaseImages(manifest: ReleaseManifest) {
  for (const [name, reference] of Object.entries(manifest.images)) {
    const [facts] = inspectSchema.parse(
      JSON.parse(docker(["image", "inspect", reference])),
    );
    if (facts.Os !== "linux" || facts.Architecture !== "amd64")
      fail("IMAGE_ARCHITECTURE_MISMATCH");
    if (!facts.RepoDigests.includes(reference)) fail("IMAGE_DIGEST_MISMATCH");
    if (name !== "postgres") {
      const labels = facts.Config.Labels || {};
      verifyImageLabels(manifest, labels);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const pull = args.includes("--pull");
  const checksum = args.includes("--checksum");
  const paths = args.filter(
    (value) => value !== "--pull" && value !== "--checksum",
  );
  if (paths.length !== 1) fail("INVALID_ARGUMENT");
  if (checksum) verifyManifestChecksum(paths[0]!);
  const manifest = parseReleaseManifest(readFileSync(paths[0]!, "utf8"));
  if (pull)
    for (const reference of Object.values(manifest.images))
      docker(["pull", "--platform", manifest.platform, reference]);
  verifyLocalReleaseImages(manifest);
  process.stdout.write(
    `PASS: release manifest ${manifest.version} ${manifest.sourceCommit}\n`,
  );
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `FAIL: ${error instanceof ReleaseManifestFailure ? error.code : "RELEASE_VERIFICATION_FAILED"}\n`,
    );
    process.exitCode = 1;
  }
}
