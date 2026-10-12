#!/bin/sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

compose_env() {
  env \
    APP_DOMAIN=product-hub.invalid \
    APP_DATABASE_URL=postgresql://app:placeholder@postgres:5432/product_hub \
    MIGRATION_DATABASE_URL=postgresql://migration:placeholder@postgres:5432/product_hub \
    BETTER_AUTH_SECRET=test-only-placeholder-value-with-32-bytes \
    BETTER_AUTH_URL=https://product-hub.invalid \
    BETTER_AUTH_TRUSTED_ORIGINS=https://product-hub.invalid \
    POSTGRES_DB=product_hub \
    POSTGRES_USER=product_hub_db_admin \
    POSTGRES_PASSWORD=placeholder-bootstrap \
    MIGRATION_DB_USER=product_hub_migration \
    MIGRATION_DB_PASSWORD=placeholder-migration \
    APP_DB_USER=product_hub_app \
    APP_DB_PASSWORD=placeholder-runtime \
    STORAGE_DRIVER=local \
    "$@"
}

prepare_release() {
  release_dir="$1"
  app_image="$2"
  migrator_image="$3"
  mkdir -p "$release_dir"
  cp "$project_dir/compose.yaml" "$release_dir/compose.yaml"
  cp "$project_dir/compose.production.yaml" "$release_dir/compose.production.yaml"
  cat >"$release_dir/compose.release.yaml" <<EOF
services:
  app:
    image: $app_image
    build: !reset null
  migration:
    image: $migrator_image
    build: !reset null
EOF
}

normalize_release() {
  release_dir="$1"
  (
    cd "$release_dir"
    compose_env docker compose \
      -p product-hub \
      -f compose.yaml \
      -f compose.production.yaml \
      -f compose.release.yaml \
      --profile operations \
      config --format json
  )
}

prepare_release "$test_root/release-old" product-hub:old product-hub-migrator:old
prepare_release "$test_root/release-new" product-hub:new product-hub-migrator:new

normalize_release "$test_root/release-old" >"$test_root/compose-old.json"
normalize_release "$test_root/release-new" >"$test_root/compose-new.json"
PRODUCT_HUB_POSTGRES_INIT_DIR="$test_root/custom-init" \
  normalize_release "$test_root/release-new" >"$test_root/compose-custom-init.json"
node -e '
  const fs = require("node:fs");
  const service = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).services.postgres;
  fs.writeFileSync(process.argv[2], `${JSON.stringify(service)}\n`);
' "$test_root/compose-old.json" "$test_root/postgres-old.json"
node -e '
  const fs = require("node:fs");
  const service = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).services.postgres;
  fs.writeFileSync(process.argv[2], `${JSON.stringify(service)}\n`);
' "$test_root/compose-new.json" "$test_root/postgres-new.json"
cmp -s "$test_root/postgres-old.json" "$test_root/postgres-new.json"

node -e '
  const fs = require("node:fs");
  const compose = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const service = compose.services.postgres;
  for (const name of ["app", "migration"]) {
    if (compose.services[name].platform !== "linux/amd64") {
      throw new Error(`${name} is not pinned to linux/amd64`);
    }
  }
  const initMount = service.volumes.find(
    (volume) => volume.target === "/docker-entrypoint-initdb.d",
  );
  if (
    !initMount ||
    initMount.type !== "bind" ||
    initMount.source !== "/opt/product-hub/config/postgres/init-production" ||
    initMount.read_only !== true
  ) {
    throw new Error("PostgreSQL init mount is not the reviewed stable read-only path");
  }
' "$test_root/compose-new.json"

node -e '
  const fs = require("node:fs");
  const compose = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const initMount = compose.services.postgres.volumes.find(
    (volume) => volume.target === "/docker-entrypoint-initdb.d",
  );
  if (initMount?.source !== process.argv[2] || initMount.read_only !== true) {
    throw new Error("PostgreSQL init directory override was not applied safely");
  }
' "$test_root/compose-custom-init.json" "$test_root/custom-init"

node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (pkg.scripts["release:build:amd64"] !== "sh scripts/build-production-artifacts.sh") {
    throw new Error("package release build does not use the controlled amd64 entrypoint");
  }
' "$project_dir/package.json"

build_script="$project_dir/scripts/build-production-artifacts.sh"
[ "$(grep -c -F -- 'docker buildx build' "$build_script")" = 1 ]
[ "$(grep -c -F -- '--platform linux/amd64' "$build_script")" = 1 ]
[ "$(grep -c -F -- '--load' "$build_script")" = 1 ]
! grep -E '(^|[[:space:]])docker build([[:space:]]|$)' "$build_script" >/dev/null

