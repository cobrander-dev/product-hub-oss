#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${LOCAL_STORAGE_ROOT:?LOCAL_STORAGE_ROOT is required}"
: "${BACKUP_SET_DIR:?BACKUP_SET_DIR is required}"
: "${RESTORE_CONFIRM_DATABASE:?RESTORE_CONFIRM_DATABASE is required}"

RESTORE_STORAGE_UID="${RESTORE_STORAGE_UID:-1001}"
RESTORE_STORAGE_GID="${RESTORE_STORAGE_GID:-1001}"

case "$RESTORE_STORAGE_UID:$RESTORE_STORAGE_GID" in
  *[!0-9:]* | :* | *: | *:*:*)
    echo "Restore storage UID and GID must be numeric" >&2
    exit 1
    ;;
esac

target_database="$(psql -X -At "$DATABASE_URL" -c 'SELECT current_database()')"
if [ "$target_database" != "$RESTORE_CONFIRM_DATABASE" ]; then
  echo "Restore confirmation does not match target database" >&2
  exit 1
fi

target_role_status="$(psql -X -At "$DATABASE_URL" -c \
  'SELECT CASE WHEN r.rolsuper THEN '\''superuser'\'' WHEN n.nspowner <> r.oid THEN '\''not_schema_owner'\'' ELSE '\''migration_owner'\'' END FROM pg_roles r JOIN pg_namespace n ON n.nspname = '\''public'\'' WHERE r.rolname = current_user')"
if [ "$target_role_status" != migration_owner ]; then
  echo "Restore requires a non-superuser migration role that owns public schema" >&2
  exit 1
fi

table_count="$(psql -X -At "$DATABASE_URL" -c \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [ "$table_count" != "0" ]; then
  echo "Restore target database must be empty" >&2
  exit 1
fi

mkdir -p "$LOCAL_STORAGE_ROOT"
if [ -n "$(find "$LOCAL_STORAGE_ROOT" -mindepth 1 -print -quit)" ]; then
  echo "Restore storage target must be empty" >&2
  exit 1
fi

if [ ! -f "$BACKUP_SET_DIR/COMPLETE" ]; then
  echo "Backup set is incomplete" >&2
  exit 1
fi
(
  cd "$BACKUP_SET_DIR"
  sha256sum --check CHECKSUMS
)

if tar -tzf "$BACKUP_SET_DIR/uploads.tar.gz" | \
  grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Uploads archive contains an unsafe path" >&2
  exit 1
fi

pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="$DATABASE_URL" "$BACKUP_SET_DIR/database.dump"
tar --extract --gzip --file="$BACKUP_SET_DIR/uploads.tar.gz" \
  --directory "$LOCAL_STORAGE_ROOT"
chown -R "$RESTORE_STORAGE_UID:$RESTORE_STORAGE_GID" "$LOCAL_STORAGE_ROOT"

BACKUP_SET_DIR="$BACKUP_SET_DIR" \
LOCAL_STORAGE_ROOT="$LOCAL_STORAGE_ROOT" \
DATABASE_URL="$DATABASE_URL" \
  "$(dirname "$0")/verify-restore.sh"
