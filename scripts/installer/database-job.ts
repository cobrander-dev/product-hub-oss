import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { z } from "zod";
import { readBoundedInput } from "./input";

const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const url = z.url().startsWith("postgresql://");
const schema = z
  .object({
    action: z.enum([
      "database-state",
      "migrations",
      "grants",
      "worker-provision",
      "verify",
    ]),
    databaseUrl: url,
    adminUser: identifier,
    migrationUser: identifier,
    appUser: identifier,
    workerUser: identifier,
    migrationUrl: url.optional(),
    appUrl: url.optional(),
    workerUrl: url.optional(),
    workerPassword: z.string().min(32).max(512).optional(),
  })
  .strict();
export type DatabaseJobInput = z.infer<typeof schema>;
type Input = DatabaseJobInput;
class JobFailure extends Error {}
function demand(condition: unknown, code: string): asserts condition {
  if (!condition) throw new JobFailure(code);
}
const workerFunctions = [
  'public.plan_hard_delete(public."HardDeleteTargetType",text)',
  "public.claim_hard_delete_operation(uuid,text,integer)",
  "public.claim_next_hard_delete_operation(text,integer)",
  "public.renew_hard_delete_operation_lease(uuid,uuid,integer)",
  "public.execute_confirmed_hard_delete(uuid,text,uuid)",
  "public.claim_hard_delete_file_task(uuid,uuid,text,integer)",
  "public.complete_hard_delete_file_task(uuid,uuid)",
  "public.retry_hard_delete_file_task(uuid,uuid,text,text,integer)",
  "public.fail_hard_delete_operation(uuid,uuid,text,text)",
  "public.complete_hard_delete_operation(uuid,uuid,jsonb)",
  "public.hard_delete_storage_catalog()",
];
const tables = new Set([
  "User",
  "Account",
  "Session",
  "Verification",
  "RateLimit",
  "Factory",
  "Category",
  "Material",
  "Product",
  "ProductFactoryAssignment",
  "FactoryQuote",
  "PriceHistory",
  "ActivityLog",
  "StoredObject",
  "ProductMainImage",
  "FactoryPrivateImage",
  "ImportJob",
  "ImportRow",
  "HardDeleteOperation",
  "HardDeleteFileTask",
  "_prisma_migrations",
]);
const migrationsRoot = join(import.meta.dirname, "../../prisma/migrations");
const migrationNames = readdirSync(migrationsRoot)
  .filter((name) => /^\d{14}_/.test(name))
  .sort();

async function connected<T>(
  connectionString: string,
  callback: (client: Client) => Promise<T>,
) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10000,
    options: "-c default_transaction_read_only=on",
  });
  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function migrationState(client: Client, complete: boolean) {
  const relations = await client.query<{ relname: string; owner: string }>(
    `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')`,
  );
  demand(
    relations.rows.every(
      (relation) =>
        tables.has(relation.relname) && relation.owner === client.user,
    ),
    "UNKNOWN_DATABASE_OBJECTS",
  );
  if (!relations.rows.length) {
    demand(!complete, "MIGRATIONS_INCOMPLETE");
    return {
      state: "empty",
      applied: 0,
      pending: migrationNames.length,
      failed: 0,
    };
  }
  demand(
    relations.rows.some((row) => row.relname === "_prisma_migrations"),
    "UNRECOGNIZED_DATABASE",
  );
  const history = await client.query<{
    migration_name: string;
    checksum: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }>(
    'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
  );
  const applied = history.rows.filter(
    (row) => row.finished_at && !row.rolled_back_at,
  );
  demand(
    !history.rows.some((row) => !row.finished_at && !row.rolled_back_at),
    "FAILED_MIGRATION",
  );
  demand(
    applied.every(
      (row, index) =>
        row.migration_name === migrationNames[index] &&
        row.checksum ===
          createHash("sha256")
            .update(
              readFileSync(
                join(migrationsRoot, row.migration_name, "migration.sql"),
              ),
            )
            .digest("hex"),
    ),
    "MIGRATION_HISTORY_MISMATCH",
  );
  if (complete)
    demand(applied.length === migrationNames.length, "MIGRATIONS_INCOMPLETE");
  return {
    state: "initialized",
    applied: applied.length,
    pending: migrationNames.length - applied.length,
    failed: 0,
  };
}

