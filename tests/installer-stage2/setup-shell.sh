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
for port in ${FAKE_BUSY_PORTS:-}; do
  case " $* " in *":$port "*) echo "LISTEN 0 511 0.0.0.0:$port 0.0.0.0:* users:((\"nginx\",pid=1,fd=6))" ;; esac
done
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

# HTTPS port: a busy port is never taken over, and a custom port without
# usable port 80 needs an explicit local-CA choice (no terminal = cancel).
run_port_case() {
  case_log="$test_root/https-$1.log"
  : >"$case_log"
  case_name=$1
  shift
  env PRODUCT_HUB_ROOT="$test_root/https-root-$case_name" \
    PRODUCT_HUB_CLI_PATH="$test_root/https-cli-$case_name" \
    PRODUCT_HUB_RELEASE_MANIFEST="$manifest" FAKE_DOCKER_LOG="$case_log" \
    PATH="$bin:$PATH" "$@" sh "$project_dir/setup.sh" >"$case_log.out" 2>&1
}
! run_port_case busy PRODUCT_HUB_HTTPS_PORT=8443 FAKE_BUSY_PORTS=8443
grep -F 'HTTPS_PORT_IN_USE' "$test_root/https-busy.log.out" >/dev/null
! grep -E '(^| )pull |(^| )run ' "$test_root/https-busy.log" >/dev/null
! run_port_case invalid PRODUCT_HUB_HTTPS_PORT=80
grep -F 'HTTPS_PORT_INVALID' "$test_root/https-invalid.log.out" >/dev/null
! run_port_case noacme PRODUCT_HUB_HTTPS_PORT=9443 FAKE_BUSY_PORTS=80
grep -F 'ACME_HTTP_PORT_UNAVAILABLE' "$test_root/https-noacme.log.out" >/dev/null
grep -F 'DNS-01' "$test_root/https-noacme.log.out" >/dev/null
! grep -E '(^| )pull |(^| )run ' "$test_root/https-noacme.log" >/dev/null
run_port_case internal PRODUCT_HUB_HTTPS_PORT=9443 FAKE_BUSY_PORTS=80 PRODUCT_HUB_TLS_ISSUER=internal
grep -F 'PRODUCT_HUB_HTTPS_PORT=9443' "$test_root/https-internal.log" >/dev/null
grep -F 'PRODUCT_HUB_RELAY_ROLE=none' "$test_root/https-internal.log" >/dev/null
grep -F 'PRODUCT_HUB_HTTP_BIND=127.0.0.1:18080' "$test_root/https-internal.log" >/dev/null
grep -F 'PRODUCT_HUB_TLS_ISSUER=internal' "$test_root/https-internal.log" >/dev/null
run_port_case holder PRODUCT_HUB_HTTPS_PORT=9443 FAKE_BUSY_PORTS=443
grep -F 'PRODUCT_HUB_RELAY_ROLE=holder' "$test_root/https-holder.log" >/dev/null
grep -F 'PRODUCT_HUB_HTTP_BIND=80 ' "$test_root/https-holder.log" >/dev/null
grep -F 'PRODUCT_HUB_HTTPS_MODE=builtin' "$test_root/https-holder.log" >/dev/null

# Shared HTTPS gateway: an owner of 80/443 that cannot be managed safely stops setup
# before any pull; otherwise the mode reaches the control container.
! run_port_case gw-nginx PRODUCT_HUB_HTTPS_MODE=gateway FAKE_BUSY_PORTS='80 443'
grep -F 'GATEWAY_UNAVAILABLE' "$test_root/https-gw-nginx.log.out" >/dev/null
grep -F 'nginx' "$test_root/https-gw-nginx.log.out" >/dev/null
! grep -E '(^| )pull |(^| )run ' "$test_root/https-gw-nginx.log" >/dev/null
[ ! -e "$test_root/https-root-gw-nginx" ]
! run_port_case gw-invalid PRODUCT_HUB_HTTPS_MODE=other
grep -F 'INVALID_HTTPS_MODE' "$test_root/https-gw-invalid.log.out" >/dev/null
# The fake control container installs nothing, so registering the site must fail loudly.
! run_port_case gw-free PRODUCT_HUB_HTTPS_MODE=gateway
grep -F 'PRODUCT_HUB_HTTPS_MODE=gateway' "$test_root/https-gw-free.log" >/dev/null
grep -F 'GATEWAY_SITE_FAILED' "$test_root/https-gw-free.log.out" >/dev/null
[ -x "$test_root/https-root-gw-free/oss-gateway.sh" ]

echo 'PASS: HTTPS port selection, busy-port refusal and explicit certificate choice'
echo 'PASS: shared HTTPS gateway refusal and mode hand-off'
echo 'PASS: setup and CLI verification contract, formal-release promotion identity, shell preflight, existing-install stop, image identity rejection, and control-container hardening'
