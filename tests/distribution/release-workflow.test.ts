import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(".github/workflows/release-images.yml", "utf8");
const postgres = readFileSync(
  "deploy/releases/postgres-linux-amd64.txt",
  "utf8",
).trim();

test("release workflow is manual, guarded, amd64-only and never uses latest", () => {
  const triggers = workflow.slice(0, workflow.indexOf("permissions:"));
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(triggers, /^\s+push:/m);
  assert.match(workflow, /PUBLISH_IMMUTABLE_IMAGES/);
  assert.match(workflow, /platforms: linux\/amd64/g);
  assert.doesNotMatch(workflow, /:\s*latest\b|:latest\b/);
});

test("every GitHub Action is pinned to a full commit SHA", () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)].map(
    (match) => match[1]!,
  );
  assert.ok(uses.length >= 10);
  for (const action of uses)
    assert.match(action, /^[^@]+@[0-9a-f]{40}$/, action);
});

test("workflow builds, scans and attests all three immutable products", () => {
  for (const repository of [
    "product-hub-oss-app",
    "product-hub-oss-migrator",
    "product-hub-oss-hard-delete-worker",
  ]) {
    assert.match(workflow, new RegExp(`ghcr\\.io/cobrander-dev/${repository}`));
  }
  assert.equal((workflow.match(/provenance: mode=max/g) || []).length, 3);
  assert.equal((workflow.match(/sbom: true/g) || []).length, 3);
  assert.equal((workflow.match(/push: false/g) || []).length, 3);
  assert.doesNotMatch(workflow, /\bpush: true/);
  assert.equal((workflow.match(/context: .\/source/g) || []).length, 3);
  const scanner = readFileSync("scripts/release/staged-images.ts", "utf8");
  assert.match(scanner, /"vuln,secret"/);
  assert.match(scanner, /"CRITICAL,HIGH"/);
  // Unfiltered inventory is always retained; --ignore-unfixed only gates.
  assert.equal((scanner.match(/"--ignore-unfixed"/g) || []).length, 1);
  assert.match(scanner, /trivy\(directory, name, \["--exit-code", "0"\]\)/);
  assert.match(workflow, /Upload complete unfiltered image scan reports/);
});

