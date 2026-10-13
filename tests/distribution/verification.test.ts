import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  parseReleaseManifest,
  releaseIdentity,
  renderReleaseManifest,
  ReleaseManifestFailure,
} from "../../scripts/release/manifest";
import {
  verifyImageLabels,
  verifyManifestChecksum,
} from "../../scripts/release/verify-manifest";

const source = "1234567890abcdef1234567890abcdef12345678";
const distribution = "a".repeat(40);
function fixture(version = `verification-${source}`) {
  return `schema_version=1\nversion=${version}\nsource_commit=${source}\ndistribution_commit=${distribution}\nplatform=linux/amd64\nrunner=ghcr.io/cobrander-dev/product-hub-oss-app@sha256:${"1".repeat(64)}\nmigrator=ghcr.io/cobrander-dev/product-hub-oss-migrator@sha256:${"2".repeat(64)}\nworker=ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker@sha256:${"3".repeat(64)}\npostgres=postgres@sha256:${"4".repeat(64)}\nworkflow_run_id=42\ncreated_at=2026-10-06T00:00:00.000Z\n`;
}
test("verification versions bind to full source SHA, independently of distribution SHA", () => {
  const manifest = parseReleaseManifest(fixture());
  assert.equal(manifest.sourceCommit, source);
  assert.equal(manifest.distributionCommit, distribution);
  assert.equal(renderReleaseManifest(manifest), fixture());
});
test("malformed versions, short SHAs, mixed identity and latest fail closed", () => {
  for (const version of [
    "latest",
    "verification-abc123",
    `verification-${source.toUpperCase()}`,
    `verification-${distribution}`,
    `sha-${source}`,
    "v01.0.0",
    "v1.0.0-01",
    "anything",
  ])
    assert.throws(
      () => parseReleaseManifest(fixture(version)),
      ReleaseManifestFailure,
    );
  for (const field of ["source_commit", "distribution_commit"])
    assert.throws(
      () =>
        parseReleaseManifest(
          fixture().replace(new RegExp(`${field}=.*`), `${field}=abc123`),
        ),
      ReleaseManifestFailure,
    );
});
test("semantic versions and legacy manifest reads remain supported", () => {
  for (const version of ["v1.0.0", "v1.2.3-rc.2"])
    assert.equal(parseReleaseManifest(fixture(version)).version, version);
  const legacy = fixture("v1.2.3")
    .replace("schema_version=1", "schema=product-hub-release/v1")
    .replace("workflow_run_id=", "workflow_run=")
    .replace("created_at=", "published_at=");
  assert.equal(parseReleaseManifest(legacy).version, "v1.2.3");
});
test("verification mode forbids SemVer input; release mode requires SemVer plus prior run", () => {
  assert.deepEqual(releaseIdentity("verification", source), {
    tag: `sha-${source}`,
    version: `verification-${source}`,
  });
  for (const version of ["v1.0.0", "latest", `verification-${source}`])
    assert.throws(() => releaseIdentity("verification", source, version));
  assert.throws(() => releaseIdentity("verification", source, "", "42"));
  assert.throws(() => releaseIdentity("verification", "abc123"));
  assert.throws(() =>
    releaseIdentity("release", source, `verification-${source}`, "42"),
  );
  assert.throws(() => releaseIdentity("release", source, "v1.0.0"));
  assert.equal(
    releaseIdentity("release", source, "v1.0.0", "42").tag,
    "v1.0.0",
  );
});
test("OCI revision is SOURCE, not tooling; promotion retains verification image labels", () => {
  const labels = {
    "org.opencontainers.image.revision": source,
    "org.opencontainers.image.version": `verification-${source}`,
  };
  verifyImageLabels(parseReleaseManifest(fixture()), labels);
  verifyImageLabels(parseReleaseManifest(fixture("v1.0.0")), labels);
  assert.throws(() =>
    verifyImageLabels(parseReleaseManifest(fixture()), {
      ...labels,
      "org.opencontainers.image.revision": distribution,
    }),
  );
});
test("checksum binds the exact manifest bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "product-hub-manifest-check-"));
  const path = join(root, "release.manifest");
  try {
    writeFileSync(path, fixture());
    writeFileSync(
      `${path}.sha256`,
      `${createHash("sha256").update(fixture()).digest("hex")}  release.manifest\n`,
    );
    verifyManifestChecksum(path);
    writeFileSync(path, fixture("v1.0.0"));
    assert.throws(() => verifyManifestChecksum(path));
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("workflow uses separate pinned source and tooling trees; scans gate every publish", () => {
  const workflow = readFileSync(".github/workflows/release-images.yml", "utf8");
  assert.match(
    workflow,
    /ref: \$\{\{ inputs.source_commit \}\}\n\s+path: source/,
  );
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}\n\s+path: tooling/);
  assert.match(workflow, /git -C source rev-parse HEAD/);
  assert.equal(
    (workflow.match(/SOURCE_COMMIT=\$\{\{ inputs.source_commit \}\}/g) || [])
      .length,
    3,
  );
  assert.ok(
    workflow.indexOf("Scan ALL actual archives") <
      workflow.indexOf("name: Push scanned bytes"),
  );
  const publishing = workflow.slice(
    workflow.indexOf("name: Push scanned bytes"),
    workflow.indexOf("name: Attest Runner"),
  );
  assert.doesNotMatch(
    publishing,
    /always\(|continue-on-error|buildx|build-push-action/,
  );
  assert.match(workflow, /DISTRIBUTION_COMMIT: \$\{\{ github.sha \}\}/);
});

for (const failure of ["failed-run", "wrong-tooling", "unsigned-manifest"])
  test(`promotion rejects ${failure} before any image transfer or publish`, () => {
    const root = mkdtempSync(join(tmpdir(), "product-hub-promotion-gate-"));
    try {
      const bin = join(root, "bin");
      const previous = join(root, "previous");
      mkdirSync(bin);
      mkdirSync(previous);
      const path = join(previous, "product-hub-release.manifest");
      const contents = fixture();
      writeFileSync(path, contents);
      writeFileSync(
        `${path}.sha256`,
        `${createHash("sha256").update(contents).digest("hex")}  product-hub-release.manifest\n`,
      );
      const log = join(root, "events");
      writeFileSync(log, "");
      const common = `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.GATE_LOG,process.argv[1]+' '+a.join(' ')+'\\n');\n`;
      writeFileSync(
        join(bin, "gh"),
        common +
          `if(a[0]==='api')process.stdout.write(JSON.stringify({conclusion:process.env.FAILURE==='failed-run'?'failure':'success',status:'completed',event:'workflow_dispatch',path:'.github/workflows/release-images.yml',head_sha:process.env.FAILURE==='wrong-tooling'?'b'.repeat(40):'a'.repeat(40)}));if(a[0]==='attestation')process.exit(1);`,
        { mode: 0o755 },
      );
      for (const name of ["skopeo", "docker"])
        writeFileSync(join(bin, name), common + "process.exit(1);", {
          mode: 0o755,
        });
      const result = spawnSync(
        process.execPath,
        [
          resolve("node_modules/tsx/dist/cli.mjs"),
          resolve("scripts/release/promotion.ts"),
          root,
          source,
          "v1.0.0",
          "42",
        ],
        {
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            NODE_ENV: "test",
            GATE_LOG: log,
            FAILURE: failure,
          },
        },
      );
      assert.equal(result.status, 1);
      assert.doesNotMatch(readFileSync(log, "utf8"), /skopeo|docker/);
      if (failure === "unsigned-manifest") {
        assert.match(readFileSync(log, "utf8"), /attestation verify/);
        assert.match(readFileSync(log, "utf8"), /--signer-digest a{40}/);
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });

for (const scenario of ["tag-exists", "tag-lookup-fails", "tag-free"] as const)
  test(`promotion tag guard: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "product-hub-promotion-tag-"));
    try {
      const bin = join(root, "bin");
      const previous = join(root, "previous");
      mkdirSync(bin);
      mkdirSync(previous);
      const path = join(previous, "product-hub-release.manifest");
      const contents = fixture();
      writeFileSync(path, contents);
      writeFileSync(
        `${path}.sha256`,
        `${createHash("sha256").update(contents).digest("hex")}  product-hub-release.manifest\n`,
      );
      const pin = join(root, "postgres.txt");
      writeFileSync(pin, `postgres@sha256:${"4".repeat(64)}\n`);
      const log = join(root, "events");
      writeFileSync(log, "");
      const common = `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.GATE_LOG,require('node:path').basename(process.argv[1])+' '+a.join(' ')+'\\n');\n`;
      // Signed verification run and attestations all succeed.
      writeFileSync(
        join(bin, "gh"),
        common +
          `if(a[0]==='api')process.stdout.write(JSON.stringify({conclusion:'success',status:'completed',event:'workflow_dispatch',path:'.github/workflows/release-images.yml',head_sha:'a'.repeat(40)}));`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "skopeo"),
        common +
          `if(a[0]==='list-tags'){if(process.env.SCENARIO==='tag-lookup-fails')process.exit(1);process.stdout.write(JSON.stringify({Tags:['sha-x',...(process.env.SCENARIO==='tag-exists'&&a[1].endsWith('-migrator')?['v1.0.0']:[])]}));process.exit(0);}process.exit(1);`,
        { mode: 0o755 },
      );
      writeFileSync(join(bin, "docker"), common + "process.exit(1);", {
        mode: 0o755,
      });
      const result = spawnSync(
        process.execPath,
        [
          resolve("node_modules/tsx/dist/cli.mjs"),
          resolve("scripts/release/promotion.ts"),
          root,
          source,
          "v1.0.0",
          "42",
        ],
        {
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            NODE_ENV: "test",
            GATE_LOG: log,
            SCENARIO: scenario,
            POSTGRES_PIN_FILE: pin,
          },
        },
      );
      const events = readFileSync(log, "utf8");
      // The fake copy always fails, so every scenario exits non-zero; what
      // matters is whether any image transfer was attempted.
      assert.equal(result.status, 1);
      if (scenario === "tag-free") {
        assert.equal((events.match(/skopeo list-tags/g) || []).length, 3);
        assert.match(
          events,
          /skopeo copy --all --preserve-digests docker:\/\//,
        );
      } else {
        assert.doesNotMatch(events, /skopeo copy|docker /);
        if (scenario === "tag-exists")
          assert.match(result.stderr, /RELEASE_TAG_ALREADY_EXISTS/);
      }
    } finally {
      rmSync(root, { recursive: true });
    }
  });
