import { defineConfig } from "@playwright/test";
delete process.env.NO_COLOR;
if (
  !process.env.APP_RUNTIME_DATABASE_URL ||
  !process.env.HARD_DELETE_WORKER_DATABASE_URL ||
  !process.env.LOCAL_STORAGE_ROOT?.includes("tmp")
)
  throw new Error("Use the disposable Phase 3 test harness");
export default defineConfig({
  testDir: "./tests/hard-delete-ui",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3100", trace: "off" },
  webServer: {
    command: `"${process.execPath}" ./node_modules/next/dist/bin/next dev -p 3100`,
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.APP_RUNTIME_DATABASE_URL,
      HARD_DELETE_WORKER_DATABASE_URL: "",
      HARD_DELETE_WORKER_DB_PASSWORD: "",
      POSTGRES_PASSWORD: "",
      MIGRATION_DB_PASSWORD: "",
      ADMIN_DATABASE_URL: "",
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
