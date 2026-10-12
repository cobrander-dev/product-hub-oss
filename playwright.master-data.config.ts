import { defineConfig } from "@playwright/test";

process.loadEnvFile(".env.test");
delete process.env.NO_COLOR;

export default defineConfig({
  testDir: "./tests/master-data",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  webServer: {
    command: `"${process.execPath}" ./node_modules/next/dist/bin/next dev -p 3100`,
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
