import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, type Page } from "@playwright/test";
import { test } from "../support/diagnostic-test";
import axeCore from "axe-core";
import sharp from "sharp";

import {
  reactivateAssignment,
  revokeAssignment,
} from "../../src/features/assignments/service";
import { setFactoryStatus } from "../../src/features/factories/service";
import { setProductStatus } from "../../src/features/products/service";
import { submitOwnQuote } from "../../src/features/quotes/service";
import { prisma } from "../../src/lib/db/prisma";
import {
  newAuthRequest,
  passwords,
  requestHeaders,
  resetAuthFixtures,
  usernames,
} from "../auth/fixtures";

test.describe.configure({ mode: "serial" });

let productIds: string[] = [];
let assignmentIds: string[] = [];
let factoryBOnlyProductId = "";
let factoryBPrivateImageId = "";
let adminHeaders: Headers;
let factoryAHeaders: Headers;
let factoryAPassword = passwords.factoryA;
const requestContexts: Array<Awaited<ReturnType<typeof newAuthRequest>>> = [];

async function apiLogin(username: string, password: string) {
  const session = await newAuthRequest(username, password);
  expect(session.response.ok()).toBeTruthy();
  requestContexts.push(session);
  return requestHeaders(session.context);
}

async function storedImage(
  storageRoot: string,
  creatorId: string,
  width: number,
  height: number,
  color: { r: number; g: number; b: number; alpha: number },
) {
  const bytes = await sharp({
    create: { width, height, channels: 4, background: color },
  })
    .webp()
    .toBuffer();
  const key = `objects/${randomUUID()}.webp`;
  await writeFile(path.join(storageRoot, key), bytes);
  return prisma.storedObject.create({
    data: {
      storageKey: key,
      mimeType: "image/webp",
      sizeBytes: bytes.length,
      width,
      height,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      createdByUserId: creatorId,
    },
  });
}

