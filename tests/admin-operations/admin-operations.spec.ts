import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";
import { test } from "../support/diagnostic-test";
import axeCore from "axe-core";

import { auth } from "../../src/lib/auth/auth";
import { prisma } from "../../src/lib/db/prisma";
import {
  newAuthRequest,
  passwords,
  resetAuthFixtures,
  resetTestRateLimits,
  usernames,
} from "../auth/fixtures";

let categoryName = "";
let materialName = "";
let productId = "";
let factoryId = "";
const securityAdmin = "admin.security";

async function seed() {
  const fixtures = await resetAuthFixtures();
  await auth.api.createUser({
    body: {
      email: `${randomUUID()}@users.invalid`,
      password: passwords.admin,
      name: securityAdmin,
      role: "ADMIN",
      data: { username: securityAdmin, factoryId: null },
    },
  });
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.material.deleteMany();
  const category = await prisma.category.create({
    data: { name: "运营分类", nameNormalized: "运营分类" },
  });
  const material = await prisma.material.create({
    data: { name: "运营材质", nameNormalized: "运营材质" },
  });
  const product = await prisma.product.create({
    data: {
      sku: "OPS-001",
      skuNormalized: "OPS-001",
      name: "运营测试产品",
      categoryId: category.id,
      materialId: material.id,
    },
  });
  const assignment = await prisma.productFactoryAssignment.create({
    data: { productId: product.id, factoryId: fixtures.factoryAId },
  });
  await prisma.factoryQuote.create({
    data: { assignmentId: assignment.id, priceCents: 32800n, moq: 100 },
  });
  await prisma.activityLog.create({
    data: {
      eventType: "QUOTE_UPDATED",
      entityType: "QUOTE",
      entityId: assignment.id,
      entityLabelSnapshot: "OPS-001 · Factory A",
      actorUserId: fixtures.adminId,
      actorRole: "ADMIN",
      actorUsernameSnapshot: usernames.admin,
      factoryId: fixtures.factoryAId,
      changes: {
        priceCents: { before: "35000", after: "32800" },
        grossWeightKg: { before: "7.8", after: "7.6" },
      },
    },
  });
  categoryName = category.name;
  materialName = material.name;
  productId = product.id;
  factoryId = fixtures.factoryAId;
}

async function login(
  page: import("@playwright/test").Page,
  username: string = usernames.admin,
  password: string = passwords.admin,
) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  // Authentication and navigation are separate asynchronous boundaries. Keep
  // the existing URL deadline, but start it after the real sign-in succeeds.
  const signedIn = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/sign-in/username" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录" }).click();
  expect((await signedIn).status()).toBe(200);
  await expect(page).toHaveURL(
    username === usernames.factoryA || username === usernames.factoryB
      ? /\/factory$/
      : /\/admin$/,
  );
}

function csv(rows: string[][]) {
  const headers = [
    "product_id",
    "SKU",
    "产品名称",
    "分类",
    "材质",
    "状态",
    "内部备注",
  ];
  return Buffer.from(
    `\uFEFF${[headers, ...rows].map((row) => row.join(",")).join("\r\n")}\r\n`,
  );
}

test.beforeAll(seed);

async function uploadPreview(
  page: import("@playwright/test").Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  action: "CREATE" | "ERROR" | "UPDATE",
) {
  // The notice follows two requests. Register both before uploading so a fast
  // rows response cannot race registration, and never filter out HTTP errors.
  const [job, rows] = await Promise.all([
    page
      .waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/imports/products/preview",
      )
      .then(async (response) => {
        expect(response.status()).toBe(201);
        return response.json();
      }),
    page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        /^\/api\/imports\/[^/]+\/rows$/.test(new URL(response.url()).pathname),
    ),
    page.locator('input[type="file"]').setInputFiles(file),
  ]);
  expect(job).toMatchObject({ totalRows: 1 });
  expect(new URL(rows.url()).pathname).toBe(`/api/imports/${job.id}/rows`);
  expect(rows.status()).toBe(200);
  expect(await rows.json()).toMatchObject({ items: [{ action }] });
}

