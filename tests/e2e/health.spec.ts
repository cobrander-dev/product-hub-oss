import { expect, test } from "@playwright/test";

test("health endpoint reports a stable application status", async ({
  request,
}) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  await expect(response.json()).resolves.toEqual({ status: "ok" });
});
