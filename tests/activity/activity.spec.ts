import { expect, test } from "@playwright/test";

import { listActivityLogs } from "../../src/features/activity/service";
import {
  type UserActivityInput,
  writeUserActivity,
} from "../../src/features/activity/writer";
import {
  assignProductToFactory,
  reactivateAssignment,
  revokeAssignment,
} from "../../src/features/assignments/service";
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
  setProductStatus,
  updateProduct,
} from "../../src/features/products/service";
import {
  getOwnQuoteForAssignment,
  submitOwnQuote,
} from "../../src/features/quotes/service";
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
let factoryAHeaders: Headers;
let factoryBHeaders: Headers;
let category: Awaited<ReturnType<typeof createCategory>>;
let material: Awaited<ReturnType<typeof createMaterial>>;
let contexts: AuthRequest[] = [];

async function login(username: string, password: string) {
  const session = await newAuthRequest(username, password);
  expect(session.response.ok()).toBeTruthy();
  contexts.push(session);
  return { session, headers: await requestHeaders(session.context) };
}

async function resetActivityFixtures() {
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
  factoryBHeaders = (await login(usernames.factoryB, passwords.factoryB))
    .headers;
  category = await createCategory(adminHeaders, { name: "Audit Base 分类" });
  material = await createMaterial(adminHeaders, { name: "Audit Base 材质" });
  await prisma.activityLog.deleteMany();
}

async function createAuditProduct(sku = "AUDIT-A") {
  return createProduct(adminHeaders, {
    sku,
    name: `Audit Product ${sku}`,
    categoryId: category.id,
    materialId: material.id,
    status: "ENABLED",
    notes: null,
  });
}

test.beforeEach(async () => {
  await resetActivityFixtures();
});

test.afterEach(async () => {
  await Promise.all(contexts.map(({ context }) => context.dispose()));
  contexts = [];
});

