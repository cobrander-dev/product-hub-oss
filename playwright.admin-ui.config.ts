import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

process.loadEnvFile(".env.test");
process.env.LOCAL_STORAGE_ROOT = path.resolve("data/test-uploads");
delete process.env.NO_COLOR;

export default defineConfig({
  testDir: "./tests/admin-ui",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["./tests/support/timing-reporter.ts"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: { mode: "retain-on-failure", screenshots: false, sources: false },
  },
  projects: [
    { name: "admin-desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "admin-mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `"${process.execPath}" ./tests/support/diagnostic-server.mjs`,
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
