import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import sharp from "sharp";

const repository = resolve(import.meta.dirname, "../..");
const suffix = randomBytes(4).toString("hex");
const project = `product-hub-bootstrap-${suffix}`;
const configVolume = `product-hub-bootstrap-config-${suffix}`;
const controllerImage = `product-hub-bootstrap-controller:${suffix}`;
const tag = process.env.PRODUCT_HUB_BOOTSTRAP_TEST_TAG || `bootstrap-${suffix}`;
const fixture = mkdtempSync(join(tmpdir(), "product-hub-bootstrap-"));
const adminPassword = randomBytes(24).toString("hex");
const factoryPassword = randomBytes(24).toString("hex");
const domain =
  process.env.PRODUCT_HUB_BOOTSTRAP_TEST_DOMAIN || "product-hub.example.com";
assert.match(domain, /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i);
const siteOrigin = `https://${domain}:34443`;
const otherOrigin = `https://${domain === "products.example-a.com" ? "hub.example-b.com" : "products.example-a.com"}:34443`;
let phase = "prerequisites";
let mountpoint = "";
let revision = "";
let volumeCreated = false;
let imageCreated = false;

async function command(
  program: string,
  args: string[],
  input?: string,
  verbose = false,
) {
  return await new Promise<string>((resolveCommand, reject) => {
    const child = spawn(program, args, {
      cwd: repository,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const record = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 8 * 1024 * 1024) child.kill();
      if (verbose) process.stdout.write(chunk);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.on("error", reject);
    const timeout = setTimeout(() => child.kill(), 1200000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        // Controller output is deliberately sanitized; never expose inspect/env/login payloads.
        if (program === "docker" && args[0] === "run") {
          for (const line of output.split(/\r?\n/))
            if (/^(STEP: [A-Z_]+|PASS:|FAIL:|DATABASE:|MIGRATIONS:)/.test(line))
              process.stderr.write(line + "\n");
        }
        reject(new Error(`test command failed during ${phase}`));
      } else resolveCommand(output.trim());
    });
    child.stdin.end(input);
  });
}
async function controller(action: string, input?: string) {
  const output = await command(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--network",
      ["install", "doctor"].includes(action) ? "none" : "host",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_READ_SEARCH",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--security-opt",
      "no-new-privileges:true",
      "-i",
      "-e",
      `PRODUCT_HUB_BOOTSTRAP_TEST_DOMAIN=${domain}`,
      "-e",
      "PRODUCT_HUB_CONTROL_CONTAINER=1",
      "--label",
      `product-hub.bootstrap-test=${suffix}`,
      "--mount",
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
      "--mount",
      `type=volume,source=${configVolume},target=${mountpoint}`,
      controllerImage,
      action,
      mountpoint,
      project,
      tag,
      revision,
    ],
    input,
  );
  process.stdout.write(output + "\n");
}
async function step(name: string, callback: () => Promise<unknown>) {
  phase = name;
  process.stdout.write(`TEST: ${name}\n`);
  await callback();
  process.stdout.write(`PASS: ${name}\n`);
}

