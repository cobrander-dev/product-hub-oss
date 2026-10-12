// Local post-build regression. No database, credentials, uploads or Production
// resources are used. This is not a substitute for the Docker A/B install gate.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const buildId = readFileSync(".next/BUILD_ID", "utf8");
async function unusedPort() {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

for (const domain of ["products.example-a.com", "hub.example-b.com"]) {
  const port = await unusedPort();
  const origin = `https://${domain}`;
  const child = spawn(
    process.execPath,
    [resolve(".next/standalone/server.js")],
    {
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        APP_DOMAIN: domain,
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_TRUSTED_ORIGINS: origin,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused_test",
        STORAGE_DRIVER: "local",
        LOCAL_STORAGE_ROOT: "/nonexistent-product-hub-runtime-smoke",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  const headers = {
    host: domain,
    "x-forwarded-host": domain,
    "x-forwarded-proto": "https",
  };
  const request = (
    path: string,
    method = "GET",
    extra: Record<string, string> = {},
  ) =>
    new Promise<Response>((done, reject) => {
      // Use HTTP directly: fetch may normalize Host, hiding the boundary under test.
      const outgoing = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: { ...headers, ...extra },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const responseHeaders = new Headers();
            for (let index = 0; index < incoming.rawHeaders.length; index += 2)
              responseHeaders.append(
                incoming.rawHeaders[index]!,
                incoming.rawHeaders[index + 1]!,
              );
            done(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      outgoing.setTimeout(5000, () =>
        outgoing.destroy(new Error("LOCAL_REQUEST_TIMEOUT")),
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, "runtime exited before readiness");
      try {
        ready = (await request("/api/health")).status === 200;
      } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, "runtime did not become ready");
    const login = await request("/login");
    assert.equal(login.status, 200);
    assert.match(await login.text(), /内部登录/);
    assert.equal(login.headers.get("x-frame-options"), "DENY");
    assert.equal((await request("/admin")).status, 307);
    const invalidHeaders: Record<string, string>[] = [
      { origin: "https://attacker.example" },
      { host: "attacker.example" },
      { "x-forwarded-host": "attacker.example" },
    ];
    for (const extra of invalidHeaders)
      assert.equal((await request("/login", "GET", extra)).status, 403);
    assert.equal(
      (
        await request("/admin/settings", "POST", {
          origin: "https://attacker.example",
          "next-action": "untrusted-test",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/auth/sign-in/username", "POST", {
          origin: "https://attacker.example",
        })
      ).status,
      403,
    );
    assert.equal(readFileSync(".next/BUILD_ID", "utf8"), buildId);
    process.stdout.write(
      `PASS: same production build runtime origin/anonymous navigation regression ${domain}\n`,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((done) => {
      if (child.exitCode !== null) done();
      else child.once("exit", () => done());
    });
  }
}