async function seedFactoryWorkspace() {
  await prisma.activityLog.deleteMany();
  await prisma.productMainImage.deleteMany();
  await prisma.factoryPrivateImage.deleteMany();
  await prisma.storedObject.deleteMany();
  await prisma.priceHistory.deleteMany();
  await prisma.factoryQuote.deleteMany();
  await prisma.productFactoryAssignment.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.material.deleteMany();
  const fixtures = await resetAuthFixtures();
  adminHeaders = await apiLogin(usernames.admin, passwords.admin);
  factoryAHeaders = await apiLogin(usernames.factoryA, passwords.factoryA);
  factoryAPassword = passwords.factoryA;

  const categories = await Promise.all(
    ["龙头", "花洒系统", "卫浴配件"].map((name) =>
      prisma.category.create({
        data: { name, nameNormalized: name.toLocaleLowerCase("en-US") },
      }),
    ),
  );
  const materials = await Promise.all(
    ["黄铜", "不锈钢", "ABS 工程塑料"].map((name) =>
      prisma.material.create({
        data: { name, nameNormalized: name.toLocaleLowerCase("en-US") },
      }),
    ),
  );
  const products = [];
  for (let index = 0; index < 13; index += 1) {
    products.push(
      await prisma.product.create({
        data: {
          sku: `FACTORY-TEST-${String(index + 1).padStart(3, "0")}`,
          skuNormalized: `FACTORY-TEST-${String(index + 1).padStart(3, "0")}`,
          name:
            index === 11
              ? "用于验证手机端中文长名称安全换行且不会造成页面横向溢出的测试产品"
              : `厂家门户测试产品 ${index + 1}`,
          categoryId: categories[index % categories.length].id,
          materialId: materials[index % materials.length].id,
        },
      }),
    );
  }
  productIds = products.slice(0, 12).map((item) => item.id);
  const assignments = [];
  for (const product of products.slice(0, 12)) {
    assignments.push(
      await prisma.productFactoryAssignment.create({
        data: { productId: product.id, factoryId: fixtures.factoryAId },
      }),
    );
  }
  assignmentIds = assignments.map((item) => item.id);

  const sharedB = await prisma.productFactoryAssignment.create({
    data: { productId: products[0].id, factoryId: fixtures.factoryBId },
  });
  const bOnly = await prisma.productFactoryAssignment.create({
    data: { productId: products[12].id, factoryId: fixtures.factoryBId },
  });
  factoryBOnlyProductId = products[12].id;
  const factoryC = await prisma.factory.create({
    data: { name: "Factory C Test", nameNormalized: "factory c test" },
  });
  const sharedC = await prisma.productFactoryAssignment.create({
    data: { productId: products[0].id, factoryId: factoryC.id },
  });

  const quoteA = await prisma.factoryQuote.create({
    data: {
      assignmentId: assignments[0].id,
      priceCents: 32800n,
      moq: 100,
      packingLengthCm: "75",
      packingWidthCm: "42",
      packingHeightCm: "18",
      netWeightKg: "6.8",
      grossWeightKg: "7.4",
      pcsPerCarton: 2,
      factoryNotes: "本厂历史报价备注",
      version: 3,
    },
  });
  for (const [oldPrice, newPrice] of [
    [null, 33800n],
    [33800n, 33000n],
    [33000n, 32800n],
  ] as const) {
    await prisma.priceHistory.create({
      data: {
        factoryQuoteId: quoteA.id,
        oldPriceCents: oldPrice,
        newPriceCents: newPrice,
        changedByUserId: fixtures.userAId,
      },
    });
  }
  await prisma.factoryQuote.create({
    data: { assignmentId: assignments[3].id, priceCents: 36000n },
  });
  await prisma.factoryQuote.create({
    data: { assignmentId: assignments[4].id, priceCents: 37500n },
  });
  await prisma.factoryQuote.create({
    data: { assignmentId: sharedB.id, priceCents: 31500n },
  });
  await prisma.factoryQuote.create({
    data: { assignmentId: sharedC.id, priceCents: 34500n },
  });

  const storageRoot = path.resolve(process.cwd(), "data/test-uploads");
  await rm(storageRoot, { recursive: true, force: true });
  await mkdir(path.join(storageRoot, "objects"), { recursive: true });
  const mainObject = await storedImage(
    storageRoot,
    fixtures.adminId,
    1200,
    900,
    { r: 225, g: 232, b: 229, alpha: 1 },
  );
  await prisma.productMainImage.create({
    data: {
      productId: products[0].id,
      storedObjectId: mainObject.id,
      createdByUserId: fixtures.adminId,
    },
  });
  const privateObject = await storedImage(
    storageRoot,
    fixtures.userAId,
    1000,
    750,
    { r: 210, g: 224, b: 231, alpha: 1 },
  );
  await prisma.factoryPrivateImage.create({
    data: {
      assignmentId: assignments[0].id,
      storedObjectId: privateObject.id,
      uploadedByUserId: fixtures.userAId,
    },
  });
  const privateBObject = await storedImage(
    storageRoot,
    fixtures.userBId,
    800,
    800,
    { r: 232, g: 220, b: 210, alpha: 1 },
  );
  factoryBPrivateImageId = (
    await prisma.factoryPrivateImage.create({
      data: {
        assignmentId: bOnly.id,
        storedObjectId: privateBObject.id,
        uploadedByUserId: fixtures.userBId,
      },
    })
  ).id;
}

async function login(page: Page, password = factoryAPassword) {
  // Each serial journey starts with a fresh browser context. Keep the suite's
  // repeated fixture logins from exercising the production rate-limit window;
  // rate limiting itself is covered by the auth suite.
  await prisma.rateLimit.deleteMany();
  await page.goto("/login");
  await page.getByLabel("用户名").fill(usernames.factoryA);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/factory$/);
}

test.beforeAll(async () => {
  await seedFactoryWorkspace();
});

test.afterAll(async () => {
  await Promise.all(requestContexts.map(({ context }) => context.dispose()));
});

