#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${LOCAL_STORAGE_ROOT:?LOCAL_STORAGE_ROOT is required}"
: "${BACKUP_SET_DIR:?BACKUP_SET_DIR is required}"

if [ ! -f "$BACKUP_SET_DIR/COMPLETE" ]; then
  echo "Backup set is incomplete" >&2
  exit 1
fi

(
  cd "$BACKUP_SET_DIR"
  sha256sum --check CHECKSUMS
)

expected_rows="$(awk -F= '$1 == "stored_object_count" { print $2 }' "$BACKUP_SET_DIR/manifest.txt")"
expected_files="$(awk -F= '$1 == "storage_file_count" { print $2 }' "$BACKUP_SET_DIR/manifest.txt")"
actual_rows="$(psql -X -At "$DATABASE_URL" -c 'SELECT count(*) FROM "StoredObject"')"
actual_files="$(find "$LOCAL_STORAGE_ROOT/objects" -type f 2>/dev/null | wc -l | tr -d ' ')"

if [ "$actual_rows" != "$expected_rows" ]; then
  echo "StoredObject count mismatch: expected $expected_rows, got $actual_rows" >&2
  exit 1
fi
if [ "$actual_files" != "$expected_files" ]; then
  echo "Storage file count mismatch: expected $expected_files, got $actual_files" >&2
  exit 1
fi

psql -X -At -F '|' "$DATABASE_URL" \
  -c 'SELECT "storageKey", "checksumSha256" FROM "StoredObject" ORDER BY "storageKey"' |
while IFS='|' read -r storage_key expected_checksum; do
  case "$storage_key" in
    objects/[0-9a-f]*.webp) ;;
    *)
      echo "Invalid storage key in database" >&2
      exit 1
      ;;
  esac
  filename="$LOCAL_STORAGE_ROOT/$storage_key"
  if [ ! -f "$filename" ]; then
    echo "Missing stored object file: $storage_key" >&2
    exit 1
  fi
  actual_checksum="$(sha256sum "$filename" | awk '{print $1}')"
  if [ "$actual_checksum" != "$expected_checksum" ]; then
    echo "Stored object checksum mismatch: $storage_key" >&2
    exit 1
  fi
done

printf '%s\n' "Restore verification passed."
