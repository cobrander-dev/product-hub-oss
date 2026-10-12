import { readFileSync } from "node:fs";
import pg from "pg";

const client = new pg.Client({
  connectionString: readFileSync(
    process.env.HARD_DELETE_WORKER_DATABASE_URL_FILE,
    "utf8",
  ).trim(),
});
try {
  if (process.env.DATABASE_URL || process.env.BETTER_AUTH_SECRET)
    throw new Error();
  await client.connect();
  const result = await client.query("SELECT current_user AS name");
  if (result.rows[0]?.name !== process.env.HARD_DELETE_WORKER_DB_USER)
    throw new Error();
  process.stdout.write("PASS\n");
} catch {
  process.stderr.write("FAIL: WORKER_CONNECTION\n");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
