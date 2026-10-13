import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseReleaseManifest,
  type ReleaseManifest,
} from "../../scripts/release/manifest";
import { verifyLocalReleaseImages } from "../../scripts/release/verify-manifest";

const source = "1234567890abcdef1234567890abcdef12345678";
const version = `verification-${source}`;
const manifest = parseReleaseManifest(
  `schema_version=1\nversion=${version}\nsource_commit=${source}\ndistribution_commit=${"a".repeat(40)}\nplatform=linux/amd64\nrunner=ghcr.io/cobrander-dev/product-hub-oss-app@sha256:${"1".repeat(64)}\nmigrator=ghcr.io/cobrander-dev/product-hub-oss-migrator@sha256:${"2".repeat(64)}\nworker=ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker@sha256:${"3".repeat(64)}\npostgres=postgres@sha256:${"4".repeat(64)}\nworkflow_run_id=42\ncreated_at=2026-10-06T00:00:00.000Z\n`,
);
const labels = {
  "org.opencontainers.image.revision": source,
  "org.opencontainers.image.version": version,
};

type Inspect = Record<string, unknown>;
function image(reference: string, overrides: Inspect = {}): Inspect {
  return {
    Id: `sha256:${"f".repeat(64)}`,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [reference],
    Config: { Labels: labels },
    ...overrides,
  };
}

// Runs the real verifier against a fake `docker image inspect` whose output
// shape is chosen per image reference.
function verifyWith(shapes: Record<string, Inspect>, target: ReleaseManifest) {
  const root = mkdtempSync(join(tmpdir(), "product-hub-docker29-"));
  const saved = {
    PATH: process.env.PATH,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  };
  try {
    writeFileSync(join(root, "images.json"), JSON.stringify(shapes));
    writeFileSync(
      join(root, "docker"),
      `#!/usr/bin/env node\nconst s=JSON.parse(require("fs").readFileSync(process.env.DOCKER_CONFIG+"/images.json","utf8"));const r=process.argv.at(-1);if(!s[r])process.exit(1);process.stdout.write(JSON.stringify([s[r]]));\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${root}:${process.env.PATH}`;
    process.env.DOCKER_CONFIG = root;
    verifyLocalReleaseImages(target);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.DOCKER_CONFIG === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = saved.DOCKER_CONFIG;
    rmSync(root, { recursive: true });
  }
}

function shapes(overrides: Record<string, Inspect> = {}) {
  const { runner, migrator, worker, postgres } = manifest.images;
  return {
    [runner]: image(runner),
    [migrator]: image(migrator),
    [worker]: image(worker),
    // Docker 29 containerd image store: unlabeled image has no Labels key.
    [postgres]: image(postgres, { Config: { Env: ["PG_MAJOR=18"] } }),
    ...overrides,
  };
}

test("Docker 29 unlabeled PostgreSQL image (Labels absent) passes verification", () => {
  verifyWith(shapes(), manifest);
});

test("Docker 28 unlabeled PostgreSQL image (Labels null) still passes", () => {
  const { postgres } = manifest.images;
  verifyWith(
    shapes({ [postgres]: image(postgres, { Config: { Labels: null } }) }),
    manifest,
  );
});

test("product images without labels are still rejected on Docker 29", () => {
  for (const name of ["runner", "migrator", "worker"] as const) {
    const reference = manifest.images[name];
    for (const config of [{}, { Labels: null }, { Labels: {} }])
      assert.throws(
        () =>
          verifyWith(
            shapes({ [reference]: image(reference, { Config: config }) }),
            manifest,
          ),
        { code: "IMAGE_REVISION_MISMATCH" },
        `${name} ${JSON.stringify(config)}`,
      );
  }
});

test("revision, version, digest and architecture checks remain strict", () => {
  const { runner, postgres } = manifest.images;
  const cases: [Record<string, Inspect>, string][] = [
    [
      {
        [runner]: image(runner, {
          Config: {
            Labels: {
              ...labels,
              "org.opencontainers.image.revision": "b".repeat(40),
            },
          },
        }),
      },
      "IMAGE_REVISION_MISMATCH",
    ],
    [
      {
        [runner]: image(runner, {
          Config: {
            Labels: { ...labels, "org.opencontainers.image.version": "latest" },
          },
        }),
      },
      "IMAGE_REVISION_MISMATCH",
    ],
    [{ [runner]: image(runner, { RepoDigests: [] }) }, "IMAGE_DIGEST_MISMATCH"],
    [
      { [postgres]: image(postgres, { Config: {}, RepoDigests: [] }) },
      "IMAGE_DIGEST_MISMATCH",
    ],
    [
      { [postgres]: image(postgres, { Config: {}, Architecture: "arm64" }) },
      "IMAGE_ARCHITECTURE_MISMATCH",
    ],
    [
      { [runner]: image(runner, { Os: "windows" }) },
      "IMAGE_ARCHITECTURE_MISMATCH",
    ],
  ];
  for (const [override, code] of cases)
    assert.throws(() => verifyWith(shapes(override), manifest), { code }, code);
});
