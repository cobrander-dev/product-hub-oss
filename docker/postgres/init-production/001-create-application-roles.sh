#!/bin/sh
set -eu

# Runs only when PGDATA is empty. The official image creates POSTGRES_USER as a
# cluster superuser; never use it as either an application or migration login.
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${MIGRATION_DB_USER:?MIGRATION_DB_USER is required}"
: "${MIGRATION_DB_PASSWORD:?MIGRATION_DB_PASSWORD is required}"
: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

for role in "$POSTGRES_USER" "$MIGRATION_DB_USER" "$APP_DB_USER"; do
  case "$role" in
    *[!a-z0-9_]* | [0-9]* | "")
      echo "Database role names must be lowercase PostgreSQL identifiers" >&2
      exit 1
      ;;
  esac
done

if [ "$POSTGRES_USER" = "$MIGRATION_DB_USER" ] ||
   [ "$POSTGRES_USER" = "$APP_DB_USER" ] ||
   [ "$MIGRATION_DB_USER" = "$APP_DB_USER" ] ||
   [ "$POSTGRES_PASSWORD" = "$MIGRATION_DB_PASSWORD" ] ||
   [ "$POSTGRES_PASSWORD" = "$APP_DB_PASSWORD" ] ||
   [ "$MIGRATION_DB_PASSWORD" = "$APP_DB_PASSWORD" ]; then
  echo "Bootstrap, migration, and runtime identities and passwords must differ" >&2
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv migration_user MIGRATION_DB_USER
\getenv migration_password MIGRATION_DB_PASSWORD
\getenv runtime_user APP_DB_USER
\getenv runtime_password APP_DB_PASSWORD

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'migration_user', :'migration_password')\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'runtime_user', :'runtime_password')\gexec

-- The bootstrap superuser owns the database. Prisma deploy needs DDL only in
-- public, so the migration role owns that schema rather than the database.
SELECT format('ALTER SCHEMA public OWNER TO %I', :'migration_user')\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database())\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), :'migration_user', :'runtime_user')\gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;
SQL