async function login(
  page: Page,
  username: string,
  password: string,
  destination: string,
) {
  let status: number | undefined;
  const response = (value: import("@playwright/test").Response) => {
    if (new URL(value.url()).pathname === "/api/auth/sign-in/username")
      status = value.status();
  };
  page.on("response", response);
  try {
    await page.goto(`${siteOrigin}/login`);
    await page.getByLabel("用户名", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${destination}$`), {
      timeout: 30000,
    });
  } catch {
    const route = page.url().startsWith(`${siteOrigin}/`)
      ? new URL(page.url()).pathname
      : "outside-test-origin";
    process.stderr.write(
      `FAIL: disposable login diagnostic; route=${route}; signInStatus=${status || 0}; invalidCredentials=${await page.getByText("用户名或密码错误", { exact: true }).count()}; pending=${await page.getByRole("button", { name: "正在登录…", exact: true }).count()}\n`,
    );
    throw new Error("disposable login failed");
  } finally {
    page.off("response", response);
  }
}
async function directRequest(
  method: string,
  path: string,
  overrides: Record<string, string | undefined> = {},
) {
  const headers: Record<string, string> = {
    host: `${domain}:34443`,
    "x-forwarded-host": `${domain}:34443`,
    "x-forwarded-proto": "https",
    ...(method === "POST" ? { origin: siteOrigin } : {}),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return await new Promise<number>((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port: 33443, method, path, headers },
      (response) => {
        response.resume();
        response.once("end", () => resolveRequest(response.statusCode || 0));
      },
    );
    request.once("error", rejectRequest);
    request.end();
  });
}
async function publicRequest(headers: Record<string, string>) {
  return await new Promise<number>((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 34443,
        path: "/login",
        method: "GET",
        rejectUnauthorized: false,
        headers: { host: `${domain}:34443`, ...headers },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolveRequest(response.statusCode || 0));
      },
    );
    request.once("error", rejectRequest);
    request.end();
  });
}
async function smoke() {
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    `/CN=${domain}`,
    "-keyout",
    join(fixture, "key.pem"),
    "-out",
    join(fixture, "cert.pem"),
  ]);
  const server = createServer(
    {
      key: readFileSync(join(fixture, "key.pem")),
      cert: readFileSync(join(fixture, "cert.pem")),
    },
    (request, response) => {
      if (request.headers.host !== `${domain}:34443`) {
        response.writeHead(421);
        response.end();
        return;
      }
      const upstreamHeaders = {
        ...request.headers,
        host: `${domain}:34443`,
        "x-forwarded-proto": "https",
        "x-forwarded-host": `${domain}:34443`,
      };
      delete upstreamHeaders.forwarded;
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: 33443,
          path: request.url,
          method: request.method,
          headers: upstreamHeaders,
        },
        (reply) => {
          response.writeHead(reply.statusCode || 502, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    },
  );
  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(34443, "127.0.0.1", resolveServer);
  });
  const browser = await chromium.launch({
    channel: "chromium",
    args: [
      `--host-resolver-rules=MAP ${domain} 127.0.0.1`,
      "--no-proxy-server",
    ],
  });
  try {
    const admin = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await admin.newPage();
    page.setDefaultTimeout(20000);
    await step("initial Admin login and route", async () => {
      await login(page, "installer_admin", adminPassword, "admin");
    });
    await step("Category and Material", async () => {
      await page.goto(`${siteOrigin}/admin/settings`);
      await page.getByLabel("新建分类").fill("安装测试分类");
      await page
        .getByRole("button", { name: "新增", exact: true })
        .first()
        .click();
      await expect(page.getByLabel("安装测试分类名称")).toBeVisible();
      await page.getByLabel("新建材质").fill("安装测试材质");
      await page
        .getByRole("button", { name: "新增", exact: true })
        .nth(1)
        .click();
      await expect(page.getByLabel("安装测试材质名称")).toBeVisible();
    });
    let productId = "";
    let privateProductId = "";
    let factoryId = "";
    await step("minimal Products and Factory", async () => {
      for (const name of ["安装测试产品", "未分配隔离产品"]) {
        await page.goto(`${siteOrigin}/admin/products/new`);
        await page.getByLabel("产品名称", { exact: true }).fill(name);
        await page
          .getByRole("button", { name: "创建产品", exact: true })
          .click();
        await expect(page).toHaveURL(/\/admin\/products\/[a-f0-9-]+$/);
        const id = page.url().split("/").at(-1)!;
        if (productId) privateProductId = id;
        else productId = id;
      }
      await page.goto(`${siteOrigin}/admin/factories/new`);
      await page.getByLabel("厂家名称", { exact: true }).fill("安装测试厂家");
      await page.getByRole("button", { name: "创建厂家", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/factories\/[a-f0-9-]+$/);
      factoryId = page.url().split("/").at(-1)!;
    });
    await step("private upload for nonempty backup", async () => {
      await page.goto(`${siteOrigin}/admin/products/${productId}`);
      const image = await sharp({
        create: {
          width: 32,
          height: 32,
          channels: 3,
          background: "#123456",
        },
      })
        .png()
        .toBuffer();
      await page.locator('input[type="file"]').setInputFiles({
        name: "bootstrap-backup.png",
        mimeType: "image/png",
        buffer: image,
      });
      await page.getByRole("button", { name: "上传主图", exact: true }).click();
      await expect(page.getByAltText("安装测试产品主图")).toBeVisible();
    });
    await step("Factory User and Assignment", async () => {
      await page.goto(`${siteOrigin}/admin/users`);
      await page
        .getByRole("button", { name: "新建厂家用户", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("选择厂家", { exact: true })
        .selectOption(factoryId);
      await dialog
        .getByLabel("用户名", { exact: true })
        .fill("installer_factory");
      await dialog.locator('input[name="password"]').fill(factoryPassword);
      await dialog
        .getByRole("button", { name: "创建用户", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await page.goto(`${siteOrigin}/admin/products/${productId}`);
      await page
        .getByLabel("选择厂家", { exact: true })
        .selectOption(factoryId);
      await page.getByRole("button", { name: "添加分配", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "安装测试厂家", exact: true }),
      ).toBeVisible();
    });
    const factory = await browser.newContext({ ignoreHTTPSErrors: true });
    const factoryPage = await factory.newPage();
    factoryPage.setDefaultTimeout(20000);
    await step("Factory login and tenant isolation", async () => {
      await login(factoryPage, "installer_factory", factoryPassword, "factory");
      await factoryPage.goto(`${siteOrigin}/admin/users`);
      await expect(factoryPage).toHaveURL(/\/factory$/);
      await factoryPage.goto(`${siteOrigin}/factory/products`);
      await expect(
        factoryPage.getByText("安装测试产品", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        factoryPage.getByText("未分配隔离产品", { exact: true }),
      ).toHaveCount(0);
      await factoryPage.goto(
        `${siteOrigin}/factory/products/${privateProductId}`,
      );
      await expect(
        factoryPage.getByText("未分配隔离产品", { exact: true }),
      ).toHaveCount(0);
      await expect(factoryPage.getByLabel("人民币价格")).toHaveCount(0);
    });
    await step("Factory Quote", async () => {
      await factoryPage.goto(`${siteOrigin}/factory/products/${productId}`);
      await factoryPage.getByLabel("人民币价格").fill("328.5");
      await factoryPage
        .getByRole("button", { name: "提交", exact: true })
        .click();
      await expect(
        factoryPage.getByText("报价已提交。", { exact: true }),
      ).toBeVisible();
    });
    await step(
      "confirmed low-risk Hard Delete and durable Worker",
      async () => {
        await page.goto(`${siteOrigin}/admin/settings`);
        await page.getByLabel("新建分类").fill("安装测试待删分类");
        await page
          .getByRole("button", { name: "新增", exact: true })
          .first()
          .click();
        const row = page
          .getByLabel("安装测试待删分类名称")
          .locator("..")
          .locator("..");
        await row.getByRole("button", { name: "停用", exact: true }).click();
        await expect(
          row.getByRole("button", { name: "启用", exact: true }),
        ).toBeVisible();
        await row
          .getByRole("button", { name: "永久删除分类", exact: true })
          .filter({ visible: true })
          .click();
        const dialog = page.getByRole("dialog");
        const phrase = await dialog
          .getByTestId("confirmation-phrase")
          .innerText();
        await dialog.getByLabel("确认短语", { exact: true }).fill(phrase);
        await dialog
          .getByRole("button", { name: "确认永久删除", exact: true })
          .click();
        await expect(
          page.getByText("分类已永久删除。", { exact: true }),
        ).toBeVisible({ timeout: 60000 });
        await expect(page.getByLabel("安装测试待删分类名称")).toHaveCount(0);
      },
    );
    await step("runtime origin and forwarded-header rejection", async () => {
      assert.equal(await directRequest("GET", "/login"), 200);
      assert.equal(
        await publicRequest({
          "x-forwarded-host": "attacker.example.net",
          "x-forwarded-proto": "http",
          forwarded: "host=attacker.example.net",
        }),
        200,
      );
      assert.equal(await publicRequest({ host: "attacker.example.net" }), 421);
      assert.equal(
        await directRequest("POST", "/admin/settings", { origin: otherOrigin }),
        403,
      );
      assert.equal(
        await directRequest("POST", "/admin/settings", {
          origin: "https://random.example.net",
        }),
        403,
      );
      assert.equal(
        await directRequest("POST", "/admin/settings", { origin: undefined }),
        403,
      );
      assert.equal(
        await directRequest("GET", "/login", { host: "attacker.example.net" }),
        403,
      );
      assert.equal(
        await directRequest("GET", "/login", {
          "x-forwarded-host": "attacker.example.net",
        }),
        403,
      );
      assert.equal(
        await directRequest("GET", "/login", {
          "x-forwarded-host": `${domain}:34443, attacker.example.net`,
        }),
        403,
      );
      assert.equal(
        await directRequest("GET", "/login", { "x-forwarded-proto": "http" }),
        403,
      );
      assert.equal(
        await directRequest("GET", "/login", {
          forwarded: `host=${domain}:34443`,
        }),
        403,
      );
      assert.equal(
        await directRequest("GET", "/api/health", {
          host: "127.0.0.1:33443",
          "x-forwarded-host": undefined,
          "x-forwarded-proto": undefined,
        }),
        200,
      );
    });
    await step("Admin and Factory logout", async () => {
      await page.getByRole("button", { name: "退出登录" }).click();
      await expect(page).toHaveURL(/\/login$/);
      await factoryPage.getByRole("button", { name: "退出登录" }).click();
      await expect(factoryPage).toHaveURL(/\/login$/);
    });
    await admin.close();
    await factory.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolveServer) =>
      server.close(() => resolveServer()),
    );
  }
}

async function cleanup() {
  phase = "owned disposable cleanup";
  const containers = (
    await command("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ])
  )
    .split("\n")
    .filter(Boolean);
  if (containers.length) {
    const inspected = JSON.parse(
      await command("docker", ["inspect", ...containers]),
    );
    assert.ok(
      inspected.every(
        (value: { Config: { Labels: Record<string, string> } }) =>
          value.Config.Labels["com.docker.compose.project"] === project,
      ),
    );
    await command("docker", ["rm", "-f", ...containers]);
  }
  const networks = (
    await command("docker", [
      "network",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ])
  )
    .split("\n")
    .filter(Boolean);
  if (networks.length) await command("docker", ["network", "rm", ...networks]);
  const volumes = (
    await command("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ])
  )
    .split("\n")
    .filter(Boolean);
  for (const volume of volumes) {
    assert.ok(volume.startsWith(project + "_"));
    await command("docker", ["volume", "rm", volume]);
  }
  if (volumeCreated) {
    const details = JSON.parse(
      await command("docker", ["volume", "inspect", configVolume]),
    )[0];
    assert.equal(details.Labels["product-hub.bootstrap-test"], suffix);
    await command("docker", ["volume", "rm", configVolume]);
  }
  if (imageCreated) await command("docker", ["image", "rm", controllerImage]);
  rmSync(fixture, { recursive: true });
  process.stdout.write(
    "PASS: removed only this test's disposable containers, networks, volumes and fixture\n",
  );
}
async function main() {
  try {
    revision = await command("git", ["rev-parse", "HEAD"]);
    assert.match(revision, /^[a-f0-9]{40}$/);
    if (!process.env.PRODUCT_HUB_BOOTSTRAP_TEST_TAG) {
      await step("local amd64 release artifacts", async () => {
        await command(
          "env",
          ["sh", "scripts/build-production-artifacts.sh", tag],
          undefined,
          true,
        );
      });
    }
    await step("disposable controller", async () => {
      const postgres = readFileSync(
        join(repository, "deploy/releases/postgres-linux-amd64.txt"),
        "utf8",
      ).trim();
      assert.match(postgres, /^postgres@sha256:[0-9a-f]{64}$/);
      await command("docker", ["pull", "--platform", "linux/amd64", postgres]);
      await command("docker", [
        "build",
        "--platform",
        "linux/amd64",
        "--build-arg",
        `MIGRATOR_IMAGE=product-hub-migrator:${tag}`,
        "-f",
        "tests/production-bootstrap/Dockerfile",
        "-t",
        controllerImage,
        ".",
      ]);
      imageCreated = true;
      await command("docker", [
        "volume",
        "create",
        "--label",
        `product-hub.bootstrap-test=${suffix}`,
        configVolume,
      ]);
      volumeCreated = true;
      mountpoint = JSON.parse(
        await command("docker", ["volume", "inspect", configVolume]),
      )[0].Mountpoint;
      assert.match(
        mountpoint,
        /^\/var\/lib\/docker\/volumes\/product-hub-bootstrap-config-[a-f0-9]{8}\/_data$/,
      );
    });
    await step("fresh preflight and release configure", () =>
      controller("setup"),
    );
    await step("fresh production install", () => controller("install"));
    await controller("snapshot");
    await step(
      "second install preserves PostgreSQL container and data",
      async () => {
        await controller("install");
        await controller("preserved");
      },
    );
    await step("independent initial Admin bootstrap and repeat refusal", () =>
      controller("bootstrap-admin", adminPassword + "\n"),
    );
    await controller("snapshot");
    await step("read-only doctor", async () => {
      await controller("doctor");
      await controller("preserved");
    });
    await step("actual App, Migrator and Worker credential isolation", () =>
      controller("credential-isolation"),
    );
    await smoke();
    await step(
      "business, history and completed deletion database assertions",
      () => controller("verify-smoke"),
    );
    await controller("snapshot");
    await step("install after business writes preserves all data", async () => {
      await controller("install");
      await controller("preserved");
    });
    await step("real failure injection and host UID1001 isolation", () =>
      controller("failures"),
    );
    await step("doctor after explicit disposable recovery", () =>
      controller("doctor"),
    );
    await step("database/uploads backup and checksums", () =>
      controller("backup"),
    );
    await step("credential-free logs/stdout/generated Compose", () =>
      controller("scan", `${adminPassword}\n${factoryPassword}\n`),
    );
    process.stdout.write(
      `PASS: disposable production bootstrap end-to-end; domain=${domain}\n`,
    );
  } catch {
    process.stderr.write(`FAIL: ${phase}; credential details suppressed\n`);
    if (mountpoint && phase.includes("login"))
      await controller("scan", `${adminPassword}\n${factoryPassword}\n`).catch(
        () => {
          process.stderr.write("FAIL: failure-state log scan\n");
        },
      );
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}
await main();
