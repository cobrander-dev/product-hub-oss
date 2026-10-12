#!/bin/bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
suffix=$(openssl rand -hex 4)
container="product-hub-phase3-ui-pg-$suffix"
test_root=$(mktemp -d)
created_container=0
cleanup() {
  if [ "$created_container" = 1 ]; then docker stop --time 20 "$container" >/dev/null 2>&1 || true; docker rm "$container" >/dev/null 2>&1 || true; fi
  # Only the directory this invocation just created, never a shared uploads root.
  rm -rf "$test_root"
}
trap cleanup EXIT
export POSTGRES_DB="product_hub_phase3_${suffix}_test"
export POSTGRES_USER=product_hub_db_admin
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export MIGRATION_DB_USER=product_hub_migration
export MIGRATION_DB_PASSWORD="$(openssl rand -hex 32)"
export APP_DB_USER=product_hub_app
export APP_DB_PASSWORD="$(openssl rand -hex 32)"
export HARD_DELETE_WORKER_DB_USER=product_hub_hard_delete_worker
export HARD_DELETE_WORKER_DB_PASSWORD="$(openssl rand -hex 32)"
created_container=1
docker run -d --name "$container" -p 127.0.0.1::5432 \
  --mount "type=bind,source=${project_dir}/docker/postgres/init-production,target=/docker-entrypoint-initdb.d,readonly" \
  --tmpfs /var/lib/postgresql:rw,size=1g \
  -e POSTGRES_DB -e POSTGRES_USER -e POSTGRES_PASSWORD \
  -e MIGRATION_DB_USER -e MIGRATION_DB_PASSWORD -e APP_DB_USER -e APP_DB_PASSWORD \
  postgres:18.6-bookworm >/dev/null
for _ in $(seq 1 45); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
echo 'DISPOSABLE_POSTGRES_READY'
test_port=$(docker port "$container" 5432/tcp | sed 's/127.0.0.1://')
export ADMIN_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${test_port}/${POSTGRES_DB}"
migration_url="postgresql://${MIGRATION_DB_USER}:${MIGRATION_DB_PASSWORD}@127.0.0.1:${test_port}/${POSTGRES_DB}"
export APP_RUNTIME_DATABASE_URL="postgresql://${APP_DB_USER}:${APP_DB_PASSWORD}@127.0.0.1:${test_port}/${POSTGRES_DB}"
export HARD_DELETE_WORKER_DATABASE_URL="postgresql://${HARD_DELETE_WORKER_DB_USER}:${HARD_DELETE_WORKER_DB_PASSWORD}@127.0.0.1:${test_port}/${POSTGRES_DB}"
export LOCAL_STORAGE_ROOT="$test_root/uploads"
mkdir -p "$LOCAL_STORAGE_ROOT"
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export BETTER_AUTH_URL=http://127.0.0.1:3100
export BETTER_AUTH_TRUSTED_ORIGINS=http://127.0.0.1:3100,http://127.0.0.1:3000
export STORAGE_DRIVER=local
export TEST_ADMIN_PASSWORD="$(openssl rand -hex 16)"
export TEST_FACTORY_A_PASSWORD="$(openssl rand -hex 16)"
export TEST_FACTORY_B_PASSWORD="$(openssl rand -hex 16)"
export TEST_NEW_PASSWORD="$(openssl rand -hex 16)"
cd "$project_dir"
DATABASE_URL="$migration_url" node ./node_modules/prisma/build/index.js migrate deploy
DATABASE_URL="$migration_url" node ./node_modules/tsx/dist/cli.mjs scripts/configure-runtime-role.ts
node ./node_modules/tsx/dist/cli.mjs scripts/provision-hard-delete-worker-role.ts
DATABASE_URL="$migration_url" node ./node_modules/tsx/dist/cli.mjs scripts/configure-runtime-role.ts
# Fixture runner is bootstrap; UI server uses the independently restricted App role.
export DATABASE_URL="$ADMIN_DATABASE_URL"
# Playwright can include request headers in failure diagnostics. Redact those
# before output leaves this disposable harness, while preserving failure status.
run_redacted() {
  "$@" 2>&1 | node --input-type=module -e 'import readline from "node:readline"; const r=readline.createInterface({input:process.stdin}); r.on("line", s=>console.log(s.replace(/((?:["\x27])?(?:set-cookie|cookie|authorization)(?:["\x27])?\s*:\s*).*/ig,"$1[REDACTED]").replace(/postgres(?:ql)?:\/\/[^\s"\x27]+/ig,"[REDACTED_DATABASE_URL]").replace(/("(?:password|sessionToken|token)"\s*:\s*")[^"]*/ig,"$1[REDACTED]")));'
}
if [ "${1:-}" = ci ]; then
  run_redacted pnpm ci:check
else
  run_redacted node ./node_modules/@playwright/test/cli.js test --config=playwright.hard-delete-ui.config.ts
  if [ "${1:-}" = full ]; then run_redacted pnpm ci:check; fi
fi
