import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";

import {
  createCategory,
  setCategoryStatus,
} from "../../src/features/categories/service";
import {
  downloadProductImportTemplate,
  exportFactoryQuotes,
  exportProducts,
} from "../../src/features/exports/service";
import {
  confirmProductImport,
  getProductImportJob,
  listProductImportRows,
  previewProductImport,
} from "../../src/features/imports/service";
import { IMPORT_HEADERS } from "../../src/features/imports/validation";
import { createMaterial } from "../../src/features/materials/service";
import {
  createProduct,
  updateProduct,
} from "../../src/features/products/service";
import { prisma } from "../../src/lib/db/prisma";
import {
  newAuthRequest,
  passwords,
  requestHeaders,
  resetAuthFixtures,
  type TestFixtures,
  usernames,
} from "../auth/fixtures";

test.describe.configure({ mode: "serial" });

type AuthRequest = Awaited<ReturnType<typeof newAuthRequest>>;

let fixtures: TestFixtures;
let adminHeaders: Headers;
let factoryHeaders: Headers;
let category: Awaited<ReturnType<typeof createCategory>>;
let material: Awaited<ReturnType<typeof createMaterial>>;
let contexts: AuthRequest[] = [];

async function login(username: string, password: string) {
  const session = await newAuthRequest(username, password);
  expect(session.response.ok()).toBeTruthy();
  contexts.push(session);
  return requestHeaders(session.context);
}

function csv(rows: string[][]) {
  const escape = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return Buffer.from(
    `\uFEFF${[IMPORT_HEADERS as unknown as string[], ...rows]
      .map((row) => row.map(escape).join(","))
      .join("\r\n")}\r\n`,
  );
}

