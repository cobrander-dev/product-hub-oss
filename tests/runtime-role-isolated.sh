#!/bin/bash
set -euo pipefail

# Runs entirely in disposable local Docker resources. No host port is opened.
: "${MIGRATOR_IMAGE:?Set MIGRATOR_IMAGE to the reviewed migrator image}"
: "${MIGRATOR_PLATFORM:=linux/amd64}"
docker image inspect "$MIGRATOR_IMAGE" >/dev/null

project_dir=$(cd "$(dirname "$0")/.." && pwd)
suffix=$(openssl rand -hex 4)
container="product-hub-gate3df-pg-$suffix"
network="product-hub-gate3df-network-$suffix"
volume="product-hub-gate3df-pgdata-$suffix"
created_network=0
created_volume=0
created_container=0

if docker container inspect "$container" >/dev/null 2>&1 ||
  docker network inspect "$network" >/dev/null 2>&1 ||
  docker volume inspect "$volume" >/dev/null 2>&1; then
  echo 'Refusing to reuse an existing isolated test resource' >&2
  exit 1
fi

cleanup() {
  if [ "$created_container" = 1 ]; then
    docker stop --time 30 "$container" >/dev/null 2>&1 || true
    docker rm "$container" >/dev/null 2>&1 || true
  fi
  if [ "$created_volume" = 1 ]; then
    docker volume rm "$volume" >/dev/null 2>&1 || true
  fi
  if [ "$created_network" = 1 ]; then
    docker network rm "$network" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

export POSTGRES_DB=product_hub_gate3df_test
export POSTGRES_USER=product_hub_db_admin
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export MIGRATION_DB_USER=product_hub_migration
export MIGRATION_DB_PASSWORD="$(openssl rand -hex 32)"
export APP_DB_USER=product_hub_app
export APP_DB_PASSWORD="$(openssl rand -hex 32)"
export HARD_DELETE_WORKER_DB_USER=product_hub_hard_delete_worker
export HARD_DELETE_WORKER_DB_PASSWORD="$(openssl rand -hex 32)"
export DATABASE_URL="postgresql://${MIGRATION_DB_USER}:${MIGRATION_DB_PASSWORD}@${container}:5432/${POSTGRES_DB}"
export ADMIN_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${container}:5432/${POSTGRES_DB}"

docker network create --internal "$network" >/dev/null
created_network=1
docker volume create "$volume" >/dev/null
created_volume=1
created_container=1
docker run -d --name "$container" --network "$network" \
  --mount "type=volume,source=${volume},target=/var/lib/postgresql" \
  --mount "type=bind,source=${project_dir}/docker/postgres/init-production,target=/docker-entrypoint-initdb.d,readonly" \
  -e POSTGRES_DB -e POSTGRES_USER -e POSTGRES_PASSWORD \
  -e MIGRATION_DB_USER -e MIGRATION_DB_PASSWORD -e APP_DB_USER -e APP_DB_PASSWORD \
  --health-cmd='pg_isready -U product_hub_db_admin -d product_hub_gate3df_test' \
  --health-interval=2s --health-timeout=3s --health-retries=30 --health-start-period=5s \
  postgres:18.6-bookworm >/dev/null

for _ in $(seq 1 45); do
  health=$(docker inspect "$container" -f '{{.State.Health.Status}}')
  [ "$health" = healthy ] && break
  [ "$health" = unhealthy ] && { echo 'Isolated PostgreSQL unhealthy' >&2; exit 1; }
  sleep 2
done
[ "$(docker inspect "$container" -f '{{.State.Health.Status}}')" = healthy ]
[ "$(docker inspect "$container" -f '{{.HostConfig.NetworkMode}}')" = "$network" ]
[ -z "$(docker port "$container")" ]
echo 'ISOLATED_POSTGRES=HEALTHY_NO_HOST_PORT'

docker run --rm --platform "$MIGRATOR_PLATFORM" --network "$network" -e DATABASE_URL "$MIGRATOR_IMAGE" \
  node ./node_modules/prisma/build/index.js migrate deploy
docker run --rm --platform "$MIGRATOR_PLATFORM" --network "$network" -e DATABASE_URL "$MIGRATOR_IMAGE" \
  node ./node_modules/prisma/build/index.js migrate status

# Reproduce the former broad grants so the first run proves remediation.
docker exec "$container" sh -c 'psql -X -w -v ON_ERROR_STOP=1 -U "$MIGRATION_DB_USER" -d "$POSTGRES_DB" -q -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO product_hub_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO product_hub_app"' >/dev/null
[ "$(docker exec "$container" psql -X -w -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT has_table_privilege('product_hub_app','public.\"_prisma_migrations\"','UPDATE')")" = t ]
echo 'OLD_VULNERABLE_GRANT_REPRODUCED=PASS'

run_grants() {
  docker run --rm --platform "$MIGRATOR_PLATFORM" --network "$network" \
    --mount "type=bind,source=${project_dir}/scripts/configure-runtime-role.ts,target=/app/scripts/configure-runtime-role.ts,readonly" \
    -e DATABASE_URL -e APP_DB_USER "$MIGRATOR_IMAGE" \
    node ./node_modules/tsx/dist/cli.mjs scripts/configure-runtime-role.ts
}
run_grants
echo 'FIRST_GRANT=PASS'
docker exec -i "$container" sh < "$project_dir/tests/runtime-role-privileges.sh"
docker exec -i "$container" sh < "$project_dir/tests/production-role-model.sh"
docker run --rm --platform "$MIGRATOR_PLATFORM" --network "$network" \
  --mount "type=bind,source=${project_dir}/scripts/provision-hard-delete-worker-role.ts,target=/app/scripts/provision-hard-delete-worker-role.ts,readonly" \
  -e ADMIN_DATABASE_URL -e MIGRATION_DB_USER -e APP_DB_USER \
  -e HARD_DELETE_WORKER_DB_USER -e HARD_DELETE_WORKER_DB_PASSWORD \
  "$MIGRATOR_IMAGE" \
  node ./node_modules/tsx/dist/cli.mjs scripts/provision-hard-delete-worker-role.ts
echo 'HARD_DELETE_WORKER_PROVISIONING=PASS'
docker exec -e HARD_DELETE_WORKER_DB_USER -e HARD_DELETE_WORKER_DB_PASSWORD \
  -i "$container" sh < "$project_dir/tests/hard-delete-foundation-privileges.sh"
if [ -n "${HARD_DELETE_WORKER_IMAGE:-}" ]; then
  "$project_dir/scripts/verify-production-image-architecture.sh" "$HARD_DELETE_WORKER_IMAGE" "$HARD_DELETE_WORKER_IMAGE" "$HARD_DELETE_WORKER_IMAGE"
  export HARD_DELETE_WORKER_DATABASE_URL="postgresql://${HARD_DELETE_WORKER_DB_USER}:${HARD_DELETE_WORKER_DB_PASSWORD}@${container}:5432/${POSTGRES_DB}"
  [ "$(docker exec "$container" psql -X -w -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT count(*) FROM "HardDeleteOperation"')" = 0 ]
  # Exercise the actual idle daemon and controlled SIGTERM. A nonexistent explicit
  # operation must fail with P0002 and is not a successful startup probe.
  worker_probe_status=0
  docker run --rm --platform linux/amd64 --network "$network" --read-only \
    --user 1001:1001 --cap-drop ALL --security-opt no-new-privileges:true \
    --pids-limit 128 --memory 512m --cpus 1 --tmpfs /tmp:size=32m,mode=1777 \
    -e HARD_DELETE_WORKER_DATABASE_URL -e LOCAL_STORAGE_ROOT=/data/uploads \
    "$HARD_DELETE_WORKER_IMAGE" timeout --preserve-status --signal=TERM --kill-after=10s 20s \
    node ./node_modules/tsx/dist/cli.mjs scripts/run-hard-delete-worker.ts || worker_probe_status=$?
  # The tsx launcher may itself exit with 128+SIGTERM even when its worker
  # receives the planned stop. Configuration/execution errors (1) and forced
  # SIGKILL (137) remain failures; do not interpret a normal SIGTERM as one.
  case "$worker_probe_status" in
    0|143) ;;
    *) echo "AMD64 worker idle startup probe failed (exit $worker_probe_status)" >&2; exit 1 ;;
  esac
  [ "$(docker exec "$container" psql -X -w -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT count(*) FROM "HardDeleteOperation"')" = 0 ]
  [ "$(docker exec "$container" psql -X -w -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT count(*) FROM "HardDeleteFileTask"')" = 0 ]
  echo 'AMD64_WORKER_STARTUP_RESTRICTED_ROLE_READ_ONLY=PASS_NO_OPERATION_CREATED'
