import { Client } from "pg";
import { z } from "zod";

const input = z
  .object({
    DATABASE_URL: z.url().startsWith("postgresql://"),
    APP_DB_USER: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/, "APP_DB_USER must be a safe identifier"),
  })
  .parse(process.env);

// Every Prisma model in schema.prisma must appear here. New migrations that add
// application tables must update this list before the post-migration grant job
// can succeed. Prisma's own migration history is deliberately excluded.
const mutableTables = [
  "Account",
  "Category",
  "Factory",
  "FactoryPrivateImage",
  "FactoryQuote",
  "ImportJob",
  "ImportRow",
  "Material",
  "Product",
  "ProductFactoryAssignment",
  "ProductMainImage",
  "RateLimit",
  "Session",
  "StoredObject",
  "Verification",
] as const;
const appendOnlyTables = ["ActivityLog", "PriceHistory"] as const;
const controlledTables = ["User"] as const;
const operationTables = ["HardDeleteOperation"] as const;
const readOnlyTables = ["HardDeleteFileTask"] as const;
const applicationTables = [
  ...mutableTables,
  ...appendOnlyTables,
  ...controlledTables,
  ...operationTables,
  ...readOnlyTables,
];
const expectedTables = [...applicationTables, "_prisma_migrations"].sort();
const privilegedFunctions = [
  "public.execute_confirmed_user_hard_delete(uuid)",
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
const runtimeFunctions = [
  'public.refresh_hard_delete_preview(public."HardDeleteTargetType",text,text,jsonb,text)',
  'public.plan_hard_delete(public."HardDeleteTargetType",text)',
  "public.confirm_hard_delete_operation(uuid,text,text,integer)",
] as const;
const allTablePrivileges = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;
const columnPrivileges = ["SELECT", "INSERT", "UPDATE", "REFERENCES"] as const;

const role = `"${input.APP_DB_USER}"`;
const verifyOnly = process.argv.includes("--check");
const client = new Client({ connectionString: input.DATABASE_URL });

function quotedTable(table: string) {
  return `"${table}"`;
}

async function assertRuntimeBoundary() {
  const roleState = await client.query<{
    oid: number;
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolcanlogin: boolean;
  }>(
    `SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
     FROM pg_roles WHERE rolname = $1`,
    [input.APP_DB_USER],
  );
  const runtime = roleState.rows[0];
  if (
    !runtime?.rolcanlogin ||
    runtime.rolsuper ||
    runtime.rolcreatedb ||
    runtime.rolcreaterole ||
    runtime.rolreplication
  ) {
    throw new Error("Runtime role is missing or has cluster privileges");
  }

  const memberships = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_auth_members WHERE member = $1",
    [runtime.oid],
  );
  if (memberships.rows[0]?.count !== "0") {
    throw new Error("Runtime role must not inherit other role privileges");
  }

  const schema = await client.query<{ owner: string }>(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'",
  );
  if (
    schema.rows[0]?.owner !== client.user ||
    schema.rows[0]?.owner === input.APP_DB_USER
  ) {
    throw new Error("Migration identity must own public schema");
  }

  const relations = await client.query<{
    relname: string;
    owner: string;
    relkind: string;
  }>(
    `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relkind
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY c.relname`,
  );
  const actualTables = relations.rows
    .filter((relation) => relation.relkind === "r" || relation.relkind === "p")
    .map((relation) => relation.relname)
    .sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new Error(
      "Public tables differ from the reviewed application allowlist",
    );
  }
  if (
    relations.rows.some(
      (relation) =>
        relation.owner !== client.user ||
        !["r", "p"].includes(relation.relkind),
    )
  ) {
    throw new Error("Unexpected public relation owner or relation type");
  }
}

