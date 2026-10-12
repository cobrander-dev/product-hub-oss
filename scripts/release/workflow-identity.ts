import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { releaseIdentity, ReleaseManifestFailure } from "./manifest";

try {
  const {
    RELEASE_MODE = "",
    SOURCE_COMMIT = "",
    DISTRIBUTION_COMMIT = "",
    RELEASE_VERSION = "",
    VERIFICATION_RUN = "",
    CONFIRMATION,
  } = process.env;
  if (
    CONFIRMATION !== "PUBLISH_IMMUTABLE_IMAGES" ||
    !/^[0-9a-f]{40}$/.test(DISTRIBUTION_COMMIT)
  )
    throw new ReleaseManifestFailure("INVALID_WORKFLOW_IDENTITY");
  const identity = releaseIdentity(
    RELEASE_MODE,
    SOURCE_COMMIT,
    RELEASE_VERSION,
    VERIFICATION_RUN,
  );
  for (const [tree, expected] of [
    ["source", SOURCE_COMMIT],
    ["tooling", DISTRIBUTION_COMMIT],
  ]) {
    const head = spawnSync("git", ["-C", tree!, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    if (head.status !== 0 || head.stdout.trim() !== expected)
      throw new ReleaseManifestFailure("CHECKOUT_REVISION_MISMATCH");
  }
  if (!process.env.GITHUB_OUTPUT)
    throw new ReleaseManifestFailure("WORKFLOW_OUTPUT_REQUIRED");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${identity.version}\ntag=${identity.tag}\n`,
  );
} catch (error) {
  process.stderr.write(
    `FAIL: ${error instanceof ReleaseManifestFailure ? error.code : "WORKFLOW_IDENTITY_FAILED"}\n`,
  );
  process.exitCode = 1;
}
