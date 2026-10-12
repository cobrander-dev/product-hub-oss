import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderManifestReleaseCompose } from "../../scripts/installer/config";
import {
  parseReleaseManifest,
  renderReleaseManifest,
} from "../../scripts/release/manifest";
import { assertUpdateTarget } from "../../scripts/installer/operator-cli";
import { verifyImageLabels } from "../../scripts/release/verify-manifest";
import {
  resolveProductionDeploymentOrigin,
  isTrustedProductionRequest,
} from "../../src/lib/deployment-origin";

test("candidate verification manifest is shared by installer-control, Compose and update guard", () => {
  const source = "1".repeat(40);
  const manifest = parseReleaseManifest(
    renderReleaseManifest({
      schema: "product-hub-release/v1",
      version: `verification-${source}`,
      sourceCommit: source,
      distributionCommit: source,
      platform: "linux/amd64",
      images: {
        runner: `ghcr.io/cobrander-dev/product-hub-oss-app@sha256:${"a".repeat(64)}`,
        migrator: `ghcr.io/cobrander-dev/product-hub-oss-migrator@sha256:${"b".repeat(64)}`,
        worker: `ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker@sha256:${"c".repeat(64)}`,
        postgres: `postgres@sha256:${"d".repeat(64)}`,
      },
      workflowRun: "42",
      publishedAt: "2026-10-06T00:00:00.000Z",
    }),
  );
  verifyImageLabels(manifest, {
    "org.opencontainers.image.revision": source,
    "org.opencontainers.image.version": manifest.version,
  });
  const template = readFileSync(
    "deploy/templates/compose.manifest.yaml.template",
    "utf8",
  );
  const compose = renderManifestReleaseCompose(template, manifest);
  for (const image of Object.values(manifest.images))
    assert.ok(compose.includes(image));
  assert.throws(
    () => assertUpdateTarget(manifest, manifest),
    /RELEASE_ALREADY_CURRENT/,
  );
  const dockerfile = readFileSync("Dockerfile", "utf8");
  assert.match(dockerfile, /COPY scripts\/installer .\/scripts\/installer/);
  assert.match(dockerfile, /COPY scripts\/release .\/scripts\/release/);
  assert.equal(
    (
      dockerfile.match(
        /org.opencontainers.image.source="https:\/\/github.com\/cobrander-dev\/product-hub-oss"/g,
      ) || []
    ).length,
    3,
  );
  const workflow = readFileSync(".github/workflows/release-images.yml", "utf8");
  for (const permission of [
    "packages: write",
    "contents: read",
    "attestations: write",
    "id-token: write",
  ])
    assert.ok(workflow.includes(permission));
});

for (const domain of ["products.example-a.com", "hub.example-b.com"])
  test(`domain-neutral runtime request contract remains exact for ${domain}`, () => {
    const origin = `https://${domain}`;
    const deployment = resolveProductionDeploymentOrigin({
      NODE_ENV: "production",
      APP_DOMAIN: domain,
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_TRUSTED_ORIGINS: origin,
    })!;
    const request = {
      host: domain,
      forwardedHost: domain,
      forwardedProto: "https",
      forwarded: null,
      origin,
      method: "POST",
      pathname: "/admin/settings",
    };
    assert.equal(isTrustedProductionRequest(request, deployment), true);
    for (const wrong of [
      { host: "attacker.example" },
      { forwardedHost: "attacker.example" },
      { origin: "https://attacker.example" },
      { origin: null },
      { forwardedProto: "http" },
    ])
      assert.equal(
        isTrustedProductionRequest({ ...request, ...wrong }, deployment),
        false,
      );
    assert.throws(() =>
      resolveProductionDeploymentOrigin({
        NODE_ENV: "production",
        APP_DOMAIN: domain,
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_TRUSTED_ORIGINS: "*",
      }),
    );
    assert.doesNotMatch(
      readFileSync("next.config.ts", "utf8"),
      /allowedOrigins|APP_DOMAIN|BETTER_AUTH_URL/,
    );
  });
