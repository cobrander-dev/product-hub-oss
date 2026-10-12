import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAccessHost,
  renderCaddyfile,
} from "../../scripts/installer/https";

test("access host accepts a domain or a usable IPv4 address only", () => {
  assert.deepEqual(parseAccessHost(" Hub.Example.com "), {
    host: "hub.example.com",
    kind: "domain",
  });
  assert.deepEqual(parseAccessHost("203.0.113.10"), {
    host: "203.0.113.10",
    kind: "ip",
  });
  // Private LAN addresses are allowed; they fall back to the local CA.
  assert.equal(parseAccessHost("192.168.1.20").kind, "ip");
  for (const value of [
    "",
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "1.2.3",
    "1.2.3.4:443",
    "https://hub.example.com",
    "*.example.com",
    "hub.example.com/path",
    "::1",
    "2001:db8::1",
  ])
    assert.throws(() => parseAccessHost(value), value);
});

test("domain mode uses automatic public TLS with HSTS and the hardened proxy", () => {
  const config = renderCaddyfile({ host: "hub.example.com", kind: "domain" });
  assert.match(config, /^\{\n\tadmin off\n\tpersist_config off\n/);
  assert.match(config, /\nhub\.example\.com \{\n/);
  assert.match(config, /Strict-Transport-Security "max-age=31536000"/);
  assert.match(config, /max_size 12MB/);
  assert.match(config, /read_header 10s/);
  assert.match(config, /reverse_proxy app:3000 \{/);
  assert.match(config, /header_up -Forwarded/);
  assert.doesNotMatch(config, /issuer internal|default_sni|http:\/\//);
});

test("IP mode tries a short-lived ACME IP certificate, then the local CA, never plain HTTP", () => {
  const config = renderCaddyfile({ host: "203.0.113.10", kind: "ip" });
  assert.match(config, /\tdefault_sni 203\.0\.113\.10\n/);
  assert.match(config, /\nhttps:\/\/203\.0\.113\.10 \{\n/);
  assert.match(
    config,
    /issuer acme \{\n\t\t\tprofile shortlived\n\t\t\}\n\t\tissuer internal/,
  );
  // HSTS is meaningless for IP literals and would pin a possibly local-CA cert.
  assert.doesNotMatch(config, /Strict-Transport-Security|http:\/\//);
  assert.match(config, /reverse_proxy app:3000 \{/);
});

test("HTTPS compose service is non-root, read-only, capability-free and off the DB network", () => {
  const compose = readFileSync("compose.https.yaml", "utf8");
  assert.match(compose, /user: "1001:1001"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /image: \$\{PRODUCT_HUB_RUNNER_IMAGE:\?/);
  assert.match(compose, /read_only: true\n\s+- type: volume/);
  assert.doesNotMatch(compose, /cap_add:|\bprivileged:|docker\.sock/);
  // Only the external App frontend network; never the internal DB network.
  assert.match(compose, /networks:\n\s+- frontend\n/);
  assert.doesNotMatch(compose, /product_hub_backend|\n\s+- backend/);
  assert.match(compose, /external: true/);
});
