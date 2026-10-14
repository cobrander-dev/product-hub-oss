// Writes every built-in HTTPS Caddyfile variant into the given directory so CI
// can validate them with the real Caddy binary.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseHttpsSettings,
  renderCaddyfile,
  type AccessHost,
} from "../../scripts/installer/https";

const directory = process.argv[2];
if (!directory) throw new Error("usage: render-caddyfiles.ts DIRECTORY");
const domain: AccessHost = { host: "hub.example.com", kind: "domain" };
const ip: AccessHost = { host: "203.0.113.10", kind: "ip" };
const cases: Record<
  string,
  [AccessHost, Parameters<typeof parseHttpsSettings>[0]?]
> = {
  legacy: [domain],
  "legacy-ip": [ip],
  holder: [domain, { port: "9443", httpBind: "80", role: "holder" }],
  member: [
    domain,
    { port: "9443", httpBind: "127.0.0.1:18080", role: "member" },
  ],
  alpn: [domain, { port: "443", httpBind: "127.0.0.1:18080", role: "none" }],
  local: [domain, { port: "9443", httpBind: "127.0.0.1:18080", role: "none" }],
  "ip-holder": [ip, { port: "8443", httpBind: "80", role: "holder" }],
};
for (const [name, [access, settings]] of Object.entries(cases))
  writeFileSync(
    join(directory, name),
    renderCaddyfile(access, settings && parseHttpsSettings(settings)),
  );
