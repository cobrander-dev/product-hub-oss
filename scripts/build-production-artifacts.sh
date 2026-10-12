#!/bin/sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
release_tag=${1:-}

if [ -z "$release_tag" ]; then
  echo "Usage: $0 <release-tag>" >&2
  exit 64
fi

case "$release_tag" in
  latest) echo "latest is not a release identity" >&2; exit 64 ;;
  *[!A-Za-z0-9._-]* | -* | *-) echo "Invalid release tag: $release_tag" >&2; exit 64 ;;
esac

runner_image="product-hub:$release_tag"
migrator_image="product-hub-migrator:$release_tag"
worker_image="product-hub-hard-delete-worker:$release_tag"
source_commit=$(git -C "$project_dir" rev-parse HEAD)

build_image() {
  target=$1
  image_ref=$2
  docker buildx build \
    --platform linux/amd64 \
    --load \
    --target "$target" \
    --build-arg "SOURCE_COMMIT=$source_commit" \
    --build-arg "RELEASE_VERSION=$release_tag" \
    --tag "$image_ref" \
    "$project_dir"
}

build_image runner "$runner_image"
build_image migrator "$migrator_image"
build_image hard-delete-worker "$worker_image"

"$project_dir/scripts/verify-production-image-architecture.sh" \
  "$runner_image" \
  "$migrator_image" \
  "$worker_image"

printf 'RUNNER_IMAGE=%s\n' "$runner_image"
printf 'MIGRATOR_IMAGE=%s\n' "$migrator_image"
printf 'HARD_DELETE_WORKER_IMAGE=%s\n' "$worker_image"
