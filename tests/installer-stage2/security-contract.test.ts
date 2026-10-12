import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const setup = readFileSync("setup.sh", "utf8");
const cli = readFileSync("scripts/product-hub", "utf8");
const operator = readFileSync("scripts/installer/operator-cli.ts", "utf8");
const caddy = readFileSync("deploy/caddy/Caddyfile.example", "utf8");
const nginx = readFileSync("deploy/nginx/product-hub.conf.example", "utf8");
const nginxHeaders = readFileSync(
  "deploy/nginx/product-hub-proxy-headers.conf.example",
  "utf8",
);
const compose = [
  "compose.yaml",
  "compose.production.yaml",
  "compose.hard-delete.yaml",
  "compose.bootstrap.yaml",
  "compose.https.yaml",
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

test("control container is ephemeral and hardened without privileged mode", () => {
  for (const source of [setup, cli]) {
    assert.match(source, /docker run --rm/);
    assert.match(source, /--read-only/);
    assert.match(source, /--tmpfs \/tmp/);
    assert.match(source, /--cap-drop ALL/);
    assert.match(source, /--cap-add CHOWN --cap-add DAC_READ_SEARCH/);
    assert.match(source, /CONTROL_IMAGE_IDENTITY_MISMATCH/);
    assert.match(source, /--security-opt no-new-privileges:true/);
    assert.match(source, /--network none/);
    assert.doesNotMatch(source, /--privileged/);
  }
});

test("Docker socket is limited to the operator wrappers", () => {
  assert.match(setup, /\/var\/run\/docker\.sock/);
  assert.match(cli, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(compose, /docker\.sock/);
});

test("registry token uses hidden TTY and password-stdin only", () => {
  for (const source of [setup, cli]) {
    assert.match(source, /stty -echo/);
    assert.match(source, /--password-stdin/);
    assert.doesNotMatch(source, /set -x/);
    assert.doesNotMatch(source, /--password[ =]"?\$ghcr_token/);
    assert.doesNotMatch(source, /--env [A-Z_]*(TOKEN|PASSWORD)/);
  }
});

test("setup checks existing installation before pull or filesystem mutation", () => {
  const existing = setup.indexOf("# This must run before a pull");
  const pull = setup.indexOf(" pull --platform");
  const mkdir = setup.indexOf("install -d");
  assert.ok(existing >= 0 && pull > existing && mkdir > pull);
});

test("status and doctor stay on the read-only operator path", () => {
  const statusBranch = operator.slice(
    operator.indexOf('if (command === "status")'),
    operator.indexOf('} else if (command === "backup")'),
  );
  assert.match(statusBranch, /status\(current\.installation\)/);
  assert.match(statusBranch, /doctor\(current\.installation\)/);
  assert.doesNotMatch(
    statusBranch,
    /backup\(|updateInstallation\(|composeMutation/,
  );
});

test("generated Caddy and Nginx snippets preserve the reviewed HTTPS header contract", () => {
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /header_up Host \{http\.request\.hostport\}/);
  assert.match(caddy, /header_up X-Forwarded-Proto \{scheme\}/);
  assert.match(caddy, /header_up X-Forwarded-Host \{http\.request\.hostport\}/);
  assert.match(caddy, /header_up -Forwarded/);

  assert.match(nginx, /return 301 https:\/\/\$host\$request_uri/);
  assert.match(nginx, /listen 443 ssl http2/);
  assert.match(nginx, /Strict-Transport-Security/);
  assert.match(
    nginx,
    /include \/etc\/nginx\/snippets\/product-hub-proxy-headers\.conf/,
  );
  assert.match(nginxHeaders, /proxy_set_header Host \$http_host/);
  assert.match(nginxHeaders, /proxy_set_header X-Forwarded-Proto \$scheme/);
  assert.match(nginxHeaders, /proxy_set_header X-Forwarded-Host \$http_host/);
  assert.match(nginxHeaders, /proxy_set_header Forwarded ""/);
  assert.match(nginxHeaders, /proxy_set_header Connection ""/);
});
