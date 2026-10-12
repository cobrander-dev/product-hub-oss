#!/bin/sh
set -eu

# Run only inside a disposable PostgreSQL container initialized from an empty
# volume with compose.production.yaml. Never run this probe against production.
case "${POSTGRES_DB:-}" in
  *_test) ;;
  *) echo 'Refusing non-test database' >&2; exit 1 ;;
esac
if [ "${POSTGRES_USER:-}" != product_hub_db_admin ] ||
   [ "${MIGRATION_DB_USER:-}" != product_hub_migration ] ||
   [ "${APP_DB_USER:-}" != product_hub_app ]; then
  echo 'Unexpected test role names' >&2
  exit 1
fi

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
  label="$1"
  identity="$2"
  statement="$3"
  if [ "$identity" = migration ]; then
    if migration_sql "$statement" >/dev/null 2>&1; then
      echo "FAIL: $label" >&2
      exit 1
    fi
  elif runtime_sql "BEGIN; $statement; ROLLBACK;" >/dev/null 2>&1; then
    echo "FAIL: $label" >&2
    exit 1
  fi
  echo "PASS: $label denied"
}

roles="$(admin_sql "SELECT rolname || ':' || rolsuper || ':' || rolcreatedb || ':' || rolcreaterole || ':' || rolreplication FROM pg_roles WHERE rolname IN ('product_hub_db_admin','product_hub_migration','product_hub_app') ORDER BY rolname")"
expected="$(printf '%s\n' 'product_hub_app:false:false:false:false' 'product_hub_db_admin:true:true:true:true' 'product_hub_migration:false:false:false:false')"
[ "$roles" = "$expected" ] || { echo 'FAIL: role attributes' >&2; exit 1; }
[ "$(admin_sql "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" = product_hub_db_admin ]
[ "$(admin_sql "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'")" = product_hub_migration ]
echo 'PASS: three-role model and ownership'

migration_sql 'BEGIN; CREATE TABLE gate3a_ddl_probe (id integer PRIMARY KEY); ALTER TABLE gate3a_ddl_probe ADD COLUMN note text; CREATE INDEX gate3a_ddl_probe_note_idx ON gate3a_ddl_probe (note); ROLLBACK;' >/dev/null
echo 'PASS: migration DDL in transaction'
expect_denied 'CREATE DATABASE' migration 'CREATE DATABASE gate3a_denied_database'
expect_denied 'CREATE ROLE' migration 'BEGIN; CREATE ROLE gate3a_denied_role; ROLLBACK;'
expect_denied 'ALTER ROLE escalation' migration 'BEGIN; ALTER ROLE product_hub_db_admin SUPERUSER; ROLLBACK;'
expect_denied 'CREATE EXTENSION' migration 'BEGIN; CREATE EXTENSION pgcrypto; ROLLBACK;'
if PGPASSWORD="$MIGRATION_DB_PASSWORD" psql -X -w -q -h 127.0.0.1 -U "$MIGRATION_DB_USER" -d postgres -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; then
  echo 'FAIL: migration can access unrelated database' >&2
  exit 1
fi
echo 'PASS: unrelated database denied'

[ "$(admin_sql 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')" = 11 ]
echo 'PASS: all eleven migrations applied'

runtime_sql "BEGIN; INSERT INTO \"Category\" (\"id\", \"name\", \"nameNormalized\", \"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000001', 'Role probe', 'role probe', now()); SELECT \"name\" FROM \"Category\" WHERE \"nameNormalized\"='role probe'; UPDATE \"Category\" SET \"name\"='Role probe updated', \"nameNormalized\"='role probe updated' WHERE \"nameNormalized\"='role probe'; DELETE FROM \"Category\" WHERE \"nameNormalized\"='role probe updated'; ROLLBACK;" >/dev/null
echo 'PASS: runtime CRUD in rolled-back transaction'
expect_denied 'PriceHistory UPDATE' runtime 'UPDATE "PriceHistory" SET "id"="id" WHERE false'
expect_denied 'PriceHistory DELETE' runtime 'DELETE FROM "PriceHistory" WHERE false'
expect_denied 'PriceHistory TRUNCATE' runtime 'TRUNCATE "PriceHistory"'
expect_denied 'ActivityLog UPDATE' runtime 'UPDATE "ActivityLog" SET "id"="id" WHERE false'
expect_denied 'ActivityLog DELETE' runtime 'DELETE FROM "ActivityLog" WHERE false'
expect_denied 'ActivityLog TRUNCATE' runtime 'TRUNCATE "ActivityLog"'
[ "$(admin_sql "SELECT count(*) FROM \"Category\" WHERE \"nameNormalized\"='role probe'")" = 0 ]
echo 'PASS: runtime CRUD probe rolled back'
