#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM
bin="$test_root/bin"
mkdir -p "$bin"

cat >"$bin/id" <<'EOF'
#!/bin/sh
[ "${1:-}" = -u ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
EOF
cat >"$bin/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac
EOF
cat >"$bin/ss" <<'EOF'
#!/bin/sh
[ "${FAKE_PORT_CHECK_FAIL:-0}" = 0 ] || exit 1
exit 0
EOF
cat >"$bin/install" <<'EOF'
#!/bin/sh
if [ "$1" = -d ]; then
  for value in "$@"; do target=$value; done
  mkdir -p "$target"
  exit 0
fi
previous=
for value in "$@"; do previous_previous=$previous; previous=$value; done
cp "$previous_previous" "$previous"
chmod 0755 "$previous"
EOF
cat >"$bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
if [ "${1:-}" = --config ]; then shift 2; fi
case "${1:-} ${2:-}" in
  "info --format") echo linux/x86_64 ;;
  "image inspect") echo "${FAKE_IMAGE_IDENTITY:-linux/amd64 1111111111111111111111111111111111111111 v1.0.0-rc.1}" ;;
  "info " | "compose version" | "pull --platform" | "run --rm") ;;
  "ps -aq" | "volume ls" | "network ls") ;;
  *) ;;
esac
exit 0
EOF
chmod +x "$bin"/*

manifest="$test_root/product-hub-release.manifest"
cat >"$manifest" <<'EOF'
schema=product-hub-release/v1
version=v1.0.0-rc.1
source_commit=1111111111111111111111111111111111111111
distribution_commit=1111111111111111111111111111111111111111
platform=linux/amd64
runner=ghcr.io/cobrander-dev/product-hub-oss-app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
migrator=ghcr.io/cobrander-dev/product-hub-oss-migrator@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
worker=ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
postgres=postgres@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
workflow_run=1
published_at=2026-10-05T00:00:00.000Z
EOF

: >"$test_root/docker.log"
PRODUCT_HUB_ROOT="$test_root/install-root" \
PRODUCT_HUB_CLI_PATH="$test_root/product-hub" \
PRODUCT_HUB_RELEASE_MANIFEST="$manifest" \
FAKE_DOCKER_LOG="$test_root/docker.log" \
PATH="$bin:$PATH" \
  sh "$project_dir/setup.sh" >"$test_root/setup.out"

grep -F -- 'run --rm -it --user 0:0 --read-only' "$test_root/docker.log" >/dev/null ||
  grep -F -- 'run --rm -i --user 0:0 --read-only' "$test_root/docker.log" >/dev/null
grep -F -- '--cap-drop ALL --cap-add CHOWN --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true --network none' "$test_root/docker.log" >/dev/null
grep -F -- '/var/run/docker.sock' "$test_root/docker.log" >/dev/null
! grep -F -- '--privileged' "$test_root/docker.log" >/dev/null
[ -x "$test_root/product-hub" ]

mkdir -p "$test_root/existing-root"
: >"$test_root/existing.log"
if PRODUCT_HUB_ROOT="$test_root/existing-root" \
  PRODUCT_HUB_CLI_PATH="$test_root/other-cli" \
  PRODUCT_HUB_RELEASE_MANIFEST="$manifest" \
  FAKE_DOCKER_LOG="$test_root/existing.log" \
  PATH="$bin:$PATH" \
  sh "$project_dir/setup.sh" >/dev/null 2>&1; then
  echo 'setup accepted an existing installation' >&2
  exit 1
fi
! grep -E '(^| )pull |(^| )run ' "$test_root/existing.log" >/dev/null

: >"$test_root/port.log"
if PRODUCT_HUB_ROOT="$test_root/port-root" \
  PRODUCT_HUB_CLI_PATH="$test_root/port-cli" \
  PRODUCT_HUB_RELEASE_MANIFEST="$manifest" \
  FAKE_DOCKER_LOG="$test_root/port.log" \
  FAKE_PORT_CHECK_FAIL=1 PATH="$bin:$PATH" \
  sh "$project_dir/setup.sh" >/dev/null 2>&1; then
  echo 'setup accepted failed port detection' >&2
  exit 1
fi
! grep -E '(^| )pull |(^| )run ' "$test_root/port.log" >/dev/null
[ ! -e "$test_root/port-root" ]

for wrong_identity in \
  'linux/arm64 1111111111111111111111111111111111111111 v1.0.0-rc.1' \
  'linux/amd64 2222222222222222222222222222222222222222 v1.0.0-rc.1' \
  'linux/amd64 1111111111111111111111111111111111111111 v9.9.9'; do
  : >"$test_root/identity.log"
  if PRODUCT_HUB_ROOT="$test_root/rejected-root" \
    PRODUCT_HUB_CLI_PATH="$test_root/rejected-cli" \
    PRODUCT_HUB_RELEASE_MANIFEST="$manifest" \
    FAKE_DOCKER_LOG="$test_root/identity.log" \
    FAKE_IMAGE_IDENTITY="$wrong_identity" \
    PATH="$bin:$PATH" \
    sh "$project_dir/setup.sh" >/dev/null 2>&1; then
    echo 'setup accepted a mismatched control image' >&2
    exit 1
  fi
  [ ! -e "$test_root/rejected-root" ]
  ! grep -E '(^| )run ' "$test_root/identity.log" >/dev/null
done

# Exercise the canonical verification contract through BOTH shell entry points.
verification="verification-1111111111111111111111111111111111111111"
verification_manifest="$test_root/verification.manifest"
sed -e "s/version=v1.0.0-rc.1/version=$verification/" \
  -e 's/schema=product-hub-release\/v1/schema_version=1/' \
  -e 's/workflow_run=/workflow_run_id=/' \
  -e 's/published_at=/created_at=/' "$manifest" >"$verification_manifest"
: >"$test_root/verification.log"
PRODUCT_HUB_ROOT="$test_root/verification-root" \
PRODUCT_HUB_CLI_PATH="$test_root/verification-cli" \
PRODUCT_HUB_RELEASE_MANIFEST="$verification_manifest" \
FAKE_IMAGE_IDENTITY="linux/amd64 1111111111111111111111111111111111111111 $verification" \
FAKE_DOCKER_LOG="$test_root/verification.log" PATH="$bin:$PATH" \
  sh "$project_dir/setup.sh" >"$test_root/verification.out"
grep -F 'ghcr.io/cobrander-dev/product-hub-oss-migrator@sha256:' "$test_root/verification.log" >/dev/null
mkdir -p "$test_root/verification-root/releases/1111111111111111111111111111111111111111/bundle"
cp "$verification_manifest" "$test_root/verification-root/releases/current.manifest"
for command in status doctor; do
  PRODUCT_HUB_ROOT="$test_root/verification-root" \
  FAKE_IMAGE_IDENTITY="linux/amd64 1111111111111111111111111111111111111111 $verification" \
  FAKE_DOCKER_LOG="$test_root/verification.log" PATH="$bin:$PATH" \
    sh "$project_dir/scripts/product-hub" "$command"
  grep -F "operator-cli.ts $command" "$test_root/verification.log" >/dev/null
done

# A formal SemVer manifest promotes the unchanged images verified for the SAME
# full source commit, so their version label stays verification-<commit>.
promoted="linux/amd64 1111111111111111111111111111111111111111 $verification"
: >"$test_root/promoted.log"
PRODUCT_HUB_ROOT="$test_root/promoted-root" \
PRODUCT_HUB_CLI_PATH="$test_root/promoted-cli" \
PRODUCT_HUB_RELEASE_MANIFEST="$manifest" \
FAKE_IMAGE_IDENTITY="$promoted" \
FAKE_DOCKER_LOG="$test_root/promoted.log" PATH="$bin:$PATH" \
  sh "$project_dir/setup.sh" >"$test_root/promoted.out"
grep -F 'operator-cli.ts setup' "$test_root/promoted.log" >/dev/null
mkdir -p "$test_root/promoted-root/releases/1111111111111111111111111111111111111111/bundle"
cp "$manifest" "$test_root/promoted-root/releases/current.manifest"
PRODUCT_HUB_ROOT="$test_root/promoted-root" \
FAKE_IMAGE_IDENTITY="$promoted" \
FAKE_DOCKER_LOG="$test_root/promoted.log" PATH="$bin:$PATH" \
  sh "$project_dir/scripts/product-hub" status
grep -F 'operator-cli.ts status' "$test_root/promoted.log" >/dev/null

# Promotion never relaxes architecture, commit or version binding.
for case in \
  "$manifest|linux/amd64 1111111111111111111111111111111111111111 verification-2222222222222222222222222222222222222222" \
  "$manifest|linux/amd64 2222222222222222222222222222222222222222 verification-1111111111111111111111111111111111111111" \
  "$manifest|linux/arm64 1111111111111111111111111111111111111111 verification-1111111111111111111111111111111111111111" \
  "$manifest|linux/amd64 1111111111111111111111111111111111111111 verification-111111111111111111111111111111111111111" \
  "$manifest|linux/amd64 1111111111111111111111111111111111111111 sha-1111111111111111111111111111111111111111" \
  "$verification_manifest|linux/amd64 1111111111111111111111111111111111111111 v1.0.0-rc.1" \
  "$verification_manifest|linux/amd64 1111111111111111111111111111111111111111 verification-2222222222222222222222222222222222222222"; do
  case_manifest=${case%%|*}
  case_identity=${case#*|}
  : >"$test_root/promotion-reject.log"
  if PRODUCT_HUB_ROOT="$test_root/promotion-reject-root" \
    PRODUCT_HUB_CLI_PATH="$test_root/promotion-reject-cli" \
    PRODUCT_HUB_RELEASE_MANIFEST="$case_manifest" \
    FAKE_IMAGE_IDENTITY="$case_identity" \
    FAKE_DOCKER_LOG="$test_root/promotion-reject.log" PATH="$bin:$PATH" \
    sh "$project_dir/setup.sh" >/dev/null 2>&1; then
    echo "setup accepted mismatched identity: $case_identity" >&2
    exit 1
  fi
  [ ! -e "$test_root/promotion-reject-root" ]
  ! grep -E '(^| )run ' "$test_root/promotion-reject.log" >/dev/null
  if PRODUCT_HUB_ROOT="$test_root/promoted-root" \
    FAKE_IMAGE_IDENTITY="$case_identity" \
    FAKE_DOCKER_LOG="$test_root/promotion-reject.log" PATH="$bin:$PATH" \
    sh "$project_dir/scripts/product-hub" status >/dev/null 2>&1 &&
    [ "$case_manifest" = "$manifest" ]; then
    echo "CLI accepted mismatched identity: $case_identity" >&2
    exit 1
  fi
done

echo 'PASS: setup and CLI verification contract, formal-release promotion identity, shell preflight, existing-install stop, image identity rejection, and control-container hardening'
