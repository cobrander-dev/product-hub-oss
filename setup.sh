#!/bin/sh
set -eu

step() { printf '\n[%s/5] %s\n' "$1" "$2"; }
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  [ -z "${2:-}" ] || printf '%s\n' "$2" >&2
  exit 1
}

docker_help='https://docs.docker.com/engine/install/ubuntu/'
compose_help='https://docs.docker.com/compose/install/linux/'
install_root=${PRODUCT_HUB_ROOT:-/opt/product-hub}
cli_path=${PRODUCT_HUB_CLI_PATH:-/usr/local/bin/product-hub}
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
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
# ---- Built-in HTTPS port and certificate validation (docs/HTTPS_PORTS.md) ----
# Prompts read /dev/tty; without a terminal the preset or default answer is used.
tty_say() { { printf '%s' "$1" >/dev/tty; } 2>/dev/null || true; }
tty_ask() {
  tty_say "$1"
  answer=''
  { IFS= read -r answer </dev/tty; } 2>/dev/null || answer=''
  printf '%s' "$answer"
}
port_published() { docker ps --format '{{.Ports}}' 2>/dev/null | grep -Eq "(^|[ ,])[^ ,]*:$1->"; }
port_busy() {
  listeners=$(ss -H -ltnu "sport = :$1" 2>/dev/null) || fail PORT_CHECK_FAILED
  [ -n "$listeners" ] || port_published "$1"
}
port_owner() {
  owner=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null |
    awk -v p=":$1->" 'index($0, p) { printf "%s容器 %s", sep, $1; sep = "、" }')
  [ -n "$owner" ] || owner=$(ss -H -ltnup "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -n 1 | cut -d'"' -f2)
  printf '%s' "${owner:-未知程序}"
}
# Container publishing host port $1 on a non-loopback address (first match).
port_container() {
  docker ps --format '{{.ID}} {{.Ports}}' 2>/dev/null | awk -v p=":$1->" '
    { n = split($0, f, /[ ,]+/); for (i = 2; i <= n; i++) if (index(f[i], p) && f[i] !~ /^127\./) { print $1; exit } }'
}
valid_https_port() {
  printf '%s' "$1" | grep -Eq '^[1-9][0-9]{0,4}$' || return 1
  [ "$1" -eq 443 ] || { [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }
}

# Subshell: in dash a failed redirection on a special builtin would end the script.
has_tty() { (: </dev/tty) 2>/dev/null; }

# HTTPS entry: shared gateway (docs/HTTPS_GATEWAY.md), own port (docs/HTTPS_PORTS.md) or an
# existing reverse proxy. Decided before any pull or write; nothing else is changed here.
gateway_script="$script_dir/scripts/oss-gateway.sh"
entry_mode=${PRODUCT_HUB_HTTPS_MODE:-}
preset_entry=0
[ -z "$entry_mode" ] || preset_entry=1
# A preset port, or no terminal at all, keeps the original port behaviour.
if [ -z "$entry_mode" ] && { [ -n "${PRODUCT_HUB_HTTPS_PORT:-}" ] || ! has_tty; }; then entry_mode=port; fi
case "$entry_mode" in '' | gateway | port | external) ;; *) fail INVALID_HTTPS_MODE 'PRODUCT_HUB_HTTPS_MODE 需为 gateway、port 或 external。' ;; esac
while [ -z "$entry_mode" ] || [ "$entry_mode" = gateway ]; do
  if [ -z "$entry_mode" ]; then
    tty_say "
请选择 HTTPS 方式：
  1) 共享 HTTPS 网关（推荐）：网址不带端口，同一服务器的多个项目共用 80/443，按域名转发（需要域名）
  2) 独立 HTTPS 端口（高级）：本项目使用自己的 HTTPS 入口，端口可选 443 或 9443 等
  3) 已有反向代理：只监听 127.0.0.1:3000，由你现有的 Nginx/Caddy 提供 HTTPS（需要域名）