test("Import UI downloads templates, previews, confirms, blocks errors and reports stale updates", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "mutation flow runs on desktop once");
  await login(page);
  await page.goto("/admin/products/import");
  for (const name of ["CSV 模板", "XLSX 模板"]) {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name }).click();
    expect((await download).suggestedFilename()).toMatch(
      /product-import-template/,
    );
  }
  await uploadPreview(
    page,
    {
      name: "valid.csv",
      mimeType: "text/csv",
      buffer: csv([
        ["", "OPS-NEW", "导入成功产品", categoryName, materialName, "启用", ""],
      ]),
    },
    "CREATE",
  );
  await expect(
    page.getByText("预览已生成；确认前不会修改任何产品。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认导入" })
    .click();
  await expect(page.getByText("导入完成，产品资料已安全更新。")).toBeVisible();
  expect(await prisma.product.count({ where: { sku: "OPS-NEW" } })).toBe(1);

  await uploadPreview(
    page,
    {
      name: "error.csv",
      mimeType: "text/csv",
      buffer: csv([
        ["", "OPS-BAD", "错误产品", "不存在分类", materialName, "启用", ""],
      ]),
    },
    "ERROR",
  );
  await expect(page.getByText("分类不存在").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "确认导入" })).toBeDisabled();

  await uploadPreview(
    page,
    {
      name: "stale.csv",
      mimeType: "text/csv",
      buffer: csv([
        [
          productId,
          "OPS-001",
          "预览后的产品名",
          categoryName,
          materialName,
          "启用",
          "",
        ],
      ]),
    },
    "UPDATE",
  );
  await expect(page.getByText("更新 1")).toBeVisible();
  await prisma.product.update({
    where: { id: productId },
    data: { notes: "并发修改" },
  });
  await page.getByRole("button", { name: "确认导入" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认导入" })
    .click();
  await expect(
    page.getByText("部分产品在预览后已被修改，请重新生成预览。"),
  ).toBeVisible();
});

test("Export UI downloads both formats and respects current filters", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "downloads run on desktop once");
  await login(page);
  await page.goto("/admin/products?search=OPS-001&status=ENABLED");
  await expect(page.getByText(/将导出 1 条/)).toBeVisible();
  for (const name of ["导出 CSV", "导出 XLSX"]) {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name }).click();
    expect((await download).suggestedFilename()).toMatch(/^products-/);
  }
  await page.goto(`/admin/quotes?factoryId=${factoryId}`);
  await expect(page.getByText(/已提交报价.*将导出 1 条/)).toBeVisible();
  for (const name of ["导出 CSV", "导出 XLSX"]) {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name }).click();
    expect((await download).suggestedFilename()).toMatch(/^factory-quotes-/);
  }
});

