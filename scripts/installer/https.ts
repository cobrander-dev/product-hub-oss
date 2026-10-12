import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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

// Domain: Caddy's automatic public certificate. IP: Let's Encrypt short-lived
// IP certificate first, then Caddy's local CA so HTTPS never degrades to HTTP.
export function renderCaddyfile({ host, kind }: AccessHost) {
  // Browsers send no SNI for IP literals and Docker's port forwarding hides
  // the public address, so IP mode pins the default SNI to the chosen IP.
  const global =
    "{\n\tadmin off\n\tpersist_config off\n\tskip_install_trust\n" +
    (kind === "ip" ? `\tdefault_sni ${host}\n` : "") +
    "\tservers {\n\t\ttimeouts {\n\t\t\tread_header 10s\n\t\t\tread_body 60s\n\t\t\twrite 120s\n\t\t\tidle 2m\n\t\t}\n\t}\n}\n";
  if (kind === "domain")
    return `${global}\n${host} {\n\theader Strict-Transport-Security "max-age=31536000"\n${proxyBody("\t")}\n}\n`;
  return `${global}\nhttps://${host} {\n\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n\t\t}\n\t\tissuer internal\n\t}\n${proxyBody("\t")}\n}\n`;
}

export function httpsPaths(root: string) {
  const directory = join(root, "config/https");
  return { directory, caddyfile: join(directory, "Caddyfile") };
}

export function httpsEnabled(root: string) {
  return existsSync(httpsPaths(root).caddyfile);
}

export function writeCaddyfile(root: string, access: AccessHost) {
  const paths = httpsPaths(root);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  // Read through the bind mount by the non-root proxy; contains no secrets.
  atomicWrite(paths.caddyfile, renderCaddyfile(access), 0o644);
}

// (Re)start the proxy on the given verified Runner digest. Used by setup and by
// update so the proxy always runs the same reviewed image as the App.
export function startHttps(options: {
  root: string;
  bundle: string;
  runnerImage: string;
  projectName: string;
}) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      httpsProject,
      "-f",
      join(options.bundle, "compose.https.yaml"),
      "up",
      "-d",
      "--remove-orphans",
    ],
    {
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DOCKER_HOST: process.env.DOCKER_HOST,
        DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
        DOCKER_CONFIG: process.env.DOCKER_CONFIG,
        PRODUCT_HUB_RUNNER_IMAGE: options.runnerImage,
        PRODUCT_HUB_CADDYFILE: httpsPaths(options.root).caddyfile,
        PRODUCT_HUB_FRONTEND_NETWORK: `${options.projectName}_product_hub_frontend`,
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
