import { expect, type Page } from "@playwright/test";
import { test } from "../support/diagnostic-test";

import { prisma } from "@/lib/db/prisma";
import { passwords, resetAuthFixtures, usernames } from "../auth/fixtures";

let productId = "";

async function seed() {
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (!database.endsWith("_test")) {
    throw new Error("Browser matrix fixture refused outside a *_test database");
  }
  await prisma.$transaction([
    prisma.importRow.deleteMany(),
    prisma.importJob.deleteMany(),
    prisma.activityLog.deleteMany(),
    prisma.productMainImage.deleteMany(),
    prisma.factoryPrivateImage.deleteMany(),
    prisma.storedObject.deleteMany(),
    prisma.priceHistory.deleteMany(),
    prisma.factoryQuote.deleteMany(),
    prisma.productFactoryAssignment.deleteMany(),
    prisma.product.deleteMany(),
    prisma.category.deleteMany(),
    prisma.material.deleteMany(),
  ]);
  const fixtures = await resetAuthFixtures();
  const category = await prisma.category.create({
    data: {
      name: "Phase 11 浏览器分类",
      nameNormalized: "phase 11 浏览器分类",
    },
  });
  const material = await prisma.material.create({
    data: {
      name: "Phase 11 Browser Material",
      nameNormalized: "phase 11 browser material",
    },
  });
  const product = await prisma.product.create({
    data: {
      sku: `PH11-${"LONG-".repeat(16)}SKU`,
      skuNormalized: `PH11-${"LONG-".repeat(16)}SKU`,
      name: `超长产品名称 Mixed 123 ${"长内容 ".repeat(24)}`,
      notes: "中英文 Mixed 123。".repeat(385),
      categoryId: category.id,
      materialId: material.id,
    },
  });
  productId = product.id;
  const assignment = await prisma.productFactoryAssignment.create({
    data: { productId: product.id, factoryId: fixtures.factoryAId },
  });
  await prisma.factoryQuote.create({
    data: {
      assignmentId: assignment.id,
      priceCents: 12345n,
      moq: 100,
      factoryNotes: "Long quote notes ".repeat(100),
    },
  });
}

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function assertRootDoesNotOverflow(page: Page, route: string) {
  await page.goto(route);
  await expect(page.locator("main")).toBeVisible();
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(
        (element) => element.getBoundingClientRect().right > innerWidth + 1,
      )
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        text: element.textContent?.trim().slice(0, 80),
        right: Math.round(element.getBoundingClientRect().right),
      })),
  }));
  expect(
    layout.scrollWidth,
    `${route} should not overflow the root viewport: ${JSON.stringify(layout.offenders)}`,
  ).toBe(layout.clientWidth);
}

test.beforeAll(seed);

test("Admin core routes survive desktop/mobile engines, long content and 200% zoom", async ({
  page,
  isMobile,
}) => {
  test.setTimeout(120_000);
  await login(page, usernames.admin, passwords.admin);
  for (const route of [
    "/admin",
    "/admin/products",
    `/admin/products/${productId}`,
    "/admin/factories",
    "/admin/quotes",
    "/admin/products/import",
    "/admin/activity",
    "/admin/users",
    "/admin/settings",
  ]) {
    await assertRootDoesNotOverflow(page, route);
  }
  if (!isMobile) {
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    await page.setViewportSize({
      width: Math.floor(viewport!.width / 2),
      height: Math.floor(viewport!.height / 2),
    });
    await assertRootDoesNotOverflow(page, "/admin/products/import");
  }
});

test("Factory core routes remain tenant-scoped across the browser matrix", async ({
  page,
}) => {
  await login(page, usernames.factoryA, passwords.factoryA);
  for (const route of [
    "/factory",
    "/factory/products",
    `/factory/products/${productId}`,
    "/factory/profile",
  ]) {
    await assertRootDoesNotOverflow(page, route);
  }
  await page.goto(`/admin/products/${productId}`);
  await expect(page).toHaveURL(/\/factory/);
});