test("Activity UI filters and renders human-readable safe detail", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop detail flow runs once");
  await login(page);
  await page.goto("/admin/activity");
  await expect(
    page.getByRole("article").filter({ hasText: "报价已更新" }),
  ).toBeVisible();
  await expect(
    page.getByText("¥350.00 → ¥328.00", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("事件").selectOption("QUOTE_UPDATED");
  await page.getByRole("button", { name: "筛选" }).click();
  await page.getByText("查看安全详情").click();
  await expect(
    page.getByRole("group").getByText("Factory A", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group").getByText(/毛重.*7.8 kg.*7.6 kg/),
  ).toBeVisible();
  await expect(page.getByText(/JSONB|metadata|storage path/i)).toHaveCount(0);
});

test("Users UI creates, rejects duplicate, disables, enables and resets password sessions", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "account mutation flow runs once");
  await resetTestRateLimits();
  await login(page, securityAdmin, passwords.admin);
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "新建厂家用户" }).click();
  await page.getByLabel("搜索厂家").fill("Factory A");
  await page.getByLabel("选择厂家").selectOption(factoryId);
  await page.getByLabel("用户名").fill("ops.factory");
  await page.locator('input[name="password"]').fill(passwords.factoryA);
  await page.getByRole("button", { name: "创建用户" }).click();
  await expect(
    page.getByText("ops.factory", { exact: true }).first(),
  ).toBeVisible();
  const oldSession = await newAuthRequest("ops.factory", passwords.factoryA);
  expect(oldSession.response.ok()).toBeTruthy();

  const row = page.getByRole("row").filter({ hasText: "ops.factory" });
  await row.getByRole("button", { name: "停用" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认停用" })
    .click();
  await expect(
    page.getByText("账号已停用", { exact: true }).first(),
  ).toBeVisible();
  const disabled = await oldSession.context.get("/factory");
  expect(disabled.url()).toMatch(/\/login/);
  await oldSession.context.dispose();
  await page
    .getByRole("row")
    .filter({ hasText: "ops.factory" })
    .getByRole("button", { name: "启用" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认启用" })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(row.getByRole("button", { name: "停用" })).toBeVisible();
  // Disable already revoked oldSession. Reset must invalidate a genuinely
  // live session created after re-enabling, not that already-dead session.
  const beforeReset = await newAuthRequest("ops.factory", passwords.factoryA);
  expect(beforeReset.response.status()).toBe(200);
  const previous = await (
    await beforeReset.context.get("/api/auth/get-session")
  ).json();
  expect(previous?.user?.username).toBe("ops.factory");
  const previousSessions = await prisma.session.findMany({
    where: { userId: previous.user.id },
    select: { id: true },
  });
  expect(previousSessions.map(({ id }) => id)).toContain(previous.session.id);
  await page
    .getByRole("row")
    .filter({ hasText: "ops.factory" })
    .getByRole("button", { name: "重置密码" })
    .click();
  await page
    .getByRole("dialog")
    .locator('input[name="password"]')
    .fill(passwords.next);
  await page
    .getByRole("dialog")
    .locator('input[name="confirm"]')
    .fill(passwords.next);
  const resetResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/admin/users" &&
      response.request().method() === "POST" &&
      Boolean(response.request().headers()["next-action"]),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认重置" })
    .click();
  expect((await resetResponse).status()).toBe(200);
  // Server Actions also return HTTP 200 for business errors. This dialog
  // closes only after ok: true, i.e. password write AND session revocation.
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const fresh = await newAuthRequest("ops.factory", passwords.next);
  try {
    expect(fresh.response.status()).toBe(200);
    const current = await (
      await fresh.context.get("/api/auth/get-session")
    ).json();
    expect(current?.user?.id).toBe(previous.user.id);
    const remaining = await prisma.session.findMany({
      where: { userId: previous.user.id },
      select: { id: true },
    });
    expect(remaining.map(({ id }) => id)).toEqual([current.session.id]);
    expect(previousSessions.some(({ id }) => id === current.session.id)).toBe(
      false,
    );
    expect(
      await (await beforeReset.context.get("/api/auth/get-session")).json(),
    ).toBeNull();
    const stale = await beforeReset.context.get("/factory");
    expect(stale.url()).toMatch(/\/login/);
    const oldPassword = await newAuthRequest("ops.factory", passwords.factoryA);
    try {
      expect(oldPassword.response.status()).toBe(401);
    } finally {
      await oldPassword.context.dispose();
    }
  } finally {
    await Promise.all([beforeReset.context.dispose(), fresh.context.dispose()]);
  }

  await page.getByRole("button", { name: "新建厂家用户" }).click();
  await page.getByLabel("搜索厂家").fill("Factory A");
  await page.getByLabel("选择厂家").selectOption(factoryId);
  await page.getByLabel("用户名").fill("ops.factory");
  await page.locator('input[name="password"]').fill(passwords.factoryA);
  await page.getByRole("button", { name: "创建用户" }).click();
  await expect(page.getByText("用户名已存在")).toBeVisible();
  // All lifecycle assertions are complete. Do not leave this scenario's five
  // sign-ins consuming the shared server's quota for the following test.
  await resetTestRateLimits();
});

test("Admin operational pages reflow and pass axe", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium viewport matrix");
  await login(page);
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const route of [
      "/admin/products/import",
      "/admin/activity",
      "/admin/users",
      "/admin/settings",
    ]) {
      await page.goto(route);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        ),
        `${route} overflow at ${viewport.width}`,
      ).toBe(false);
    }
  }
  for (const route of [
    "/admin/products/import",
    "/admin/activity",
    "/admin/users",
  ]) {
    await page.goto(route);
    await page.addScriptTag({ content: axeCore.source });
    const violations = await page.evaluate(
      async () =>
        (
          await (
            window as typeof window & {
              axe: {
                run: (options: {
                  runOnly: string[];
                }) => Promise<{ violations: unknown[] }>;
              };
            }
          ).axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag22aa"] })
        ).violations,
    );
    expect(violations).toEqual([]);
  }
});

