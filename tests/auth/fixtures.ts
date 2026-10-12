import { randomUUID } from "node:crypto";

import { request, type APIRequestContext } from "@playwright/test";

import { auth } from "../../src/lib/auth/auth";
import { prisma } from "../../src/lib/db/prisma";

export const usernames = {
  admin: "admin.user",
  factoryA: "factory.a",
  factoryB: "factory.b",
} as const;

export const passwords = {
  admin: process.env.TEST_ADMIN_PASSWORD!,
  factoryA: process.env.TEST_FACTORY_A_PASSWORD!,
  factoryB: process.env.TEST_FACTORY_B_PASSWORD!,
  next: process.env.TEST_NEW_PASSWORD!,
} as const;

export type TestFixtures = Awaited<ReturnType<typeof resetAuthFixtures>>;

function assertTestDatabase() {
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (!database.endsWith("_test")) {
    throw new Error(
      "Destructive fixture reset refused outside a *_test database.",
    );
  }
}

export async function resetTestRateLimits() {
  assertTestDatabase();
  await prisma.rateLimit.deleteMany();
}

async function createUser(input: {
  username: string;
  password: string;
  role: "ADMIN" | "FACTORY";
  factoryId: string | null;
}) {
  return auth.api.createUser({
    body: {
      email: `${randomUUID()}@users.invalid`,
      password: input.password,
      name: input.username,
      role: input.role,
      data: {
        username: input.username,
        factoryId: input.factoryId,
      },
    },
  });
}

export async function resetAuthFixtures() {
  assertTestDatabase();
  await prisma.$transaction([
    prisma.hardDeleteFileTask.deleteMany(),
    prisma.session.deleteMany(),
    prisma.account.deleteMany(),
    prisma.importRow.deleteMany(),
    prisma.hardDeleteOperation.deleteMany(),
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
    prisma.user.deleteMany(),
    prisma.rateLimit.deleteMany(),
    prisma.factory.deleteMany(),
  ]);

  const [factoryA, factoryB] = await Promise.all([
    prisma.factory.create({
      data: { name: "Factory A", nameNormalized: "factory a" },
    }),
    prisma.factory.create({
      data: { name: "Factory B", nameNormalized: "factory b" },
    }),
  ]);
  const admin = await createUser({
    username: usernames.admin,
    password: passwords.admin,
    role: "ADMIN",
    factoryId: null,
  });
  const userA = await createUser({
    username: usernames.factoryA,
    password: passwords.factoryA,
    role: "FACTORY",
    factoryId: factoryA.id,
  });
  const userB = await createUser({
    username: usernames.factoryB,
    password: passwords.factoryB,
    role: "FACTORY",
    factoryId: factoryB.id,
  });

  return {
    adminId: admin.user.id,
    factoryAId: factoryA.id,
    factoryBId: factoryB.id,
    userAId: userA.user.id,
    userBId: userB.user.id,
  };
}

export async function newAuthRequest(username: string, password: string) {
  const context = await request.newContext({
    baseURL: "http://127.0.0.1:3100",
    extraHTTPHeaders: { origin: "http://127.0.0.1:3100" },
  });
  const response = await context.post("/api/auth/sign-in/username", {
    data: { username, password },
  });
  return { context, response };
}

export async function requestHeaders(context: APIRequestContext) {
  const state = await context.storageState();
  const cookie = state.cookies
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  return new Headers({
    cookie,
    origin: "http://127.0.0.1:3100",
  });
}
