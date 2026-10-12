import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { readDatabasePlan } from "../../src/features/hard-delete/planner";
import {
  confirmHardDeleteForAdmin,
  createHardDeletePreview,
  createHardDeletePreviewForAdmin,
} from "../../src/features/hard-delete/service";
import {
  runHardDeleteOperation,
  SimulatedHardDeleteCrash,
} from "../../src/features/hard-delete/worker";
import type { AdminActor } from "../../src/lib/auth/context-core";
import { prisma } from "../../src/lib/db/prisma";
import {
  createImageStorageKey,
  LocalStorageProvider,
} from "../../src/lib/storage/local";
import type { StorageProvider } from "../../src/lib/storage/provider";
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
let actor: AdminActor;
let storageRoot: string;
let storage: LocalStorageProvider;

function assertDisposableEnvironment() {
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (!database.endsWith("_test")) {
    throw new Error("Hard delete tests refuse non-test databases");
  }
  if (!storageRoot.startsWith(os.tmpdir())) {
    throw new Error("Hard delete tests require a temporary storage root");
  }
}

async function resetState() {
  fixtures = await resetAuthFixtures();
  actor = {
    userId: fixtures.adminId,
    username: usernames.admin,
    role: "ADMIN",
    factoryId: null,
  };
}

async function storedObject(bytes: Buffer) {
  const storageKey = createImageStorageKey();
  await storage.put(storageKey, bytes);
  return prisma.storedObject.create({
    data: {
      storageKey,
      mimeType: "image/webp",
      sizeBytes: BigInt(bytes.length),
      width: 10,
      height: 10,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
      originalFilename: "phase2.webp",
      createdByUserId: fixtures.adminId,
    },
  });
}

