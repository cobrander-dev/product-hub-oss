#!/bin/sh
set -eu
project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
: "${HARD_DELETE_WORKER_IMAGE:?Reviewed worker image is required}"
: "${HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE:?Worker secret file is required}"
env_file=${PRODUCT_HUB_ENV_FILE:-/opt/product-hub/config/product-hub.env}
release_file=${PRODUCT_HUB_RELEASE_FILE:-$project_dir/compose.release.yaml}
[ -f "$env_file" ] && [ -f "$release_file" ] && [ -s "$HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE" ] || { echo 'Required deployment inputs missing' >&2; exit 1; }
# The same fail-closed verifier accepts three image references.
"$project_dir/scripts/verify-production-image-architecture.sh" "$HARD_DELETE_WORKER_IMAGE" "$HARD_DELETE_WORKER_IMAGE" "$HARD_DELETE_WORKER_IMAGE"
# Validate quietly. Never echo interpolated secrets or full Compose environment.
docker compose --env-file "$env_file" -p product-hub -f "$project_dir/compose.yaml" -f "$project_dir/compose.production.yaml" -f "$release_file" -f "$project_dir/compose.hard-delete.yaml" --profile operations-hard-delete config --quiet
docker compose --env-file "$env_file" -p product-hub -f "$project_dir/compose.yaml" -f "$project_dir/compose.production.yaml" -f "$release_file" -f "$project_dir/compose.hard-delete.yaml" --profile operations-hard-delete up -d --no-deps --no-build hard-delete-worker