mkdir -p "$test_root/build-bin"
cat >"$test_root/build-bin/docker" <<'EOF'
#!/bin/sh
if [ "$1 $2" = "buildx build" ]; then
  printf '%s\n' "$*" >>"$DOCKER_BUILD_LOG"
  exit 0
fi
if [ "$1 $2" = "image inspect" ]; then
  if [ "${FAKE_IMAGE_MISSING:-0}" = 1 ]; then
    exit 1
  fi
  printf 'sha256:fixture|linux|%s\n' "${FAKE_IMAGE_ARCHITECTURE:-amd64}"
  exit 0
fi
echo "Unexpected docker command: $*" >&2
exit 1
EOF
chmod +x "$test_root/build-bin/docker"

DOCKER_BUILD_LOG="$test_root/build.log" \
PATH="$test_root/build-bin:$PATH" \
  "$build_script" release-test >"$test_root/build-output.log"

[ "$(wc -l <"$test_root/build.log" | tr -d ' ')" = 3 ]
source_commit="$(git -C "$project_dir" rev-parse HEAD)"
grep -F -- "--target runner --build-arg SOURCE_COMMIT=$source_commit --build-arg RELEASE_VERSION=release-test --tag product-hub:release-test" "$test_root/build.log" >/dev/null
grep -F -- "--target migrator --build-arg SOURCE_COMMIT=$source_commit --build-arg RELEASE_VERSION=release-test --tag product-hub-migrator:release-test" "$test_root/build.log" >/dev/null
grep -F -- "--target hard-delete-worker --build-arg SOURCE_COMMIT=$source_commit --build-arg RELEASE_VERSION=release-test --tag product-hub-hard-delete-worker:release-test" "$test_root/build.log" >/dev/null
[ "$(grep -c -F -- '--build-arg SOURCE_COMMIT=' "$test_root/build.log")" = 3 ]
grep -F -- 'PRODUCTION_IMAGE_ARCHITECTURE=PASS' "$test_root/build-output.log" >/dev/null

for invalid_tag in 'bad tag' 'bad/tag' ':latest' latest; do
  if DOCKER_BUILD_LOG="$test_root/rejected-build.log" \
    PATH="$test_root/build-bin:$PATH" \
    "$build_script" "$invalid_tag" >/dev/null 2>&1; then
    echo "Release build accepted invalid tag" >&2
    exit 1
  fi
done

for rejected_architecture in arm64 aarch64 unknown; do
  if DOCKER_BUILD_LOG="$test_root/build.log" \
    FAKE_IMAGE_ARCHITECTURE="$rejected_architecture" \
    PATH="$test_root/build-bin:$PATH" \
    "$project_dir/scripts/verify-production-image-architecture.sh" runner migrator worker >/dev/null 2>&1; then
    echo "Architecture gate accepted $rejected_architecture" >&2
    exit 1
  fi
done

if DOCKER_BUILD_LOG="$test_root/build.log" \
  FAKE_IMAGE_MISSING=1 \
  PATH="$test_root/build-bin:$PATH" \
  "$project_dir/scripts/verify-production-image-architecture.sh" runner migrator worker >/dev/null 2>&1; then
  echo "Architecture gate accepted a missing image" >&2
  exit 1
fi

mkdir -p "$test_root/bin"
cat >"$test_root/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$DOCKER_COMMAND_LOG"
EOF
chmod +x "$test_root/bin/docker"
: >"$test_root/product-hub.env"
: >"$test_root/compose.release.yaml"

DOCKER_COMMAND_LOG="$test_root/migration.log" \
PRODUCT_HUB_ENV_FILE="$test_root/product-hub.env" \
PRODUCT_HUB_RELEASE_FILE="$test_root/compose.release.yaml" \
PATH="$test_root/bin:$PATH" \
  "$project_dir/scripts/deploy-production-migration.sh"

[ "$(wc -l <"$test_root/migration.log" | tr -d ' ')" = 2 ]
grep -F -- '--profile operations run --rm --no-deps migration' "$test_root/migration.log" >/dev/null

DOCKER_COMMAND_LOG="$test_root/app.log" \
PRODUCT_HUB_ENV_FILE="$test_root/product-hub.env" \
PRODUCT_HUB_RELEASE_FILE="$test_root/compose.release.yaml" \
PATH="$test_root/bin:$PATH" \
  "$project_dir/scripts/deploy-production-app.sh"

[ "$(wc -l <"$test_root/app.log" | tr -d ' ')" = 2 ]
grep -F -- 'up -d --no-deps app' "$test_root/app.log" >/dev/null

echo "PASS: release paths preserve PostgreSQL, use --no-deps, and enforce inspected linux/amd64 artifacts"
