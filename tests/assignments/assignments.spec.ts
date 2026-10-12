import { expect, test } from "@playwright/test";

import {
  assignProductToFactory,
  getAssignedProduct,
  listAssignedProducts,
  listFactoriesForProduct,
  listProductsForFactory,
  reactivateAssignment,
  revokeAssignment,
} from "../../src/features/assignments/service";
import { createCategory } from "../../src/features/categories/service";
import { setFactoryStatus } from "../../src/features/factories/service";
import { createMaterial } from "../../src/features/materials/service";
import {
  createProduct,
  setProductStatus,
} from "../../src/features/products/service";
import { setFactoryUserEnabled } from "../../src/lib/auth/accounts";
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
type ProductFixture = Awaited<ReturnType<typeof createProduct>>;

let fixtures: TestFixtures;
let adminHeaders: Headers;
let factoryAHeaders: Headers;
let productA: ProductFixture;
let productB: ProductFixture;
let productC: ProductFixture;
let contexts: AuthRequest[] = [];

async function login(username: string, password: string) {
  const session = await newAuthRequest(username, password);
  expect(session.response.ok()).toBeTruthy();
  contexts.push(session);
  return { session, headers: await requestHeaders(session.context) };
}

async function resetAssignmentFixtures() {
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

  adminHeaders = (await login(usernames.admin, passwords.admin)).headers;
  factoryAHeaders = (await login(usernames.factoryA, passwords.factoryA))
    .headers;

  const category = await createCategory(adminHeaders, {
    name: "Test Assignment 分类",
  });
  const material = await createMaterial(adminHeaders, {
    name: "Test Assignment 材质",
  });
  const base = { categoryId: category.id, materialId: material.id };
  [productA, productB, productC] = await Promise.all([
    createProduct(adminHeaders, {
      ...base,
      sku: "ASSIGN-A",
      name: "Test Assignment Product A",
      notes: "Admin-only note A",
    }),
    createProduct(adminHeaders, {
      ...base,
      sku: "ASSIGN-B",
      name: "Test Assignment Product B",
      notes: "Admin-only note B",
    }),
    createProduct(adminHeaders, {
      ...base,
      sku: "ASSIGN-C",
      name: "Test Assignment Product C",
      notes: "Admin-only note C",
    }),
  ]);
}

test.beforeEach(async () => {
  await resetAssignmentFixtures();
});

test.afterEach(async () => {
  await Promise.all(contexts.map(({ context }) => context.dispose()));
  contexts = [];
});

test("Admin assign is idempotent, concurrency-safe, revocable and reactivates the stable relationship", async () => {
  const assigned = await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryAId,
  });
  const duplicate = await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryAId,
  });
  expect(duplicate.id).toBe(assigned.id);
  expect(duplicate.assignedAt.getTime()).toBe(assigned.assignedAt.getTime());

  const concurrent = await Promise.all([
    assignProductToFactory(adminHeaders, {
      productId: productB.id,
      factoryId: fixtures.factoryAId,
    }),
    assignProductToFactory(adminHeaders, {
      productId: productB.id,
      factoryId: fixtures.factoryAId,
    }),
  ]);
  expect(concurrent[0].id).toBe(concurrent[1].id);
  expect(
    await prisma.productFactoryAssignment.count({
      where: { productId: productB.id, factoryId: fixtures.factoryAId },
    }),
  ).toBe(1);

  const revoked = await revokeAssignment(adminHeaders, {
    assignmentId: assigned.id,
  });
  expect(revoked.status).toBe("REVOKED");
  expect(revoked.revokedAt).not.toBeNull();
  const doubleRevoked = await revokeAssignment(adminHeaders, {
    assignmentId: assigned.id,
  });
  expect(doubleRevoked.revokedAt?.getTime()).toBe(revoked.revokedAt?.getTime());

  const reactivated = await reactivateAssignment(adminHeaders, {
    assignmentId: assigned.id,
  });
  expect(reactivated.id).toBe(assigned.id);
  expect(reactivated.createdAt.getTime()).toBe(assigned.createdAt.getTime());
  expect(reactivated.status).toBe("ACTIVE");
  expect(reactivated.revokedAt).toBeNull();
  expect(reactivated.assignedAt.getTime()).toBeGreaterThanOrEqual(
    revoked.revokedAt!.getTime(),
  );

  await revokeAssignment(adminHeaders, { assignmentId: assigned.id });
  const pairReactivated = await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryAId,
  });
  expect(pairReactivated.id).toBe(assigned.id);
  expect(pairReactivated.status).toBe("ACTIVE");
});