test("Factory dashboard, products, filters and detail expose only own data", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop journey runs once");
  await login(page);
  await expect(page.getByRole("heading", { name: "厂家概览" })).toBeVisible();
  await expect(page.getByText("12", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("9", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "产品", exact: true }).click();
  await expect(page.getByText("共 12 个产品")).toBeVisible();
  await page.getByPlaceholder("搜索 SKU 或产品名称").fill("FACTORY-TEST-001");
  await page.getByLabel("报价状态").selectOption("submitted");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect(page.getByText("厂家门户测试产品 1")).toBeVisible();
  await Promise.all([
    page.waitForURL(new RegExp(`/factory/products/${productIds[0]}$`)),
    page.getByText("厂家门户测试产品 1").click(),
  ]);
  await expect(page.getByText("¥328.00").first()).toBeVisible();
  await expect(page.getByText("¥315.00")).toHaveCount(0);
  await expect(page.getByText("¥345.00")).toHaveCount(0);
  await expect(page.getByText("Factory B")).toHaveCount(0);
  await expect(page.getByText("Factory C Test")).toHaveCount(0);
  await page.getByRole("button", { name: "查看大图" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();
});

test("Factory submits, updates, avoids no-op history and handles version conflict", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "mutation journey runs once");
  await login(page);
  await page.goto(`/factory/products/${productIds[1]}`);
  await page.getByLabel("人民币价格").fill("328.5");
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect(page.getByText("报价已提交。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "没有需要提交的修改" }),
  ).toBeDisabled();

  await page.goto(`/factory/products/${productIds[2]}`);
  await page.getByLabel("人民币价格").fill("410");
  await page.getByLabel("MOQ").fill("120");
  await page.getByLabel("包装长度").fill("75");
  await page.getByLabel("包装宽度").fill("42");
  await page.getByLabel("包装高度").fill("18");
  await page.getByLabel("净重").fill("6.8");
  await page.getByLabel("毛重").fill("7.4");
  await page.getByLabel("每箱数量").fill("2");
  await page.getByLabel("厂家备注").fill("完整报价资料测试");
  await expect(page.getByText("0.0567 m³")).toBeVisible();
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect(page.getByText("报价已提交。")).toBeVisible();
  await page.getByLabel("包装高度").fill("19");
  await page.getByRole("button", { name: "更新提交" }).click();
  await expect(page.getByText("报价已更新提交。")).toBeVisible();
  await expect(page.getByText("1 条")).toBeVisible();

  await page.goto(`/factory/products/${productIds[0]}`);
  const current = await prisma.factoryQuote.findUniqueOrThrow({
    where: { assignmentId: assignmentIds[0] },
  });
  await submitOwnQuote(factoryAHeaders, {
    assignmentId: assignmentIds[0],
    expectedVersion: current.version,
    price: "329",
    moq: 100,
    packingLengthCm: "75",
    packingWidthCm: "42",
    packingHeightCm: "18",
    netWeightKg: "6.8",
    grossWeightKg: "7.4",
    pcsPerCarton: 2,
    factoryNotes: "并发更新",
  });
  await page.getByLabel("人民币价格").fill("330");
  await page.getByRole("button", { name: "更新提交" }).click();
  await expect(
    page.getByText("该报价已被其他用户更新，请刷新后重试。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新最新数据" }),
  ).toBeVisible();
});

test("Factory manages its private image while cross-tenant product and image stay hidden", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "image journey runs once");
  await login(page);
  await page.goto(`/factory/products/${productIds[0]}`);
  const firstImage = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 4,
      background: { r: 220, g: 230, b: 235, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await page.getByLabel("选择厂家图片").setInputFiles({
    name: "factory-private.png",
    mimeType: "image/png",
    buffer: firstImage,
  });
  await page.getByRole("button", { name: "更换图片" }).click();
  await expect(page.getByText("厂家图片已更换。")).toBeVisible();
  await page.getByLabel("选择厂家图片").setInputFiles({
    name: "factory-private-replace.webp",
    mimeType: "image/webp",
    buffer: await sharp(firstImage).webp().toBuffer(),
  });
  await page.getByRole("button", { name: "更换图片" }).click();
  await expect(page.getByText("厂家图片已更换。")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "移除图片" }).click();
  await expect(page.getByText("厂家图片已移除。")).toBeVisible();

  await page.goto(`/factory/products/${factoryBOnlyProductId}`);
  await expect(page).toHaveURL(/\/factory\/products\?notice=unavailable/);
  const privateResponse = await page.request.get(
    `/api/images/factory-private/${factoryBPrivateImageId}`,
  );
  expect(privateResponse.status()).toBe(404);
});

