import { expect } from "@playwright/test";
import { test } from "../support/diagnostic-test";

import {
  changeOwnPassword,
  createFactoryUser,
  resetFactoryUserPassword,
  setFactoryEnabled,
  setFactoryUserEnabled,
} from "../../src/lib/auth/accounts";
import { AuthorizationError } from "../../src/lib/auth/context-core";
import { prisma } from "../../src/lib/db/prisma";
import {
  newAuthRequest,
  passwords,
  requestHeaders,
  resetAuthFixtures,
  type TestFixtures,
  usernames,
} from "./fixtures";

test.describe.configure({ mode: "serial" });

let fixtures: TestFixtures;

test.beforeEach(async () => {
  fixtures = await resetAuthFixtures();
});

test("unauthenticated and cross-role page access is denied", async ({
  browser,
  request,
}) => {
  expect((await request.get("/admin", { maxRedirects: 0 })).status()).toBe(307);
  expect((await request.get("/factory", { maxRedirects: 0 })).status()).toBe(
    307,
  );

  const admin = await newAuthRequest(usernames.admin, passwords.admin);
  expect(admin.response.ok()).toBeTruthy();
  const adminBrowser = await browser.newContext({
    storageState: await admin.context.storageState(),
  });
  const adminPage = await adminBrowser.newPage();
  await adminPage.goto("/factory");
  await expect(adminPage).toHaveURL(/\/admin$/);

  const factory = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  const factoryBrowser = await browser.newContext({
    storageState: await factory.context.storageState(),
  });
  const factoryPage = await factoryBrowser.newPage();
  await factoryPage.goto("/admin");
  await expect(factoryPage).toHaveURL(/\/factory$/);

  await Promise.all([
    admin.context.dispose(),
    factory.context.dispose(),
    adminBrowser.close(),
    factoryBrowser.close(),
  ]);
});

test("login is case-insensitive and failures do not enumerate usernames", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(usernames.admin.toUpperCase());
  await page.getByLabel("密码").fill(passwords.admin);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin$/);

  await page.context().clearCookies();
  for (const [username, password] of [
    ["unknown.user", passwords.admin],
    [usernames.admin, "definitely-wrong"],
  ]) {
    await page.goto("/login");
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();
  }
});

test("hidden email stays internal and the minimal login works at mobile width", async ({
  page,
}) => {
  const login = await newAuthRequest(usernames.admin, passwords.admin);
  const body = await login.response.text();
  expect(body).not.toContain("@users.invalid");
  expect(body).not.toContain('"email"');
  const stored = await prisma.user.findUniqueOrThrow({
    where: { id: fixtures.adminId },
    select: { email: true },
  });
  expect(stored.email.endsWith("@users.invalid")).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "内部登录" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await login.context.dispose();
});