test("Admin cannot assign disabled Product or disabled Factory", async () => {
  await expect(
    assignProductToFactory(adminHeaders, {
      productId: crypto.randomUUID(),
      factoryId: fixtures.factoryAId,
    }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND", message: "产品不存在" });
  await expect(
    assignProductToFactory(adminHeaders, {
      productId: productA.id,
      factoryId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND", message: "厂家不存在" });
  await expect(
    revokeAssignment(adminHeaders, { assignmentId: crypto.randomUUID() }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND", message: "分配关系不存在" });

  await setProductStatus(adminHeaders, { id: productA.id, status: "DISABLED" });
  await expect(
    assignProductToFactory(adminHeaders, {
      productId: productA.id,
      factoryId: fixtures.factoryAId,
    }),
  ).rejects.toMatchObject({
    kind: "CONFLICT",
    message: "已停用的产品不能分配",
  });

  await setFactoryStatus(adminHeaders, {
    id: fixtures.factoryBId,
    status: "DISABLED",
  });
  await expect(
    assignProductToFactory(adminHeaders, {
      productId: productB.id,
      factoryId: fixtures.factoryBId,
    }),
  ).rejects.toMatchObject({
    kind: "CONFLICT",
    message: "已停用的厂家不能分配产品",
  });
});

test("Admin read models support Product-to-Factories and Factory-to-Products views", async () => {
  const assignmentA = await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryAId,
  });
  const assignmentB = await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryBId,
  });
  await assignProductToFactory(adminHeaders, {
    productId: productB.id,
    factoryId: fixtures.factoryAId,
  });
  await revokeAssignment(adminHeaders, { assignmentId: assignmentB.id });

  const factories = await listFactoriesForProduct(adminHeaders, {
    productId: productA.id,
    page: 1,
    pageSize: 10,
    search: "Factory",
  });
  expect(factories.total).toBe(2);
  expect(factories.items.map(({ id }) => id)).toContain(assignmentA.id);
  const activeFactories = await listFactoriesForProduct(adminHeaders, {
    productId: productA.id,
    status: "ACTIVE",
  });
  expect(activeFactories.total).toBe(1);

  const products = await listProductsForFactory(adminHeaders, {
    factoryId: fixtures.factoryAId,
    page: 1,
    pageSize: 1,
    search: "Assignment Product",
  });
  expect(products.total).toBe(2);
  expect(products.items).toHaveLength(1);
  expect(products.totalPages).toBe(2);
});

test("Factory list and detail are tenant-scoped and never expose Product notes", async () => {
  const own = await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryAId,
  });
  const other = await assignProductToFactory(adminHeaders, {
    productId: productB.id,
    factoryId: fixtures.factoryBId,
  });

  const list = await listAssignedProducts(factoryAHeaders, {
    page: 1,
    pageSize: 20,
    search: "ASSIGN",
  });
  expect(list.total).toBe(1);
  expect(list.items[0]?.id).toBe(productA.id);
  expect(list.items[0]).not.toHaveProperty("notes");
  const detail = await getAssignedProduct(factoryAHeaders, productA.id);
  expect(detail.id).toBe(productA.id);
  expect(detail).not.toHaveProperty("notes");

  await expect(
    getAssignedProduct(factoryAHeaders, productB.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND", message: "产品不存在" });
  await expect(
    listAssignedProducts(factoryAHeaders, { factoryId: fixtures.factoryBId }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });
  await expect(
    getAssignedProduct(factoryAHeaders, {
      productId: productB.id,
      factoryId: fixtures.factoryBId,
    }),
  ).rejects.toMatchObject({ kind: "VALIDATION" });

  await expect(
    assignProductToFactory(factoryAHeaders, {
      productId: productC.id,
      factoryId: fixtures.factoryAId,
    }),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  await expect(
    revokeAssignment(factoryAHeaders, { assignmentId: own.id }),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  await expect(
    reactivateAssignment(factoryAHeaders, { assignmentId: other.id }),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
});

test("Revoked and disabled Products are immediately hidden from Factory reads", async () => {
  const assignment = await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryAId,
  });
  await revokeAssignment(adminHeaders, { assignmentId: assignment.id });
  expect((await listAssignedProducts(factoryAHeaders)).total).toBe(0);
  await expect(
    getAssignedProduct(factoryAHeaders, productA.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });

  await reactivateAssignment(adminHeaders, { assignmentId: assignment.id });
  await setProductStatus(adminHeaders, { id: productA.id, status: "DISABLED" });
  expect((await listAssignedProducts(factoryAHeaders)).total).toBe(0);
  await expect(
    getAssignedProduct(factoryAHeaders, productA.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });

  await setProductStatus(adminHeaders, { id: productA.id, status: "ENABLED" });
  expect((await listAssignedProducts(factoryAHeaders)).total).toBe(1);
});

test("Factory disable and user disable deny reads while re-enabled Factory keeps ACTIVE assignments", async () => {
  await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryAId,
  });
  expect((await listAssignedProducts(factoryAHeaders)).total).toBe(1);

  await setFactoryStatus(adminHeaders, {
    id: fixtures.factoryAId,
    status: "DISABLED",
  });
  await expect(listAssignedProducts(factoryAHeaders)).rejects.toMatchObject({
    kind: "UNAUTHENTICATED",
  });
  expect(
    await prisma.productFactoryAssignment.findUniqueOrThrow({
      where: {
        productId_factoryId: {
          productId: productA.id,
          factoryId: fixtures.factoryAId,
        },
      },
    }),
  ).toMatchObject({ status: "ACTIVE" });

  await setFactoryStatus(adminHeaders, {
    id: fixtures.factoryAId,
    status: "ACTIVE",
  });
  const relogin = await login(usernames.factoryA, passwords.factoryA);
  expect((await listAssignedProducts(relogin.headers)).total).toBe(1);

  await setFactoryUserEnabled(adminHeaders, {
    userId: fixtures.userAId,
    enabled: false,
  });
  await expect(listAssignedProducts(relogin.headers)).rejects.toMatchObject({
    kind: "UNAUTHENTICATED",
  });
});

test("Product and Factory deletion are restricted while Assignment exists", async () => {
  await assignProductToFactory(adminHeaders, {
    productId: productA.id,
    factoryId: fixtures.factoryAId,
  });
  await expect(
    prisma.product.delete({ where: { id: productA.id } }),
  ).rejects.toBeDefined();
  await expect(
    prisma.factory.delete({ where: { id: fixtures.factoryAId } }),
  ).rejects.toBeDefined();
});
