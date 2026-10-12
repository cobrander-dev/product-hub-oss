#!/bin/sh
set -eu

if [ -n "${DATABASE_URL:-}" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  exec node "$script_dir/backup-connection.mjs" "$0"
fi
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSFILE:?PGPASSFILE is required}"
: "${LOCAL_STORAGE_ROOT:?LOCAL_STORAGE_ROOT is required}"
: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${RELEASE_REVISION:?RELEASE_REVISION is required}"

case "$RELEASE_REVISION" in
  *[!0-9a-f]* | "")
    echo "RELEASE_REVISION must be a lowercase Git revision" >&2
    exit 1
    ;;
esac

timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
case "$timestamp" in
  *[!0-9TZ]* | "")
    echo "BACKUP_TIMESTAMP contains unsupported characters" >&2
    exit 1
    ;;
esac

set_dir="$BACKUP_ROOT/product-hub-$timestamp-$RELEASE_REVISION"
if [ -e "$set_dir" ]; then
  echo "Backup target already exists: $set_dir" >&2
  exit 1
fi

umask 077
mkdir -p "$set_dir"
db_file="$set_dir/database.dump"
uploads_file="$set_dir/uploads.tar.gz"
files_checksum="$set_dir/uploads-files.sha256"

# Credentials stay in the restricted password file, never in client argv.
pg_dump --format=custom --no-owner --no-privileges \
  --file="$db_file"

mkdir -p "$LOCAL_STORAGE_ROOT/objects"
(
  cd "$LOCAL_STORAGE_ROOT"
  find objects -type f -print0 | sort -z | xargs -0 -r sha256sum
) >"$files_checksum"
tar --create --gzip --file="$uploads_file" \
  --directory "$LOCAL_STORAGE_ROOT" .

migration_version="$(psql -X -At -c \
  'SELECT COALESCE(max(migration_name), '\''none'\'') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')"
stored_count="$(psql -X -At -c 'SELECT count(*) FROM "StoredObject"')"
storage_file_count="$(wc -l <"$files_checksum" | tr -d ' ')"

case "$migration_version" in
  *[!0-9A-Za-z_-]*)
    echo "Unexpected migration version value" >&2
    exit 1
    ;;
esac

db_checksum="$(sha256sum "$db_file" | awk '{print $1}')"
uploads_checksum="$(sha256sum "$uploads_file" | awk '{print $1}')"
files_checksum_checksum="$(sha256sum "$files_checksum" | awk '{print $1}')"

printf '%s\n' \
  "timestamp=$timestamp" \
  "git_revision=$RELEASE_REVISION" \
  "migration_version=$migration_version" \
  "database_file=database.dump" \
  "database_sha256=$db_checksum" \
  "uploads_file=uploads.tar.gz" \
  "uploads_sha256=$uploads_checksum" \
  "uploads_files_sha256=$files_checksum_checksum" \
  "stored_object_count=$stored_count" \
  "storage_file_count=$storage_file_count" \
  >"$set_dir/manifest.txt"

(
  cd "$set_dir"
  sha256sum database.dump uploads.tar.gz uploads-files.sha256 manifest.txt \
    >CHECKSUMS
)
touch "$set_dir/COMPLETE"
printf '%s\n' "$set_dir"