test("PostgreSQL release dependency is pinned to one amd64 manifest digest", () => {
  assert.match(postgres, /^postgres@sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(postgres, /18\.6-bookworm|latest/);
});

test("source gates and final OCI builds use separate strictly dependent runners", () => {
  const source = workflow.slice(
    workflow.indexOf("  source-verification:"),
    workflow.indexOf("  publish:"),
  );
  const publish = workflow.slice(
    workflow.indexOf("  publish:"),
    workflow.indexOf("  github-release:"),
  );
  assert.match(source, /runs-on: ubuntu-24\.04/);
  assert.match(source, /permissions:\n\s+contents: read/);
  for (const gate of [
    "pnpm ci:check",
    "pnpm audit --prod --audit-level high",
    "pnpm release:build:amd64",
    "pnpm test:domain-neutral-release",
    "Repository secret scan",
    "ci-environment.mjs cleanup",
  ]) {
    assert.ok(source.includes(gate), gate);
    assert.ok(!publish.includes(gate), gate);
  }
  assert.match(
    publish,
    /needs: source-verification\n\s+runs-on: ubuntu-24\.04/,
  );
  const jobHeader = publish.slice(0, publish.indexOf("    steps:"));
  assert.doesNotMatch(jobHeader, /^\s+if:|continue-on-error/m);
  assert.doesNotMatch(
    publish,
    /download-artifact|playwright install|cache: pnpm/,
  );
  assert.match(publish, /ref: \$\{\{ github.sha \}\}\n\s+path: tooling/);
  assert.match(
    publish,
    /ref: \$\{\{ inputs.source_commit \}\}\n\s+path: source/,
  );
  assert.match(publish, /workflow-identity.ts/);
  assert.ok(
    publish.indexOf("Scan ALL actual archives") <
      publish.indexOf("Authenticate to GHCR"),
  );
  assert.doesNotMatch(
    workflow,
    /continue-on-error|docker (system|builder|volume) prune/,
  );
});

test("every final archive and scan has a disk stop gate without disabling attestations", () => {
  for (const [checkpoint, minimum, nextStep] of [
    ["before-runner", "12288", "Stage Runner OCI"],
    ["before-migrator", "8192", "Stage Migrator OCI"],
    ["before-worker", "6144", "Stage Worker OCI"],
    ["before-scan", "4096", "Scan ALL actual archives"],
  ]) {
    const gate = `release-disk-check.sh ${checkpoint} ${minimum}`;
    assert.ok(workflow.includes(gate), gate);
    assert.ok(workflow.indexOf(gate) < workflow.indexOf(nextStep));
  }
  assert.match(
    workflow,
    /name: Record OCI runner final disk usage even on failure\n\s+if: always\(\)/,
  );
});

test("disk diagnostics are read-only and fail closed below each filesystem floor", () => {
  const root = mkdtempSync(join(tmpdir(), "product-hub-disk-gate-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub(
    "docker",
    `
case "$*" in
  'info --format {{.DockerRootDir}}') printf '%s\\n' "$DISK_TEST_ROOT" ;;
  'system df'|'buildx du') echo 'read-only disk summary' ;;
  *) exit 99 ;;
esac`,
  );
  stub(
    "pnpm",
    `test "$*" = 'store path' || exit 99; echo "$DISK_TEST_ROOT/store"`,
  );
  stub(
    "df",
    `
case "$*" in
  *-Pk*)
    free=20000000
    case "$*" in *"$DISK_TEST_LOW_PATH") free="$DISK_TEST_FREE" ;; esac
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
    printf '/dev/test 30000000 0 %s 0%% /\\n' "$free" ;;
  *) echo 'filesystem summary' ;;
esac`,
  );
  const workspace = join(root, "workspace");
  const temporary = join(root, "temporary");
  mkdirSync(workspace);
  mkdirSync(temporary);
  const script = resolve(".github/scripts/release-disk-check.sh");
  const run = (lowPath: string, free: string, minimum = "12288") =>
    spawnSync("bash", [script, "test-checkpoint", minimum], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: temporary,
        DISK_TEST_ROOT: root,
        DISK_TEST_LOW_PATH: lowPath,
        DISK_TEST_FREE: free,
      },
    });
  try {
    for (const path of [workspace, temporary, root]) {
      assert.equal(run(path, String(12288 * 1024)).status, 0);
      const low = run(path, String(12288 * 1024 - 1));
      assert.equal(low.status, 1);
      assert.match(low.stdout, /Insufficient disk/);
      assert.equal(run(path, "91200", "0").status, 0);
      assert.equal(run(path, "invalid").status, 1);
    }
    assert.equal(run(root, "20000000", "-1").status, 64);
    assert.equal(run(root, "20000000", "invalid").status, 64);
    const scriptText = readFileSync(script, "utf8");
    assert.doesNotMatch(
      scriptText,
      /\bprune\s*\n|\brm\s+-|docker inspect|printenv/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formal release only creates an attested DRAFT GitHub Release", () => {
  const job = workflow.slice(workflow.indexOf("  github-release:"));
  assert.match(job, /needs: publish\n\s+if: inputs.mode == 'release'/);
  assert.match(
    job,
    /permissions:\n\s+contents: write\n\s+id-token: write\n\s+attestations: write/,
  );
  assert.match(job, /gh release create "\$RELEASE_VERSION"[^\n]*--draft/);
  assert.doesNotMatch(job, /--latest|gh release edit|--draft=false|:latest/);
  assert.match(
    job,
    /sha256sum --check --strict product-hub-release.manifest.sha256/,
  );
  assert.match(job, /attest-build-provenance@[0-9a-f]{40}/);
  assert.match(job, /product-hub-installer.tar.gz[\s\S]*install.sh/);
  // Only this release-only job may write repository contents.
  const before = workflow.slice(0, workflow.indexOf("  github-release:"));
  assert.doesNotMatch(before, /contents: write/);
});
