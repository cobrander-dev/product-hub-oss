import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

process.loadEnvFile(".env.test");
process.env.LOCAL_STORAGE_ROOT = path.resolve("data/test-uploads");
delete process.env.NO_COLOR;

export default defineConfig({
  testDir: "./tests/factory-ui",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    { name: "factory-desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "factory-mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `"${process.execPath}" ./node_modules/next/dist/bin/next dev -p 3100`,
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
