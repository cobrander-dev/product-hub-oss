#!/bin/sh
set -eu

release_tag=${PRODUCT_HUB_DOMAIN_TEST_TAG:?A reviewed local release tag is required}
case "$release_tag" in
  *[!A-Za-z0-9._-]* | -* | *-) echo "Invalid release tag" >&2; exit 64 ;;
esac

runner="product-hub:$release_tag"
migrator="product-hub-migrator:$release_tag"
worker="product-hub-hard-delete-worker:$release_tag"

"$(dirname "$0")/../scripts/verify-production-image-architecture.sh" \
  "$runner" "$migrator" "$worker"
runner_before=$(docker image inspect "$runner" --format '{{.Id}}')

for domain in products.example-a.com hub.example-b.com; do
  PRODUCT_HUB_BOOTSTRAP_TEST_TAG="$release_tag" \
    PRODUCT_HUB_BOOTSTRAP_TEST_DOMAIN="$domain" \
    pnpm test:production-install
  runner_after=$(docker image inspect "$runner" --format '{{.Id}}')
  if [ "$runner_after" != "$runner_before" ]; then
    echo "Runner image changed during domain tests" >&2
    exit 1
  fi
done

printf 'PASS: both isolated domains used the same Runner image ID %s\n' "$runner_before"