async function xlsx(
  rows: Array<Array<string | { formula: string; result: string }>>,
  extraSheet = false,
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Products");
  sheet.addRow([...IMPORT_HEADERS]);
  for (const row of rows) sheet.addRow(row);
  if (extraSheet) workbook.addWorksheet("Unexpected");
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function row(input: {
  id?: string;
  sku?: string;
  name: string;
  category?: string;
  material?: string;
  status?: string;
  notes?: string;
}) {
  return [
    input.id ?? "",
    input.sku ?? "",
    input.name,
    input.category ?? category.name,
    input.material ?? material.name,
    input.status ?? "启用",
    input.notes ?? "",
  ];
}

async function resetFixtures() {
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (!database.endsWith("_test"))
    throw new Error("Refusing to reset a non-test database");
  await prisma.importRow.deleteMany();
  await prisma.importJob.deleteMany();
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
  fixtures = await resetAuthFixtures();
  adminHeaders = await login(usernames.admin, passwords.admin);
  factoryHeaders = await login(usernames.factoryA, passwords.factoryA);
  category = await createCategory(adminHeaders, { name: "Import 分类" });
  material = await createMaterial(adminHeaders, { name: "Import 材质" });
  await prisma.activityLog.deleteMany();
}

test.beforeEach(resetFixtures);

test.afterEach(async () => {
  await Promise.all(contexts.map(({ context }) => context.dispose()));
  contexts = [];
});

test.afterAll(async () => {
  await prisma.importRow.deleteMany();
  await prisma.importJob.deleteMany();
});

test("previews 105 CSV creates without mutation, then confirms atomically with audit", async () => {
  const rows = Array.from({ length: 105 }, (_, index) =>
    row({ sku: `BULK-${index + 1}`, name: `Bulk Product ${index + 1}` }),
  );
  const job = await previewProductImport(adminHeaders, {
    bytes: csv(rows),
    filename: "bulk.csv",
  });
  expect(job.counts).toEqual({
    totalRows: 105,
    createRows: 105,
    updateRows: 0,
    noChangeRows: 0,
    errorRows: 0,
  });
  expect(await prisma.product.count()).toBe(0);
  expect(await prisma.activityLog.count()).toBe(0);
  expect(await prisma.importRow.count({ where: { jobId: job.id } })).toBe(105);
  expect(
    await prisma.importRow.count({
      where: { jobId: job.id, resolvedProductId: null },
    }),
  ).toBe(105);

  const confirmed = await confirmProductImport(adminHeaders, job.id);
  expect(confirmed.status).toBe("CONFIRMED");
  expect(await prisma.product.count()).toBe(105);
  expect(
    await prisma.activityLog.count({ where: { eventType: "PRODUCT_CREATED" } }),
  ).toBe(105);
  expect(
    await prisma.importRow.count({
      where: { jobId: job.id, resolvedProductId: { not: null } },
    }),
  ).toBe(105);
  await expect(
    confirmProductImport(adminHeaders, job.id),
  ).rejects.toMatchObject({
    kind: "CONFLICT",
  });
});

test("supports XLSX create, exact-ID update and no-change using canonical dictionaries", async () => {
  const existing = await createProduct(adminHeaders, {
    sku: "OLD-1",
    name: "Existing",
    categoryId: category.id,
    materialId: material.id,
    notes: "old",
  });
  await prisma.activityLog.deleteMany();
  const job = await previewProductImport(adminHeaders, {
    bytes: await xlsx([
      row({ sku: "NEW-XLSX", name: "XLSX New" }),
      row({
        id: existing.id,
        sku: "UPDATED-1",
        name: "Existing updated",
        notes: "new",
      }),
    ]),
    filename: "products.xlsx",
  });
  expect(job.counts).toMatchObject({
    createRows: 1,
    updateRows: 1,
    errorRows: 0,
  });
  const page = await listProductImportRows(adminHeaders, job.id, {
    action: "UPDATE",
  });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.changes).toMatchObject({
    sku: { before: "OLD-1", after: "UPDATED-1" },
  });
  await confirmProductImport(adminHeaders, job.id);
  expect(
    await prisma.product.findUnique({ where: { id: existing.id } }),
  ).toMatchObject({
    sku: "UPDATED-1",
    name: "Existing updated",
    notes: "new",
  });
  const resolved = await prisma.importRow.findMany({
    where: { jobId: job.id },
    select: { action: true, targetProductId: true, resolvedProductId: true },
    orderBy: { rowNumber: "asc" },
  });
  expect(resolved[0]).toMatchObject({
    action: "CREATE",
    targetProductId: null,
  });
  expect(resolved[0]?.resolvedProductId).not.toBeNull();
  expect(resolved[1]).toMatchObject({
    action: "UPDATE",
    targetProductId: existing.id,
    resolvedProductId: existing.id,
  });

  const noChange = await previewProductImport(adminHeaders, {
    bytes: csv([
      row({
        id: existing.id,
        sku: "UPDATED-1",
        name: "Existing updated",
        notes: "new",
      }),
    ]),
    filename: "no-change.csv",
  });
  expect(noChange.counts.noChangeRows).toBe(1);
  await confirmProductImport(adminHeaders, noChange.id);
  expect(
    await prisma.importRow.findFirst({
      where: { jobId: noChange.id },
      select: { action: true, resolvedProductId: true },
    }),
  ).toEqual({ action: "NO_CHANGE", resolvedProductId: existing.id });
});

test("persists row errors and blocks confirmation for duplicates and invalid dictionaries", async () => {
  await createProduct(adminHeaders, {
    sku: "EXISTS",
    name: "Existing SKU",
    categoryId: category.id,
    materialId: material.id,
  });
  await setCategoryStatus(adminHeaders, {
    id: category.id,
    status: "DISABLED",
  });
  const job = await previewProductImport(adminHeaders, {
    bytes: csv([
      row({ sku: "DUP", name: "Duplicate A" }),
      row({ sku: "DUP", name: "Duplicate B" }),
      row({ sku: "EXISTS", name: "Existing conflict", category: "Missing" }),
    ]),
    filename: "errors.csv",
  });
  expect(job.counts.errorRows).toBe(3);
  const errors = await listProductImportRows(adminHeaders, job.id, {
    action: "ERROR",
  });
  expect(errors.items).toHaveLength(3);
  expect(JSON.stringify(errors.items.map((item) => item.errors))).toContain(
    "重复",
  );
  expect(JSON.stringify(errors.items.map((item) => item.errors))).toContain(
    "不存在",
  );
  await expect(
    confirmProductImport(adminHeaders, job.id),
  ).rejects.toMatchObject({
    kind: "CONFLICT",
  });
});