fi
run_grants
echo 'REPEATED_GRANT=PASS'
docker exec -i "$container" sh < "$project_dir/tests/runtime-role-privileges.sh"

# Future tables remain inaccessible until an updated allowlist is reviewed.
docker exec "$container" sh -c 'psql -X -w -v ON_ERROR_STOP=1 -U "$MIGRATION_DB_USER" -d "$POSTGRES_DB" -q -c "CREATE TABLE gate3df_unknown_table (id integer PRIMARY KEY)"' >/dev/null
if run_grants >/dev/null 2>&1; then
  echo 'UNKNOWN_TABLE_GATE=FAIL' >&2
  exit 1
fi
docker exec "$container" sh -c 'psql -X -w -v ON_ERROR_STOP=1 -U "$MIGRATION_DB_USER" -d "$POSTGRES_DB" -q -c "DROP TABLE gate3df_unknown_table"' >/dev/null
echo 'UNKNOWN_TABLE_GATE=PASS_DENIED'

# Re-running the reviewed script also removes a direct column-level grant.
docker exec "$container" sh -c 'psql -X -w -v ON_ERROR_STOP=1 -U "$MIGRATION_DB_USER" -d "$POSTGRES_DB" -q -c "GRANT SELECT (id) ON TABLE \"_prisma_migrations\" TO product_hub_app"' >/dev/null
run_grants
[ "$(docker exec "$container" psql -X -w -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT has_any_column_privilege('product_hub_app','public.\"_prisma_migrations\"','SELECT')")" = f ]
echo 'COLUMN_GRANT_REMEDIATION=PASS'

docker exec -i "$container" sh < "$project_dir/tests/runtime-role-privileges.sh"
echo 'ISOLATED_REGRESSION=PASS'