test("Master Data mutations emit semantic, actor-backed, no-op-free audit events", async () => {
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const product = await createAuditProduct();
  const productUpdate = {
    id: product.id,
    sku: product.sku,
    name: "Audit Product Renamed",
    categoryId: category.id,
    materialId: material.id,
    status: "ENABLED" as const,
    notes: "short audit note",
  };
  await updateProduct(adminHeaders, productUpdate);
  const beforeNoOp = await prisma.activityLog.count();
  await updateProduct(adminHeaders, productUpdate);
  expect(await prisma.activityLog.count()).toBe(beforeNoOp);
  await setProductStatus(adminHeaders, {
    id: product.id,
    status: "DISABLED",
  });
  await setProductStatus(adminHeaders, {
    id: product.id,
    status: "DISABLED",
  });
  await setProductStatus(adminHeaders, { id: product.id, status: "ENABLED" });

  const extraCategory = await createCategory(adminHeaders, {
    name: "Audit Category",
  });
  await updateCategory(adminHeaders, {
    id: extraCategory.id,
    name: "Audit Category Updated",
  });
  await updateCategory(adminHeaders, {
    id: extraCategory.id,
    name: "Audit Category Updated",
  });
  await setCategoryStatus(adminHeaders, {
    id: extraCategory.id,
    status: "DISABLED",
  });
  await setCategoryStatus(adminHeaders, {
    id: extraCategory.id,
    status: "ACTIVE",
  });

  const extraMaterial = await createMaterial(adminHeaders, {
    name: "Audit Material",
  });
  await updateMaterial(adminHeaders, {
    id: extraMaterial.id,
    name: "Audit Material Updated",
  });
  await setMaterialStatus(adminHeaders, {
    id: extraMaterial.id,
    status: "DISABLED",
  });
  await setMaterialStatus(adminHeaders, {
    id: extraMaterial.id,
    status: "ACTIVE",
  });

  const extraFactory = await createFactory(adminHeaders, {
    name: "Audit Factory",
    contactName: "测试联系人",
    phone: "123456",
    notes: "factory note",
  });
  await updateFactory(adminHeaders, {
    id: extraFactory.id,
    name: "Audit Factory Updated",
    contactName: "新联系人",
    phone: "654321",
    notes: "factory note updated",
  });
  await setFactoryStatus(adminHeaders, {
    id: extraFactory.id,
    status: "DISABLED",
  });
  await setFactoryStatus(adminHeaders, {
    id: extraFactory.id,
    status: "ACTIVE",
  });

  const productEvents = await listActivityLogs(adminHeaders, {
    entityType: "PRODUCT",
    pageSize: 20,
  });
  expect(productEvents.total).toBe(4);
  expect(productEvents.items.map(({ eventType }) => eventType).sort()).toEqual([
    "PRODUCT_CREATED",
    "PRODUCT_DISABLED",
    "PRODUCT_ENABLED",
    "PRODUCT_UPDATED",
  ]);
  const updateEvent = productEvents.items.find(
    ({ eventType }) => eventType === "PRODUCT_UPDATED",
  );
  expect(updateEvent?.changes).toEqual({
    name: { before: "Audit Product AUDIT-A", after: "Audit Product Renamed" },
    notes: { before: null, after: "short audit note" },
  });
  expect(updateEvent).toMatchObject({
    actorSource: "USER",
    actorUserId: fixtures.adminId,
    actorRole: "ADMIN",
    actorUsernameSnapshot: usernames.admin,
  });

  expect(
    (await listActivityLogs(adminHeaders, { entityType: "CATEGORY" })).total,
  ).toBe(4);
  expect(
    (await listActivityLogs(adminHeaders, { entityType: "MATERIAL" })).total,
  ).toBe(4);
  const factoryEvents = await listActivityLogs(adminHeaders, {
    factoryId: extraFactory.id,
  });
  expect(factoryEvents.total).toBe(4);

  const pageOne = await listActivityLogs(adminHeaders, {
    page: 1,
    pageSize: 2,
    actorUserId: fixtures.adminId,
    from: startedAt,
    to: new Date(Date.now() + 1_000).toISOString(),
  });
  const pageTwo = await listActivityLogs(adminHeaders, {
    page: 2,
    pageSize: 2,
    actorUserId: fixtures.adminId,
    from: startedAt,
    to: new Date(Date.now() + 1_000).toISOString(),
  });
  expect(pageOne.items).toHaveLength(2);
  expect(pageTwo.items).toHaveLength(2);
  expect(pageOne.items[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
    pageOne.items[1]!.createdAt.getTime(),
  );
  expect(pageTwo.items.map(({ id }) => id)).not.toContain(pageOne.items[0]!.id);
  expect(
    (
      await listActivityLogs(adminHeaders, {
        eventType: "PRODUCT_DISABLED",
      })
    ).total,
  ).toBe(1);
  await expect(listActivityLogs(factoryAHeaders)).rejects.toMatchObject({
    kind: "FORBIDDEN",
  });
});

test("Assignment lifecycle writes exactly one semantic event per real transition", async () => {
  const product = await createAuditProduct();
  await prisma.activityLog.deleteMany();
  const assignment = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryAId,
  });
  await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryAId,
  });
  await revokeAssignment(adminHeaders, { assignmentId: assignment.id });
  await revokeAssignment(adminHeaders, { assignmentId: assignment.id });
  await reactivateAssignment(adminHeaders, { assignmentId: assignment.id });

  const events = await listActivityLogs(adminHeaders, {
    entityType: "ASSIGNMENT",
  });
  expect(events.total).toBe(3);
  expect(events.items.map(({ eventType }) => eventType).sort()).toEqual([
    "ASSIGNMENT_ASSIGNED",
    "ASSIGNMENT_REACTIVATED",
    "ASSIGNMENT_REVOKED",
  ]);
  expect(
    events.items.every(
      (event) =>
        event.actorUserId === fixtures.adminId &&
        event.factoryId === fixtures.factoryAId &&
        event.entityId === assignment.id,
    ),
  ).toBeTruthy();
  const assigned = events.items.find(
    ({ eventType }) => eventType === "ASSIGNMENT_ASSIGNED",
  );
  expect(assigned?.changes).toMatchObject({
    productId: { before: null, after: product.id },
    factoryId: { before: null, after: fixtures.factoryAId },
    status: { before: null, after: "ACTIVE" },
  });
});

