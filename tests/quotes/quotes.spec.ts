import { expect, test } from "@playwright/test";

import {
  assignProductToFactory,
  reactivateAssignment,
  revokeAssignment,
} from "../../src/features/assignments/service";
import { createCategory } from "../../src/features/categories/service";
import {
  createFactory,
  setFactoryStatus,
} from "../../src/features/factories/service";
import { createMaterial } from "../../src/features/materials/service";
import {
  createProduct,
  setProductStatus,
} from "../../src/features/products/service";
import {
  getAdminQuote,
  getOwnQuoteForAssignment,
  listAdminPriceHistory,
  listAdminQuotes,
  listOwnPriceHistory,
  submitOwnQuote,
} from "../../src/features/quotes/service";
import { createFactoryUser } from "../../src/lib/auth/accounts";
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
type AssignmentFixture = Awaited<ReturnType<typeof assignProductToFactory>>;

let fixtures: TestFixtures;
let adminHeaders: Headers;
let factoryAHeaders: Headers;
let factoryBHeaders: Headers;
let product: ProductFixture;
let assignmentA: AssignmentFixture;
let contexts: AuthRequest[] = [];

async function login(username: string, password: string) {
  const session = await newAuthRequest(username, password);
  expect(session.response.ok()).toBeTruthy();
  contexts.push(session);
  return { session, headers: await requestHeaders(session.context) };
}

async function requiredOwnQuote(headers: Headers, assignmentId: string) {
  const quote = await getOwnQuoteForAssignment(headers, assignmentId);
  if (!quote) throw new Error("Expected the assignment to have a quote.");
  return quote;
}

async function resetQuoteFixtures() {
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

  const category = await createCategory(adminHeaders, {
    name: "Test Quote 分类",
  });
  const material = await createMaterial(adminHeaders, {
    name: "Test Quote 材质",
  });
  product = await createProduct(adminHeaders, {
    categoryId: category.id,
    materialId: material.id,
    sku: "QUOTE-A",
    name: "Test Quote Product A",
  });
  assignmentA = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryAId,
  });
}

function quoteInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { assignmentId: assignmentA.id, price: "328", ...overrides };
}

test.beforeEach(async () => {
  await resetQuoteFixtures();
});

test.afterEach(async () => {
  await Promise.all(contexts.map(({ context }) => context.dispose()));
  contexts = [];
});

test("first submit requires a valid RMB price and creates the initial history atomically", async () => {
  for (const price of ["0", "-1", "328.123"]) {
    await expect(
      submitOwnQuote(factoryAHeaders, quoteInput({ price })),
    ).rejects.toMatchObject({ kind: "VALIDATION" });
  }
  expect(await prisma.factoryQuote.count()).toBe(0);
  expect(await prisma.priceHistory.count()).toBe(0);

  const quote = await submitOwnQuote(factoryAHeaders, quoteInput());
  expect(quote).toMatchObject({
    assignmentId: assignmentA.id,
    priceCents: "32800",
    moq: null,
    packingLengthCm: null,
    packingWidthCm: null,
    packingHeightCm: null,
    cbmM3: null,
    netWeightKg: null,
    grossWeightKg: null,
    pcsPerCarton: null,
    factoryNotes: null,
    version: 1,
  });
  expect(quote.submittedAt).toBeInstanceOf(Date);

  const history = await listOwnPriceHistory(factoryAHeaders, {
    quoteId: quote.id,
  });
  expect(history.total).toBe(1);
  expect(history.items[0]).toMatchObject({
    factoryQuoteId: quote.id,
    oldPriceCents: null,
    newPriceCents: "32800",
    changedByUserId: fixtures.userAId,
  });
  expect(history.items[0]!.changedAt).toBeInstanceOf(Date);
});

