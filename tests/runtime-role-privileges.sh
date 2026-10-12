#!/bin/sh
set -eu

# Run only inside a disposable PostgreSQL container after all migrations and
# the reviewed runtime grant script. This must never target production.
case "${POSTGRES_DB:-}" in
  *_test) ;;
  *) echo 'Refusing non-test database' >&2; exit 1 ;;
esac
[ "${POSTGRES_USER:-}" = product_hub_db_admin ]
[ "${MIGRATION_DB_USER:-}" = product_hub_migration ]
[ "${APP_DB_USER:-}" = product_hub_app ]

admin_sql() {
  psql -X -w -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"
}
migration_sql() {
  PGPASSWORD="$MIGRATION_DB_PASSWORD" psql -X -w -qAt -h 127.0.0.1 -U "$MIGRATION_DB_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"
}
runtime_sql() {
  PGPASSWORD="$APP_DB_PASSWORD" psql -X -w -qAt -h 127.0.0.1 -U "$APP_DB_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "$1"
}
expect_denied() {
  label=$1
  identity=$2
  statement=$3
  if [ "$identity" = runtime ]; then
    if result=$(runtime_sql "$statement" 2>&1); then
      echo "FAIL: $label unexpectedly allowed" >&2
      exit 1
    fi
  else
    if result=$(migration_sql "$statement" 2>&1); then
      echo "FAIL: $label unexpectedly allowed" >&2
      exit 1
    fi
  fi
  if ! printf '%s\n' "$result" | grep -Eq 'permission denied|must be superuser|must have.*privilege'; then
    printf '%s\n' "$result" >&2
    echo "FAIL: $label failed for a reason other than permissions" >&2
    exit 1
  fi
  echo "PASS: $label denied"
}

[ "$(admin_sql 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 11 ]
[ "$(admin_sql "SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='product_hub_app')")" = 0 ]
[ "$(admin_sql "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_get_userbyid(c.relowner)='product_hub_app'")" = 0 ]
[ "$(admin_sql "SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclobjtype IN ('r','S') AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace) AND (a.grantee=0 OR a.grantee=(SELECT oid FROM pg_roles WHERE rolname='product_hub_app'))")" = 0 ]
[ "$(admin_sql "SELECT has_schema_privilege('product_hub_app','public','CREATE')")" = f ]
for privilege in SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER; do
  [ "$(admin_sql "SELECT has_table_privilege('product_hub_app','public.\"_prisma_migrations\"','$privilege')")" = f ]
done
for privilege in SELECT INSERT UPDATE REFERENCES; do
  [ "$(admin_sql "SELECT has_any_column_privilege('product_hub_app','public.\"_prisma_migrations\"','$privilege')")" = f ]
done
echo 'PASS: catalog checks, ownership, memberships, default privileges and Prisma metadata isolation'

expect_denied 'Prisma SELECT' runtime 'SELECT * FROM "_prisma_migrations" LIMIT 0'
expect_denied 'Prisma column SELECT' runtime 'SELECT id FROM "_prisma_migrations" LIMIT 0'
expect_denied 'Prisma INSERT' runtime 'INSERT INTO "_prisma_migrations" DEFAULT VALUES'
expect_denied 'Prisma UPDATE' runtime 'UPDATE "_prisma_migrations" SET checksum=checksum WHERE false'
expect_denied 'Prisma DELETE' runtime 'DELETE FROM "_prisma_migrations" WHERE false'
expect_denied 'Prisma TRUNCATE' runtime 'TRUNCATE "_prisma_migrations"'

runtime_sql "BEGIN; INSERT INTO \"Category\" (\"id\",\"name\",\"nameNormalized\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000101','Privilege probe','privilege probe',now()); SELECT \"id\" FROM \"Category\" WHERE \"nameNormalized\"='privilege probe'; UPDATE \"Category\" SET \"name\"='Privilege probe updated', \"nameNormalized\"='privilege probe updated' WHERE \"nameNormalized\"='privilege probe'; DELETE FROM \"Category\" WHERE \"nameNormalized\"='privilege probe updated'; ROLLBACK;" >/dev/null
[ "$(admin_sql "SELECT count(*) FROM \"Category\" WHERE \"nameNormalized\"='privilege probe'")" = 0 ]
echo 'PASS: normal runtime INSERT/SELECT/UPDATE/DELETE with rollback'

runtime_sql "BEGIN; INSERT INTO \"ActivityLog\" (\"id\",\"eventType\",\"entityType\",\"entityId\",\"entityLabelSnapshot\",\"actorSource\",\"actorRole\",\"actorUsernameSnapshot\",\"changes\") VALUES ('00000000-0000-4000-8000-000000000102','PRODUCT_CREATED','PRODUCT','probe','Privilege probe','SYSTEM','SYSTEM','system','{\"probe\":true}'::jsonb); SELECT \"id\" FROM \"ActivityLog\" WHERE \"entityId\"='probe'; ROLLBACK;" >/dev/null
[ "$(admin_sql "SELECT count(*) FROM \"ActivityLog\" WHERE \"entityId\"='probe'")" = 0 ]
echo 'PASS: ActivityLog INSERT/SELECT with rollback'