test("Factory cannot access operational pages or endpoints", async ({
  page,
}) => {
  await login(page, usernames.factoryA, passwords.factoryA);
  for (const route of [
    "/admin/products/import",
    "/admin/activity",
    "/admin/users",
    "/admin/settings",
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/factory$/);
  }
  const responses = await Promise.all([
    page.request.get("/api/imports/products/templates/csv"),
    page.request.get("/api/exports/products/csv"),
    page.request.get("/api/exports/factory-quotes/csv"),
    page.request.post("/api/imports/products/preview", {
      multipart: {
        file: { name: "x.csv", mimeType: "text/csv", buffer: csv([]) },
      },
      headers: { origin: "http://127.0.0.1:3100" },
    }),
  ]);
  for (const response of responses) expect(response.status()).toBe(403);
});

test("Admin can change own password and other sessions are revoked", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "password change runs last on desktop");
  // beforeAll(seed) refuses non-test databases. Isolate this multi-session
  // scenario from earlier tests' sign-ins, never reset during the scenario.
  await prisma.rateLimit.deleteMany();
  await login(page, securityAdmin, passwords.admin);
  const other = await newAuthRequest(securityAdmin, passwords.admin);
  try {
    expect(other.response.status()).toBe(200);
    const previousSessions = await prisma.session.findMany({
      where: { user: { username: securityAdmin } },
      select: { id: true },
    });
    expect(previousSessions.length).toBeGreaterThanOrEqual(2);

    await page.goto("/admin/settings");
    await page.locator('input[name="currentPassword"]').fill(passwords.admin);
    await page.locator('input[name="newPassword"]').fill(passwords.next);
    await page.locator('input[name="confirmPassword"]').fill(passwords.next);
    const changed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/change-password" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "修改密码" }).click();
    expect((await changed).status()).toBe(200);
    await expect(
      page.getByText("密码已更新，其他登录会话已撤销。"),
    ).toBeVisible();

    // Better Auth rotates the current session; browser continuity does not
    // mean retaining the old session ID or leaving any old session usable.
    await page.reload();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    const current = await (
      await page.request.get("/api/auth/get-session")
    ).json();
    expect(current?.user?.username).toBe(securityAdmin);
    const remaining = await prisma.session.findMany({
      where: { user: { username: securityAdmin } },
      select: { id: true },
    });
    expect(remaining).toHaveLength(1);
    expect(previousSessions.some(({ id }) => id === remaining[0]?.id)).toBe(
      false,
    );
    expect(
      await (await other.context.get("/api/auth/get-session")).json(),
    ).toBeNull();

    const oldPassword = await newAuthRequest(securityAdmin, passwords.admin);
    try {
      expect(oldPassword.response.status()).toBe(401);
    } finally {
      await oldPassword.context.dispose();
    }
    const fresh = await newAuthRequest(securityAdmin, passwords.next);
    try {
      expect(fresh.response.status()).toBe(200);
    } finally {
      await fresh.context.dispose();
    }
  } finally {
    await other.context.dispose();
  }
});