async function assertGrants() {
  for (const privilege of allTablePrivileges) {
    const history = await client.query<{ allowed: boolean }>(
      `SELECT has_table_privilege($1, 'public."_prisma_migrations"', $2) AS allowed`,
      [input.APP_DB_USER, privilege],
    );
    if (history.rows[0]?.allowed) {
      throw new Error("Runtime can access Prisma migration history");
    }
  }
  for (const privilege of columnPrivileges) {
    const history = await client.query<{ allowed: boolean }>(
      `SELECT has_any_column_privilege($1, 'public."_prisma_migrations"', $2) AS allowed`,
      [input.APP_DB_USER, privilege],
    );
    if (history.rows[0]?.allowed) {
      throw new Error("Runtime has column access to Prisma migration history");
    }
  }

  const schemaCreate = await client.query<{ allowed: boolean }>(
    "SELECT has_schema_privilege($1, 'public', 'CREATE') AS allowed",
    [input.APP_DB_USER],
  );
  if (schemaCreate.rows[0]?.allowed) {
    throw new Error("Runtime can create objects in public schema");
  }

  const publicGrants = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND a.grantee = 0`,
  );
  if (publicGrants.rows[0]?.count !== "0") {
    throw new Error("PUBLIC has access to a public relation");
  }

  const publicFunctionGrants = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE n.nspname = 'public' AND a.grantee = 0`,
  );
  if (publicFunctionGrants.rows[0]?.count !== "0") {
    throw new Error("PUBLIC has access to a public function");
  }

  const unsafeDefaults = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_default_acl d
     CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclobjtype IN ('r', 'S')
       AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
       AND (a.grantee = 0 OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1))`,
    [input.APP_DB_USER],
  );
  if (unsafeDefaults.rows[0]?.count !== "0") {
    throw new Error("Runtime or PUBLIC has unsafe future object grants");
  }

  for (const table of applicationTables) {
    if (operationTables.includes(table as (typeof operationTables)[number])) {
      continue;
    }
    const expected = new Set<string>(["SELECT"]);
    if (!readOnlyTables.includes(table as (typeof readOnlyTables)[number])) {
      expected.add("INSERT");
    }
    if (mutableTables.includes(table as (typeof mutableTables)[number])) {
      expected.add("UPDATE");
      expected.add("DELETE");
    }
    if (controlledTables.includes(table as (typeof controlledTables)[number])) {
      expected.add("UPDATE");
    }
    for (const privilege of allTablePrivileges) {
      const result = await client.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1, $2, $3) AS allowed",
        [input.APP_DB_USER, `public.${quotedTable(table)}`, privilege],
      );
      if (result.rows[0]?.allowed !== expected.has(privilege)) {
        throw new Error(
          `Unexpected Runtime ${privilege} privilege on ${table}`,
        );
      }
    }
    for (const privilege of columnPrivileges) {
      if (expected.has(privilege)) continue;
      const result = await client.query<{ allowed: boolean }>(
        "SELECT has_any_column_privilege($1, $2, $3) AS allowed",
        [input.APP_DB_USER, `public.${quotedTable(table)}`, privilege],
      );
      if (result.rows[0]?.allowed) {
        throw new Error(
          `Unexpected Runtime column ${privilege} privilege on ${table}`,
        );
      }
    }
  }

  const operationTablePrivileges = await client.query<{
    selectAllowed: boolean;
    tableInsert: boolean;
    tableUpdate: boolean;
    tableDelete: boolean;
  }>(
    `SELECT has_table_privilege($1, 'public."HardDeleteOperation"', 'SELECT') AS "selectAllowed",
            has_table_privilege($1, 'public."HardDeleteOperation"', 'INSERT') AS "tableInsert",
            has_table_privilege($1, 'public."HardDeleteOperation"', 'UPDATE') AS "tableUpdate",
            has_table_privilege($1, 'public."HardDeleteOperation"', 'DELETE') AS "tableDelete"`,
    [input.APP_DB_USER],
  );
  const operationPrivileges = operationTablePrivileges.rows[0];
  if (
    !operationPrivileges?.selectAllowed ||
    operationPrivileges.tableInsert ||
    operationPrivileges.tableUpdate ||
    operationPrivileges.tableDelete
  ) {
    throw new Error("Runtime HardDeleteOperation table privileges are unsafe");
  }
  const operationInsertColumns = [
    "targetType",
    "targetId",
    "targetLabelSnapshot",
    "preview",
    "previewSha256",
    "requestedByUserId",
    "requestedByUsernameSnapshot",
    "requestedAt",
    "expiresAt",
  ];
  for (const column of operationInsertColumns) {
    const permission = await client.query<{ allowed: boolean }>(
      `SELECT has_column_privilege($1, 'public."HardDeleteOperation"', $2, 'INSERT') AS allowed`,
      [input.APP_DB_USER, column],
    );
    if (!permission.rows[0]?.allowed)
      throw new Error(`Runtime cannot insert HardDeleteOperation.${column}`);
  }

  for (const functionName of privilegedFunctions) {
    const functionState = await client.query<{
      exists: boolean;
      allowed: boolean;
    }>(
      `SELECT to_regprocedure($2) IS NOT NULL AS exists,
              COALESCE(has_function_privilege($1, to_regprocedure($2), 'EXECUTE'), false) AS allowed`,
      [input.APP_DB_USER, functionName],
    );
    if (!functionState.rows[0]?.exists || functionState.rows[0]?.allowed) {
      throw new Error(
        "Runtime must not execute privileged hard delete functions",
      );
    }
  }
  for (const functionName of runtimeFunctions) {
    const functionState = await client.query<{
      exists: boolean;
      allowed: boolean;
    }>(
      `SELECT to_regprocedure($2) IS NOT NULL AS exists,
              COALESCE(has_function_privilege($1, to_regprocedure($2), 'EXECUTE'), false) AS allowed`,
      [input.APP_DB_USER, functionName],
    );
    if (!functionState.rows[0]?.exists || !functionState.rows[0]?.allowed) {
      throw new Error(
        "Runtime is missing an approved hard delete control function",
      );
    }
  }
}

await client.connect();
try {
  await client.query(verifyOnly ? "BEGIN READ ONLY" : "BEGIN");
  await assertRuntimeBoundary();

  if (!verifyOnly) {
    // Remove grants from the prior broad policy before granting only reviewed
    // application tables. There are no sequences in the current Prisma schema.
    await client.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`,
    );
    await client.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`,
    );
    await client.query(
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`,
    );
    await client.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC");
    await client.query(
      "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC",
    );
    await client.query(
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${role}`,
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
    );
    await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);

    for (const table of mutableTables) {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${quotedTable(table)} TO ${role}`,
      );
    }
    for (const table of appendOnlyTables) {
      await client.query(
        `GRANT SELECT, INSERT ON TABLE ${quotedTable(table)} TO ${role}`,
      );
    }
    for (const table of controlledTables) {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON TABLE ${quotedTable(table)} TO ${role}`,
      );
    }
    await client.query(
      `GRANT SELECT ON TABLE "HardDeleteOperation" TO ${role}`,
    );
    await client.query(
      `GRANT INSERT ("targetType","targetId","targetLabelSnapshot","preview","previewSha256","requestedByUserId","requestedByUsernameSnapshot","requestedAt","expiresAt") ON TABLE "HardDeleteOperation" TO ${role}`,
    );
    for (const table of readOnlyTables) {
      await client.query(
        `GRANT SELECT ON TABLE ${quotedTable(table)} TO ${role}`,
      );
    }
    await client.query(
      `GRANT EXECUTE ON FUNCTION public.plan_hard_delete(public."HardDeleteTargetType", TEXT) TO ${role}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION public.confirm_hard_delete_operation(UUID, TEXT, TEXT, INTEGER) TO ${role}`,
    );

    await client.query(
      `GRANT EXECUTE ON FUNCTION public.refresh_hard_delete_preview(public."HardDeleteTargetType", TEXT, TEXT, JSONB, TEXT) TO ${role}`,
    );
  }
  await assertGrants();

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

process.stdout.write(
  verifyOnly
    ? "Runtime database privileges verified.\n"
    : "Runtime database privileges configured and verified.\n",
);
