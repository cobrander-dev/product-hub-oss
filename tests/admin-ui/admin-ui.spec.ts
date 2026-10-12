import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { expect } from "@playwright/test";
import axeCore from "axe-core";
import sharp from "sharp";

import { prisma } from "../../src/lib/db/prisma";
import {
  passwords,
  resetAuthFixtures,
  resetTestRateLimits,
  usernames,
} from "../auth/fixtures";
import { test } from "../support/diagnostic-test";

let productIds: string[] = [];
let factoryCId = "";
let firstAssignmentId = "";

async function seedAdminWorkspace() {
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
  const authFixtures = await resetAuthFixtures();
  const categories = await Promise.all(
    ["龙头", "花洒系统", "卫浴配件"].map((name) =>
      prisma.category.create({
        data: { name, nameNormalized: name.toLocaleLowerCase("en-US") },
      }),
    ),
  );
  const materials = await Promise.all(
    ["黄铜", "不锈钢", "锌合金", "ABS 工程塑料"].map((name) =>
      prisma.material.create({
        data: { name, nameNormalized: name.toLocaleLowerCase("en-US") },
      }),
    ),
  );
  factoryCId = (
    await prisma.factory.create({
      data: {
        name: "Factory C Test",
        nameNormalized: "factory c test",
        contactName: "测试联系人 C",
        phone: "+86 138 0000 0003",
      },
    })
  ).id;
  await prisma.factory.update({
    where: { id: authFixtures.factoryAId },
    data: { contactName: "测试联系人 A", phone: "+86 138 0000 0001" },
  });
  const products: Array<{ id: string }> = [];
  for (let index = 0; index < 12; index += 1) {
    products.push(
      await prisma.product.create({
        data: {
          sku:
            index === 10
              ? null
              : index === 11
                ? "TEST-LONG-SKU-2026-ADMIN-OPERATIONAL-UI-RESPONSIVE-CHECK"
                : `TEST-${String(index + 1).padStart(3, "0")}`,
          skuNormalized:
            index === 10
              ? null
              : index === 11
                ? "TEST-LONG-SKU-2026-ADMIN-OPERATIONAL-UI-RESPONSIVE-CHECK"
                : `TEST-${String(index + 1).padStart(3, "0")}`,
          name:
            index === 11
              ? "测试超长产品名称用于验证中文内容在窄屏卡片中的安全换行与截断行为"
              : `测试产品 ${index + 1}`,
          categoryId: categories[index % categories.length].id,
          materialId: materials[index % materials.length].id,
          status: index === 9 ? "DISABLED" : "ENABLED",
          notes:
            index === 0
              ? "这是管理员内部测试备注。"
              : index === 5
                ? "长备注测试。".repeat(625)
                : null,
        },
      }),
    );
  }
  productIds = products.map((item) => item.id);
  const assignments = await Promise.all(
    [authFixtures.factoryAId, authFixtures.factoryBId, factoryCId].map(
      (factoryId) =>
        prisma.productFactoryAssignment.create({
          data: { productId: products[0].id, factoryId },
        }),
    ),
  );
  firstAssignmentId = assignments[0].id;
  const prices = [32800n, 31500n, 34500n];
  for (let index = 0; index < assignments.length; index += 1) {
    const quote = await prisma.factoryQuote.create({
      data: {
        assignmentId: assignments[index].id,
        priceCents: prices[index],
        moq: 100 + index * 50,
        packingLengthCm: "42.5",
        packingWidthCm: "31",
        packingHeightCm: index === 2 ? null : "18.5",
        netWeightKg: "6.8",
        grossWeightKg: "7.4",
        pcsPerCarton: 2,
        factoryNotes: `测试厂家报价备注 ${index + 1}`,
      },
    });
    await prisma.priceHistory.create({
      data: {
        factoryQuoteId: quote.id,
        oldPriceCents: null,
        newPriceCents: prices[index],
        changedByUserId: authFixtures.adminId,
      },
    });
  }
  await prisma.productFactoryAssignment.create({
    data: { productId: products[1].id, factoryId: authFixtures.factoryAId },
  });
  await prisma.productFactoryAssignment.create({
    data: { productId: products[2].id, factoryId: authFixtures.factoryBId },
  });

  const storageRoot = path.resolve(process.cwd(), "data/test-uploads");
  await rm(storageRoot, { recursive: true, force: true });
  await mkdir(path.join(storageRoot, "objects"), { recursive: true });
  const imageSpecs = [
    {
      width: 1200,
      height: 900,
      background: { r: 225, g: 232, b: 229, alpha: 1 },
    },
    {
      width: 700,
      height: 1200,
      background: { r: 232, g: 225, b: 218, alpha: 1 },
    },
    { width: 900, height: 900, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  ];
  for (let index = 0; index < imageSpecs.length; index += 1) {
    const spec = imageSpecs[index];
    const bytes = await sharp({ create: { ...spec, channels: 4 } })
      .webp()
      .toBuffer();
    const key = `objects/${randomUUID()}.webp`;
    await writeFile(path.join(storageRoot, key), bytes);
    const object = await prisma.storedObject.create({
      data: {
        storageKey: key,
        mimeType: "image/webp",
        sizeBytes: bytes.length,
        width: spec.width,
        height: spec.height,
        checksumSha256: randomUUID().replaceAll("-", "").repeat(2),
        createdByUserId: authFixtures.adminId,
      },
    });
    await prisma.productMainImage.create({
      data: {
        productId: products[index].id,
        storedObjectId: object.id,
        createdByUserId: authFixtures.adminId,
      },
    });
  }
  const privateBytes = await sharp({
    create: {
      width: 1000,
      height: 750,
      channels: 4,
      background: { r: 210, g: 224, b: 231, alpha: 1 },
    },
  })
    .webp()
    .toBuffer();
  const privateKey = `objects/${randomUUID()}.webp`;
  await writeFile(path.join(storageRoot, privateKey), privateBytes);
  const privateObject = await prisma.storedObject.create({
    data: {
      storageKey: privateKey,
      mimeType: "image/webp",
      sizeBytes: privateBytes.length,
      width: 1000,
      height: 750,
      checksumSha256: randomUUID().replaceAll("-", "").repeat(2),
      createdByUserId: authFixtures.adminId,
    },
  });
  await prisma.factoryPrivateImage.create({
    data: {
      assignmentId: firstAssignmentId,
      storedObjectId: privateObject.id,
      uploadedByUserId: authFixtures.userAId,
    },
  });
}

async function login(
  page: import("@playwright/test").Page,
  username: string = usernames.admin,
  password: string = passwords.admin,
) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  const signInResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/sign-in/username") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "登录" }).click();
  expect((await signInResponse).status()).toBe(200);
  await expect(page).toHaveURL(
    username === usernames.admin ? /\/admin$/ : /\/factory$/,
    { timeout: 15_000 },
  );
}

