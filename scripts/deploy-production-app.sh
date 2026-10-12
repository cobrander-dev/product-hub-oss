#!/bin/sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="${PRODUCT_HUB_ENV_FILE:-/opt/product-hub/config/product-hub.env}"
release_file="${PRODUCT_HUB_RELEASE_FILE:-$project_dir/compose.release.yaml}"

if [ ! -f "$env_file" ]; then
  echo "Production environment file not found: $env_file" >&2
  exit 1
fi

if [ ! -f "$release_file" ]; then
  echo "Reviewed release override not found: $release_file" >&2
  exit 1
fi

cd "$project_dir"

docker compose \
  --env-file "$env_file" \
  -p product-hub \
  -f compose.yaml \
  -f compose.production.yaml \
  -f "$release_file" \
  config --quiet

docker compose \
  --env-file "$env_file" \
  -p product-hub \
  -f compose.yaml \
  -f compose.production.yaml \
  -f "$release_file" \
  up -d --no-deps app
