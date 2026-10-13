#!/bin/sh
set -eu

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  [ -z "${2:-}" ] || printf '%s\n' "$2" >&2
  exit 1
}

docker_help='https://docs.docker.com/engine/install/ubuntu/'
compose_help='https://docs.docker.com/compose/install/linux/'
install_root=${PRODUCT_HUB_ROOT:-/opt/product-hub}
cli_path=${PRODUCT_HUB_CLI_PATH:-/usr/local/bin/product-hub}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest=${PRODUCT_HUB_RELEASE_MANIFEST:-"$script_dir/product-hub-release.manifest"}

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED_RUN_SUDO_SETUP '请使用 root 或 sudo 运行。'
[ "$(uname -s)" = Linux ] || fail LINUX_REQUIRED '仅支持 Linux 服务器。'
[ "$(uname -m)" = x86_64 ] || fail X86_64_REQUIRED '仅支持 x86_64 (amd64) 服务器。'
command -v docker >/dev/null 2>&1 || {
  printf 'Docker Engine is required: %s\nDocker Compose plugin: %s\n' "$docker_help" "$compose_help" >&2
  fail DOCKER_REQUIRED
}
docker info >/dev/null 2>&1 || fail DOCKER_DAEMON_UNAVAILABLE
[ "$(docker info --format '{{.OSType}}/{{.Architecture}}')" = linux/x86_64 ] || fail LINUX_AMD64_DOCKER_REQUIRED
docker compose version >/dev/null 2>&1 || {
  printf 'Docker Compose plugin is required: %s\n' "$compose_help" >&2
  fail DOCKER_COMPOSE_REQUIRED
}

# This must run before a pull, secret generation, mkdir, or any other mutation.
if [ -e "$install_root" ] || [ -L "$install_root" ] || [ -e "$cli_path" ] || [ -L "$cli_path" ]; then
  printf 'Existing Product Hub files detected. Use product-hub status or product-hub update; setup will not overwrite them.\n' >&2
  printf '检测到已安装 Product Hub，安装程序不会覆盖。请运行 product-hub 打开管理菜单。\n' >&2
  fail EXISTING_INSTALLATION
fi
if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=product-hub)" ] ||
  [ -n "$(docker volume ls -q --filter label=com.docker.compose.project=product-hub)" ] ||
  [ -n "$(docker network ls -q --filter label=com.docker.compose.project=product-hub)" ]; then
  fail EXISTING_COMPOSE_PROJECT
fi
command -v ss >/dev/null 2>&1 || fail PORT_CHECK_REQUIRES_IPROUTE2
listeners=$(ss -H -ltn 'sport = :3000' 2>/dev/null) || fail PORT_CHECK_FAILED
[ -z "$listeners" ] || fail APP_PORT_IN_USE '本机 3000 端口已被占用。'
# The optional built-in HTTPS proxy needs both public web ports.
https_ports=free
for web_port in 80 443; do
  web_listeners=$(ss -H -ltn "sport = :$web_port" 2>/dev/null) || fail PORT_CHECK_FAILED
  [ -z "$web_listeners" ] || https_ports=busy
done
# Prefer the public IP found by install.sh; otherwise the default-route source.
suggested_ip=${PRODUCT_HUB_SUGGESTED_IP:-}
if [ -z "$suggested_ip" ] && command -v ip >/dev/null 2>&1; then
  suggested_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }') || suggested_ip=''
fi
printf '%s' "$suggested_ip" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || suggested_ip=''

[ -f "$manifest" ] || fail RELEASE_MANIFEST_REQUIRED
manifest_value() {
  key=$1
  value=$(awk -F= -v key="$key" '$1 == key { count += 1; value = substr($0, index($0, "=") + 1) } END { if (count == 1) print value }' "$manifest")
  [ -n "$value" ] || fail INVALID_RELEASE_MANIFEST
  printf '%s\n' "$value"
}
migrator=$(manifest_value migrator)
source_commit=$(manifest_value source_commit)
release_version=$(manifest_value version)
printf '%s' "$migrator" | grep -Eq '^ghcr\.io/cobrander-dev/product-hub-oss-migrator@sha256:[0-9a-f]{64}$' || fail INVALID_MIGRATOR_DIGEST
printf '%s' "$source_commit" | grep -Eq '^[0-9a-f]{40}$' || fail INVALID_SOURCE_COMMIT

