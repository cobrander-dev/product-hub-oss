import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseAccessHost,
  parseHttpsSettings,
  publicOrigin,
  readAccessFile,
  renderAccessFile,
  renderCaddyfile,
} from "../../scripts/installer/https";
import { resolveProductionDeploymentOrigin } from "../../src/lib/deployment-origin";
import {
  askBuiltinHttps,
  renderSourceEnvironment,
} from "../../scripts/installer/operator-cli";

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

test("installations from before custom ports keep their exact configuration", () => {
  const access = { host: "hub.example.com", kind: "domain" as const };
  const legacy = renderCaddyfile(access);
  assert.doesNotMatch(legacy, /auto_https|acme-relay|protocols|http:\/\//);
  assert.equal(
    renderAccessFile(access, true),
    "host=hub.example.com\nkind=domain\nhttps=builtin\n",
  );
  const compose = readFileSync("compose.https.yaml", "utf8");
  // Older CLIs start new compose files without port variables.
  assert.match(compose, /"\$\{PRODUCT_HUB_HTTP_BIND:-80\}:80"/);
  assert.match(compose, /"\$\{PRODUCT_HUB_HTTPS_PORT:-443\}:443"/);
  const relay = readFileSync("compose.https-relay.yaml", "utf8");
  assert.match(relay, /name: oss-https-relay\n\s+external: true/);
  assert.match(relay, /oss\.https-relay: \$\{PRODUCT_HUB_RELAY_ROLE/);
  assert.doesNotMatch(relay, /backend|postgres/);
});

test("custom ports carry the port in redirects and use only workable challenges", () => {
  const access = { host: "hub.example.com", kind: "domain" as const };
  const settings = (input: Parameters<typeof parseHttpsSettings>[0]) =>
    parseHttpsSettings(input);
  const holder = renderCaddyfile(
    access,
    settings({ port: "9443", httpBind: "80", role: "holder" }),
  );
  assert.match(holder, /auto_https disable_redirects/);
  assert.match(holder, /issuer acme \{\n\t+disable_tlsalpn_challenge\n/);
  assert.match(
    holder,
    /http:\/\/hub\.example\.com \{\n\tredir https:\/\/hub\.example\.com:9443\{uri\} 308/,
  );
  assert.match(holder, /protocols h1 h2/);
  assert.match(
    holder,
    /reverse_proxy \{http\.request\.host\}\.acme-relay\.invalid:80 \{\n\t+header_up X-OSS-HTTPS-Relay 1/,
  );
  assert.match(holder, /@relay not header X-OSS-HTTPS-Relay \*/);
  assert.match(holder, /header_up Host \{http\.request\.hostport\}/);

  const member = renderCaddyfile(
    access,
    settings({ port: "9443", httpBind: "127.0.0.1:18080", role: "member" }),
  );
  assert.doesNotMatch(member, /acme-relay|disable_http_challenge/);
  assert.match(member, /disable_tlsalpn_challenge/);

  const alpn = renderCaddyfile(
    access,
    settings({ port: "443", httpBind: "127.0.0.1:18080", role: "none" }),
  );
  assert.match(alpn, /disable_http_challenge/);
  assert.doesNotMatch(alpn, /disable_tlsalpn_challenge|protocols h1 h2/);

  // No challenge can reach this server: never pretend ACME could succeed.
  const local = renderCaddyfile(
    access,
    settings({ port: "9443", httpBind: "127.0.0.1:18080", role: "none" }),
  );
  assert.match(local, /\ttls internal\n/);
  assert.doesNotMatch(local, /issuer acme|Strict-Transport-Security/);

  const ca = renderCaddyfile(
    access,
    settings({
      port: "443",
      httpBind: "80",
      role: "holder",
      acmeCa: "https://pebble:14000/dir",
    }),
  );
  assert.match(
    ca,
    /acme_ca https:\/\/pebble:14000\/dir\n\tacme_ca_root \/etc\/caddy\/acme-ca-root\.pem/,
  );
});

test("HTTPS settings are validated and round-trip through config/access", () => {
  for (const input of [
    { port: "80" },
    { port: "1023" },
    { port: "65536" },
    { port: "08443" },
    { port: "9443", httpBind: "0.0.0.0:18080", role: "member" },
    { port: "9443", httpBind: "80", role: "member" },
    { port: "9443", httpBind: "127.0.0.1:18080", role: "holder" },
    { port: "9443", role: "other" },
    { port: "9443", issuer: "zerossl" },
    { port: "9443", acmeCa: "http://pebble/dir" },
  ])
    assert.throws(() => parseHttpsSettings(input), JSON.stringify(input));
  assert.equal(publicOrigin("hub.example.com", 443), "https://hub.example.com");
  assert.equal(
    publicOrigin("hub.example.com", 9443),
    "https://hub.example.com:9443",
  );
  const root = mkdtempSync(join(tmpdir(), "product-hub-access-"));
  try {
    mkdirSync(join(root, "config"));
    const access = { host: "hub.example.com", kind: "domain" as const };
    const settings = parseHttpsSettings({
      port: "9443",
      httpBind: "127.0.0.1:18080",
      role: "member",
    });
    writeFileSync(
      join(root, "config/access"),
      renderAccessFile(access, true, settings),
    );
    assert.deepEqual(readAccessFile(root), {
      access,
      builtin: true,
      settings,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth origin, APP_DOMAIN and runtime gate include a non-standard port", () => {
  const values = Object.fromEntries(
    renderSourceEnvironment("hub.example.com", "/opt/example", 9443)
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  assert.equal(values.APP_DOMAIN, "hub.example.com:9443");
  assert.equal(values.BETTER_AUTH_URL, "https://hub.example.com:9443");
  assert.equal(
    values.BETTER_AUTH_TRUSTED_ORIGINS,
    "https://hub.example.com:9443",
  );
  const standard = renderSourceEnvironment("hub.example.com", "/opt/example");
  assert.match(standard, /^APP_DOMAIN=hub\.example\.com$/m);
  assert.match(standard, /^BETTER_AUTH_URL=https:\/\/hub\.example\.com$/m);

  for (const [domain, origin] of [
    ["hub.example.com:9443", "https://hub.example.com:9443"],
    ["203.0.113.10", "https://203.0.113.10"],
    ["203.0.113.10:9443", "https://203.0.113.10:9443"],
  ])
    assert.deepEqual(
      resolveProductionDeploymentOrigin({
        NODE_ENV: "production",
        APP_DOMAIN: domain,
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_TRUSTED_ORIGINS: origin,
      }),
      { host: domain, origin },
    );
  for (const [domain, origin] of [
    ["hub.example.com", "https://hub.example.com:9443"],
    ["203.0.113.10:8443", "https://203.0.113.10:9443"],
    ["999.0.113.10", "https://999.0.113.10"],
  ])
    assert.throws(() =>
      resolveProductionDeploymentOrigin({
        NODE_ENV: "production",
        APP_DOMAIN: domain,
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_TRUSTED_ORIGINS: origin,
      }),
    );
});

test("IP access cannot use the hostname relay and never claims a public certificate it cannot get", () => {
  const env = {
    PRODUCT_HUB_HTTPS_MODE: "builtin",
    PRODUCT_HUB_HTTPS_PORT: "9443",
    PRODUCT_HUB_HTTP_BIND: "127.0.0.1:18080",
    PRODUCT_HUB_RELAY_ROLE: "member",
  };
  const ip = askBuiltinHttps({ host: "203.0.113.10", kind: "ip" }, env);
  assert.equal(ip?.role, "none");
  assert.equal(ip?.issuer, "internal");
  const domain = askBuiltinHttps(
    { host: "hub.example.com", kind: "domain" },
    env,
  );
  assert.equal(domain?.role, "member");
  assert.equal(domain?.issuer, "auto");
  assert.equal(
    askBuiltinHttps(
      { host: "hub.example.com", kind: "domain" },
      { PRODUCT_HUB_HTTPS_MODE: "external" },
    ),
    undefined,
  );
  assert.throws(() =>
    askBuiltinHttps(
      { host: "203.0.113.10", kind: "ip" },
      { PRODUCT_HUB_HTTPS_MODE: "external" },
    ),
  );
});
