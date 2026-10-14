import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { BootstrapFailure } from "../../scripts/installer/bootstrap";
import {
  assertUpdateTarget,
  renderSourceEnvironment,
  verifyBackupResult,
} from "../../scripts/installer/operator-cli";
import { parseReleaseManifest } from "../../scripts/release/manifest";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function manifest(version: string, commit: string, postgres = digest("d")) {
  return parseReleaseManifest(
    [
      "schema=product-hub-release/v1",
      `version=${version}`,
      `source_commit=${commit}`,
      `distribution_commit=${commit}`,
      "platform=linux/amd64",
      `runner=ghcr.io/cobrander-dev/product-hub-oss-app@${digest("a")}`,
      `migrator=ghcr.io/cobrander-dev/product-hub-oss-migrator@${digest("b")}`,
      `worker=ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker@${digest("c")}`,
      `postgres=postgres@${postgres}`,
      "workflow_run=42",
      "published_at=2026-10-05T00:00:00.000Z",
      "",
    ].join("\n"),
  );
}

function failure(run: () => void) {
  try {
    run();
    assert.fail("operation unexpectedly accepted");
  } catch (error) {
    assert.ok(error instanceof BootstrapFailure);
    return error.code;
  }
}

test("setup config generates independent CSPRNG secrets without Admin password", () => {
  const contents = renderSourceEnvironment("hub.example.com", "/opt/example");
  const values = Object.fromEntries(
    contents
      .split("\n")
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  const secrets = [
    values.BETTER_AUTH_SECRET,
    values.POSTGRES_ADMIN_PASSWORD,
    values.POSTGRES_MIGRATION_PASSWORD,
    values.POSTGRES_APP_PASSWORD,
    values.HARD_DELETE_WORKER_DB_PASSWORD,
  ];
  assert.equal(new Set(secrets).size, 5);
  assert.ok(secrets.every((value) => value && value.length >= 64));
  assert.equal(values.BOOTSTRAP_ADMIN_PASSWORD, undefined);
  assert.equal(values.APP_DATABASE_URL, undefined);
  assert.equal(values.BETTER_AUTH_URL, "https://hub.example.com");
});

test("update is forward-only and PostgreSQL image changes require a separate rollout", () => {
  const current = manifest(
    "v1.0.0-rc.1",
    "1111111111111111111111111111111111111111",
  );
  const target = manifest("v1.0.0", "2222222222222222222222222222222222222222");
  assert.doesNotThrow(() => assertUpdateTarget(current, target));
  assert.equal(
    failure(() => assertUpdateTarget(target, current)),
    "RELEASE_DOWNGRADE",
  );
  assert.doesNotThrow(() =>
    assertUpdateTarget(
      manifest("v1.0.0-rc.2", "4444444444444444444444444444444444444444"),
      manifest("v1.0.0-rc.10", "5555555555555555555555555555555555555555"),
    ),
  );
  assert.equal(
    failure(() =>
      assertUpdateTarget(
        manifest("v1.0.0-rc.10", "5555555555555555555555555555555555555555"),
        manifest("v1.0.0-rc.2", "4444444444444444444444444444444444444444"),
      ),
    ),
    "RELEASE_DOWNGRADE",
  );
  assert.equal(
    failure(() =>
      assertUpdateTarget(
        current,
        manifest(
          "v1.0.1",
          "3333333333333333333333333333333333333333",
          digest("e"),
        ),
      ),
    ),
    "POSTGRES_UPDATE_REQUIRES_SEPARATE_ROLLOUT",
  );
});

test("backup result requires COMPLETE and verifies the exact checksum set", () => {
  const root = mkdtempSync(join(tmpdir(), "product-hub-backup-test-"));
  const set = join(root, `product-hub-20261014T000000Z-${"a".repeat(40)}`);
  mkdirSync(set);
  try {
    const files = {
      "database.dump": "database",
      "uploads.tar.gz": "uploads",
      "uploads-files.sha256": "objects/example  fixture\n",
      "manifest.txt": "timestamp=fixture\n",
    };
    for (const [name, contents] of Object.entries(files))
      writeFileSync(join(set, name), contents);
    writeFileSync(
      join(set, "CHECKSUMS"),
      Object.entries(files)
        .map(
          ([name, contents]) =>
            `${createHash("sha256").update(contents).digest("hex")}  ${name}`,
        )
        .join("\n") + "\n",
    );
    writeFileSync(join(set, "COMPLETE"), "");
    const result = verifyBackupResult(`${set}\n`, root);
    assert.equal(result.path, set);
    // The backup container prints its own mount path, /backups/<set>.
    assert.equal(
      verifyBackupResult(`/backups/${basename(set)}\n`, root).path,
      set,
    );
    for (const output of [
      "/backups/../etc\n",
      "/backups/product-hub-x/../../etc\n",
      "/elsewhere/product-hub-20261014T000000Z-" + "a".repeat(40) + "\n",
    ])
      assert.equal(
        failure(() => verifyBackupResult(output, root)),
        "BACKUP_PATH",
      );
    assert.equal(readFileSync(result.complete, "utf8"), "");
    writeFileSync(join(set, "database.dump"), "tampered");
    assert.equal(
      failure(() => verifyBackupResult(`${set}\n`, root)),
      "BACKUP_CHECKSUM_MISMATCH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator source keeps update --check before pull, backup, or mutation", () => {
  const source = readFileSync("scripts/installer/operator-cli.ts", "utf8");
  const check = source.indexOf("if (check)");
  const pull = source.indexOf("pullAndVerify(target)", check);
  const update = source.indexOf("updateInstallation(installation)", check);
  assert.ok(check >= 0 && pull > check && update > pull);
  assert.match(source.slice(check, pull), /return;/);
});

test("actual update locks, doctors, verifies target, then pulls", () => {
  const source = readFileSync("scripts/installer/operator-cli.ts", "utf8");
  const lock = source.indexOf(
    "mkdirSync(lock",
    source.indexOf("async function update"),
  );
  const doctor = source.indexOf("await doctor(current.installation)", lock);
  const verify = source.indexOf(
    "assertUpdateTarget(current.manifest, target)",
    doctor,
  );
  const pull = source.indexOf("pullAndVerify(target)", verify);
  assert.ok(lock >= 0 && doctor > lock && verify > doctor && pull > verify);
});

test("current release marker advances only after update and final doctor", () => {
  const source = readFileSync("scripts/installer/operator-cli.ts", "utf8");
  const update = source.lastIndexOf("await updateInstallation(installation)");
  const doctor = source.indexOf("await doctor(installation)", update);
  const promote = source.indexOf("promoteManifest(target)", doctor);
  assert.ok(update >= 0 && doctor > update && promote > doctor);
});