runtime_base=/run
[ -d "$runtime_base" ] && [ -w "$runtime_base" ] || runtime_base=/tmp
docker_config=$(mktemp -d "$runtime_base/product-hub-docker.XXXXXX")
restore_tty=''
cleanup() {
  if [ -n "$restore_tty" ]; then stty "$restore_tty" </dev/tty 2>/dev/null || true; fi
  rm -rf "$docker_config"
}
trap cleanup EXIT HUP INT TERM

if ! docker --config "$docker_config" pull --platform linux/amd64 "$migrator" >/dev/null 2>&1; then
  [ -t 0 ] || fail GHCR_AUTH_REQUIRED
  printf 'GHCR username: ' >/dev/tty
  IFS= read -r ghcr_username </dev/tty
  [ -n "$ghcr_username" ] || fail GHCR_USERNAME_REQUIRED
  printf 'GHCR read token: ' >/dev/tty
  restore_tty=$(stty -g </dev/tty)
  stty -echo </dev/tty
  IFS= read -r ghcr_token </dev/tty
  stty "$restore_tty" </dev/tty
  restore_tty=''
  printf '\n' >/dev/tty
  [ -n "$ghcr_token" ] || fail GHCR_TOKEN_REQUIRED
  printf '%s' "$ghcr_token" | docker --config "$docker_config" login ghcr.io --username "$ghcr_username" --password-stdin >/dev/null
  unset ghcr_token
  docker --config "$docker_config" pull --platform linux/amd64 "$migrator" >/dev/null
fi

image_identity=$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}' "$migrator")
# Exact match, or a formal SemVer manifest promoting the unchanged images that
# were built and verified for the same full source commit (verifyImageLabels).
identity_ok=0
[ "$image_identity" = "linux/amd64 $source_commit $release_version" ] && identity_ok=1
if printf '%s' "$release_version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' &&
  [ "$image_identity" = "linux/amd64 $source_commit verification-$source_commit" ]; then
  identity_ok=1
fi
[ "$identity_ok" -eq 1 ] || fail CONTROL_IMAGE_IDENTITY_MISMATCH

printf 'Recommended/acceptance host profile: 4 vCPU, 8 GiB RAM, 80 GiB disk. This is not yet a declared minimum.\n'
install -d -o root -g root -m 0700 "$install_root"
manifest_abs=$(CDPATH= cd -- "$(dirname -- "$manifest")" && pwd)/$(basename -- "$manifest")
repository_root="$install_root/releases/$source_commit/bundle"

run_control() {
  tty_flag=-i
  if [ -t 0 ] && [ -t 1 ]; then tty_flag=-it; fi
  docker run --rm "$tty_flag" \
    --user 0:0 \
    --read-only \
    --tmpfs /tmp:size=64m,mode=1777 \
    --tmpfs /run:size=16m,mode=0700 \
    --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges:true \
    --network none \
    --pids-limit 256 \
    --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
    --mount type=bind,source="$install_root",target="$install_root" \
    --mount type=bind,source="$manifest_abs",target=/release.manifest,readonly \
    --mount type=bind,source="$docker_config",target=/root/.docker,readonly \
    --env HOME=/root \
    --env DOCKER_CONFIG=/root/.docker \
    --env PRODUCT_HUB_ROOT="$install_root" \
    --env PRODUCT_HUB_CONTROL_CONTAINER=1 \
    --env PRODUCT_HUB_REPOSITORY_ROOT="$repository_root" \
    --env PRODUCT_HUB_RELEASE_REVISION="$source_commit" \
    --env PRODUCT_HUB_HTTPS_PORTS="$https_ports" \
    --env PRODUCT_HUB_SUGGESTED_IP="$suggested_ip" \
    "$migrator" \
    node /app/node_modules/tsx/dist/cli.mjs /app/scripts/installer/operator-cli.ts setup --manifest /release.manifest
}

run_control
install -o root -g root -m 0755 "$script_dir/scripts/product-hub" "$cli_path"
printf 'PASS: Product Hub installed.\n'
if grep -qx 'https=builtin' "$install_root/config/access" 2>/dev/null; then
  printf '\n正在等待 HTTPS 证书（最长约 2 分钟）...\n'
  "$cli_path" https 120 || true
else
  printf '反向代理示例已生成在 %s/proxy，未自动应用。\n' "$install_root"
fi
printf '\n管理命令: sudo product-hub（菜单） | status | doctor | backup | upgrade | logs | https\n'
