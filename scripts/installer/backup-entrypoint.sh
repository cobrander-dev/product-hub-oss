#!/bin/sh
set -eu
# The one-shot container receives five validated fields only through stdin.
IFS= read -r PGHOST
IFS= read -r PGPORT
IFS= read -r PGDATABASE
IFS= read -r PGUSER
IFS= read -r password
if IFS= read -r extra; then echo 'FAIL: BACKUP_INPUT' >&2; exit 1; fi
umask 077
PGPASSFILE=$(mktemp /tmp/product-hub-backup-password.XXXXXX)
trap 'rm -f "$PGPASSFILE"' EXIT HUP INT TERM
{
  separator=''
  for value in "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" "$password"; do
    printf '%s' "$separator"
    printf '%s' "$value" | sed 's/\\/\\\\/g;s/:/\\:/g'
    separator=':'
  done
  printf '\n'
} >"$PGPASSFILE"
unset password value DATABASE_URL PGPASSWORD PGSERVICE PGSERVICEFILE
export PGHOST PGPORT PGDATABASE PGUSER PGPASSFILE
export PGCONNECT_TIMEOUT=10
sh /operations/backup.sh
