import { Client } from "pg";
import { z } from "zod";

const input = z
  .object({
    ADMIN_DATABASE_URL: z.url().startsWith("postgresql://"),
    MIGRATION_DB_USER: z
      .string()
      .regex(
        /^[a-z_][a-z0-9_]*$/,
        "MIGRATION_DB_USER must be a safe identifier",
      ),
    APP_DB_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/, "APP_DB_USER must be a safe identifier"),
    HARD_DELETE_WORKER_DB_USER: z
      .string()
      .regex(
        /^[a-z_][a-z0-9_]*$/,
        "HARD_DELETE_WORKER_DB_USER must be a safe identifier",
      ),
    HARD_DELETE_WORKER_DB_PASSWORD: z.string().min(32).max(512),
  })
  .superRefine((value, context) => {
    const identities = new Set([
      value.MIGRATION_DB_USER,
      value.APP_DB_USER,
      value.HARD_DELETE_WORKER_DB_USER,
    ]);
    if (identities.size !== 3) {
      context.addIssue({
        code: "custom",
        message: "Migration, Runtime, and Hard Delete Worker roles must differ",
      });
    }
  })
  .parse(process.env);

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
] as const;
const appSharedFunctions = new Set<string>([workerFunctions[0]]);
const client = new Client({ connectionString: input.ADMIN_DATABASE_URL });

function quotedIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const worker = quotedIdentifier(input.HARD_DELETE_WORKER_DB_USER);
const verifyOnly = process.argv.includes("--check");

await client.connect();
try {
  const administrator = await client.query<{
    rolsuper: boolean;
    rolcreaterole: boolean;
  }>(
    "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user",
  );
  if (
    !administrator.rows[0]?.rolsuper &&
    !administrator.rows[0]?.rolcreaterole
  ) {
    throw new Error("Provisioning identity must be allowed to manage roles");
  }

  for (const functionName of workerFunctions) {
    const functionState = await client.query<{
      owner: string;
      securityDefiner: boolean;
      settings: string[] | null;
    }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS "securityDefiner",
              p.proconfig AS settings
       FROM pg_proc p
       WHERE p.oid = to_regprocedure($1)`,
      [functionName],
    );
    const hardDeleteFunction = functionState.rows[0];
    if (
      !hardDeleteFunction ||
      hardDeleteFunction.owner !== input.MIGRATION_DB_USER ||
      !hardDeleteFunction.securityDefiner ||
      JSON.stringify(hardDeleteFunction.settings) !==
        JSON.stringify(["search_path=pg_catalog"])
    ) {
      throw new Error(`Hard delete function boundary differs: ${functionName}`);
    }
  }

  await client.query(verifyOnly ? "BEGIN READ ONLY" : "BEGIN");
  if (!verifyOnly) {
    const existing = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [input.HARD_DELETE_WORKER_DB_USER],
    );
    const roleStatement = await client.query<{ statement: string }>(
      existing.rows[0]?.exists
        ? `SELECT format(
           'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
           $1::text,
           $2::text
         ) AS statement`
        : `SELECT format(
           'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
           $1::text,
           $2::text
         ) AS statement`,
      [input.HARD_DELETE_WORKER_DB_USER, input.HARD_DELETE_WORKER_DB_PASSWORD],
    );
    await client.query(roleStatement.rows[0]!.statement);

    const databaseName = await client.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    const database = quotedIdentifier(databaseName.rows[0]!.name);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM ${worker}`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${worker}`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${worker}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${worker}`);
    await client.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${worker}`,
    );
    await client.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${worker}`,
    );
    await client.query(
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${worker}`,
    );
    for (const functionName of workerFunctions) {
      const grant = await client.query<{ statement: string }>(
        "SELECT format('GRANT EXECUTE ON FUNCTION %s TO %I', $1::regprocedure, $2::text) AS statement",
        [functionName, input.HARD_DELETE_WORKER_DB_USER],
      );
      await client.query(grant.rows[0]!.statement);
    }
  }

  const roleState = await client.query<{
    oid: number;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolinherit: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
  }>(
    `SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
            rolreplication, rolbypassrls, rolcanlogin
     FROM pg_roles WHERE rolname = $1`,
    [input.HARD_DELETE_WORKER_DB_USER],
  );
  const state = roleState.rows[0];
  if (
    !state?.rolcanlogin ||
    state.rolsuper ||
    state.rolcreatedb ||
    state.rolcreaterole ||
    state.rolinherit ||
    state.rolreplication ||
    state.rolbypassrls
  ) {
    throw new Error("Hard Delete Worker role attributes are unsafe");
  }

  const memberships = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_auth_members
     WHERE member = $1 OR roleid = $1`,
    [state.oid],
  );
  if (memberships.rows[0]?.count !== "0") {
    throw new Error("Hard Delete Worker must not have role memberships");
  }

  const tableGrants = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM information_schema.role_table_grants
     WHERE grantee = $1`,
    [input.HARD_DELETE_WORKER_DB_USER],
  );
  if (tableGrants.rows[0]?.count !== "0") {
    throw new Error("Hard Delete Worker must not have direct table grants");
  }

  for (const functionName of workerFunctions) {
    const execution = await client.query<{
      workerAllowed: boolean;
      appAllowed: boolean;
      publicAllowed: boolean;
    }>(
      `SELECT has_function_privilege($1, to_regprocedure($3), 'EXECUTE') AS "workerAllowed",
              has_function_privilege($2, to_regprocedure($3), 'EXECUTE') AS "appAllowed",
              EXISTS (
                SELECT 1 FROM pg_proc p
                CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = to_regprocedure($3) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
              ) AS "publicAllowed"`,
      [input.HARD_DELETE_WORKER_DB_USER, input.APP_DB_USER, functionName],
    );
    const appShouldExecute = appSharedFunctions.has(functionName);
    if (
      !execution.rows[0]?.workerAllowed ||
      execution.rows[0]?.appAllowed !== appShouldExecute ||
      execution.rows[0]?.publicAllowed
    ) {
      throw new Error(
        `Hard delete worker function boundary is unsafe: ${functionName}`,
      );
    }
  }

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

process.stdout.write(
  verifyOnly
    ? "Hard Delete Worker role verified.\n"
    : "Hard Delete Worker role provisioned and verified.\n",
);
