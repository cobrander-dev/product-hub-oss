#!/bin/sh
# Product Hub 一键安装 / One-line installer
#
#   bash <(curl -fsSL https://github.com/cobrander-dev/product-hub-oss/releases/latest/download/install.sh)
#
# Downloads a published release bundle, verifies its SHA-256 checksums (and its
# GitHub artifact attestation when the gh CLI is available), then runs the
# bundled setup.sh. Re-running on an installed server opens the admin menu.
set -eu

repository=cobrander-dev/product-hub-oss
install_root=/opt/product-hub
cli_path=/usr/local/bin/product-hub
docker_gpg_fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

say() { printf '%s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  [ -z "${2:-}" ] || printf '%s\n' "$2" >&2
  exit 1
}
# Prompts must work for both "bash <(curl ...)" and "curl ... | sh".
ask() {
  printf '%s' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || answer=''
  printf '%s' "$answer"
}

[ "$(id -u)" -eq 0 ] || fail ROOT_REQUIRED '请使用 root 运行，或在命令前加 sudo。'
[ "$(uname -s)" = Linux ] || fail LINUX_REQUIRED '仅支持 Linux 服务器。'
[ "$(uname -m)" = x86_64 ] || fail X86_64_REQUIRED '仅支持 x86_64 (amd64) 服务器。'
[ -r /dev/tty ] || fail TTY_REQUIRED '需要交互式终端（请通过 SSH 登录后运行）。'

say ''
say '========================================'
say '  Product Hub 安装程序'
say '========================================'

if [ -e "$install_root" ] || [ -e "$cli_path" ]; then
  if [ -x "$cli_path" ]; then
    say '检测到已安装 Product Hub，打开管理菜单。'
    exec "$cli_path" </dev/tty
  fi
  fail EXISTING_INSTALLATION "检测到 $install_root 已存在但管理命令缺失，安装程序不会覆盖，请人工检查。"
fi

. /etc/os-release 2>/dev/null || true
os_id=${ID:-unknown}
os_version=${VERSION_ID:-unknown}
case "$os_id $os_version" in
  "ubuntu 24.04") ;;
  "ubuntu 22.04" | "debian 12" | "debian 13")
    say "提示：当前系统为 $os_id $os_version，正式验证环境为 Ubuntu 24.04。" ;;
  *)
    say "提示：当前系统 $os_id $os_version 未经验证，建议使用 Ubuntu 24.04。"
    case "$(ask '仍要继续吗？[y/N]: ')" in y | Y) ;; *) exit 1 ;; esac ;;
esac

# Small host tools used by setup and the admin CLI.
missing=''
for tool in curl:curl openssl:openssl ss:iproute2 tar:tar sha256sum:coreutils gpg:gnupg; do
  command -v "${tool%%:*}" >/dev/null 2>&1 || missing="$missing ${tool#*:}"
done
if [ -n "$missing" ]; then
  command -v apt-get >/dev/null 2>&1 || fail TOOLS_REQUIRED "缺少工具:$missing，请先手动安装。"
  say "安装必要工具:$missing"
  apt-get update -qq
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates $missing >/dev/null
fi

install_docker() {
  case "$os_id" in ubuntu | debian) ;; *) fail DOCKER_REQUIRED '该系统无法自动安装 Docker，请先按 https://docs.docker.com/engine/install/ 安装。' ;; esac
  [ -n "${VERSION_CODENAME:-}" ] || fail OS_CODENAME_REQUIRED
  say '从 Docker 官方源安装 Docker Engine 与 Compose 插件...'
  install -m 0755 -d /etc/apt/keyrings
  key=$(mktemp)
  curl -fsSL --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$os_id/gpg" -o "$key"
  # Pin Docker's published release key before trusting the repository.
  fingerprint=$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  [ "$fingerprint" = "$docker_gpg_fingerprint" ] || { rm -f "$key"; fail DOCKER_KEY_MISMATCH 'Docker 官方 GPG 密钥指纹不匹配，已停止。'; }
  install -m 0644 "$key" /etc/apt/keyrings/docker.asc
  rm -f "$key"
  printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$os_id" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
}

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  say '未检测到 Docker Engine 或 Docker Compose 插件。'
  case "$(ask '是否从 Docker 官方源自动安装？[Y/n]: ')" in
    n | N | no | NO) fail DOCKER_REQUIRED '请先安装 Docker：https://docs.docker.com/engine/install/' ;;
    *) install_docker ;;
  esac
fi
docker info >/dev/null 2>&1 || fail DOCKER_DAEMON_UNAVAILABLE 'Docker 服务未运行，请执行 systemctl start docker 后重试。'

# Public IP suggestion for installs without a domain. Only the address itself
# is requested; the user confirms or replaces it in setup.
say '正在检测服务器公网 IP...'
public_ip=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
printf '%s' "$public_ip" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || public_ip=''

if [ -n "${PRODUCT_HUB_VERSION:-}" ]; then
  printf '%s' "$PRODUCT_HUB_VERSION" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' || fail INVALID_VERSION
  base="https://github.com/$repository/releases/download/$PRODUCT_HUB_VERSION"
else
  base="https://github.com/$repository/releases/latest/download"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
say '下载安装包...'
for asset in product-hub-installer.tar.gz SHA256SUMS; do
  curl -fsSL --proto '=https' --tlsv1.2 "$base/$asset" -o "$work/$asset" ||
    fail RELEASE_DOWNLOAD_FAILED '下载失败，请检查网络或 GitHub 访问。'
done
(cd "$work" && grep ' product-hub-installer.tar.gz$' SHA256SUMS | sha256sum --check --strict --quiet) ||
  fail RELEASE_CHECKSUM_MISMATCH '安装包校验失败，已停止。'
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh attestation verify "$work/product-hub-installer.tar.gz" --repo "$repository" >/dev/null ||
    fail RELEASE_ATTESTATION_INVALID '安装包来源证明验证失败，已停止。'
  say '已验证安装包的 GitHub 来源证明。'
fi
mkdir "$work/bundle"
tar -xzf "$work/product-hub-installer.tar.gz" -C "$work/bundle" --no-same-owner
(cd "$work/bundle" && sha256sum --check --strict --quiet product-hub-release.manifest.sha256) ||
  fail RELEASE_CHECKSUM_MISMATCH '发布清单校验失败，已停止。'

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  say '提示：检测到 ufw 防火墙已启用。若使用内置 HTTPS，请放行 80 和 443 端口：ufw allow 80,443/tcp'
fi
say '提示：云服务器还需要在安全组中放行 TCP 80/443。'

PRODUCT_HUB_SUGGESTED_IP="$public_ip" sh "$work/bundle/setup.sh" </dev/tty