"
    case "$(tty_ask '请选择 [1]: ')" in
      '' | 1) entry_mode=gateway ;;
      2) entry_mode=port ;;
      3) entry_mode=external ;;
      *) continue ;;
    esac
  fi
  [ "$entry_mode" = gateway ] || break
  [ -f "$gateway_script" ] || fail GATEWAY_SCRIPT_MISSING
  gateway_state=$(sh "$gateway_script" detect)
  answer=y
  case "$gateway_state" in
    managed)
      printf '检测到共享 HTTPS 网关，将为本项目添加独立站点（先校验，失败自动回滚，其他站点不受影响）。\n'
      break
      ;;
    host-caddy)
      printf '检测到宿主机 Caddy 占用 80/443，将在 /etc/caddy/Caddyfile 中添加本项目站点（修改前备份，先校验再重新加载，失败自动恢复）。\n'
      [ "$preset_entry" -eq 1 ] || answer=$(tty_ask '继续？[Y/n]: ')
      ;;
    absent)
      printf '80/443 空闲：将安装共享 HTTPS 网关（Docker 项目 oss-gateway，占用 80/443），之后其他项目可直接添加自己的域名。\n'
      [ "$preset_entry" -eq 1 ] || answer=$(tty_ask '安装共享 HTTPS 网关？[Y/n]: ')
      ;;
    *)
      owner=${gateway_state#unmanageable }
      [ "$preset_entry" -eq 0 ] || fail GATEWAY_UNAVAILABLE "80/443 已被 $owner 占用，无法安全接管；不会停止或修改它。"
      tty_say "80/443 已被 $owner 占用，无法安全接管：不会停止或修改它。可改选「独立 HTTPS 端口」或「已有反向代理」。
"
      entry_mode=''
      continue
      ;;
  esac
  case "$answer" in '' | y | Y | yes | YES) break ;; esac
  [ "$preset_entry" -eq 0 ] || fail CANCELLED
  entry_mode=''
done

https_mode=builtin
[ "$entry_mode" != gateway ] || https_mode=gateway
[ "$entry_mode" != external ] || https_mode=external
https_port=${PRODUCT_HUB_HTTPS_PORT:-}
preset_port=0
[ -z "$https_port" ] || preset_port=1
while [ "$entry_mode" = port ]; do
  if [ -z "$https_port" ]; then
    tty_say "
请选择 HTTPS 端口：
  · 直接回车使用 443（标准端口，访问地址不带端口号）
  · 同一台服务器安装多个项目时，可输入其他端口，例如 8443、9443
  · 输入 p：改用服务器上已有的反向代理（Nginx/Caddy，仅限域名）
"
    https_port=$(tty_ask 'HTTPS 端口 [443]: ')
    https_port=${https_port:-443}
  fi
  case "$https_port" in p | P) https_mode=external; break ;; esac
  if ! valid_https_port "$https_port"; then
    [ "$preset_port" -eq 0 ] || fail HTTPS_PORT_INVALID 'HTTPS 端口需为 443 或 1024-65535；80 保留给 HTTP 和证书验证。'
    tty_say "无效的端口：$https_port（可用 443 或 1024-65535）。
"
    https_port=''
    continue
  fi
  if port_busy "$https_port"; then
    [ "$preset_port" -eq 0 ] || fail HTTPS_PORT_IN_USE "端口 $https_port 已被占用（$(port_owner "$https_port")）。不会停止或修改占用它的程序，请换一个端口。"
    tty_say "端口 $https_port 已被占用（$(port_owner "$https_port")）。不会停止或修改占用它的程序，请换一个端口。
"
    https_port=''
    continue
  fi
  break
done

relay_role=''
http_bind=80
tls_issuer=${PRODUCT_HUB_TLS_ISSUER:-auto}
case "$tls_issuer" in auto | internal) ;; *) fail INVALID_TLS_ISSUER ;; esac
if [ "$https_mode" = builtin ]; then
  holder=$(port_container 80)
  if [ -z "$holder" ] && ! port_busy 80; then
    relay_role=holder
    printf '80 端口空闲：使用 80 端口完成证书验证，并为同一服务器上的其他项目转发验证请求。\n'
  elif [ -n "$holder" ] &&
    [ "$(docker inspect --format '{{index .Config.Labels "oss.https-relay"}}' "$holder" 2>/dev/null)" = holder ]; then
    relay_role=member
    printf '80 端口由同一服务器上的另一个项目（%s）提供，证书验证请求由它转发到本项目（仅限域名访问）。\n' "$(port_owner 80)"
  else
    relay_role=none
    if [ "$https_port" -eq 443 ]; then
      printf '80 端口被其他程序占用（%s），将只通过 443 端口完成证书验证（TLS-ALPN-01）。\n' "$(port_owner 80)"
    elif [ "$tls_issuer" != internal ]; then
      printf '无法自动申请受信任的 HTTPS 证书：\n'
      printf '  · 公网证书机构只在 80 端口（HTTP-01）或 443 端口（TLS-ALPN-01）验证域名\n'
      printf '  · 80 端口已被其他程序占用（%s），本项目使用的是 %s 端口\n' "$(port_owner 80)" "$https_port"
      printf '  · DNS-01 验证需要 DNS 服务商 API 凭据，本安装程序不支持\n'
      tty_say '请选择：
  1) 使用本机 CA 证书（浏览器会提示不受信任，可导入根证书后使用）
  2) 改用已有反向代理模式（仅限域名）
  3) 取消安装