test("optional quote fields validate precisely and CBM is derived with Decimal arithmetic", async () => {
  const notes = "<script>alert('plain text only')</script>";
  const quote = await submitOwnQuote(
    factoryAHeaders,
    quoteInput({
      price: "328.50",
      moq: 20,
      packingLengthCm: "75",
      packingWidthCm: "42.5",
      packingHeightCm: "18.25",
      netWeightKg: "6.85",
      grossWeightKg: "7.1",
      pcsPerCarton: 4,
      factoryNotes: notes,
    }),
  );
  expect(quote).toMatchObject({
    priceCents: "32850",
    moq: 20,
    packingLengthCm: "75",
    packingWidthCm: "42.5",
    packingHeightCm: "18.25",
    cbmM3: "0.058171875",
    netWeightKg: "6.85",
    grossWeightKg: "7.1",
    pcsPerCarton: 4,
    factoryNotes: notes,
  });

  let version = quote.version;
  const partial = await submitOwnQuote(
    factoryAHeaders,
    quoteInput({
      expectedVersion: version,
      packingLengthCm: "42.5",
      netWeightKg: "5",
    }),
  );
  version = partial.version;
  expect(partial.cbmM3).toBeNull();
  expect(partial.grossWeightKg).toBeNull();

  const equalWeights = await submitOwnQuote(
    factoryAHeaders,
    quoteInput({
      expectedVersion: version,
      grossWeightKg: "5",
      netWeightKg: "5",
    }),
  );
  expect(equalWeights.grossWeightKg).toBe("5");
  expect(equalWeights.netWeightKg).toBe("5");

  const invalidCases = [
    { moq: 0 },
    { moq: -1 },
    { moq: 1.5 },
    { packingLengthCm: "0" },
    { packingWidthCm: "-1" },
    { packingHeightCm: "1.2345" },
    { netWeightKg: "0" },
    { grossWeightKg: "-1" },
    { netWeightKg: "6", grossWeightKg: "5" },
    { pcsPerCarton: 0 },
    { pcsPerCarton: -1 },
    { pcsPerCarton: 1.5 },
    { factoryNotes: "x".repeat(5001) },
  ];
  for (const values of invalidCases) {
    await expect(
      submitOwnQuote(
        factoryAHeaders,
        quoteInput({ expectedVersion: equalWeights.version, ...values }),
      ),
    ).rejects.toMatchObject({ kind: "VALIDATION" });
  }
  expect(
    (await requiredOwnQuote(factoryAHeaders, assignmentA.id)).version,
  ).toBe(equalWeights.version);
});

test("updates append only real price changes and reject stale versions", async () => {
  const first = await submitOwnQuote(
    factoryAHeaders,
    quoteInput({ price: "338" }),
  );
  const second = await submitOwnQuote(
    factoryAHeaders,
    quoteInput({ price: "328", expectedVersion: first.version }),
  );
  const packagingOnly = await submitOwnQuote(
    factoryAHeaders,
    quoteInput({
      price: "328",
      expectedVersion: second.version,
      packingLengthCm: "75",
    }),
  );
  expect(packagingOnly.version).toBe(3);
  expect(await prisma.priceHistory.count()).toBe(2);

  const outcomes = await Promise.allSettled([
    submitOwnQuote(
      factoryAHeaders,
      quoteInput({ price: "315", expectedVersion: packagingOnly.version }),
    ),
    submitOwnQuote(
      factoryAHeaders,
      quoteInput({ price: "310", expectedVersion: packagingOnly.version }),
    ),
  ]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  const rejected = outcomes.find(({ status }) => status === "rejected");
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: {
      kind: "CONFLICT",
      message: "该报价已被其他用户更新，请刷新后重试。",
    },
  });

  const current = await requiredOwnQuote(factoryAHeaders, assignmentA.id);
  expect(current.version).toBe(4);
  const history = await listAdminPriceHistory(adminHeaders, {
    quoteId: first.id,
  });
  expect(history.total).toBe(3);
  expect(history.items.map((item) => item.newPriceCents)).toEqual([
    current.priceCents,
    "32800",
    "33800",
  ]);
  expect(history.items.map((item) => item.oldPriceCents)).toEqual([
    "32800",
    "33800",
    null,
  ]);
  expect(
    history.items.every((item) => item.changedByUserId === fixtures.userAId),
  ).toBeTruthy();
});

