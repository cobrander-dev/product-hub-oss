import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { BootstrapFailure } from "./bootstrap";
import { atomicWrite } from "./config";

export const httpsProject = "product-hub-https";
const hostnamePattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function demand(condition: unknown, code: string): asserts condition {
  if (!condition) throw new BootstrapFailure(code);
}

export type AccessHost = { host: string; kind: "domain" | "ip" };

// Domain (preferred) or a literal IPv4 address for installs without a domain.
// Loopback, unspecified, broadcast, link-local and multicast are never valid
// browser origins for a server install.
export function parseAccessHost(input: string): AccessHost {
  const host = input.trim().toLowerCase();
  if (hostnamePattern.test(host)) return { host, kind: "domain" };
  demand(isIP(host) === 4, "INVALID_APP_DOMAIN_OR_IP");
  const [a, b] = host.split(".").map(Number) as [number, number];
  demand(
    a !== 0 &&
      a !== 127 &&
      !(a === 169 && b === 254) &&
      a < 224 &&
      host !== "255.255.255.255",
    "UNUSABLE_IP_ADDRESS",
  );
  return { host, kind: "ip" };
}

const proxyBody = (indent: string) =>
  [
    "encode zstd gzip",
    "request_body {",
    "\tmax_size 12MB",
    "}",
    "header -Server",
    "reverse_proxy app:3000 {",
    "\theader_up Host {http.request.hostport}",
    "\theader_up X-Real-IP {remote_host}",
    "\theader_up X-Forwarded-For {remote_host}",
    "\theader_up X-Forwarded-Proto {scheme}",
    "\theader_up X-Forwarded-Host {http.request.hostport}",
    "\theader_up -Forwarded",
    "}",
  ]
    .map((line) => indent + line)
    .join("\n");

// How this proxy takes part in certificate validation when several self-hosted
// projects share one server (docs/HTTPS_PORTS.md):
//   holder  publishes host port 80, answers HTTP-01 and relays other projects'
//           hostnames to <hostname>.acme-relay.invalid on network oss-https-relay
//   member  host port 80 belongs to another project's relay holder
//   none    host port 80 belongs to an unrelated program
export type RelayRole = "holder" | "member" | "none";
export const relayNetwork = "oss-https-relay";

export type HttpsSettings = {
  port: number;
  httpBind: string;
  role: RelayRole;
  issuer: "auto" | "internal";
  acmeCa?: string;
};

