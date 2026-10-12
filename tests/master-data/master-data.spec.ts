import { expect, test } from "@playwright/test";

import {
  createCategory,
  setCategoryStatus,
  updateCategory,
} from "../../src/features/categories/service";
import {
  createFactory,
  setFactoryStatus,
  updateFactory,
} from "../../src/features/factories/service";
import {
  createMaterial,
  setMaterialStatus,
  updateMaterial,
} from "../../src/features/materials/service";
import {
  createProduct,
  listProducts,
  setProductStatus,
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

let fixtures: TestFixtures;
let adminHeaders: Headers;
let factoryHeaders: Headers;
let contexts: Awaited<ReturnType<typeof newAuthRequest>>[] = [];

async function resetMasterData() {
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (!database.endsWith("_test")) {
    throw new Error(
      "Destructive fixture reset refused outside a *_test database.",
    );
  }
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
  const admin = await newAuthRequest(usernames.admin, passwords.admin);
  const factory = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  contexts = [admin, factory];
  adminHeaders = await requestHeaders(admin.context);
  factoryHeaders = await requestHeaders(factory.context);
}

async function baseDictionaries() {
  const category = await createCategory(adminHeaders, { name: "Test 分类" });
  const material = await createMaterial(adminHeaders, { name: "Test 材质" });
  return { category, material };
}

test.beforeEach(async () => {
  await resetMasterData();
});

test.afterEach(async () => {
  await Promise.all(contexts.map(({ context }) => context.dispose()));
  contexts = [];
});

test("Product supports nullable SKU, canonical uniqueness, SKU updates and disable", async () => {
  const { category, material } = await baseDictionaries();
  const first = await createProduct(adminHeaders, {
    sku: "  ",
    name: "Test Product One",
    categoryId: category.id,
    materialId: material.id,
  });
  const second = await createProduct(adminHeaders, {
    sku: null,
    name: "Test Product Two",
    categoryId: category.id,
    materialId: material.id,
  });
  expect(first.sku).toBeNull();
  expect(second.sku).toBeNull();

  const withSku = await createProduct(adminHeaders, {
    sku: " test-001 ",
    name: "Test Product SKU",
    categoryId: category.id,
    materialId: material.id,
  });
  await expect(
    createProduct(adminHeaders, {
      sku: "TEST-001",
      name: "Duplicate SKU",
      categoryId: category.id,
      materialId: material.id,
    }),
  ).rejects.toMatchObject({ kind: "CONFLICT", message: "SKU 已存在" });

  const concurrent = await Promise.allSettled([
    createProduct(adminHeaders, {
      sku: "TEST-RACE",
      name: "Concurrent Product A",
      categoryId: category.id,
      materialId: material.id,
    }),
    createProduct(adminHeaders, {
      sku: "test-race",
      name: "Concurrent Product B",
      categoryId: category.id,
      materialId: material.id,
    }),
  ]);
  expect(
    concurrent.filter(({ status }) => status === "fulfilled"),
  ).toHaveLength(1);
  expect(concurrent.filter(({ status }) => status === "rejected")).toHaveLength(
    1,
  );

  const updated = await updateProduct(adminHeaders, {
    id: withSku.id,
    sku: "TEST-002",
    name: withSku.name,
    categoryId: category.id,
    materialId: material.id,
    status: "ENABLED",
    notes: " Test note ",
  });
  expect(updated.sku).toBe("TEST-002");
  expect(updated.notes).toBe("Test note");
  expect(
    (
      await setProductStatus(adminHeaders, {
        id: withSku.id,
        status: "DISABLED",
      })
    ).status,
  ).toBe("DISABLED");
});

test("Product validates references, blocks Factory mutation and supports bounded queries", async () => {
  const { category, material } = await baseDictionaries();
  await setMaterialStatus(adminHeaders, {
    id: material.id,
    status: "DISABLED",
  });
  await expect(
    createProduct(adminHeaders, {
      sku: "TEST-INVALID-MATERIAL",
      name: "Invalid Material Product",
      categoryId: category.id,
      materialId: material.id,
    }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND", message: "材质不存在或已停用" });
  await expect(
    createProduct(adminHeaders, {
      sku: "TEST-INVALID-CATEGORY",
      name: "Invalid Category Product",
      categoryId: crypto.randomUUID(),
      materialId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND", message: "分类不存在或已停用" });
  await expect(
    createProduct(factoryHeaders, {
      name: "Forbidden Product",
      categoryId: category.id,
      materialId: material.id,
    }),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  await expect(
    createCategory(factoryHeaders, { name: "Forbidden Category" }),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  await expect(
    createMaterial(factoryHeaders, { name: "Forbidden Material" }),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  await expect(
    createFactory(factoryHeaders, { name: "Forbidden Factory" }),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });

  await setMaterialStatus(adminHeaders, { id: material.id, status: "ACTIVE" });
  for (const [sku, name] of [
    ["TEST-A", "Alpha"],
    ["TEST-B", "Beta"],
  ]) {
    await createProduct(adminHeaders, {
      sku,
      name,
      categoryId: category.id,
      materialId: material.id,
    });
  }
  const result = await listProducts(adminHeaders, {
    page: 1,
    pageSize: 1,
    search: "test-",
    categoryId: category.id,
    materialId: material.id,
    status: "ENABLED",
    sortBy: "name",
    sortDirection: "asc",
  });
  expect(result.total).toBe(2);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.name).toBe("Alpha");
  expect(result.totalPages).toBe(2);
});

test("Category enforces normalized uniqueness, supports update and disable while referenced", async () => {
  const category = await createCategory(adminHeaders, {
    name: "  Test Category  ",
  });
  await expect(
    createCategory(adminHeaders, { name: "test category" }),
  ).rejects.toMatchObject({
    kind: "CONFLICT",
    message: "分类名称已存在",
  });
  expect(
    (
      await updateCategory(adminHeaders, {
        id: category.id,
        name: "Renamed Category",
      })
    ).name,
  ).toBe("Renamed Category");
  const material = await createMaterial(adminHeaders, {
    name: "Test Category Material",
  });
  await createProduct(adminHeaders, {
    name: "Test Category Reference",
    categoryId: category.id,
    materialId: material.id,
  });
  expect(
    (
      await setCategoryStatus(adminHeaders, {
        id: category.id,
        status: "DISABLED",
      })
    ).status,
  ).toBe("DISABLED");
  await expect(
    prisma.category.delete({ where: { id: category.id } }),
  ).rejects.toBeDefined();
});

test("Material enforces normalized uniqueness, supports update and disable while referenced", async () => {
  const material = await createMaterial(adminHeaders, {
    name: "  Test Material  ",
  });
  await expect(
    createMaterial(adminHeaders, { name: "test material" }),
  ).rejects.toMatchObject({
    kind: "CONFLICT",
    message: "材质名称已存在",
  });
  expect(
    (
      await updateMaterial(adminHeaders, {
        id: material.id,
        name: "Renamed Material",
      })
    ).name,
  ).toBe("Renamed Material");
  const category = await createCategory(adminHeaders, {
    name: "Test Material Category",
  });
  await createProduct(adminHeaders, {
    name: "Test Material Reference",
    categoryId: category.id,
    materialId: material.id,
  });
  expect(
    (
      await setMaterialStatus(adminHeaders, {
        id: material.id,
        status: "DISABLED",
      })
    ).status,
  ).toBe("DISABLED");
  await expect(
    prisma.material.delete({ where: { id: material.id } }),
  ).rejects.toBeDefined();
});

test("Factory master data can be created, updated and disabled without regressing session revocation", async () => {
  const created = await createFactory(adminHeaders, {
    name: " Test New Factory ",
    contactName: " Test Contact ",
    phone: " 123456 ",
    notes: " Internal only ",
  });
  expect(created).toMatchObject({
    name: "Test New Factory",
    contactName: "Test Contact",
    phone: "123456",
    notes: "Internal only",
  });
  expect(
    (
      await updateFactory(adminHeaders, {
        id: created.id,
        name: "Test Updated Factory",
        contactName: null,
        phone: null,
        notes: null,
      })
    ).name,
  ).toBe("Test Updated Factory");

  await setFactoryStatus(adminHeaders, {
    id: fixtures.factoryAId,
    status: "DISABLED",
  });
  expect(
    await (
      await contexts[1]!.context.get(
        "http://127.0.0.1:3100/api/auth/get-session",
      )
    ).json(),
  ).toBeNull();
  await expect(
    createFactory(factoryHeaders, { name: "Forbidden Factory" }),
  ).rejects.toMatchObject({ kind: "UNAUTHENTICATED" });
});