async function productClosureFixture() {
  const categoryName = `Category ${randomUUID()}`;
  const materialName = `Material ${randomUUID()}`;
  const [category, material] = await Promise.all([
    prisma.category.create({
      data: { name: categoryName, nameNormalized: categoryName.toLowerCase() },
    }),
    prisma.material.create({
      data: { name: materialName, nameNormalized: materialName.toLowerCase() },
    }),
  ]);
  const product = await prisma.product.create({
    data: {
      name: "Phase 2 Product",
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
  const revokedAssignment = await prisma.productFactoryAssignment.update({
    where: { id: assignment.id },
    data: { status: "REVOKED", revokedAt: new Date(Date.now() + 1_000) },
  });
  const quote = await prisma.factoryQuote.create({
    data: { assignmentId: revokedAssignment.id, priceCents: 12345n },
  });
  const history = await prisma.priceHistory.create({
    data: {
      factoryQuoteId: quote.id,
      newPriceCents: 12345n,
      changedByUserId: fixtures.userAId,
    },
  });
  const mainObject = await storedObject(Buffer.from("main-image-phase-2"));
  const privateObject = await storedObject(
    Buffer.from("private-image-phase-2"),
  );
  const mainImage = await prisma.productMainImage.create({
    data: {
      productId: product.id,
      storedObjectId: mainObject.id,
      createdByUserId: fixtures.adminId,
    },
  });
  const privateImage = await prisma.factoryPrivateImage.create({
    data: {
      assignmentId: revokedAssignment.id,
      storedObjectId: privateObject.id,
      uploadedByUserId: fixtures.userAId,
    },
  });
  const job = await prisma.importJob.create({
    data: {
      originalFilename: "stable.csv",
      checksumSha256: "a".repeat(64),
      totalRows: 1,
      createRows: 0,
      updateRows: 1,
      noChangeRows: 0,
      errorRows: 0,
      createdByUserId: fixtures.adminId,
    },
  });
  const importRow = await prisma.importRow.create({
    data: {
      jobId: job.id,
      rowNumber: 2,
      action: "UPDATE",
      targetProductId: product.id,
      resolvedProductId: product.id,
      targetUpdatedAtSnapshot: product.updatedAt,
      normalizedData: { name: product.name },
      errors: [],
    },
  });
  const activity = await prisma.activityLog.create({
    data: {
      eventType: "PRODUCT_DISABLED",
      entityType: "PRODUCT",
      entityId: product.id,
      entityLabelSnapshot: product.name,
      actorUserId: fixtures.adminId,
      actorRole: "ADMIN",
      actorUsernameSnapshot: usernames.admin,
      changes: { status: { before: "ENABLED", after: "DISABLED" } },
    },
  });
  return {
    category,
    material,
    product,
    assignment: revokedAssignment,
    quote,
    history,
    mainObject,
    privateObject,
    mainImage,
    privateImage,
    job,
    importRow,
    activity,
  };
}

async function confirmedProductOperation() {
  const closure = await productClosureFixture();
  const preview = await createHardDeletePreviewForAdmin(
    actor,
    { targetType: "PRODUCT", targetId: closure.product.id },
    { storage },
  );
  if (
    !preview.operationId ||
    !("previewSha256" in preview) ||
    !("version" in preview)
  ) {
    throw new Error("Expected an eligible product preview");
  }
  await confirmHardDeleteForAdmin(
    actor,
    {
      operationId: preview.operationId,
      previewSha256: preview.previewSha256,
      expectedVersion: preview.version,
      confirmationPhrase: preview.confirmationPhrase,
    },
    { storage },
  );
  return { closure, preview };
}

async function executeTarget(
  targetType: Parameters<
    typeof createHardDeletePreviewForAdmin
  >[1] extends never
    ? never
    : | "USER"
      | "FACTORY"
      | "CATEGORY"
      | "MATERIAL"
      | "ASSIGNMENT"
      | "QUOTE"
      | "PRODUCT_MAIN_IMAGE"
      | "FACTORY_PRIVATE_IMAGE",
  targetId: string,
  workerId: string,
) {
  const preview = await createHardDeletePreviewForAdmin(
    actor,
    { targetType, targetId },
    { storage },
  );
  if (
    !preview.operationId ||
    !("previewSha256" in preview) ||
    !("version" in preview)
  ) {
    throw new Error(`Expected eligible ${targetType} preview`);
  }
  await confirmHardDeleteForAdmin(
    actor,
    {
      operationId: preview.operationId,
      previewSha256: preview.previewSha256,
      expectedVersion: preview.version,
      confirmationPhrase: preview.confirmationPhrase,
    },
    { storage },
  );
  const result = await runHardDeleteOperation({
    operationId: preview.operationId,
    workerDatabaseUrl: process.env.DATABASE_URL!,
    workerId,
    storage,
  });
  expect(result.status).toBe("COMPLETED");
  return preview.operationId;
}

test.beforeAll(async () => {
  storageRoot = await mkdtemp(
    path.join(os.tmpdir(), "product-hub-hard-delete-"),
  );
  storage = new LocalStorageProvider(storageRoot);
  assertDisposableEnvironment();
});

test.beforeEach(async () => {
  assertDisposableEnvironment();
  await resetState();
});

test.afterAll(async () => {
  await prisma.$disconnect();
  await rm(storageRoot, { recursive: true, force: true });
});

test("planner covers the authorized matrix, blockers, stable import references and shared object ref-count", async () => {
  const closure = await productClosureFixture();
  const productPlan = await readDatabasePlan("PRODUCT", closure.product.id);
  expect(productPlan.delete.assignments).toContain(closure.assignment.id);
  expect(productPlan.delete.quotes).toContain(closure.quote.id);
  expect(productPlan.delete.priceHistories).toContain(closure.history.id);
  expect(productPlan.delete.importRowsToDetach).toEqual([closure.importRow.id]);
  expect(productPlan.files).toHaveLength(2);

  await prisma.user.update({
    where: { id: fixtures.userAId },
    data: { banned: true },
  });
  await prisma.factory.update({
    where: { id: fixtures.factoryAId },
    data: { status: "DISABLED" },
  });
  const factoryPlan = await readDatabasePlan("FACTORY", fixtures.factoryAId);
  expect(factoryPlan.blockers).toEqual([]);
  expect(factoryPlan.delete.users).toContain(fixtures.userAId);
  expect(factoryPlan.preserve.products).toContain(closure.product.id);

  const userPlan = await readDatabasePlan("USER", fixtures.userAId);
  expect(userPlan.blockers).toEqual([]);
  expect(userPlan.delete.users).toEqual([fixtures.userAId]);

  const categoryPlan = await readDatabasePlan("CATEGORY", closure.category.id);
  expect(categoryPlan.blockers).toContain("CATEGORY_NOT_DISABLED");
  expect(categoryPlan.blockers).toContain("CATEGORY_HAS_PRODUCTS");
  const materialPlan = await readDatabasePlan("MATERIAL", closure.material.id);
  expect(materialPlan.blockers).toContain("MATERIAL_HAS_PRODUCTS");
  expect(
    (await readDatabasePlan("ASSIGNMENT", closure.assignment.id)).blockers,
  ).toEqual([]);
  expect((await readDatabasePlan("QUOTE", closure.quote.id)).blockers).toEqual(
    [],
  );

  await prisma.factoryPrivateImage.delete({
    where: { id: closure.privateImage.id },
  });
  await prisma.storedObject.delete({ where: { id: closure.privateObject.id } });
  const shared = closure.mainObject;
  await prisma.factoryPrivateImage.create({
    data: {
      assignmentId: closure.assignment.id,
      storedObjectId: shared.id,
      uploadedByUserId: fixtures.userAId,
    },
  });
  const mainPlan = await readDatabasePlan(
    "PRODUCT_MAIN_IMAGE",
    closure.mainImage.id,
  );
  expect(mainPlan.delete.storedObjects).toEqual([]);
  expect(mainPlan.files).toEqual([]);
  const privateRelation = await prisma.factoryPrivateImage.findUniqueOrThrow({
    where: { assignmentId: closure.assignment.id },
  });
  const privatePlan = await readDatabasePlan(
    "FACTORY_PRIVATE_IMAGE",
    privateRelation.id,
  );
  expect(privatePlan.delete.storedObjects).toEqual([]);
});

test("Admin control plane rejects Factory, tampered input, duplicate, stale, expired and double confirmation", async () => {
  const closure = await productClosureFixture();
  const factorySession = await newAuthRequest(
    usernames.factoryA,
    passwords.factoryA,
  );
  const factoryHeaders = await requestHeaders(factorySession.context);
  await expect(
    createHardDeletePreview(
      factoryHeaders,
      { targetType: "PRODUCT", targetId: closure.product.id },
      { storage },
    ),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  await factorySession.context.dispose();

  await expect(
    createHardDeletePreviewForAdmin(
      actor,
      {
        targetType: "PRODUCT",
        targetId: closure.product.id,
        dependencyIds: [closure.assignment.id],
      },
      { storage },
    ),
  ).rejects.toMatchObject({ kind: "VALIDATION" });

  const first = await createHardDeletePreviewForAdmin(
    actor,
    { targetType: "PRODUCT", targetId: closure.product.id },
    { storage },
  );
  const refreshed = await createHardDeletePreviewForAdmin(
    actor,
    { targetType: "PRODUCT", targetId: closure.product.id },
    { storage },
  );
  expect(refreshed.operationId).toBe(first.operationId);
  expect(await prisma.hardDeleteOperation.count()).toBe(1);
  if (
    !first.operationId ||
    !("previewSha256" in first) ||
    !("version" in first)
  ) {
    throw new Error("Expected preview operation");
  }
  await prisma.product.update({
    where: { id: closure.product.id },
    data: { notes: "stale change" },
  });
  await expect(
    confirmHardDeleteForAdmin(
      actor,
      {
        operationId: first.operationId,
        previewSha256: first.previewSha256,
        expectedVersion: first.version,
        confirmationPhrase: first.confirmationPhrase,
      },
      { storage },
    ),
  ).rejects.toMatchObject({ kind: "CONFLICT" });

  const fresh = await createHardDeletePreviewForAdmin(
    actor,
    { targetType: "PRODUCT", targetId: closure.product.id },
    { storage },
  );
  if (
    !fresh.operationId ||
    !("previewSha256" in fresh) ||
    !("version" in fresh)
  )
    throw new Error("Expected preview");
  await confirmHardDeleteForAdmin(
    actor,
    {
      operationId: fresh.operationId,
      previewSha256: fresh.previewSha256,
      expectedVersion: fresh.version,
      confirmationPhrase: fresh.confirmationPhrase,
    },
    { storage },
  );
  await expect(
    confirmHardDeleteForAdmin(
      actor,
      {
        operationId: fresh.operationId,
        previewSha256: fresh.previewSha256,
        expectedVersion: fresh.version,
        confirmationPhrase: fresh.confirmationPhrase,
      },
      { storage },
    ),
  ).rejects.toMatchObject({ kind: "CONFLICT" });

  const other = await prisma.product.create({
    data: {
      name: "Expired",
      status: "DISABLED",
      categoryId: closure.category.id,
      materialId: closure.material.id,
    },
  });
  const expired = await createHardDeletePreviewForAdmin(
    actor,
    { targetType: "PRODUCT", targetId: other.id },
    { storage },
  );
  if (
    !expired.operationId ||
    !("previewSha256" in expired) ||
    !("version" in expired)
  )
    throw new Error("Expected preview");
  await prisma.hardDeleteOperation.update({
    where: { id: expired.operationId },
    data: {
      requestedAt: new Date("2026-09-28T00:00:00Z"),
      expiresAt: new Date("2026-09-29T00:00:00Z"),
    },
  });
  await expect(
    confirmHardDeleteForAdmin(
      actor,
      {
        operationId: expired.operationId,
        previewSha256: expired.previewSha256,
        expectedVersion: expired.version,
        confirmationPhrase: expired.confirmationPhrase,
      },
      { storage, now: () => new Date("2026-09-29T01:00:00Z") },
    ),
  ).rejects.toMatchObject({ kind: "CONFLICT" });
});

test("worker commits DB closure before files, preserves import/business parents, and is idempotent", async () => {
  const { closure, preview } = await confirmedProductOperation();
  const result = await runHardDeleteOperation({
    workerDatabaseUrl: process.env.DATABASE_URL!,
    workerId: "phase2-worker-a",
    storage,
  });
  expect(result.status).toBe("COMPLETED");
  expect(result.operationId).toBe(preview.operationId);
  expect(
    await prisma.product.findUnique({ where: { id: closure.product.id } }),
  ).toBeNull();
  expect(
    await prisma.productFactoryAssignment.findUnique({
      where: { id: closure.assignment.id },
    }),
  ).toBeNull();
  expect(
    await prisma.factoryQuote.findUnique({ where: { id: closure.quote.id } }),
  ).toBeNull();
  expect(
    await prisma.priceHistory.findUnique({ where: { id: closure.history.id } }),
  ).toBeNull();
  expect(
    await prisma.storedObject.count({
      where: { id: { in: [closure.mainObject.id, closure.privateObject.id] } },
    }),
  ).toBe(0);
  expect(await storage.stat(closure.mainObject.storageKey)).toBeNull();
  expect(await storage.stat(closure.privateObject.storageKey)).toBeNull();
  expect(
    await prisma.category.findUnique({ where: { id: closure.category.id } }),
  ).not.toBeNull();
  expect(
    await prisma.material.findUnique({ where: { id: closure.material.id } }),
  ).not.toBeNull();
  expect(
    await prisma.factory.findUnique({ where: { id: fixtures.factoryAId } }),
  ).not.toBeNull();
  const preservedRow = await prisma.importRow.findUniqueOrThrow({
    where: { id: closure.importRow.id },
  });
  expect(preservedRow.targetProductId).toBeNull();
  expect(preservedRow.resolvedProductId).toBeNull();
  expect(
    await prisma.importJob.findUnique({ where: { id: closure.job.id } }),
  ).toMatchObject({ updateRows: 1, totalRows: 1 });
  expect(
    await prisma.hardDeleteFileTask.count({
      where: { operationId: preview.operationId!, status: "DELETED" },
    }),
  ).toBe(2);
  expect(
    (
      await prisma.hardDeleteOperation.findUniqueOrThrow({
        where: { id: preview.operationId! },
      })
    ).status,
  ).toBe("COMPLETED");

  const repeated = await runHardDeleteOperation({
    operationId: preview.operationId!,
    workerDatabaseUrl: process.env.DATABASE_URL!,
    workerId: "phase2-worker-repeat",
    storage,
  });
  expect(repeated).toMatchObject({
    status: "NOT_CLAIMED",
    reason: "COMPLETED",
  });
});

test("worker rejects a preview when the physical file inventory changes", async () => {
  const { preview } = await confirmedProductOperation();
  const unexpectedKey = createImageStorageKey();
  await storage.put(unexpectedKey, Buffer.from("unexpected-after-preview"));
  try {
    const result = await runHardDeleteOperation({
      operationId: preview.operationId!,
      workerDatabaseUrl: process.env.DATABASE_URL!,
      workerId: "file-state-stale-worker",
      storage,
    });
    expect(result).toMatchObject({
      status: "FAILED",
      failureCode: "STALE_PREVIEW",
    });
  } finally {
    await storage.delete(unexpectedKey);
  }
});

test("file task retries a transient storage deletion failure", async () => {
  const { preview } = await confirmedProductOperation();
  let failedOnce = false;
  const flakyStorage: StorageProvider = {
    name: "LOCAL",
    put: (key, bytes) => storage.put(key, bytes),
    open: (key) => storage.open(key),
    read: (key) => storage.read(key),
    copy: (source, destination) => storage.copy(source, destination),
    delete: async (key) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("transient storage failure");
      }
      await storage.delete(key);
    },
    stat: (key) => storage.stat(key),
    listKeys: () => storage.listKeys(),
  };
  const first = await runHardDeleteOperation({
    operationId: preview.operationId!,
    workerDatabaseUrl: process.env.DATABASE_URL!,
    workerId: "file-retry-first",
    storage: flakyStorage,
    leaseSeconds: 1,
    retryDelaySeconds: 1,
  });
  expect(first.status).toBe("FILES_PENDING");
  expect(
    await prisma.hardDeleteFileTask.count({
      where: {
        operationId: preview.operationId!,
        status: "RETRYABLE",
        errorCode: "STORAGE_DELETE_FAILED",
      },
    }),
  ).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const recovered = await runHardDeleteOperation({
    operationId: preview.operationId!,
    workerDatabaseUrl: process.env.DATABASE_URL!,
    workerId: "file-retry-recovery",
    storage,
    leaseSeconds: 5,
  });
  expect(recovered.status).toBe("COMPLETED");
});

test("fixed execution closures delete every other authorized target and preserve matrix parents", async () => {
  await prisma.user.update({
    where: { id: fixtures.userAId },
    data: { banned: true },
  });
  const userClosure = await productClosureFixture();
  await executeTarget("USER", fixtures.userAId, "matrix-user");
  expect(
    await prisma.user.findUnique({ where: { id: fixtures.userAId } }),
  ).toBeNull();
  expect(
    await prisma.factoryQuote.findUnique({
      where: { id: userClosure.quote.id },
    }),
  ).not.toBeNull();
  expect(
    (
      await prisma.priceHistory.findUniqueOrThrow({
        where: { id: userClosure.history.id },
      })
    ).changedByUserId,
  ).toBeNull();

  await resetState();
  const factoryClosure = await productClosureFixture();
  await prisma.user.update({
    where: { id: fixtures.userAId },
    data: { banned: true },
  });
  await prisma.factory.update({
    where: { id: fixtures.factoryAId },
    data: { status: "DISABLED" },
  });
  await executeTarget("FACTORY", fixtures.factoryAId, "matrix-factory");
  expect(
    await prisma.factory.findUnique({ where: { id: fixtures.factoryAId } }),
  ).toBeNull();
  expect(
    await prisma.product.findUnique({
      where: { id: factoryClosure.product.id },
    }),
  ).not.toBeNull();
  expect(
    await prisma.productMainImage.findUnique({
      where: { id: factoryClosure.mainImage.id },
    }),
  ).not.toBeNull();
  expect(
    await prisma.factoryPrivateImage.findUnique({
      where: { id: factoryClosure.privateImage.id },
    }),
  ).toBeNull();

  await resetState();
  const category = await prisma.category.create({
    data: {
      name: "Unused Category",
      nameNormalized: "unused category",
      status: "DISABLED",
    },
  });
  await executeTarget("CATEGORY", category.id, "matrix-category");
  expect(
    await prisma.category.findUnique({ where: { id: category.id } }),
  ).toBeNull();
  const material = await prisma.material.create({
    data: {
      name: "Unused Material",
      nameNormalized: "unused material",
      status: "DISABLED",
    },
  });
  await executeTarget("MATERIAL", material.id, "matrix-material");
  expect(
    await prisma.material.findUnique({ where: { id: material.id } }),
  ).toBeNull();

  await resetState();
  const assignmentClosure = await productClosureFixture();
  await executeTarget(
    "ASSIGNMENT",
    assignmentClosure.assignment.id,
    "matrix-assignment",
  );
  expect(
    await prisma.productFactoryAssignment.findUnique({
      where: { id: assignmentClosure.assignment.id },
    }),
  ).toBeNull();
  expect(
    await prisma.product.findUnique({
      where: { id: assignmentClosure.product.id },
    }),
  ).not.toBeNull();
  expect(
    await prisma.productMainImage.findUnique({
      where: { id: assignmentClosure.mainImage.id },
    }),
  ).not.toBeNull();

  await resetState();
  const quoteClosure = await productClosureFixture();
  await executeTarget("QUOTE", quoteClosure.quote.id, "matrix-quote");
  expect(
    await prisma.factoryQuote.findUnique({
      where: { id: quoteClosure.quote.id },
    }),
  ).toBeNull();
  expect(
    await prisma.productFactoryAssignment.findUnique({
      where: { id: quoteClosure.assignment.id },
    }),
  ).not.toBeNull();
  expect(
    await prisma.factoryPrivateImage.findUnique({
      where: { id: quoteClosure.privateImage.id },
    }),
  ).not.toBeNull();

  await resetState();
  const mainClosure = await productClosureFixture();
  await executeTarget(
    "PRODUCT_MAIN_IMAGE",
    mainClosure.mainImage.id,
    "matrix-main-image",
  );
  expect(
    await prisma.productMainImage.findUnique({
      where: { id: mainClosure.mainImage.id },
    }),
  ).toBeNull();
  expect(
    await prisma.product.findUnique({ where: { id: mainClosure.product.id } }),
  ).not.toBeNull();
  expect(
    await prisma.factoryPrivateImage.findUnique({
      where: { id: mainClosure.privateImage.id },
    }),
  ).not.toBeNull();

  await resetState();
  const privateClosure = await productClosureFixture();
  await executeTarget(
    "FACTORY_PRIVATE_IMAGE",
    privateClosure.privateImage.id,
    "matrix-private-image",
  );
  expect(
    await prisma.factoryPrivateImage.findUnique({
      where: { id: privateClosure.privateImage.id },
    }),
  ).toBeNull();
  expect(
    await prisma.productMainImage.findUnique({
      where: { id: privateClosure.mainImage.id },
    }),
  ).not.toBeNull();
  expect(
    await prisma.productFactoryAssignment.findUnique({
      where: { id: privateClosure.assignment.id },
    }),
  ).not.toBeNull();
});

for (const point of [
  "BEFORE_DATABASE_EXECUTION",
  "AFTER_DATABASE_COMMIT",
  "AFTER_FILE_DELETE",
  "AFTER_ALL_FILES",
] as const) {
  test(`worker recovers after ${point}`, async () => {
    const { preview } = await confirmedProductOperation();
    let crashed = false;
    await expect(
      runHardDeleteOperation({
        operationId: preview.operationId!,
        workerDatabaseUrl: process.env.DATABASE_URL!,
        workerId: `crash-${point}`,
        storage,
        leaseSeconds: 1,
        faultInjector: async (current) => {
          if (!crashed && current === point) {
            crashed = true;
            throw new SimulatedHardDeleteCrash(point);
          }
        },
      }),
    ).rejects.toBeInstanceOf(SimulatedHardDeleteCrash);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const recovered = await runHardDeleteOperation({
      operationId: preview.operationId!,
      workerDatabaseUrl: process.env.DATABASE_URL!,
      workerId: `recovery-${point}`,
      storage,
      leaseSeconds: 5,
    });
    expect(recovered.status).toBe("COMPLETED");
  });
}

test("database transaction failure rolls back closure and concurrent workers cannot both claim", async () => {
  const { closure, preview } = await confirmedProductOperation();
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION public.phase2_fail_product_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'phase2 injected database failure'; END; $$;
    CREATE TRIGGER phase2_fail_product_delete BEFORE DELETE ON public."Product"
    FOR EACH ROW EXECUTE FUNCTION public.phase2_fail_product_delete();
  `);
  try {
    await expect(
      runHardDeleteOperation({
        operationId: preview.operationId!,
        workerDatabaseUrl: process.env.DATABASE_URL!,
        workerId: "rollback-worker",
        storage,
        leaseSeconds: 1,
      }),
    ).rejects.toThrow(/phase2 injected database failure/);
    expect(
      await prisma.product.findUnique({ where: { id: closure.product.id } }),
    ).not.toBeNull();
    expect(
      await prisma.hardDeleteFileTask.count({
        where: { operationId: preview.operationId! },
      }),
    ).toBe(0);
  } finally {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS phase2_fail_product_delete ON public."Product";
      DROP FUNCTION IF EXISTS public.phase2_fail_product_delete();
    `);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const [left, right] = await Promise.all([
    runHardDeleteOperation({
      operationId: preview.operationId!,
      workerDatabaseUrl: process.env.DATABASE_URL!,
      workerId: "concurrent-left",
      storage,
      leaseSeconds: 10,
    }),
    runHardDeleteOperation({
      operationId: preview.operationId!,
      workerDatabaseUrl: process.env.DATABASE_URL!,
      workerId: "concurrent-right",
      storage,
      leaseSeconds: 10,
    }),
  ]);
  expect(
    [left.status, right.status].filter((status) => status === "COMPLETED"),
  ).toHaveLength(1);
  expect([left.status, right.status]).toContain("NOT_CLAIMED");
});