'
      case "$(tty_ask '请输入 1/2/3 [3]: ')" in
        1) tls_issuer=internal ;;
        2) https_mode=external relay_role='' ;;
        *) fail ACME_HTTP_PORT_UNAVAILABLE '已取消，没有做任何更改。' ;;
      esac
    fi
  fi
  if [ -n "$relay_role" ] && [ "$relay_role" != holder ]; then
    # Caddy still listens on container port 80 for relayed challenges; loopback only.
    http_bind=''
    for candidate in $(seq 18080 18179); do
      port_busy "$candidate" || { http_bind="127.0.0.1:$candidate"; break; }
    done
    [ -n "$http_bind" ] || fail NO_FREE_LOOPBACK_PORT
  fi
fi
acme_ca=${PRODUCT_HUB_ACME_CA:-}
acme_ca_root_pem=''
if [ -n "$acme_ca" ]; then
  [ -f "${PRODUCT_HUB_ACME_CA_ROOT:-}" ] || fail ACME_CA_ROOT_REQUIRED
  acme_ca_root_pem=$(cat "$PRODUCT_HUB_ACME_CA_ROOT")
fi
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

step 3 '正在下载镜像（首次安装可能需要几分钟）'
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
manifest_abs=$(CDPATH='' cd -- "$(dirname -- "$manifest")" && pwd)/$(basename -- "$manifest")
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
    --env PRODUCT_HUB_HTTPS_MODE="$https_mode" \
    --env PRODUCT_HUB_HTTPS_PORT="$https_port" \
    --env PRODUCT_HUB_HTTP_BIND="$http_bind" \
    --env PRODUCT_HUB_RELAY_ROLE="$relay_role" \
    --env PRODUCT_HUB_TLS_ISSUER="$tls_issuer" \
    --env PRODUCT_HUB_ACME_CA="$acme_ca" \
    --env PRODUCT_HUB_ACME_CA_ROOT_PEM="$acme_ca_root_pem" \
    --env PRODUCT_HUB_SUGGESTED_IP="$suggested_ip" \
    "$migrator" \
    node /app/node_modules/tsx/dist/cli.mjs /app/scripts/installer/operator-cli.ts setup --manifest /release.manifest
}

step 4 '正在配置服务'
run_control
install -o root -g root -m 0755 "$script_dir/scripts/product-hub" "$cli_path"
printf 'PASS: Product Hub installed.\n'
access_host=$(awk -F= '$1 == "host" { print $2 }' "$install_root/config/access" 2>/dev/null) || access_host=''
if [ "$https_mode" = gateway ]; then
  # Kept for `product-hub https --apply`; the gateway itself is not part of Product Hub.
  install -o root -g root -m 0755 "$gateway_script" "$install_root/oss-gateway.sh"
  "$cli_path" https --apply || {
    printf '共享 HTTPS 网关站点未能添加，已回滚，其他网站未受影响。Product Hub 已安装并只在 127.0.0.1:3000 运行；\n' >&2
    printf '处理后运行 sudo product-hub https --apply 重试。\n' >&2
    fail GATEWAY_SITE_FAILED
  }
fi
step 5 '安装成功'
if grep -qx 'https=gateway' "$install_root/config/access" 2>/dev/null; then
  printf '\n正在等待 HTTPS 证书（最长约 2 分钟）...\n'
  "$cli_path" https 120 || true
  printf '云服务器请在安全组/防火墙中放行 TCP 80 和 443。\n'
  printf '同一服务器的其他网站可用 sudo oss-gateway add <名称> <域名> 127.0.0.1:<端口> 添加。\n'
elif grep -qx 'https=builtin' "$install_root/config/access" 2>/dev/null; then
  printf '\n正在等待 HTTPS 证书（最长约 2 分钟）...\n'
  "$cli_path" https 120 || true
  if [ "$relay_role" = holder ]; then
    printf '云服务器请在安全组/防火墙中放行 TCP 80 和 TCP %s。\n' "$https_port"
  else
    printf '云服务器请在安全组/防火墙中放行 TCP %s。\n' "$https_port"
  fi
  [ "$relay_role" != member ] || printf '证书续期依赖占用 80 端口的项目保持运行。\n'
else
  printf '应用监听 127.0.0.1:3000，访问域名：%s（由你自己的反向代理提供 HTTPS）。\n' "$access_host"
  printf '反向代理示例已生成在 %s/proxy，未自动应用。\n' "$install_root"
fi
printf '\n管理命令: sudo product-hub（菜单） | status | doctor | backup | upgrade | logs | https\n'
