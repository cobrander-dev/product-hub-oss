import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import axeCore from "axe-core";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { prisma } from "../../src/lib/db/prisma";
import {
  LocalStorageProvider,
  createImageStorageKey,
} from "../../src/lib/storage/local";
import { runHardDeleteOperation } from "../../src/features/hard-delete/worker";
import {
  createHardDeletePreview,
  confirmHardDelete,
  readHardDeleteOperation,
  confirmHardDeleteForAdmin,
  createHardDeletePreviewForAdmin,
} from "../../src/features/hard-delete/service";
import type { AuthorizedHardDeleteTargetType } from "../../src/features/hard-delete/types";
import {
  entityLabels,
  completedDestination,
} from "../../src/features/hard-delete/presentation";
import {
  resetAuthFixtures,
  usernames,
  passwords,
  newAuthRequest,
  requestHeaders,
} from "../auth/fixtures";
const root = process.env.LOCAL_STORAGE_ROOT!;
const storage = new LocalStorageProvider(root);
let fixtures: Awaited<ReturnType<typeof resetAuthFixtures>>;
async function object() {
  const bytes = await sharp({
    create: { width: 12, height: 12, channels: 3, background: "#246" },
  })
    .webp()
    .toBuffer();
  const storageKey = createImageStorageKey();
  await storage.put(storageKey, bytes);
  return prisma.storedObject.create({
    data: {
      storageKey,
      mimeType: "image/webp",
      sizeBytes: BigInt(bytes.length),
      width: 12,
      height: 12,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      createdByUserId: fixtures.userAId,
    },
  });
}
async function seed() {
  const category = await prisma.category.create({
    data: { name: "待删分类", nameNormalized: "待删分类", status: "DISABLED" },
  });
  const material = await prisma.material.create({
    data: { name: "待删材质", nameNormalized: "待删材质", status: "DISABLED" },
  });
  const product = await prisma.product.create({
    data: {
      name: "永久删除验收产品",
      sku: "PHASE3-TEST",
      status: "DISABLED",
      categoryId: category.id,
      materialId: material.id,
    },
  });
  const assignment = await prisma.productFactoryAssignment.create({
    data: {
      productId: product.id,
      factoryId: fixtures.factoryAId,
    },
  });
  await prisma.productFactoryAssignment.update({
    where: { id: assignment.id },
    data: { status: "REVOKED", revokedAt: new Date(Date.now() + 1000) },
  });
  const quote = await prisma.factoryQuote.create({
    data: {
      assignmentId: assignment.id,
      priceCents: 12345n,
    },
  });
  const history = await prisma.priceHistory.create({
    data: {
      factoryQuoteId: quote.id,
      newPriceCents: 12345n,
      changedByUserId: fixtures.userAId,
    },
  });
  const mainObject = await object();
  const privateObject = await object();
  const main = await prisma.productMainImage.create({
    data: {
      productId: product.id,
      storedObjectId: mainObject.id,
      createdByUserId: fixtures.userAId,
    },
  });
  const privateImage = await prisma.factoryPrivateImage.create({
    data: {
      assignmentId: assignment.id,
      storedObjectId: privateObject.id,
      uploadedByUserId: fixtures.userAId,
    },
  });
  await prisma.factory.update({
    where: { id: fixtures.factoryAId },
    data: { status: "DISABLED" },
  });
  await prisma.user.update({
    where: { id: fixtures.userAId },
    data: { banned: true },
  });
  for (const eventType of [
    "USER_CREATED",
    "USER_ENABLED",
    "USER_DISABLED",
  ] as const)
    await prisma.activityLog.create({
      data: {
        eventType,
        entityType: "USER",
        entityId: fixtures.userAId,
        entityLabelSnapshot: usernames.factoryA,
        actorUserId: fixtures.adminId,
        actorRole: "ADMIN",
        actorUsernameSnapshot: usernames.admin,
        changes: { value: { before: null, after: "fixture" } },
      },
    });
  const retainedAudit = await prisma.activityLog.create({
    data: {
      eventType: "QUOTE_SUBMITTED",
      entityType: "QUOTE",
      entityId: quote.id,
      entityLabelSnapshot: product.name,
      actorUserId: fixtures.userAId,
      actorRole: "FACTORY",
      actorUsernameSnapshot: usernames.factoryA,
      factoryId: fixtures.factoryAId,
      changes: { value: { before: null, after: "fixture" } },
    },
  });
  const job = await prisma.importJob.create({
    data: {
      originalFilename: "stable.csv",
      checksumSha256: "a".repeat(64),
      totalRows: 2,
      createRows: 1,
      updateRows: 1,
      noChangeRows: 0,
      errorRows: 0,
      createdByUserId: fixtures.userAId,
    },
  });
  const stableRow = await prisma.importRow.create({
    data: {
      jobId: job.id,
      rowNumber: 2,
      action: "CREATE",
      resolvedProductId: product.id,
      normalizedData: { sku: product.sku },
      errors: [],
    },
  });
  const legacyRow = await prisma.importRow.create({
    data: {
      jobId: job.id,
      rowNumber: 3,
      action: "CREATE",
      normalizedData: { sku: product.sku, name: product.name },
      errors: [],
    },
  });
  return {
    category,
    material,
    product,
    assignment,
    quote,
    history,
    mainObject,
    privateObject,
    main,
    privateImage,
    job,
    stableRow,
    legacyRow,
    retainedAudit,
  };
}
async function login(
  page: Page,
  username: string = usernames.admin,
  password: string = passwords.admin,
) {
  const response = await page.request.post("/api/auth/sign-in/username", {
    headers: { origin: "http://127.0.0.1:3100" },
    data: { username, password },
  });
  expect(response.ok()).toBeTruthy();
}
test.beforeEach(async () => {
  if (
    !new URL(process.env.DATABASE_URL!).pathname.endsWith("_test") ||
    !root.includes("tmp")
  )
    throw new Error("Disposable scope required");
  fixtures = await resetAuthFixtures();
  // The root belongs exclusively to this harness, not a real uploads directory.
  for (const entry of await readdir(root))
    await rm(root + "/" + entry, { recursive: true, force: true });
});
async function preview(page: Page, type: AuthorizedHardDeleteTargetType) {
  const scope =
    type === "CATEGORY" || type === "MATERIAL"
      ? page
          .getByLabel((type === "CATEGORY" ? "待删分类" : "待删材质") + "名称")
          .locator("..")
          .locator("..")
      : type === "USER"
        ? page
            .getByRole("row")
            .filter({ hasText: usernames.factoryA })
            .filter({ visible: true })
        : page;
  await scope
    .getByRole("button", { name: "永久删除" + entityLabels[type], exact: true })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}
