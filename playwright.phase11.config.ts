import { defineConfig, devices } from "@playwright/test";

process.loadEnvFile(".env.test");
delete process.env.NO_COLOR;

export default defineConfig({
  testDir: "./tests/phase11",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "phase11-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `"${process.execPath}" ./node_modules/next/dist/bin/next dev -p 3100`,
    url: "http://127.0.0.1:3100/api/ready",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