async function verifyRoles(input: Input) {
  await connected(input.databaseUrl, async (client) => {
    const owners = await client.query<{
      databaseOwner: string;
      schemaOwner: string;
    }>(
      `SELECT pg_get_userbyid(d.datdba) AS "databaseOwner", pg_get_userbyid(n.nspowner) AS "schemaOwner" FROM pg_database d, pg_namespace n WHERE d.datname=current_database() AND n.nspname='public'`,
    );
    demand(
      owners.rows[0]?.databaseOwner === input.adminUser &&
        owners.rows[0]?.schemaOwner === input.migrationUser,
      "DATABASE_OWNERSHIP",
    );
    for (const user of [input.adminUser, input.migrationUser, input.appUser]) {
      const roles = await client.query<{
        rolsuper: boolean;
        rolcanlogin: boolean;
        safe: boolean;
      }>(
        `SELECT r.rolsuper, r.rolcanlogin, (NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)) AS safe FROM pg_roles r WHERE rolname=$1`,
        [user],
      );
      const role = roles.rows[0];
      demand(
        role?.rolcanlogin &&
          (user === input.adminUser ? role.rolsuper : role.safe),
        "DATABASE_ROLE_BOUNDARY",
      );
    }
  });
  for (const [connectionString, user] of [
    [input.migrationUrl, input.migrationUser],
    [input.appUrl, input.appUser],
  ] as const) {
    demand(connectionString, "MISSING_CONNECTION");
    await connected(connectionString, async (client) => {
      const result = await client.query<{ name: string }>(
        "SELECT current_user AS name",
      );
      demand(result.rows[0]?.name === user, "DATABASE_IDENTITY");
    });
  }
}

function child(
  script: string,
  environment: Record<string, string>,
  check = false,
) {
  const result = spawnSync(
    process.execPath,
    ["./node_modules/tsx/dist/cli.mjs", script, ...(check ? ["--check"] : [])],
    {
      cwd: join(import.meta.dirname, "../.."),
      env: { PATH: process.env.PATH, NODE_ENV: "production", ...environment },
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    },
  );
  demand(result.status === 0, "PRIVILEGE_JOB_FAILED");
}

async function verifyWorker(input: Input) {
  demand(input.workerUrl, "MISSING_CONNECTION");
  await connected(input.workerUrl, async (client) => {
    const identity = await client.query<{ name: string }>(
      "SELECT current_user AS name",
    );
    demand(identity.rows[0]?.name === input.workerUser, "WORKER_IDENTITY");
  });
  await connected(input.databaseUrl, async (client) => {
    const unsafe = await client.query<{ unsafe: boolean }>(
      `SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls OR NOT r.rolcanlogin OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) OR has_schema_privilege(r.oid,'public','CREATE') OR has_database_privilege(r.oid,current_database(),'CREATE,TEMP') OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (c.relowner=r.oid OR CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE') ELSE false END))) AS unsafe FROM pg_roles r WHERE r.rolname=$1`,
      [input.workerUser],
    );
    demand(unsafe.rows[0]?.unsafe === false, "WORKER_PRIVILEGE_BOUNDARY");
    const oids = await client.query<{ oid: number | null }>(
      "SELECT to_regprocedure(value)::oid AS oid FROM unnest($1::text[]) value",
      [workerFunctions],
    );
    const approved = new Set(oids.rows.map((row) => row.oid));
    demand(
      oids.rows.every((row) => row.oid !== null) &&
        approved.size === workerFunctions.length,
      "WORKER_FUNCTIONS_MISSING",
    );
    const functions = await client.query<{
      oid: number;
      allowed: boolean;
      safe: boolean;
      publicAllowed: boolean;
    }>(
      `SELECT p.oid, has_function_privilege($1,p.oid,'EXECUTE') AS allowed, (p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog'] AND pg_get_userbyid(p.proowner)=$2) AS safe, EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS "publicAllowed" FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`,
      [input.workerUser, input.migrationUser],
    );
    demand(
      functions.rows.every(
        (row) =>
          !row.publicAllowed &&
          row.allowed === approved.has(row.oid) &&
          (!row.allowed || row.safe),
      ),
      "FUNCTION_GRANT_BOUNDARY",
    );
  });
}