test("one Product supports three tenant-isolated quotes while Admin can compare all", async () => {
  const assignmentB = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: fixtures.factoryBId,
  });
  const factoryC = await createFactory(adminHeaders, { name: "Factory C" });
  await createFactoryUser(adminHeaders, {
    factoryId: factoryC.id,
    username: "factory.c",
    password: passwords.factoryB,
    name: "Factory C User",
  });
  const factoryCHeaders = (await login("factory.c", passwords.factoryB))
    .headers;
  const assignmentC = await assignProductToFactory(adminHeaders, {
    productId: product.id,
    factoryId: factoryC.id,
  });

  const [quoteA, quoteB, quoteC] = await Promise.all([
    submitOwnQuote(factoryAHeaders, quoteInput({ price: "328" })),
    submitOwnQuote(factoryBHeaders, {
      assignmentId: assignmentB.id,
      price: "315",
    }),
    submitOwnQuote(factoryCHeaders, {
      assignmentId: assignmentC.id,
      price: "345",
    }),
  ]);
  const adminList = await listAdminQuotes(adminHeaders, {
    productId: product.id,
  });
  expect(adminList.total).toBe(3);
  expect(adminList.items.map((item) => item.priceCents).sort()).toEqual([
    "31500",
    "32800",
    "34500",
  ]);
  expect(
    (await requiredOwnQuote(factoryAHeaders, assignmentA.id)).priceCents,
  ).toBe("32800");
  expect(
    (await requiredOwnQuote(factoryBHeaders, assignmentB.id)).priceCents,
  ).toBe("31500");
  expect(
    (await requiredOwnQuote(factoryCHeaders, assignmentC.id)).priceCents,
  ).toBe("34500");

  await expect(
    getOwnQuoteForAssignment(factoryAHeaders, assignmentB.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(
    submitOwnQuote(factoryAHeaders, {
      assignmentId: assignmentB.id,
      price: "1",
    }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(
    listOwnPriceHistory(factoryAHeaders, { quoteId: quoteB.id }),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(getAdminQuote(factoryAHeaders, quoteC.id)).rejects.toMatchObject(
    {
      kind: "FORBIDDEN",
    },
  );
  await expect(
    submitOwnQuote(
      factoryAHeaders,
      quoteInput({
        quoteId: quoteA.id,
        productId: product.id,
        factoryId: fixtures.factoryBId,
      }),
    ),
  ).rejects.toMatchObject({ kind: "VALIDATION" });
  await expect(
    submitOwnQuote(adminHeaders, quoteInput({ price: "1" })),
  ).rejects.toMatchObject({ kind: "FORBIDDEN" });
});

test("revocation and disabled entities hide Factory access without deleting history", async () => {
  const quote = await submitOwnQuote(factoryAHeaders, quoteInput());
  await revokeAssignment(adminHeaders, { assignmentId: assignmentA.id });
  await expect(
    getOwnQuoteForAssignment(factoryAHeaders, assignmentA.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await expect(
    submitOwnQuote(
      factoryAHeaders,
      quoteInput({ expectedVersion: quote.version }),
    ),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  expect((await getAdminQuote(adminHeaders, quote.id)).priceCents).toBe(
    "32800",
  );
  expect(
    (await listAdminPriceHistory(adminHeaders, { quoteId: quote.id })).total,
  ).toBe(1);

  await reactivateAssignment(adminHeaders, { assignmentId: assignmentA.id });
  const reactivated = await requiredOwnQuote(factoryAHeaders, assignmentA.id);
  expect(reactivated.id).toBe(quote.id);
  const updated = await submitOwnQuote(
    factoryAHeaders,
    quoteInput({ price: "315", expectedVersion: reactivated.version }),
  );
  expect(updated.id).toBe(quote.id);
  expect(
    (await listOwnPriceHistory(factoryAHeaders, { quoteId: quote.id })).total,
  ).toBe(2);

  await setProductStatus(adminHeaders, { id: product.id, status: "DISABLED" });
  await expect(
    getOwnQuoteForAssignment(factoryAHeaders, assignmentA.id),
  ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  await setProductStatus(adminHeaders, { id: product.id, status: "ENABLED" });
  expect((await requiredOwnQuote(factoryAHeaders, assignmentA.id)).id).toBe(
    quote.id,
  );

  await setFactoryStatus(adminHeaders, {
    id: fixtures.factoryAId,
    status: "DISABLED",
  });
  await expect(
    getOwnQuoteForAssignment(factoryAHeaders, assignmentA.id),
  ).rejects.toMatchObject({ kind: "UNAUTHENTICATED" });
  expect(await prisma.factoryQuote.count()).toBe(1);
  expect(await prisma.priceHistory.count()).toBe(2);
  await setFactoryStatus(adminHeaders, {
    id: fixtures.factoryAId,
    status: "ACTIVE",
  });
  const reloggedHeaders = (await login(usernames.factoryA, passwords.factoryA))
    .headers;
  expect((await requiredOwnQuote(reloggedHeaders, assignmentA.id)).id).toBe(
    quote.id,
  );
});

test("database relations protect quote history and anonymize deleted actor provenance", async () => {
  await expect(
    prisma.factoryQuote.create({
      data: { assignmentId: assignmentA.id, priceCents: 0n },
    }),
  ).rejects.toBeTruthy();
  const quote = await submitOwnQuote(factoryAHeaders, quoteInput());
  await expect(
    prisma.factoryQuote.update({
      where: { id: quote.id },
      data: { netWeightKg: "6", grossWeightKg: "5" },
    }),
  ).rejects.toBeTruthy();
  await expect(
    prisma.factoryQuote.update({
      where: { id: quote.id },
      data: { version: 0 },
    }),
  ).rejects.toBeTruthy();
  await expect(
    prisma.priceHistory.create({
      data: {
        factoryQuoteId: quote.id,
        oldPriceCents: 32800n,
        newPriceCents: 32800n,
        changedByUserId: fixtures.userAId,
      },
    }),
  ).rejects.toBeTruthy();
  await expect(
    prisma.factoryQuote.delete({ where: { id: quote.id } }),
  ).rejects.toBeTruthy();
  await expect(
    prisma.productFactoryAssignment.delete({ where: { id: assignmentA.id } }),
  ).rejects.toBeTruthy();
  await prisma.user.delete({ where: { id: fixtures.userAId } });
  expect(await prisma.priceHistory.count()).toBe(1);
  expect(
    await prisma.priceHistory.findFirst({
      where: { factoryQuoteId: quote.id },
      select: { changedByUserId: true },
    }),
  ).toEqual({ changedByUserId: null });
});
