import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  parseReleaseManifest,
  ReleaseManifestFailure,
  renderReleaseManifest,
  type ReleaseManifest,
} from "./manifest";

function value(name: string) {
  const result = process.env[name];
  if (!result) throw new ReleaseManifestFailure(`MISSING_${name}`);
  return result;
}

try {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3)
    throw new ReleaseManifestFailure("INVALID_ARGUMENT");
  const manifest: ReleaseManifest = {
    schema: "product-hub-release/v1",
    version: value("RELEASE_VERSION"),
    sourceCommit: value("SOURCE_COMMIT"),
    distributionCommit: value("DISTRIBUTION_COMMIT"),
    platform: "linux/amd64",
    images: {
      runner: value("RUNNER_IMAGE"),
      migrator: value("MIGRATOR_IMAGE"),
      worker: value("WORKER_IMAGE"),
      postgres: value("POSTGRES_IMAGE"),
    },
    workflowRun: value("WORKFLOW_RUN"),
    publishedAt: value("PUBLISHED_AT"),
  };
  const rendered = renderReleaseManifest(manifest);
  parseReleaseManifest(rendered);
  writeFileSync(output, rendered, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  writeFileSync(
    `${output}.sha256`,
    `${createHash("sha256").update(rendered).digest("hex")}  ${basename(output)}\n`,
    { flag: "wx", mode: 0o644 },
  );
  process.stdout.write("PASS: immutable release manifest created\n");
} catch (error) {
  process.stderr.write(
    `FAIL: ${error instanceof ReleaseManifestFailure ? error.code : "MANIFEST_CREATE_FAILED"}\n`,
  );
  process.exitCode = 1;
}
