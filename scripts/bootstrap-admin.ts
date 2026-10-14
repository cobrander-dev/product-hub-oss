import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { readBoundedInput } from "./installer/input";

const inputSchema = z
  .object({
    databaseUrl: z.url().startsWith("postgresql://"),
    username: z
      .string()
      .trim()
      .min(3)
      .max(30)
      .regex(/^[a-zA-Z0-9._]+$/)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(8).max(128),
    name: z.string().trim().min(1).max(100),
  })
  .strict();

async function main() {
  if (process.argv.length !== 2 || process.env.BOOTSTRAP_ADMIN_PASSWORD)
    throw new Error("UNSAFE_PASSWORD_SOURCE");
  const input = inputSchema.parse(JSON.parse(await readBoundedInput()));
  const client = new Client({ connectionString: input.databaseUrl });
  const password = await hashPassword(input.password);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('product-hub-initial-admin', 0))",
    );
    const role = await client.query<{ safe: boolean }>(
      `SELECT (NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls AND NOT has_schema_privilege(current_user, 'public', 'CREATE')) AS safe FROM pg_roles r WHERE rolname=current_user`,
    );
    if (role.rows[0]?.safe !== true) throw new Error("APP_IDENTITY_REQUIRED");
    const admin = await client.query(
      "SELECT 1 FROM \"User\" WHERE role = 'ADMIN' LIMIT 1",
    );
    if (admin.rowCount) throw new Error("ADMIN_EXISTS");
    const id = randomUUID();
    await client.query(
      `INSERT INTO "User" (id, name, email, "emailVerified", role, username, "factoryId", "createdAt", "updatedAt") VALUES ($1,$2,$3,false,'ADMIN',$4,NULL,now(),now())`,
      [id, input.name, `${randomUUID()}@users.invalid`, input.username],
    );
    await client.query(
      `INSERT INTO "Account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1,$2,'credential',$2,$3,now(),now())`,
      [randomUUID(), id, password],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  process.stdout.write("PASS: initial Admin created\n");
}

main().catch((error: unknown) => {
  const code =
    error instanceof Error &&
    [
      "ADMIN_EXISTS",
      "APP_IDENTITY_REQUIRED",
      "UNSAFE_PASSWORD_SOURCE",
    ].includes(error.message)
      ? error.message
      : "BOOTSTRAP_FAILED";
  process.stderr.write(`FAIL: ${code}\n`);
  process.exitCode = 1;
});