runtime_sql "BEGIN;
INSERT INTO \"Factory\" (\"id\",\"name\",\"nameNormalized\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000103','Probe factory','probe factory',now());
INSERT INTO \"User\" (\"id\",\"name\",\"email\",\"username\",\"role\",\"factoryId\",\"updatedAt\") VALUES ('gate3df-probe-user','Probe User','gate3df-probe@users.invalid','gate3df-probe','FACTORY','00000000-0000-4000-8000-000000000103',now());
INSERT INTO \"Category\" (\"id\",\"name\",\"nameNormalized\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000104','Probe category','probe category',now());
INSERT INTO \"Material\" (\"id\",\"name\",\"nameNormalized\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000105','Probe material','probe material',now());
INSERT INTO \"Product\" (\"id\",\"name\",\"categoryId\",\"materialId\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000106','Probe product','00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000105',now());
INSERT INTO \"ProductFactoryAssignment\" (\"id\",\"productId\",\"factoryId\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000107','00000000-0000-4000-8000-000000000106','00000000-0000-4000-8000-000000000103',now());
INSERT INTO \"FactoryQuote\" (\"id\",\"assignmentId\",\"priceCents\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000108','00000000-0000-4000-8000-000000000107',100,now());
INSERT INTO \"PriceHistory\" (\"id\",\"factoryQuoteId\",\"newPriceCents\",\"changedByUserId\") VALUES ('00000000-0000-4000-8000-000000000109','00000000-0000-4000-8000-000000000108',100,'gate3df-probe-user');
SELECT \"id\" FROM \"PriceHistory\" WHERE \"id\"='00000000-0000-4000-8000-000000000109';
ROLLBACK;" >/dev/null
[ "$(admin_sql "SELECT count(*) FROM \"PriceHistory\" WHERE \"id\"='00000000-0000-4000-8000-000000000109'")" = 0 ]
echo 'PASS: PriceHistory INSERT/SELECT with rolled-back related rows'

for table in PriceHistory ActivityLog; do
  expect_denied "$table UPDATE" runtime "UPDATE \"$table\" SET \"id\"=\"id\" WHERE false"
  expect_denied "$table DELETE" runtime "DELETE FROM \"$table\" WHERE false"
  expect_denied "$table TRUNCATE" runtime "TRUNCATE \"$table\""
done
expect_denied 'HardDeleteOperation DELETE' runtime 'DELETE FROM "HardDeleteOperation" WHERE false'
expect_denied 'HardDeleteOperation UPDATE' runtime 'UPDATE "HardDeleteOperation" SET "status"="status" WHERE false'
expect_denied 'HardDeleteOperation status injection' runtime "INSERT INTO \"HardDeleteOperation\" (\"targetType\",\"targetId\",\"targetLabelSnapshot\",\"status\",\"preview\",\"previewSha256\",\"requestedByUsernameSnapshot\",\"expiresAt\") VALUES ('USER','probe','probe','CONFIRMED','{}'::jsonb,repeat('a',64),'probe',now()+interval '30 minutes')"
expect_denied 'HardDeleteFileTask INSERT' runtime 'INSERT INTO "HardDeleteFileTask" DEFAULT VALUES'
expect_denied 'Hard Delete mutation function EXECUTE' runtime "SELECT public.execute_confirmed_hard_delete('00000000-0000-4000-8000-000000000000',repeat('a',64),'00000000-0000-4000-8000-000000000000')"
expect_denied 'User DELETE outside Hard Delete Worker' runtime 'DELETE FROM "User" WHERE false'

expect_denied 'Runtime CREATE DATABASE' runtime 'CREATE DATABASE gate3df_runtime_forbidden'
expect_denied 'Runtime CREATE ROLE' runtime 'CREATE ROLE gate3df_runtime_forbidden'
expect_denied 'Runtime ALTER ROLE' runtime 'ALTER ROLE product_hub_db_admin SUPERUSER'
expect_denied 'Migration CREATE DATABASE' migration 'CREATE DATABASE gate3df_migration_forbidden'
expect_denied 'Migration CREATE ROLE' migration 'CREATE ROLE gate3df_migration_forbidden'
expect_denied 'Migration ALTER ROLE' migration 'ALTER ROLE product_hub_db_admin SUPERUSER'

migration_sql 'CREATE TABLE gate3df_future_probe (id integer PRIMARY KEY)' >/dev/null
expect_denied 'Future table SELECT by Runtime' runtime 'SELECT * FROM gate3df_future_probe'
migration_sql 'DROP TABLE gate3df_future_probe' >/dev/null
echo 'PASS: future tables are denied until explicitly added to the allowlist'