test("Assignment, product and factory lifecycle changes take effect immediately", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "lifecycle journey runs once");
  await login(page);
  await page.goto(`/factory/products/${productIds[5]}`);
  await revokeAssignment(adminHeaders, { assignmentId: assignmentIds[5] });
  await page.reload();
  await expect(page).toHaveURL(/notice=unavailable/);
  await reactivateAssignment(adminHeaders, { assignmentId: assignmentIds[5] });
  await page.goto(`/factory/products/${productIds[5]}`);
  await expect(
    page.getByRole("heading", { name: "厂家门户测试产品 6" }),
  ).toBeVisible();

  await setProductStatus(adminHeaders, {
    id: productIds[5],
    status: "DISABLED",
  });
  await page.reload();
  await expect(page).toHaveURL(/notice=unavailable/);
  await setProductStatus(adminHeaders, {
    id: productIds[5],
    status: "ENABLED",
  });

  const factoryAId = (
    await prisma.user.findUniqueOrThrow({
      where: { username: usernames.factoryA },
    })
  ).factoryId!;
  await setFactoryStatus(adminHeaders, { id: factoryAId, status: "DISABLED" });
  await page.goto("/factory");
  await expect(page).toHaveURL(/\/login$/);
  await setFactoryStatus(adminHeaders, { id: factoryAId, status: "ACTIVE" });
});

test("Factory changes password and logs out", async ({ page, isMobile }) => {
  test.skip(isMobile, "account mutation journey runs once");
  await login(page);
  await page.getByRole("link", { name: "账户", exact: true }).click();
  await expect(
    page.getByText(usernames.factoryA, { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Factory A", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("当前密码").fill(factoryAPassword);
  await page.getByLabel("新密码（至少 8 位）").fill(passwords.next);
  await page.getByLabel("确认新密码").fill(passwords.next);
  const passwordResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/change-password") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "更新密码" }).click();
  expect((await passwordResponse).status()).toBe(200);
  await expect(page.getByLabel("当前密码")).toHaveValue("");
  factoryAPassword = passwords.next;
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, factoryAPassword);
});

test("Factory portal reflows across required viewports and passes axe", async ({
  page,
  isMobile,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium viewport matrix only");
  test.setTimeout(90_000);
  await login(page);
  const viewports = isMobile
    ? [{ width: 390, height: 844 }]
    : [
        { width: 375, height: 812 },
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
      ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of [
      "/factory",
      "/factory/products",
      `/factory/products/${productIds[0]}`,
      "/factory/profile",
    ]) {
      await page.goto(route);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        ),
        `${route} should not overflow at ${viewport.width}px`,
      ).toBe(false);
    }
  }
  await page.goto(`/factory/products/${productIds[0]}`);
  await expect(page.getByLabel("人民币价格")).toHaveAttribute(
    "inputmode",
    "decimal",
  );
  await expect(page.getByLabel("MOQ")).toHaveAttribute("inputmode", "numeric");
  await expect(page.getByLabel("包装长度")).toHaveAttribute(
    "inputmode",
    "decimal",
  );
  await page.addScriptTag({ content: axeCore.source });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as typeof window & {
        axe: {
          run: (options: { runOnly: string[] }) => Promise<{
            violations: Array<{ id: string; help: string }>;
          }>;
        };
      }
    ).axe;
    return (await axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag22aa"] }))
      .violations;
  });
  expect(violations).toEqual([]);
});