test("public signup, email login and username availability endpoints stay closed", async ({
  request,
}) => {
  const paths = [
    "/api/auth/sign-up/email",
    "/api/auth/sign-in/email",
    "/api/auth/is-username-available?username=admin.user",
    "/api/auth/request-password-reset",
  ];
  for (const path of paths) {
    const response = await request.fetch(path, {
      method: path.includes("available") ? "GET" : "POST",
      headers: { origin: "http://127.0.0.1:3100" },
      data: {},
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
  }
});

test("origin checks reject cross-site password requests and login rate limits persist in PostgreSQL", async ({
  request,
}) => {
  const signedIn = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  const crossSite = await signedIn.context.post("/api/auth/change-password", {
    headers: { origin: "https://attacker.invalid" },
    data: {
      currentPassword: passwords.factoryA,
      newPassword: passwords.next,
      revokeOtherSessions: true,
    },
  });
  expect(crossSite.status()).toBe(403);

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await request.post("/api/auth/sign-in/username", {
      headers: { origin: "http://127.0.0.1:3100" },
      data: { username: "rate.limit", password: "wrong-password" },
    });
    statuses.push(response.status());
  }
  expect(statuses.slice(0, 4).every((status) => status === 401)).toBeTruthy();
  expect(statuses.slice(4)).toEqual([429, 429]);
  expect(await prisma.rateLimit.count()).toBeGreaterThan(0);
  await signedIn.context.dispose();
});

test("logout clears the browser session and returns to login", async ({
  browser,
}) => {
  const factory = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  const context = await browser.newContext({
    storageState: await factory.context.storageState(),
  });
  const page = await context.newPage();
  await page.goto("/factory");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  const session = await page.request.get("/api/auth/get-session");
  expect(await session.json()).toBeNull();
  await Promise.all([factory.context.dispose(), context.close()]);
});

test("disabled users lose current sessions and cannot create new ones", async () => {
  const admin = await newAuthRequest(usernames.admin, passwords.admin);
  const factory = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  await setFactoryUserEnabled(await requestHeaders(admin.context), {
    userId: fixtures.userAId,
    enabled: false,
  });

  const current = await factory.context.get("/api/auth/get-session");
  expect(await current.json()).toBeNull();
  const next = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  expect(next.response.ok()).toBeFalsy();

  await Promise.all([
    admin.context.dispose(),
    factory.context.dispose(),
    next.context.dispose(),
  ]);
});

test("disabled factories lose all sessions and cannot log in", async () => {
  const admin = await newAuthRequest(usernames.admin, passwords.admin);
  const factory = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  await setFactoryEnabled(await requestHeaders(admin.context), {
    factoryId: fixtures.factoryAId,
    enabled: false,
  });

  expect(
    await (await factory.context.get("/api/auth/get-session")).json(),
  ).toBeNull();
  const next = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  expect(next.response.ok()).toBeFalsy();

  await Promise.all([
    admin.context.dispose(),
    factory.context.dispose(),
    next.context.dispose(),
  ]);
});

test("factory tenant identity comes from the session and tampering is not found", async ({
  browser,
}) => {
  const factory = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  const context = await browser.newContext({
    storageState: await factory.context.storageState(),
  });
  const page = await context.newPage();
  await page.goto("/factory");
  await expect(page.getByTestId("factory-name")).toHaveText("Factory A");
  const response = await page.goto(`/factory?factoryId=${fixtures.factoryBId}`);
  expect(response?.status()).toBe(404);
  await Promise.all([factory.context.dispose(), context.close()]);
});

test("admin reset uses official hashing and invalidates old sessions", async () => {
  const admin = await newAuthRequest(usernames.admin, passwords.admin);
  const old = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  expect(old.response.status()).toBe(200);
  const previous = await (
    await old.context.get("/api/auth/get-session")
  ).json();
  expect(previous?.user?.id).toBe(fixtures.userAId);
  await resetFactoryUserPassword(await requestHeaders(admin.context), {
    userId: fixtures.userAId,
    newPassword: passwords.next,
  });
  // No intervening DB query or wait: success must mean immediately usable.
  const newPassword = await newAuthRequest(usernames.factoryA, passwords.next);
  expect(newPassword.response.status()).toBe(200);
  const current = await (
    await newPassword.context.get("/api/auth/get-session")
  ).json();
  expect(current?.user?.id).toBe(fixtures.userAId);
  expect(current.session.id).not.toBe(previous.session.id);
  expect(
    await prisma.session.findUnique({ where: { id: previous.session.id } }),
  ).toBeNull();
  expect(
    await (await old.context.get("/api/auth/get-session")).json(),
  ).toBeNull();
  const oldPassword = await newAuthRequest(
    usernames.factoryA,
    passwords.factoryA,
  );
  expect(oldPassword.response.status()).toBe(401);

  await Promise.all([
    admin.context.dispose(),
    old.context.dispose(),
    oldPassword.context.dispose(),
    newPassword.context.dispose(),
  ]);
});

test("factory self-service requires the current password and revokes other sessions", async ({
  browser,
}) => {
  const first = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  const second = await newAuthRequest(usernames.factoryA, passwords.factoryA);

  await expect(
    changeOwnPassword(await requestHeaders(first.context), {
      currentPassword: "wrong-current-password",
      newPassword: passwords.next,
    }),
  ).rejects.toBeDefined();
  const firstBrowser = await browser.newContext({
    storageState: await first.context.storageState(),
  });
  const page = await firstBrowser.newPage();
  await page.goto("/factory");
  await page.getByLabel("当前密码").fill(passwords.factoryA);
  await page.getByLabel("新密码（至少 8 位）").fill(passwords.next);
  await page.getByRole("button", { name: "更新密码" }).click();
  await expect(
    page.getByText("密码已更新，其他登录会话已退出。"),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/factory$/);
  expect(
    await (await second.context.get("/api/auth/get-session")).json(),
  ).toBeNull();
  await Promise.all([
    first.context.dispose(),
    second.context.dispose(),
    firstBrowser.close(),
  ]);
});

test("only an admin can create a factory-bound user for an active factory", async () => {
  const admin = await newAuthRequest(usernames.admin, passwords.admin);
  const factory = await newAuthRequest(usernames.factoryA, passwords.factoryA);

  const created = await createFactoryUser(await requestHeaders(admin.context), {
    factoryId: fixtures.factoryAId,
    username: "NEW.Factory",
    password: passwords.next,
    name: "New Factory User",
  });
  expect(created.username).toBe("new.factory");
  expect(created.factoryId).toBe(fixtures.factoryAId);

  await expect(
    createFactoryUser(await requestHeaders(factory.context), {
      factoryId: fixtures.factoryAId,
      username: "forbidden.user",
      password: passwords.next,
      name: "Forbidden",
    }),
  ).rejects.toMatchObject({
    kind: "FORBIDDEN",
  } satisfies Partial<AuthorizationError>);

  await setFactoryEnabled(await requestHeaders(admin.context), {
    factoryId: fixtures.factoryBId,
    enabled: false,
  });
  await expect(
    createFactoryUser(await requestHeaders(admin.context), {
      factoryId: fixtures.factoryBId,
      username: "disabled.factory",
      password: passwords.next,
      name: "Disabled Factory",
    }),
  ).rejects.toMatchObject({
    kind: "NOT_FOUND",
  } satisfies Partial<AuthorizationError>);

  await Promise.all([admin.context.dispose(), factory.context.dispose()]);
});

test("admin user lifecycle records safe Business ActivityLog events with server-derived actors", async () => {
  const admin = await newAuthRequest(usernames.admin, passwords.admin);
  const factory = await newAuthRequest(usernames.factoryA, passwords.factoryA);
  const adminHeaders = await requestHeaders(admin.context);
  const factoryHeaders = await requestHeaders(factory.context);

  const created = await createFactoryUser(adminHeaders, {
    factoryId: fixtures.factoryAId,
    username: "audit.factory",
    password: passwords.next,
    name: "Audit Factory User",
  });
  const createdEvent = await prisma.activityLog.findFirstOrThrow({
    where: { entityId: created.id, eventType: "USER_CREATED" },
  });
  expect(createdEvent).toMatchObject({
    entityType: "USER",
    entityId: created.id,
    entityLabelSnapshot: "audit.factory",
    actorSource: "USER",
    actorUserId: fixtures.adminId,
    actorRole: "ADMIN",
    actorUsernameSnapshot: usernames.admin,
    factoryId: fixtures.factoryAId,
    changes: {
      username: { before: null, after: "audit.factory" },
      status: { before: null, after: "ENABLED" },
      factoryId: { before: null, after: fixtures.factoryAId },
    },
  });
  expect(createdEvent.createdAt).toBeInstanceOf(Date);

  await expect(
    setFactoryUserEnabled(factoryHeaders, {
      userId: created.id,
      enabled: false,
    }),
  ).rejects.toMatchObject({
    kind: "FORBIDDEN",
  } satisfies Partial<AuthorizationError>);
  await expect(
    setFactoryUserEnabled(adminHeaders, {
      userId: "missing-user",
      enabled: false,
    }),
  ).rejects.toMatchObject({
    kind: "NOT_FOUND",
  } satisfies Partial<AuthorizationError>);
  expect(
    await prisma.activityLog.count({ where: { entityId: created.id } }),
  ).toBe(1);

  await setFactoryUserEnabled(adminHeaders, {
    userId: created.id,
    enabled: false,
  });
  const disabledEvent = await prisma.activityLog.findFirstOrThrow({
    where: { entityId: created.id, eventType: "USER_DISABLED" },
  });
  expect(disabledEvent).toMatchObject({
    entityType: "USER",
    entityId: created.id,
    entityLabelSnapshot: "audit.factory",
    actorSource: "USER",
    actorUserId: fixtures.adminId,
    actorRole: "ADMIN",
    actorUsernameSnapshot: usernames.admin,
    factoryId: fixtures.factoryAId,
    changes: { status: { before: "ENABLED", after: "DISABLED" } },
  });
  expect(disabledEvent.createdAt).toBeInstanceOf(Date);
  await setFactoryUserEnabled(adminHeaders, {
    userId: created.id,
    enabled: false,
  });
  expect(
    await prisma.activityLog.count({
      where: { entityId: created.id, eventType: "USER_DISABLED" },
    }),
  ).toBe(1);

  await setFactoryUserEnabled(adminHeaders, {
    userId: created.id,
    enabled: true,
  });
  const enabledEvent = await prisma.activityLog.findFirstOrThrow({
    where: { entityId: created.id, eventType: "USER_ENABLED" },
  });
  expect(enabledEvent).toMatchObject({
    entityType: "USER",
    entityId: created.id,
    entityLabelSnapshot: "audit.factory",
    actorSource: "USER",
    actorUserId: fixtures.adminId,
    actorRole: "ADMIN",
    actorUsernameSnapshot: usernames.admin,
    factoryId: fixtures.factoryAId,
    changes: { status: { before: "DISABLED", after: "ENABLED" } },
  });
  expect(enabledEvent.createdAt).toBeInstanceOf(Date);
  await setFactoryUserEnabled(adminHeaders, {
    userId: created.id,
    enabled: true,
  });
  expect(
    await prisma.activityLog.count({
      where: { entityId: created.id, eventType: "USER_ENABLED" },
    }),
  ).toBe(1);

  const lifecycleEvents = await prisma.activityLog.findMany({
    where: { entityId: created.id },
    orderBy: { createdAt: "asc" },
  });
  expect(lifecycleEvents).toHaveLength(3);
  const auditPayload = JSON.stringify(lifecycleEvents);
  expect(auditPayload).not.toContain(passwords.next);
  expect(auditPayload).not.toContain("@users.invalid");
  expect(auditPayload).not.toMatch(
    /password|session|token|credential|auth_secret|database_url/i,
  );

  await Promise.all([admin.context.dispose(), factory.context.dispose()]);
});