test("detects stale updates and rolls back every row", async () => {
  const existing = await createProduct(adminHeaders, {
    sku: "STALE",
    name: "Before",
    categoryId: category.id,
    materialId: material.id,
  });
  const job = await previewProductImport(adminHeaders, {
    bytes: csv([
      row({ id: existing.id, sku: "STALE", name: "From import" }),
      row({ sku: "ATOMIC-NEW", name: "Must roll back" }),
    ]),
    filename: "stale.csv",
  });
  await updateProduct(adminHeaders, {
    id: existing.id,
    sku: "STALE",
    name: "Concurrent change",
    categoryId: category.id,
    materialId: material.id,
    status: "ENABLED",
    notes: null,
  });
  await expect(
    confirmProductImport(adminHeaders, job.id),
  ).rejects.toMatchObject({
    kind: "CONFLICT",
  });
  expect(
    await prisma.product.findUnique({ where: { skuNormalized: "ATOMIC-NEW" } }),
  ).toBeNull();
  expect((await getProductImportJob(adminHeaders, job.id)).status).toBe(
    "PREVIEW_READY",
  );
});

test("rejects unsafe workbook structures and denies every Factory import/export entry", async () => {
  await expect(
    previewProductImport(adminHeaders, {
      bytes: await xlsx([
        [
          "",
          "",
          { formula: "1+1", result: "2" },
          category.name,
          material.name,
          "启用",
          "",
        ],
      ]),
      filename: "formula.xlsx",
    }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });
  await expect(
    previewProductImport(adminHeaders, {
      bytes: await xlsx([row({ name: "One" })], true),
      filename: "sheets.xlsx",
    }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });
  await expect(
    previewProductImport(adminHeaders, {
      bytes: Buffer.from("not xlsx"),
      filename: "fake.xlsx",
    }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });
  await expect(
    previewProductImport(adminHeaders, {
      bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
      filename: "oversized.csv",
    }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });
  const tooMany = Array.from({ length: 5001 }, (_, index) =>
    row({ name: `Too many ${index}` }),
  );
  await expect(
    previewProductImport(adminHeaders, {
      bytes: csv(tooMany),
      filename: "too-many.csv",
    }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });

  await expect(
    previewProductImport(factoryHeaders, {
      bytes: csv([row({ name: "Denied" })]),
      filename: "denied.csv",
    }),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  await expect(
    downloadProductImportTemplate(factoryHeaders, "csv"),
  ).rejects.toMatchObject({
    kind: "FORBIDDEN",
  });
  await expect(exportProducts(factoryHeaders, "csv", {})).rejects.toMatchObject(
    { kind: "FORBIDDEN" },
  );
  await expect(
    exportFactoryQuotes(factoryHeaders, "xlsx", {}),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
});

test("exposes protected preview, paging, confirm, template and export Route Handlers", async () => {
  const adminApi = contexts[0]!.context;
  const factoryApi = contexts[1]!.context;
  const templateResponse = await adminApi.get(
    "/api/imports/products/templates/csv",
  );
  expect(templateResponse.status()).toBe(200);
  expect(templateResponse.headers()["content-disposition"]).toContain(
    "attachment;",
  );
  expect((await templateResponse.body()).length).toBeGreaterThan(0);
  expect(
    (await factoryApi.get("/api/imports/products/templates/csv")).status(),
  ).toBe(403);
  expect((await factoryApi.get("/api/exports/products/csv")).status()).toBe(
    403,
  );

  const previewResponse = await adminApi.post("/api/imports/products/preview", {
    multipart: {
      file: {
        name: "route.csv",
        mimeType: "text/csv",
        buffer: csv([row({ sku: "ROUTE-1", name: "Route Product" })]),
      },
    },
  });
  expect(previewResponse.status()).toBe(201);
  const job = (await previewResponse.json()) as { id: string };
  expect((await adminApi.get(`/api/imports/${job.id}`)).status()).toBe(200);
  expect(
    (await adminApi.get(`/api/imports/${job.id}/rows?pageSize=1`)).status(),
  ).toBe(200);
  expect((await factoryApi.get(`/api/imports/${job.id}`)).status()).toBe(403);
  expect((await adminApi.post(`/api/imports/${job.id}/confirm`)).status()).toBe(
    200,
  );

  const exportResponse = await adminApi.get(
    "/api/exports/products/xlsx?search=ROUTE-1",
  );
  expect(exportResponse.status()).toBe(200);
  expect(exportResponse.headers()["content-type"]).toContain(
    "spreadsheetml.sheet",
  );
});

test("exports filtered Product and three-factory Quote data with injection-safe CSV/XLSX", async () => {
  const product = await createProduct(adminHeaders, {
    sku: "EXPORT-1",
    name: "+Export Product",
    categoryId: category.id,
    materialId: material.id,
    notes: '=HYPERLINK("bad")',
  });
  const thirdFactory = await prisma.factory.create({
    data: { name: "@Factory C", nameNormalized: "@factory c" },
  });
  const factoryIds = [
    fixtures.factoryAId,
    fixtures.factoryBId,
    thirdFactory.id,
  ];
  for (let index = 0; index < factoryIds.length; index += 1) {
    const assignment = await prisma.productFactoryAssignment.create({
      data: { productId: product.id, factoryId: factoryIds[index]! },
    });
    await prisma.factoryQuote.create({
      data: {
        assignmentId: assignment.id,
        priceCents: BigInt(12345 + index),
        moq: 10 + index,
        packingLengthCm: "10.000",
        packingWidthCm: "20.000",
        packingHeightCm: "30.000",
        factoryNotes: index === 0 ? "=SUM(1,1)" : `note-${index}`,
      },
    });
  }

  const productCsv = await exportProducts(adminHeaders, "csv", {
    search: "EXPORT-1",
    hasMainImage: "false",
  });
  expect(productCsv.bytes.subarray(0, 3)).toEqual(
    Buffer.from([0xef, 0xbb, 0xbf]),
  );
  const productRecords = parse(productCsv.bytes, { bom: true }) as string[][];
  expect(productRecords).toHaveLength(2);
  expect(productRecords[1]).toContain("'+Export Product");
  expect(productRecords[1]).toContain('\'=HYPERLINK("bad")');

  const quoteCsv = await exportFactoryQuotes(adminHeaders, "csv", {
    factoryId: fixtures.factoryAId,
  });
  const quoteRecords = parse(quoteCsv.bytes, { bom: true }) as string[][];
  expect(quoteRecords).toHaveLength(2);
  expect(quoteRecords[1]).toContain("123.45");
  expect(quoteRecords[1]).toContain("0.0060");
  expect(quoteRecords[1]).toContain("'=SUM(1,1)");

  const quoteXlsx = await exportFactoryQuotes(adminHeaders, "xlsx", {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(quoteXlsx.bytes).buffer);
  const sheet = workbook.worksheets[0]!;
  expect(sheet.rowCount).toBe(4);
  expect(sheet.views[0]?.state).toBe("frozen");
  const notesColumn = quoteColumnsIndex(sheet, "厂家备注");
  const protectedCell = [2, 3, 4]
    .map((rowNumber) => sheet.getCell(rowNumber, notesColumn))
    .find((cell) => cell.text === "'=SUM(1,1)");
  expect(protectedCell?.type).toBe(ExcelJS.ValueType.String);

  const template = await downloadProductImportTemplate(adminHeaders, "xlsx");
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.load(Uint8Array.from(template.bytes).buffer);
  expect(templateWorkbook.worksheets).toHaveLength(1);
  expect(templateWorkbook.worksheets[0]?.getRow(1).values).toContain(
    "product_id",
  );
});

function quoteColumnsIndex(sheet: ExcelJS.Worksheet, header: string) {
  let result = 0;
  sheet.getRow(1).eachCell((cell, column) => {
    if (cell.text === header) result = column;
  });
  return result;
}