export function publicOrigin(host: string, port = 443) {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

export function relayAlias(host: string) {
  return `${host}.acme-relay.invalid`;
}

const acmeDirectoryPattern =
  /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/i;

export function parseHttpsSettings(input: {
  port?: string;
  httpBind?: string;
  role?: string;
  issuer?: string;
  acmeCa?: string;
}): HttpsSettings {
  const port = Number(input.port || "443");
  demand(
    /^[1-9][0-9]{0,4}$/.test(input.port || "443") &&
      (port === 443 || (port >= 1024 && port <= 65535)),
    "INVALID_HTTPS_PORT",
  );
  const httpBind = input.httpBind || "80";
  demand(
    httpBind === "80" || /^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(httpBind),
    "INVALID_HTTP_BIND",
  );
  const role = (input.role || "holder") as RelayRole;
  demand(["holder", "member", "none"].includes(role), "INVALID_RELAY_ROLE");
  demand((role === "holder") === (httpBind === "80"), "INVALID_HTTP_BIND");
  const issuer = (input.issuer || "auto") as HttpsSettings["issuer"];
  demand(["auto", "internal"].includes(issuer), "INVALID_TLS_ISSUER");
  const acmeCa = input.acmeCa || undefined;
  demand(!acmeCa || acmeDirectoryPattern.test(acmeCa), "INVALID_ACME_CA");
  return { port, httpBind, role, issuer, acmeCa };
}

// Domain: Caddy's automatic public certificate. IP: Let's Encrypt short-lived
// IP certificate first, then Caddy's local CA so HTTPS never degrades to HTTP.
// Without settings the output is exactly the configuration of installations
// made before custom ports (80/443, no relay).
export function renderCaddyfile(
  { host, kind }: AccessHost,
  settings?: HttpsSettings,
) {
  const port = settings?.port ?? 443;
  const role = settings?.role;
  // TLS-ALPN-01 is validated on public port 443 and HTTP-01 on port 80.
  const challenges =
    (port !== 443 ? "\t\t\tdisable_tlsalpn_challenge\n" : "") +
    (role === "none" ? "\t\t\tdisable_http_challenge\n" : "");
  const internal =
    settings?.issuer === "internal" || (port !== 443 && role === "none");
  // Browsers send no SNI for IP literals and Docker's port forwarding hides
  // the public address, so IP mode pins the default SNI to the chosen IP.
  const global =
    "{\n\tadmin off\n\tpersist_config off\n\tskip_install_trust\n" +
    (kind === "ip" ? `\tdefault_sni ${host}\n` : "") +
    (settings ? "\tauto_https disable_redirects\n" : "") +
    (settings?.acmeCa
      ? `\tacme_ca ${settings.acmeCa}\n\tacme_ca_root /etc/caddy/acme-ca-root.pem\n`
      : "") +
    "\tservers {\n" +
    // HTTP/3 would be advertised on UDP 443, which is not ours on other ports.
    (port !== 443 ? "\t\tprotocols h1 h2\n" : "") +
    "\t\ttimeouts {\n\t\t\tread_header 10s\n\t\t\tread_body 60s\n\t\t\twrite 120s\n\t\t\tidle 2m\n\t\t}\n\t}\n}\n";
  let site: string;
  // No HSTS with the local CA: it would pin a certificate browsers do not trust.
  if (internal)
    site = `${kind === "domain" ? host : `https://${host}`} {\n\ttls internal\n${proxyBody("\t")}\n}\n`;
  else if (kind === "domain")
    site = `${host} {\n${challenges ? `\ttls {\n\t\tissuer acme {\n${challenges}\t\t}\n\t}\n` : ""}\theader Strict-Transport-Security "max-age=31536000"\n${proxyBody("\t")}\n}\n`;
  else
    site = `https://${host} {\n\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n${challenges}\t\t}\n\t\tissuer internal\n\t}\n${proxyBody("\t")}\n}\n`;
  if (!settings) return `${global}\n${site}`;
  // Explicit redirect so it carries the public port; port 80 may be relayed.
  let http = `\nhttp://${host} {\n\tredir ${publicOrigin(host, port)}{uri} 308\n}\n`;
  if (role === "holder")
    // Plain HTTP for other projects' hostnames (ACME HTTP-01 and redirects) is
    // passed to their proxies; the header stops a request from looping.
    http +=
      "\n:80 {\n\t@relay not header X-OSS-HTTPS-Relay *\n\thandle @relay {\n" +
      "\t\treverse_proxy {http.request.host}.acme-relay.invalid:80 {\n\t\t\theader_up X-OSS-HTTPS-Relay 1\n\t\t}\n\t}\n" +
      "\trespond 421\n}\n";
  return `${global}\n${site}${http}`;
}

export function httpsPaths(root: string) {
  const directory = join(root, "config/https");
  return {
    directory,
    caddyfile: join(directory, "Caddyfile"),
    acmeCaRoot: join(directory, "acme-ca-root.pem"),
  };
}

// config/access: host, kind, https=builtin|external and, for installations
// with custom-port support, port/http_bind/role/issuer[/acme_ca].
export function readAccessFile(root: string) {
  const path = join(root, "config/access");
  if (!existsSync(path)) return undefined;
  const values = Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  const access = parseAccessHost(values.host || "");
  demand(access.kind === values.kind, "INVALID_ACCESS_CONFIG");
  const settings =
    values.port === undefined
      ? undefined
      : parseHttpsSettings({
          port: values.port,
          httpBind: values.http_bind,
          role: values.role,
          issuer: values.issuer,
          acmeCa: values.acme_ca,
        });
  return { access, builtin: values.https === "builtin", settings };
}

export function renderAccessFile(
  access: AccessHost,
  builtin: boolean,
  settings?: HttpsSettings,
) {
  let text = `host=${access.host}\nkind=${access.kind}\nhttps=${builtin ? "builtin" : "external"}\n`;
  if (builtin && settings)
    text +=
      `port=${settings.port}\nhttp_bind=${settings.httpBind}\nrole=${settings.role}\nissuer=${settings.issuer}\n` +
      (settings.acmeCa ? `acme_ca=${settings.acmeCa}\n` : "");
  return text;
}

export function httpsEnabled(root: string) {
  return existsSync(httpsPaths(root).caddyfile);
}

export function writeCaddyfile(
  root: string,
  access: AccessHost,
  settings?: HttpsSettings,
) {
  const paths = httpsPaths(root);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  // Read through the bind mount by the non-root proxy; contains no secrets.
  atomicWrite(paths.caddyfile, renderCaddyfile(access, settings), 0o644);
}

function dockerEnvironment() {
  return {
    NODE_ENV: "production" as const,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  };
}

// The shared relay network is created when missing and never removed: other
// projects on the server may be attached to it.
export function ensureRelayNetwork() {
  const options = {
    encoding: "utf8" as const,
    env: dockerEnvironment(),
    timeout: 60 * 1000,
  };
  if (
    spawnSync("docker", ["network", "inspect", relayNetwork], options)
      .status === 0
  )
    return;
  const created = spawnSync(
    "docker",
    ["network", "create", "--label", "oss.https-relay=1", relayNetwork],
    options,
  );
  demand(
    created.status === 0 ||
      spawnSync("docker", ["network", "inspect", relayNetwork], options)
        .status === 0,
    "RELAY_NETWORK_FAILED",
  );
}

// (Re)start the proxy on the given verified Runner digest. Used by setup and by
// update so the proxy always runs the same reviewed image as the App.
export function startHttps(options: {
  root: string;
  bundle: string;
  runnerImage: string;
  projectName: string;
  access?: AccessHost;
  settings?: HttpsSettings;
  recreate?: boolean;
}) {
  const files = ["-f", join(options.bundle, "compose.https.yaml")];
  const relay = join(options.bundle, "compose.https-relay.yaml");
  const acmeCa = join(options.bundle, "compose.https-acme-ca.yaml");
  if (options.settings && options.access) {
    demand(existsSync(relay), "RELEASE_TOO_OLD_FOR_HTTPS_SETTINGS");
    ensureRelayNetwork();
    files.push("-f", relay);
    if (options.settings.acmeCa) files.push("-f", acmeCa);
  }
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      httpsProject,
      ...files,
      "up",
      "-d",
      "--remove-orphans",
      ...(options.recreate ? ["--force-recreate"] : []),
    ],
    {
      encoding: "utf8",
      env: {
        ...dockerEnvironment(),
        PRODUCT_HUB_RUNNER_IMAGE: options.runnerImage,
        PRODUCT_HUB_CADDYFILE: httpsPaths(options.root).caddyfile,
        PRODUCT_HUB_FRONTEND_NETWORK: `${options.projectName}_product_hub_frontend`,
        ...(options.settings && options.access
          ? {
              PRODUCT_HUB_HTTPS_PORT: String(options.settings.port),
              PRODUCT_HUB_HTTP_BIND: options.settings.httpBind,
              PRODUCT_HUB_RELAY_ROLE: options.settings.role,
              PRODUCT_HUB_RELAY_ALIAS: relayAlias(options.access.host),
              PRODUCT_HUB_ACME_CA_ROOT: httpsPaths(options.root).acmeCaRoot,
            }
          : {}),
      },
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  demand(result.status === 0, "HTTPS_PROXY_START_FAILED");
}

export function httpsStatus() {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${httpsProject}`,
      "--format",
      "{{.Image}} {{.State}} {{.Status}}",
    ],
    {
      encoding: "utf8",
      env: { NODE_ENV: "production", PATH: process.env.PATH },
      timeout: 30 * 1000,
    },
  );
  demand(result.status === 0, "DOCKER_COMMAND_FAILED");
  return result.stdout.trim();
}