test.beforeAll(async () => {
  await seedAdminWorkspace();
});

test.beforeEach(async () => {
  await resetTestRateLimits();
});

test("Admin dashboard, products, factories and quotes use real data", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop navigation flow runs once");
  await login(page);
  await expect(page.getByRole("heading", { name: "工作台概览" })).toBeVisible();
  await expect(page.getByText("12", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "产品", exact: true }).click();
  await expect(page.getByText("共 12 个产品")).toBeVisible();
  await page.getByRole("link", { name: "画廊视图" }).click();
  await expect(page).toHaveURL(/view=gallery/);
  await page.getByPlaceholder("搜索 SKU 或产品名称").fill("TEST-001");
  await page.getByRole("button", { name: "筛选" }).click();
  await expect(page.getByText("测试产品 1").first()).toBeVisible();
  await page.getByText("测试产品 1").first().click();
  await expect(page.getByText("¥315.00")).toBeVisible();
  await expect(page.getByText("¥328.00")).toBeVisible();
  await expect(page.getByText("¥345.00")).toBeVisible();
  await page.getByRole("link", { name: "厂家", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Factory C Test" }).first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "报价", exact: true }).click();
  await expect(page.getByRole("heading", { name: "报价工作区" })).toBeVisible();
  await expect(page.getByText("待报价").first()).toBeVisible();
});

test("Admin dashboard, products, factories and quotes use real data — quote detail", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop navigation flow runs once");
  await login(page);
  await page.goto(`/admin/quotes/${firstAssignmentId}`);
  await expect(page).toHaveURL(`/admin/quotes/${firstAssignmentId}`);
  await expect(page.getByRole("heading", { name: "价格历史" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "厂家私图", exact: true }),
  ).toBeVisible();
});

