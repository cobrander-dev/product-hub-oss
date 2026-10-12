#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${LOCAL_STORAGE_ROOT:?LOCAL_STORAGE_ROOT is required}"

missing_files=0
unreferenced_rows=0
filesystem_orphans=0
pending_deletions=0
known_keys="$(mktemp)"
pending_keys="$(mktemp)"
trap 'rm -f "$known_keys" "$pending_keys"' EXIT

psql -X -At "$DATABASE_URL" -c \
  'SELECT "storageKey" FROM "StoredObject" ORDER BY "storageKey"' >"$known_keys"
psql -X -At "$DATABASE_URL" -c \
  'SELECT DISTINCT "storageKey" FROM "HardDeleteFileTask" WHERE "status" <> '\''DELETED'\'' ORDER BY "storageKey"' >"$pending_keys"

while IFS= read -r storage_key; do
  if [ ! -f "$LOCAL_STORAGE_ROOT/$storage_key" ]; then
    printf '%s\n' "DB_WITHOUT_FILE $storage_key"
    missing_files=$((missing_files + 1))
  fi
done <"$known_keys"

psql -X -At "$DATABASE_URL" -c '
  SELECT so."storageKey"
  FROM "StoredObject" so
  LEFT JOIN "ProductMainImage" pm ON pm."storedObjectId" = so.id
  LEFT JOIN "FactoryPrivateImage" fp ON fp."storedObjectId" = so.id
  WHERE pm.id IS NULL AND fp.id IS NULL
  ORDER BY so."storageKey"' |
while IFS= read -r storage_key; do
  printf '%s\n' "DB_WITHOUT_REFERENCE $storage_key"
done
unreferenced_rows="$(psql -X -At "$DATABASE_URL" -c '
  SELECT count(*)
  FROM "StoredObject" so
  LEFT JOIN "ProductMainImage" pm ON pm."storedObjectId" = so.id
  LEFT JOIN "FactoryPrivateImage" fp ON fp."storedObjectId" = so.id
  WHERE pm.id IS NULL AND fp.id IS NULL')"

if [ -d "$LOCAL_STORAGE_ROOT/objects" ]; then
  find "$LOCAL_STORAGE_ROOT/objects" -type f | while IFS= read -r filename; do
    storage_key="${filename#"$LOCAL_STORAGE_ROOT/"}"
    if ! grep -Fqx "$storage_key" "$known_keys"; then
      if grep -Fqx "$storage_key" "$pending_keys"; then
        printf '%s\n' "PENDING_DELETE $storage_key"
      else
        printf '%s\n' "FILE_WITHOUT_DB $storage_key"
      fi
    fi
  done
  filesystem_orphans="$(find "$LOCAL_STORAGE_ROOT/objects" -type f | while IFS= read -r filename; do
    storage_key="${filename#"$LOCAL_STORAGE_ROOT/"}"
    if ! grep -Fqx "$storage_key" "$known_keys" && ! grep -Fqx "$storage_key" "$pending_keys"; then printf '%s\n' 1; fi
  done | wc -l | tr -d ' ')"
  pending_deletions="$(find "$LOCAL_STORAGE_ROOT/objects" -type f | while IFS= read -r filename; do
    storage_key="${filename#"$LOCAL_STORAGE_ROOT/"}"
    if grep -Fqx "$storage_key" "$pending_keys"; then printf '%s\n' 1; fi
  done | wc -l | tr -d ' ')"
fi

printf '%s\n' \
  "DRY_RUN missing_files=$missing_files unreferenced_rows=$unreferenced_rows pending_deletions=$pending_deletions filesystem_orphans=$filesystem_orphans"