async function confirmUI(page: Page, type: AuthorizedHardDeleteTargetType) {
  const dialog = await preview(page, type);
  const phrase = await dialog.getByTestId("confirmation-phrase").textContent();
  await expect(
    dialog.getByRole("button", { name: "确认永久删除", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("确认短语", { exact: true }).fill(phrase! + " ");
  await expect(
    dialog.getByRole("button", { name: "确认永久删除", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("确认短语", { exact: true }).fill(phrase!);
  await dialog
    .getByRole("button", { name: "确认永久删除", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/hard-delete\/[a-f0-9-]+/);
  return page.url().split("/").at(-1)!;
}
async function worker(id: string, injected = storage) {
  return runHardDeleteOperation({
    operationId: id,
    workerDatabaseUrl: process.env.HARD_DELETE_WORKER_DATABASE_URL!,
    workerId: "phase3-e2e-worker",
    storage: injected,
    leaseSeconds: 1,
    retryDelaySeconds: 1,
  });
}
for (const type of [
  "PRODUCT",
  "FACTORY",
  "USER",
  "CATEGORY",
  "MATERIAL",
  "ASSIGNMENT",
  "QUOTE",
  "PRODUCT_MAIN_IMAGE",
  "FACTORY_PRIVATE_IMAGE",
] as const) {
  test(
    type + " UI → restricted worker → final verification → navigation",
    async ({ page }) => {
      const data = await seed();
      if (type === "CATEGORY" || type === "MATERIAL") {
        const category = await prisma.category.create({
          data: { name: "保留分类", nameNormalized: "保留分类" },
        });
        const material = await prisma.material.create({
          data: { name: "保留材质", nameNormalized: "保留材质" },
        });
        await prisma.product.update({
          where: { id: data.product.id },
          data: { categoryId: category.id, materialId: material.id },
        });
      }
      await login(page);
      const route =
        type === "FACTORY"
          ? "/admin/factories/" + fixtures.factoryAId
          : type === "USER"
            ? "/admin/users"
            : ["CATEGORY", "MATERIAL"].includes(type)
              ? "/admin/settings"
              : type === "QUOTE"
                ? "/admin/quotes/records/" + data.quote.id
                : ["ASSIGNMENT", "FACTORY_PRIVATE_IMAGE"].includes(type)
                  ? "/admin/quotes/" + data.assignment.id
                  : "/admin/products/" + data.product.id;
      await page.goto(route);
      const id = await confirmUI(page, type);
      await expect(page.getByRole("status")).toContainText("已确认");
      const status = await page.request.get("/api/admin/hard-delete/" + id);
      const wire = await status.text();
      for (const forbidden of [
        data.mainObject.storageKey,
        data.privateObject.storageKey,
        root,
        "leaseToken",
        "previewSha256",
        process.env.HARD_DELETE_WORKER_DB_PASSWORD!,
      ])
        expect(wire).not.toContain(forbidden);
      if (type === "PRODUCT") {
        const cli = spawnSync(
          process.execPath,
          [
            "./node_modules/tsx/dist/cli.mjs",
            "scripts/run-hard-delete-worker.ts",
            id,
          ],
          {
            encoding: "utf8",
            env: {
              NODE_ENV: "production",
              PATH: process.env.PATH,
              HARD_DELETE_WORKER_DATABASE_URL:
                process.env.HARD_DELETE_WORKER_DATABASE_URL,
              LOCAL_STORAGE_ROOT: root,
            },
          },
        );
        expect(cli.status, cli.stderr).toBe(0);
        expect(JSON.parse(cli.stdout.trim().split("\n").at(-1)!).status).toBe(
          "COMPLETED",
        );
      } else expect((await worker(id)).status).toBe("COMPLETED");
      await expect(page).toHaveURL(
        new RegExp(
          completedDestination(type).replaceAll("/", "\\/") +
            "\\?hardDeleted=" +
            id,
        ),
        { timeout: 15000 },
      );
      await expect(page.getByRole("status")).toContainText(
        entityLabels[type] + "已永久删除",
      );
      await page.reload();
      if (
        type === "PRODUCT" ||
        type === "FACTORY" ||
        type === "ASSIGNMENT" ||
        type === "QUOTE"
      ) {
        const response = await page.goto(route);
        expect(response!.status()).not.toBe(500);
        await expect(
          page.getByRole("heading", { name: "记录不存在" }),
        ).toBeVisible();
      }
      if (type === "PRODUCT") {
        expect(
          await prisma.product.findUnique({ where: { id: data.product.id } }),
        ).toBeNull();
        expect(await storage.stat(data.mainObject.storageKey)).toBeNull();
        expect(await storage.stat(data.privateObject.storageKey)).toBeNull();
        const row = await prisma.importRow.findUniqueOrThrow({
          where: { id: data.stableRow.id },
        });
        expect(row.resolvedProductId).toBeNull();
        expect(
          await prisma.importRow.findUnique({
            where: { id: data.legacyRow.id },
          }),
        ).not.toBeNull();
      }
      if (type === "FACTORY") {
        expect(
          await prisma.factory.findUnique({
            where: { id: fixtures.factoryAId },
          }),
        ).toBeNull();
        expect(
          await prisma.product.findUnique({ where: { id: data.product.id } }),
        ).not.toBeNull();
        expect(await storage.stat(data.mainObject.storageKey)).not.toBeNull();
      }
      if (type === "USER") {
        expect(
          await prisma.user.findUnique({ where: { id: fixtures.userAId } }),
        ).toBeNull();
        expect(
          await prisma.account.count({ where: { userId: fixtures.userAId } }),
        ).toBe(0);
        expect(
          await prisma.session.count({ where: { userId: fixtures.userAId } }),
        ).toBe(0);
        expect(
          await prisma.activityLog.count({
            where: {
              entityId: fixtures.userAId,
              eventType: {
                in: ["USER_CREATED", "USER_ENABLED", "USER_DISABLED"],
              },
            },
          }),
        ).toBe(0);
        expect(
          (
            await prisma.priceHistory.findUniqueOrThrow({
              where: { id: data.history.id },
            })
          ).changedByUserId,
        ).toBeNull();
        expect(
          (
            await prisma.activityLog.findUniqueOrThrow({
              where: { id: data.retainedAudit.id },
            })
          ).actorUserId,
        ).toBeNull();
        await page.goto("/admin/quotes/" + data.assignment.id);
        await expect(page.getByText("已永久删除用户").first()).toBeVisible();
      }
      if (type === "QUOTE") {
        expect(
          await prisma.factoryQuote.findUnique({
            where: { id: data.quote.id },
          }),
        ).toBeNull();
        expect(
          await prisma.priceHistory.findUnique({
            where: { id: data.history.id },
          }),
        ).toBeNull();
        expect(
          await prisma.productFactoryAssignment.findUnique({
            where: { id: data.assignment.id },
          }),
        ).not.toBeNull();
      }
      if (type === "PRODUCT_MAIN_IMAGE")
        expect(await storage.stat(data.mainObject.storageKey)).toBeNull();
      if (type === "FACTORY_PRIVATE_IMAGE")
        expect(await storage.stat(data.privateObject.storageKey)).toBeNull();
    },
  );
}
test("blocked dictionaries, active assignment/quote, enabled product/factory/user and Admin deny", async ({
  page,
}) => {
  const data = await seed();
  await login(page);
  for (const type of ["CATEGORY", "MATERIAL"] as const) {
    await page.goto("/admin/settings");
    const dialog = await preview(page, type);
    await expect(dialog.getByText("仍有 1 个产品使用。")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "确认永久删除" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
  }
  await prisma.productFactoryAssignment.update({
    where: { id: data.assignment.id },
    data: { status: "ACTIVE", revokedAt: null },
  });
  await page.goto("/admin/quotes/" + data.assignment.id);
  for (const type of ["ASSIGNMENT", "QUOTE"] as const) {
    const dialog = await preview(page, type);
    await expect(dialog.getByText(/请先撤销分配/)).toBeVisible();
    await page.keyboard.press("Escape");
  }
  const actor = {
    userId: fixtures.adminId,
    username: usernames.admin,
    role: "ADMIN" as const,
    factoryId: null,
  };
  for (const id of [fixtures.adminId, fixtures.userBId]) {
    const result = await createHardDeletePreviewForAdmin(
      actor,
      { targetType: "USER", targetId: id },
      { storage },
    );
    expect(result.status).toBe("BLOCKED");
  }
  await prisma.product.update({
    where: { id: data.product.id },
    data: { status: "ENABLED" },
  });
  await prisma.factory.update({
    where: { id: fixtures.factoryAId },
    data: { status: "ACTIVE" },
  });
  for (const [type, id] of [
    ["PRODUCT", data.product.id],
    ["FACTORY", fixtures.factoryAId],
  ] as const)
    expect(
      (
        await createHardDeletePreviewForAdmin(
          actor,
          { targetType: type, targetId: id },
          { storage },
        )
      ).status,
    ).toBe("BLOCKED");
});
test("stale preview requires explicit refresh, server phrase rejection and duplicate confirmation", async ({
  page,
}) => {
  const data = await seed();
  await login(page);
  await page.goto("/admin/products/" + data.product.id);
  const dialog = await preview(page, "PRODUCT");
  await expect(dialog.getByTestId("confirmation-phrase")).toBeVisible();
  await page.addScriptTag({ content: axeCore.source });
  const accessibility = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: typeof axeCore }).axe;
    return (
      await axe.run(document.querySelector('[role="dialog"]')!, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
      })
    ).violations.map((item) => ({ id: item.id, impact: item.impact }));
  });
  expect(accessibility).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const original = await dialog
    .getByTestId("confirmation-phrase")
    .textContent();
  const old = await prisma.hardDeleteOperation.findFirstOrThrow();
  const actor = {
    userId: fixtures.adminId,
    username: usernames.admin,
    role: "ADMIN" as const,
    factoryId: null,
  };
  await expect(
    confirmHardDeleteForAdmin(
      actor,
      {
        operationId: old.id,
        previewSha256: old.previewSha256,
        expectedVersion: old.version,
        confirmationPhrase: "DELETE wrong",
      },
      { storage },
    ),
  ).rejects.toMatchObject({ kind: "VALIDATION" });
  await prisma.product.update({
    where: { id: data.product.id },
    data: { notes: "preview changed" },
  });
  await dialog.getByLabel("确认短语", { exact: true }).fill(original!);
  await dialog.getByRole("button", { name: "确认永久删除" }).click();
  await expect(
    dialog.getByText("数据在确认期间发生了变化，请重新检查删除影响。"),
  ).toBeVisible();
  expect(
    (
      await prisma.hardDeleteOperation.findUniqueOrThrow({
        where: { id: old.id },
      })
    ).status,
  ).toBe("PREVIEWED");
  await dialog.getByRole("button", { name: "重新检查删除影响" }).click();
  await expect(dialog.getByTestId("confirmation-phrase")).toBeVisible();
  await expect(dialog.getByLabel("确认短语", { exact: true })).toHaveValue("");
  await dialog.getByLabel("确认短语", { exact: true }).fill(original!);
  await dialog
    .getByRole("button", { name: "确认永久删除" })
    .dblclick({ delay: 10 });
  await expect(page).toHaveURL(/hard-delete/);
  expect(await prisma.hardDeleteOperation.count()).toBe(1);
  const current = await prisma.hardDeleteOperation.findUniqueOrThrow({
    where: { id: old.id },
  });
  await expect(
    confirmHardDeleteForAdmin(
      actor,
      {
        operationId: old.id,
        previewSha256: current.previewSha256,
        expectedVersion: current.version,
        confirmationPhrase: original,
      },
      { storage },
    ),
  ).rejects.toMatchObject({ kind: "CONFLICT" });
  const duplicate = await createHardDeletePreviewForAdmin(
    actor,
    { targetType: "PRODUCT", targetId: data.product.id },
    { storage },
  );
  expect(duplicate).toMatchObject({ status: "ACTIVE", operationId: old.id });
  expect((await worker(old.id)).status).toBe("COMPLETED");
});
test("shared storage relation removed while actual file survives", async ({
  page,
}) => {
  const data = await seed();
  await prisma.factoryPrivateImage.update({
    where: { id: data.privateImage.id },
    data: { storedObjectId: data.mainObject.id },
  });
  await storage.delete(data.privateObject.storageKey);
  await prisma.storedObject.delete({ where: { id: data.privateObject.id } });
  await login(page);
  await page.goto("/admin/products/" + data.product.id);
  const dialog = await preview(page, "PRODUCT_MAIN_IMAGE");
  await expect(dialog.getByText("服务器专属物理文件：0")).toBeVisible();
  await dialog
    .getByLabel("确认短语", { exact: true })
    .fill((await dialog.getByTestId("confirmation-phrase").textContent())!);
  await dialog.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page).toHaveURL(/hard-delete/);
  expect((await worker(page.url().split("/").at(-1)!)).status).toBe(
    "COMPLETED",
  );
  expect(
    await prisma.productMainImage.findUnique({ where: { id: data.main.id } }),
  ).toBeNull();
  expect(
    await prisma.storedObject.findUnique({ where: { id: data.mainObject.id } }),
  ).not.toBeNull();
  expect(await storage.stat(data.mainObject.storageKey)).not.toBeNull();
  expect(
    await prisma.factoryPrivateImage.findUnique({
      where: { id: data.privateImage.id },
    }),
  ).not.toBeNull();
});
test("physical delete retry shows no premature success, 390px mobile and keyboard dialog", async ({
  page,
}) => {
  const data = await seed();
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/admin/products/" + data.product.id);
  const dialog = await preview(page, "PRODUCT");
  await expect(dialog.getByTestId("confirmation-phrase")).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
  ).toBe(true);
  for (let i = 0; i < 10; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "永久删除产品", exact: true }),
  ).toBeFocused();
  const id = await confirmUI(page, "PRODUCT");
  const failing = new Proxy(storage, {
    get(target, property) {
      if (property === "delete")
        return async () => {
          throw new Error("fault: hidden private path");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect((await worker(id, failing)).status).toBe("FILES_PENDING");
  await expect(page.getByText(/文件清理失败，系统将自动重试/)).toBeVisible({
    timeout: 10000,
  });
  expect(
    await prisma.product.findUnique({ where: { id: data.product.id } }),
  ).toBeNull();
  await expect(page).toHaveURL(/hard-delete/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect((await worker(id)).status).toBe("COMPLETED");
  await expect(page).toHaveURL(/hardDeleted=/);
});
test("Factory and anonymous deny all boundaries, safe DTO and real runtime grants", async ({
  page,
}) => {
  const data = await seed();
  const actor = {
    userId: fixtures.adminId,
    username: usernames.admin,
    role: "ADMIN" as const,
    factoryId: null,
  };
  const result = await createHardDeletePreviewForAdmin(
    actor,
    { targetType: "PRODUCT", targetId: data.product.id },
    { storage },
  );
  if (result.status !== "PREVIEWED") throw new Error("preview required");
  const factory = await newAuthRequest(usernames.factoryB, passwords.factoryB);
  const headers = await requestHeaders(factory.context);
  const confirm = {
    operationId: result.operationId,
    previewSha256: result.previewSha256,
    expectedVersion: result.version,
    confirmationPhrase: result.confirmationPhrase,
  };
  for (const h of [headers, new Headers()]) {
    for (const action of [
      () =>
        createHardDeletePreview(
          h,
          { targetType: "PRODUCT", targetId: data.product.id },
          { storage },
        ),
      () => confirmHardDelete(h, confirm, { storage }),
      () => readHardDeleteOperation(h, result.operationId, { storage }),
    ])
      await expect(action()).rejects.toMatchObject({
        kind: h === headers ? "FORBIDDEN" : "UNAUTHENTICATED",
      });
  }
  expect(
    (
      await factory.context.get("/api/admin/hard-delete/" + result.operationId)
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.get("/api/admin/hard-delete/" + result.operationId)
    ).status(),
  ).toBe(401);
  await login(page, usernames.factoryB, passwords.factoryB);
  await page.goto("/factory");
  await expect(page.getByText("危险操作", { exact: false })).toHaveCount(0);
  const runtime = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.APP_RUNTIME_DATABASE_URL!,
    }),
  });
  const runtimePreview = await createHardDeletePreviewForAdmin(
    actor,
    { targetType: "PRODUCT", targetId: data.product.id },
    { database: runtime as typeof prisma, storage },
  );
  if (runtimePreview.status !== "PREVIEWED")
    throw new Error("runtime preview required");
  const concurrentConfirmation = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      confirmHardDeleteForAdmin(
        actor,
        {
          operationId: runtimePreview.operationId,
          previewSha256: runtimePreview.previewSha256,
          expectedVersion: runtimePreview.version,
          confirmationPhrase: runtimePreview.confirmationPhrase,
        },
        { database: runtime as typeof prisma, storage },
      ),
    ),
  );
  expect(
    concurrentConfirmation.filter((item) => item.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    concurrentConfirmation.filter((item) => item.status === "rejected"),
  ).toHaveLength(1);
  expect(
    concurrentConfirmation.find((item) => item.status === "rejected"),
  ).toMatchObject({ reason: { kind: "CONFLICT" } });
  await expect(runtime.activityLog.deleteMany()).rejects.toThrow();
  await expect(runtime.priceHistory.deleteMany()).rejects.toThrow();
  await runtime.$disconnect();
  const client = new Client({
    connectionString: process.env.HARD_DELETE_WORKER_DATABASE_URL,
  });
  await client.connect();
  await expect(client.query('SELECT * FROM public."User"')).rejects.toThrow();
  await expect(
    client.query(
      "SELECT public.refresh_hard_delete_preview('PRODUCT','x','x','{}'::jsonb,'x')",
    ),
  ).rejects.toThrow();
  await client.end();
  await factory.context.dispose();
});
