import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderManifestReleaseCompose } from "../../scripts/installer/config";
import {
  parseReleaseManifest,
  ReleaseManifestFailure,
  renderReleaseManifest,
} from "../../scripts/release/manifest";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function fixture() {
  return [
    "schema_version=1",
    "version=v1.2.3-rc.1",
    "source_commit=1234567890abcdef1234567890abcdef12345678",
    "distribution_commit=1234567890abcdef1234567890abcdef12345678",
    "platform=linux/amd64",
    `runner=ghcr.io/cobrander-dev/product-hub-oss-app@${digest("a")}`,
    `migrator=ghcr.io/cobrander-dev/product-hub-oss-migrator@${digest("b")}`,
    `worker=ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker@${digest("c")}`,
    `postgres=postgres@${digest("d")}`,
    "workflow_run_id=12345",
    "created_at=2026-10-05T00:00:00.000Z",
    "",
  ].join("\n");
}

function code(contents: string) {
  try {
    parseReleaseManifest(contents);
    assert.fail("manifest unexpectedly accepted");
  } catch (error) {
    assert.ok(error instanceof ReleaseManifestFailure);
    return (error as ReleaseManifestFailure).code;
  }
}

test("strict manifest parser accepts and round-trips the immutable contract", () => {
  const parsed = parseReleaseManifest(fixture());
  assert.equal(parsed.version, "v1.2.3-rc.1");
  assert.equal(parsed.platform, "linux/amd64");
  assert.equal(renderReleaseManifest(parsed), fixture());
});

test("manifest is data, not shell syntax, and rejects shape/order changes", () => {
  assert.equal(
    code(fixture().replace("schema_version=", "# schema_version=")),
    "INVALID_MANIFEST_SHAPE",
  );
  assert.equal(
    code(fixture().replace("version=v1.2.3-rc.1", "version=$(id)")),
    "INVALID_RELEASE_VERSION",
  );
  assert.equal(
    code(fixture().replaceAll("\n", "\r\n")),
    "INVALID_MANIFEST_ENCODING",
  );
});

test("latest, tags, wrong repositories and non-amd64 manifests fail closed", () => {
  assert.equal(
    code(fixture().replace("version=v1.2.3-rc.1", "version=latest")),
    "INVALID_RELEASE_VERSION",
  );
  assert.equal(
    code(
      fixture().replace(
        /runner=.*\n/,
        "runner=ghcr.io/cobrander-dev/product-hub-oss-app:latest\n",
      ),
    ),
    "INVALID_PRODUCT_IMAGE",
  );
  assert.equal(
    code(fixture().replace("platform=linux/amd64", "platform=linux/arm64")),
    "INVALID_RELEASE_PLATFORM",
  );
  assert.equal(
    code(
      fixture().replace(
        "ghcr.io/cobrander-dev/product-hub-oss-app",
        "ghcr.io/example/other",
      ),
    ),
    "INVALID_PRODUCT_IMAGE",
  );
});

test("source and distribution revisions may be different full commits", () => {
  assert.equal(
    parseReleaseManifest(
      fixture().replace(
        "distribution_commit=1234567890abcdef1234567890abcdef12345678",
        "distribution_commit=abcdef1234567890abcdef1234567890abcdef12",
      ),
    ).distributionCommit,
    "abcdef1234567890abcdef1234567890abcdef12",
  );
});

test("manifest renders a secret-free four-digest Compose override", () => {
  const manifest = parseReleaseManifest(fixture());
  const template = readFileSync(
    "deploy/templates/compose.manifest.yaml.template",
    "utf8",
  );
  const rendered = renderManifestReleaseCompose(template, manifest);
  for (const reference of Object.values(manifest.images))
    assert.ok(rendered.includes(reference));
  assert.doesNotMatch(rendered, /PASSWORD|SECRET=|DATABASE_URL/);
  assert.doesNotMatch(rendered, /\{\{/);
});