test("Quote, PriceHistory and ActivityLog remain distinct, atomic and tenant-safe", async () => {
  const product = await createAuditProduct();
  const assignmentA = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryAId,
  });
  const assignmentB = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryBId,
  });
  await prisma.activityLog.deleteMany();

  const first = await submitOwnQuote(factoryAHeaders, {
    assignmentId: assignmentA.id,
    price: "328",
    factoryNotes: "initial note",
  });
  const priceUpdate = await submitOwnQuote(factoryAHeaders, {
    assignmentId: assignmentA.id,
    expectedVersion: first.version,
    price: "315",
    factoryNotes: "initial note",
  });
  const longNote = "敏感业务备注".repeat(60);
  const weightUpdate = await submitOwnQuote(factoryAHeaders, {
    assignmentId: assignmentA.id,
    expectedVersion: priceUpdate.version,
    price: "315",
    netWeightKg: "7.2",
    grossWeightKg: "7.6",
    factoryNotes: longNote,
  });
  const noOp = await submitOwnQuote(factoryAHeaders, {
    assignmentId: assignmentA.id,
    expectedVersion: weightUpdate.version,
    price: "315",
    netWeightKg: "7.2",
    grossWeightKg: "7.6",
    factoryNotes: longNote,
  });
  expect(noOp.version).toBe(weightUpdate.version);
  expect(await prisma.priceHistory.count()).toBe(2);

  const quoteEvents = await listActivityLogs(adminHeaders, {
    entityType: "QUOTE",
    factoryId: fixtures.factoryAId,
  });
  expect(quoteEvents.total).toBe(3);
  expect(
    quoteEvents.items.filter(({ eventType }) => eventType === "QUOTE_UPDATED"),
  ).toHaveLength(2);
  expect(
    quoteEvents.items.every(
      (event) =>
        event.actorUserId === fixtures.userAId &&
        event.actorUsernameSnapshot === usernames.factoryA &&
        event.factoryId === fixtures.factoryAId,
    ),
  ).toBeTruthy();
  const weightEvent = quoteEvents.items.find((event) => {
    const changes = event.changes as Record<string, unknown>;
    return "grossWeightKg" in changes;
  });
  const serializedWeightEvent = JSON.stringify(weightEvent);
  expect(serializedWeightEvent).toContain("长文本");
  expect(serializedWeightEvent).toContain("SHA-256");
  expect(serializedWeightEvent).not.toContain(longNote);

  const quoteB = await submitOwnQuote(factoryBHeaders, {
    assignmentId: assignmentB.id,
    price: "300",
  });
  const activityCount = await prisma.activityLog.count();
  await expect(
    submitOwnQuote(factoryAHeaders, {
      assignmentId: assignmentB.id,
      expectedVersion: quoteB.version,
      price: "1",
    }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  expect(await prisma.activityLog.count()).toBe(activityCount);
  expect(
    (await getOwnQuoteForAssignment(factoryBHeaders, assignmentB.id))
      ?.priceCents,
  ).toBe("30000");
});

test("an ActivityLog insert failure rolls back Quote and PriceHistory", async () => {
  const product = await createAuditProduct();
  const assignment = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryAId,
  });
  await prisma.activityLog.deleteMany();
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fail_activity_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'test forced activity failure';
    END;
    $$;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER test_fail_activity_insert_trigger
    BEFORE INSERT ON "ActivityLog"
    FOR EACH ROW EXECUTE FUNCTION test_fail_activity_insert();
  `);
  try {
    await expect(
      submitOwnQuote(factoryAHeaders, {
        assignmentId: assignment.id,
        price: "328",
      }),
    ).rejects.toBeTruthy();
  } finally {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS test_fail_activity_insert_trigger ON "ActivityLog";`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS test_fail_activity_insert();`,
    );
  }
  expect(await prisma.factoryQuote.count()).toBe(0);
  expect(await prisma.priceHistory.count()).toBe(0);
  expect(await prisma.activityLog.count()).toBe(0);
});

test("audit allowlists reject password, session and secret fields", async () => {
  const product = await createAuditProduct();
  await prisma.activityLog.deleteMany();
  const actor = {
    userId: fixtures.adminId,
    username: usernames.admin,
    role: "ADMIN" as const,
    factoryId: null,
  };
  const base = {
    eventType: "PRODUCT_UPDATED" as const,
    actor,
    entityId: product.id,
    entityLabelSnapshot: product.name,
    factoryId: null,
    before: {
      sku: product.sku,
      name: product.name,
      categoryId: product.categoryId,
      materialId: product.materialId,
      notes: null,
    },
    after: {
      sku: product.sku,
      name: "Safe changed name",
      categoryId: product.categoryId,
      materialId: product.materialId,
      notes: null,
    },
    metadata: {},
  } satisfies UserActivityInput<"PRODUCT_UPDATED">;

  const unsafeChanges = {
    ...base,
    after: { ...base.after, password: "never-store-this-password" },
  } as unknown as UserActivityInput<"PRODUCT_UPDATED">;
  await expect(
    prisma.$transaction((tx) => writeUserActivity(tx, unsafeChanges)),
  ).rejects.toThrow("non-allowlisted");

  const unsafeMetadata = {
    ...base,
    metadata: {
      sessionToken: "never-store-this-session",
      authSecret: "never-store-this-secret",
      hiddenEmail: "hidden@users.invalid",
    },
  } as unknown as UserActivityInput<"PRODUCT_UPDATED">;
  await expect(
    prisma.$transaction((tx) => writeUserActivity(tx, unsafeMetadata)),
  ).rejects.toThrow("non-allowlisted");
  expect(await prisma.activityLog.count()).toBe(0);
});
