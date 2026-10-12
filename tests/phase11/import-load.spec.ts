import { expect, request, test } from "@playwright/test";

import { createCategory } from "@/features/categories/service";
import { listActivityLogs } from "@/features/activity/service";
import { listAssignedProducts } from "@/features/assignments/service";
import {
  confirmProductImport,
  previewProductImport,
} from "@/features/imports/service";
import { IMPORT_HEADERS } from "@/features/imports/validation";
import { createMaterial } from "@/features/materials/service";
import { listProducts } from "@/features/products/service";
import { listAdminQuotes } from "@/features/quotes/service";
import { prisma } from "@/lib/db/prisma";
import { passwords, resetAuthFixtures, usernames } from "../auth/fixtures";

async function resetImportLoadFixtures() {
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (!database.endsWith("_test")) {
    throw new Error("Import load fixture refused outside a *_test database");
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
  return resetAuthFixtures();
}

async function timings(operation: () => Promise<unknown>) {
  const samples: number[] = [];
  for (let index = 0; index < 12; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    p50: Math.round(samples[Math.floor(samples.length * 0.5)]!),
    p95: Math.round(samples[Math.floor(samples.length * 0.95)]!),
  };
}

test("previews and confirms the 5,000-row import ceiling atomically", async () => {
  test.setTimeout(240_000);
  const fixtures = await resetImportLoadFixtures();

  const context = await request.newContext({
    baseURL: "http://127.0.0.1:3100",
    extraHTTPHeaders: { origin: "http://127.0.0.1:3100" },
  });
  const login = await context.post("/api/auth/sign-in/username", {
    data: { username: usernames.admin, password: passwords.admin },
  });
  expect(login.ok()).toBeTruthy();
  const state = await context.storageState();
  const headers = new Headers({
    cookie: state.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; "),
    origin: "http://127.0.0.1:3100",
  });

  try {
    const category = await createCategory(headers, { name: "Phase 11 load" });
    const material = await createMaterial(headers, { name: "Load material" });
    const rows = Array.from({ length: 5_000 }, (_, index) => [
      "",
      `PH11-${String(index + 1).padStart(5, "0")}`,
      `Phase 11 Product ${index + 1}`,
      category.name,
      material.name,
      "启用",
      "load verification",
    ]);
    const bytes = Buffer.from(
      `\uFEFF${[IMPORT_HEADERS as unknown as string[], ...rows]
        .map((row) => row.join(","))
        .join("\r\n")}\r\n`,
    );
    const rssBefore = process.memoryUsage().rss;
    const previewStarted = performance.now();
    const job = await previewProductImport(headers, {
      bytes,
      filename: "phase11-5000.csv",
    });
    const previewMs = Math.round(performance.now() - previewStarted);
    expect(job.counts).toEqual({
      totalRows: 5_000,
      createRows: 5_000,
      updateRows: 0,
      noChangeRows: 0,
      errorRows: 0,
    });
    expect(await prisma.product.count()).toBe(0);

    const confirmStarted = performance.now();
    await confirmProductImport(headers, job.id);
    const confirmMs = Math.round(performance.now() - confirmStarted);
    const rssDeltaMiB = Math.round(
      (process.memoryUsage().rss - rssBefore) / 1024 / 1024,
    );

    expect(await prisma.product.count()).toBe(5_000);
    expect(
      await prisma.activityLog.count({
        where: { eventType: "PRODUCT_CREATED" },
      }),
    ).toBe(5_000);
    console.log(
      `PHASE11_IMPORT_LOAD preview_ms=${previewMs} confirm_ms=${confirmMs} rss_delta_mib=${rssDeltaMiB}`,
    );

    const products = await prisma.product.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
      take: 1_000,
    });
    await prisma.productFactoryAssignment.createMany({
      data: products.map((product) => ({
        productId: product.id,
        factoryId: fixtures.factoryAId,
      })),
    });
    const assignments = await prisma.productFactoryAssignment.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
      take: 500,
    });
    await prisma.factoryQuote.createMany({
      data: assignments.map((assignment, index) => ({
        assignmentId: assignment.id,
        priceCents: BigInt(10_000 + index),
        moq: 100,
      })),
    });
    const quotes = await prisma.factoryQuote.findMany({
      select: { id: true, priceCents: true },
    });
    await prisma.priceHistory.createMany({
      data: quotes.map((quote) => ({
        factoryQuoteId: quote.id,
        oldPriceCents: null,
        newPriceCents: quote.priceCents,
        changedByUserId: fixtures.userAId,
      })),
    });

    const factoryContext = await request.newContext({
      baseURL: "http://127.0.0.1:3100",
      extraHTTPHeaders: { origin: "http://127.0.0.1:3100" },
    });
    const factoryLogin = await factoryContext.post(
      "/api/auth/sign-in/username",
      {
        data: {
          username: usernames.factoryA,
          password: passwords.factoryA,
        },
      },
    );
    expect(factoryLogin.ok()).toBeTruthy();
    const factoryState = await factoryContext.storageState();
    const factoryHeaders = new Headers({
      cookie: factoryState.cookies
        .map((item) => `${item.name}=${item.value}`)
        .join("; "),
      origin: "http://127.0.0.1:3100",
    });
    try {
      const [adminProducts, factoryProducts, adminQuotes, activity] =
        await Promise.all([
          timings(() =>
            listProducts(headers, { page: 1, pageSize: 50, search: "Phase" }),
          ),
          timings(() =>
            listAssignedProducts(factoryHeaders, {
              page: 1,
              pageSize: 50,
              search: "Phase",
            }),
          ),
          timings(() =>
            listAdminQuotes(headers, { page: 1, pageSize: 50, search: "" }),
          ),
          timings(() => listActivityLogs(headers, { page: 1, pageSize: 50 })),
        ]);
      console.log(
        `PHASE11_LIST_LOAD products=5000 assignments=1000 quotes=500 history=500 activity=5002 admin_products_p50_ms=${adminProducts.p50} admin_products_p95_ms=${adminProducts.p95} factory_products_p50_ms=${factoryProducts.p50} factory_products_p95_ms=${factoryProducts.p95} quotes_p50_ms=${adminQuotes.p50} quotes_p95_ms=${adminQuotes.p95} activity_p50_ms=${activity.p50} activity_p95_ms=${activity.p95}`,
      );
    } finally {
      await factoryContext.dispose();
    }
  } finally {
    await context.dispose();
  }
});