test("Admin can create and edit a product through existing actions", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "mutation flow runs once");
  await login(page);
  await page.goto("/admin/products/new");
  await page.getByLabel("产品名称").fill("测试新增产品");
  await page.getByLabel("SKU").fill("TEST-NEW-001");
  await page.getByRole("button", { name: "创建产品" }).click();
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: "测试新增产品" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "编辑资料" }).click();
  await page.getByLabel("产品名称").fill("测试新增产品已编辑");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(
    page.getByRole("heading", { name: "测试新增产品已编辑" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "停用" }).click();
  await expect(page.getByRole("button", { name: "启用" })).toBeVisible();
  await page.getByRole("button", { name: "启用" }).click();
  await expect(page.getByRole("button", { name: "停用" })).toBeVisible();
});

test("Admin can manage image, assignment, factory and dictionaries", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop mutation coverage runs once");
  await login(page);
  await page.goto(`/admin/products/${productIds[3]}`);
  await page.getByLabel("选择厂家").selectOption(factoryCId);
  await page.getByRole("button", { name: "添加分配" }).click();
  await expect(
    page.getByRole("link", { name: "Factory C Test" }).first(),
  ).toBeVisible();

  await page.goto(`/admin/products/${productIds[0]}`);
  await expect(page.getByText("厂家私图").first()).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "撤销分配" }).first().click();
  await expect(
    page.getByRole("button", { name: "重新激活" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新激活" }).first().click();
  await expect(
    page.getByRole("button", { name: "撤销分配" }).first(),
  ).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  const promotionResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/main/promote") && response.status() === 200,
  );
  await page.getByRole("button", { name: "设为主图" }).click();
  await promotionResponse;

  const upload = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 4,
      background: { r: 235, g: 226, b: 214, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  await page.locator('input[type="file"]').setInputFiles({
    name: "admin-ui-test.png",
    mimeType: "image/png",
    buffer: upload,
  });
  await page.getByRole("button", { name: "替换主图" }).click();
  await expect(page.getByText("主图已替换。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "永久删除产品主图", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "移除主图", exact: true }),
  ).toHaveCount(0); // Phase 3 full deletion is covered by restricted-worker E2E.
});

test("Admin can manage image, assignment, factory and dictionaries — factory", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop mutation coverage runs once");
  await login(page);
  await page.goto("/admin/factories/new");
  await page.getByLabel("厂家名称").fill("Admin UI 新建厂家");
  await page.getByLabel("联系人").fill("测试联系人");
  await page.getByRole("button", { name: "创建厂家" }).click();
  await expect(
    page.getByRole("heading", { name: "Admin UI 新建厂家" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "编辑资料" }).click();
  await page.getByLabel("联系电话").fill("+86 138 0000 0099");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("+86 138 0000 0099").first()).toBeVisible();
  await page.getByRole("button", { name: "停用" }).click();
  await expect(page.getByRole("button", { name: "启用" })).toBeVisible();
  await page.getByRole("button", { name: "启用" }).click();
  await expect(page.getByRole("button", { name: "停用" })).toBeVisible();
});

test("Admin can manage image, assignment, factory and dictionaries — dictionaries", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop mutation coverage runs once");
  await login(page);
  await page.goto("/admin/settings");
  await expect(page).toHaveURL("/admin/settings");
  await page.getByLabel("新建分类").fill("Admin UI 新分类");
  await page.getByRole("button", { name: "新增" }).first().click();
  await expect(page.locator('input[value="Admin UI 新分类"]')).toBeVisible();
  await page.getByLabel("新建材质").fill("Admin UI 新材质");
  await page.getByRole("button", { name: "新增" }).nth(1).click();
  await expect(page.locator('input[value="Admin UI 新材质"]')).toBeVisible();
});

test("Mobile workspace reflows without horizontal overflow and passes axe", async ({
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
      "/admin",
      "/admin/products",
      `/admin/products/${productIds[0]}`,
      `/admin/factories/${factoryCId}`,
      "/admin/quotes",
      `/admin/quotes/${firstAssignmentId}`,
      "/admin/settings",
    ]) {
      await page.goto(route);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      expect(
        overflow,
        `${route} should not overflow at ${viewport.width}px`,
      ).toBe(false);
    }
  }
  await page.goto("/admin/products");
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

test("Factory session cannot enter Admin workspace", async ({ page }) => {
  await login(page, usernames.factoryA, passwords.factoryA);
  await page.goto("/admin/products");
  await expect(page).toHaveURL(/\/factory$/);
});