export async function verifyDatabaseReadOnly(input: Input) {
  schema.parse(input);
  await verifyRoles(input);
  demand(input.migrationUrl, "MISSING_CONNECTION");
  const result = await connected(input.migrationUrl, (client) =>
    migrationState(client, true),
  );
  child(
    "scripts/configure-runtime-role.ts",
    { DATABASE_URL: input.migrationUrl, APP_DB_USER: input.appUser },
    true,
  );
  child(
    "scripts/provision-hard-delete-worker-role.ts",
    {
      ADMIN_DATABASE_URL: input.databaseUrl,
      MIGRATION_DB_USER: input.migrationUser,
      APP_DB_USER: input.appUser,
      HARD_DELETE_WORKER_DB_USER: input.workerUser,
      HARD_DELETE_WORKER_DB_PASSWORD:
        "verification-only-placeholder-with-32-characters",
    },
    true,
  );
  await verifyWorker(input);
  return result;
}

async function main() {
  const input = schema.parse(JSON.parse(await readBoundedInput(16384)));
  let result: Record<string, unknown> = {};
  if (input.action === "database-state") {
    await verifyRoles(input);
    demand(input.migrationUrl, "MISSING_CONNECTION");
    result = await connected(input.migrationUrl, (client) =>
      migrationState(client, false),
    );
  } else if (input.action === "migrations") {
    const migration = spawnSync(
      process.execPath,
      ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
      {
        cwd: join(import.meta.dirname, "../.."),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          DATABASE_URL: input.databaseUrl,
        },
        encoding: "utf8",
        timeout: 180000,
      },
    );
    demand(migration.status === 0, "MIGRATION_FAILED");
    result = await connected(input.databaseUrl, (client) =>
      migrationState(client, true),
    );
  } else if (input.action === "grants") {
    child("scripts/configure-runtime-role.ts", {
      DATABASE_URL: input.databaseUrl,
      APP_DB_USER: input.appUser,
    });
  } else if (input.action === "worker-provision") {
    demand(
      input.workerPassword && input.workerUrl,
      "MISSING_WORKER_CREDENTIAL",
    );
    const exists = await connected(
      input.databaseUrl,
      async (client) =>
        (
          await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
            input.workerUser,
          ])
        ).rowCount,
    );
    if (exists) await verifyWorker(input);
    child(
      "scripts/provision-hard-delete-worker-role.ts",
      {
        ADMIN_DATABASE_URL: input.databaseUrl,
        MIGRATION_DB_USER: input.migrationUser,
        APP_DB_USER: input.appUser,
        HARD_DELETE_WORKER_DB_USER: input.workerUser,
        HARD_DELETE_WORKER_DB_PASSWORD: input.workerPassword,
      },
      Boolean(exists),
    );
    await verifyWorker(input);
  } else {
    result = await verifyDatabaseReadOnly(input);
  }
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch((error: unknown) => {
    const postgresCodes: Record<string, string> = {
      "28P01": "DATABASE_AUTHENTICATION_FAILED",
      "3D000": "DATABASE_NOT_FOUND",
      "42501": "DATABASE_PERMISSION_DENIED",
      "42P01": "DATABASE_RELATION_MISSING",
      "42703": "DATABASE_COLUMN_MISSING",
      ECONNREFUSED: "DATABASE_UNREACHABLE",
      ENOTFOUND: "DATABASE_HOST_UNRESOLVED",
    };
    const code =
      error instanceof JobFailure
        ? error.message
        : error instanceof SyntaxError
          ? "INPUT_JSON_INVALID"
          : error instanceof z.ZodError
            ? "INPUT_VALIDATION_FAILED"
            : error &&
                typeof error === "object" &&
                "code" in error &&
                typeof error.code === "string"
              ? postgresCodes[error.code] || "DATABASE_JOB_FAILED"
              : "DATABASE_JOB_FAILED";
    process.stderr.write(`FAIL: ${code}\n`);
    process.exitCode = 1;
  });
