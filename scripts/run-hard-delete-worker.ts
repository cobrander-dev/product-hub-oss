import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Client } from "pg";

import { runHardDeleteOperation } from "@/features/hard-delete/worker";
import { LocalStorageProvider } from "@/lib/storage/local";

async function main() {
  if (process.env.BETTER_AUTH_SECRET || process.env.DATABASE_URL)
    throw new Error("Worker identity must be isolated");
  const secretFile = process.env.HARD_DELETE_WORKER_DATABASE_URL_FILE;
  if (secretFile && process.env.HARD_DELETE_WORKER_DATABASE_URL)
    throw new Error("Ambiguous worker secret source");
  const workerUrl = secretFile
    ? (await readFile(secretFile, "utf8")).trim()
    : process.env.HARD_DELETE_WORKER_DATABASE_URL;
  const environment = z
    .object({
      HARD_DELETE_WORKER_DATABASE_URL: z.url().startsWith("postgresql://"),
      HARD_DELETE_WORKER_DB_USER: z
        .string()
        .regex(/^[a-z_][a-z0-9_]*$/)
        .default("product_hub_hard_delete_worker"),
      LOCAL_STORAGE_ROOT: z.string().startsWith("/"),
      HARD_DELETE_WORKER_ID: z
        .string()
        .min(1)
        .max(100)
        .default("hard-delete-worker"),
      HARD_DELETE_WORKER_POLL_MS: z.coerce
        .number()
        .int()
        .min(250)
        .max(60_000)
        .default(2_000),
    })
    .parse({ ...process.env, HARD_DELETE_WORKER_DATABASE_URL: workerUrl });
  if (
    new URL(environment.HARD_DELETE_WORKER_DATABASE_URL).username !==
    environment.HARD_DELETE_WORKER_DB_USER
  )
    throw new Error("Worker must use its dedicated role");
  const boundary = new Client({
    connectionString: environment.HARD_DELETE_WORKER_DATABASE_URL,
  });
  try {
    await boundary.connect();
    const result = await boundary.query<{ safe: boolean }>(`
      SELECT (NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls
        AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND (has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
            OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER')))
        AND NOT has_function_privilege(current_user,'public.confirm_hard_delete_operation(uuid,text,text,integer)','EXECUTE')
        AND NOT has_function_privilege(current_user,'public.refresh_hard_delete_preview(public."HardDeleteTargetType",text,text,jsonb,text)','EXECUTE')
      ) AS safe FROM pg_roles r WHERE rolname=current_user
    `);
    if (result.rows[0]?.safe !== true)
      throw new Error("Worker privilege boundary failed");
  } finally {
    await boundary.end();
  }

  const requestedOperationId = process.argv[2]
    ? z.string().uuid().parse(process.argv[2])
    : undefined;
  const storage = new LocalStorageProvider(environment.LOCAL_STORAGE_ROOT);
  let stopping = false;
  process.once("SIGTERM", () => {
    stopping = true;
  });
  process.once("SIGINT", () => {
    stopping = true;
  });

  do {
    const result = await runHardDeleteOperation({
      operationId: requestedOperationId,
      workerDatabaseUrl: environment.HARD_DELETE_WORKER_DATABASE_URL,
      workerId: environment.HARD_DELETE_WORKER_ID,
      storage,
    });
    void result;
    if (requestedOperationId || stopping) break;
    await new Promise((resolve) =>
      setTimeout(resolve, environment.HARD_DELETE_WORKER_POLL_MS),
    );
  } while (!stopping);
}
main().catch(() => {
  process.stderr.write(
    "Hard Delete Worker stopped: configuration, connection, or execution check failed.\n",
  );
  process.exitCode = 1;
});
