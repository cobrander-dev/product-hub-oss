#!/bin/sh
# Product Hub 一键安装 / One-line installer
#
#   curl -fsSL https://github.com/cobrander-dev/product-hub-oss/releases/latest/download/install.sh -o install.sh && bash install.sh
#
# The script runs only after curl has saved the whole file. Started by a non-root user, it
# re-runs itself through sudo.
#
# Downloads a published release bundle, verifies its SHA-256 checksums (and its
# GitHub artifact attestation when the gh CLI is available), then runs the
# bundled setup.sh. Re-running on an installed server opens the admin menu.
set -eu

repository=cobrander-dev/product-hub-oss
install_root=/opt/product-hub
cli_path=/usr/local/bin/product-hub
docker_gpg_fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88     # apt repositories
docker_rpm_gpg_fingerprint=060A61C51B558A7F742B77AAC52FEB6B621E9F35 # dnf repositories

say() { printf '%s\n' "$*"; }
step() { printf '\n[%s/5] %s\n' "$1" "$2"; }
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

if [ "$(id -u)" -ne 0 ]; then
  # A piped script cannot be re-run safely, so only a downloaded file is elevated.
  if [ -f "$0" ] && command -v sudo >/dev/null 2>&1; then
    exec sudo ${PRODUCT_HUB_VERSION:+"PRODUCT_HUB_VERSION=$PRODUCT_HUB_VERSION"} \
      ${PRODUCT_HUB_HTTPS_MODE:+"PRODUCT_HUB_HTTPS_MODE=$PRODUCT_HUB_HTTPS_MODE"} \
      ${PRODUCT_HUB_HTTPS_PORT:+"PRODUCT_HUB_HTTPS_PORT=$PRODUCT_HUB_HTTPS_PORT"} \
      ${PRODUCT_HUB_TLS_ISSUER:+"PRODUCT_HUB_TLS_ISSUER=$PRODUCT_HUB_TLS_ISSUER"} sh "$0"
  fi
  fail ROOT_REQUIRED '请使用 root 运行，或在命令前加 sudo。'
fi
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

step 1 '正在检查系统'
. /etc/os-release 2>/dev/null || true
os_id=${ID:-unknown}
os_version=${VERSION_ID:-unknown}
os_like=" ${ID_LIKE:-} "
# Package family with an official Docker repository. Derivatives use their
# Ubuntu/Debian base; other systems need Docker installed beforehand.
pkg='' docker_distro='' docker_codename=''
case "$os_id" in
  ubuntu | debian) pkg=apt docker_distro=$os_id docker_codename=${VERSION_CODENAME:-} ;;
  fedora) pkg=dnf docker_distro=fedora ;;
  rhel | centos | rocky | almalinux | ol) pkg=dnf docker_distro=rhel ;;
  *)
    case "$os_like" in
      *" ubuntu "*) [ -z "${UBUNTU_CODENAME:-}" ] || { pkg=apt docker_distro=ubuntu docker_codename=$UBUNTU_CODENAME; } ;;
      *" debian "*) [ -z "${VERSION_CODENAME:-}" ] || { pkg=apt docker_distro=debian docker_codename=$VERSION_CODENAME; } ;;
      *" rhel "* | *" fedora "*) ! command -v dnf >/dev/null 2>&1 || { pkg=dnf docker_distro=rhel; } ;;
    esac
    ;;
esac
case "$os_id $os_version" in
  "ubuntu 24.04") ;;
  "ubuntu 22.04" | "ubuntu 26.04" | "debian 12" | "debian 13" | fedora\ * | rocky\ 9* | rocky\ 10* | almalinux\ 9* | almalinux\ 10* | rhel\ 9* | rhel\ 10*)
    say "提示：当前系统为 $os_id $os_version，完整安装验证环境为 Ubuntu 24.04。" ;;
  *)
    if [ -n "$pkg" ]; then
      say "提示：当前系统 $os_id $os_version 未经实际验证，将按 $docker_distro 系方式安装。"
    else
      say "提示：当前系统 $os_id $os_version 不在自动安装支持范围（支持 Ubuntu/Debian 系与 Fedora/RHEL/Rocky/AlmaLinux 系）。"
      say '      如已自行安装 Docker Engine、Docker Compose 插件以及 curl/openssl/ss 等工具，仍可继续。'
    fi
    case "$(ask '仍要继续吗？[y/N]: ')" in y | Y) ;; *) exit 1 ;; esac ;;
esac

say "系统：$os_id $os_version（x86_64）"

step 2 '正在安装依赖'
# Small host tools used by setup and the admin CLI.
if [ "$pkg" = dnf ]; then
  tools='curl:curl openssl:openssl ss:iproute tar:tar sha256sum:coreutils gpg:gnupg2 flock:util-linux'
else
  tools='curl:curl openssl:openssl ss:iproute2 tar:tar sha256sum:coreutils gpg:gnupg flock:util-linux'
fi
missing=''
for tool in $tools; do
  command -v "${tool%%:*}" >/dev/null 2>&1 || missing="$missing ${tool#*:}"
done
if [ -n "$missing" ]; then
  say "安装必要工具:$missing"
  # shellcheck disable=SC2086 # $missing is a word list of package names
  case "$pkg" in
    apt)
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates $missing >/dev/null ;;
    dnf) dnf install -y -q ca-certificates $missing >/dev/null ;;
    *) fail TOOLS_REQUIRED "缺少工具:$missing。当前系统无法自动安装，请先手动安装后重试。" ;;
  esac
fi

# Downloads Docker's signing key and pins its published fingerprint.
fetch_docker_key() {
  curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$3" || fail DOCKER_DOWNLOAD_FAILED '无法下载 Docker 官方签名密钥。'
  fingerprint=$(gpg --show-keys --with-colons "$3" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  [ "$fingerprint" = "$2" ] || { rm -f "$3"; fail DOCKER_KEY_MISMATCH 'Docker 官方 GPG 密钥指纹不匹配，已停止。'; }
}

install_docker() {
  case "$pkg" in
    apt) [ -n "$docker_codename" ] || fail OS_CODENAME_REQUIRED '无法识别系统版本代号，请先手动安装 Docker。' ;;
    dnf) ;;
    *) fail DOCKER_REQUIRED "当前系统 $os_id 无法自动安装 Docker，请先按 https://docs.docker.com/engine/install/ 安装 Docker Engine 与 Compose 插件。" ;;
  esac
  say '从 Docker 官方源安装 Docker Engine 与 Compose 插件...'
  key=$(mktemp)
  if [ "$pkg" = apt ]; then
    install -m 0755 -d /etc/apt/keyrings
    fetch_docker_key "https://download.docker.com/linux/$docker_distro/gpg" "$docker_gpg_fingerprint" "$key"
    install -m 0644 "$key" /etc/apt/keyrings/docker.asc
    rm -f "$key"
    printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
      "$docker_distro" "$docker_codename" >/etc/apt/sources.list.d/docker.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  else
    fetch_docker_key "https://download.docker.com/linux/$docker_distro/gpg" "$docker_rpm_gpg_fingerprint" "$key"
    rpm --import "$key"
    rm -f "$key"
    curl -fsSL --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$docker_distro/docker-ce.repo" \
      -o /etc/yum.repos.d/docker-ce.repo || fail DOCKER_DOWNLOAD_FAILED '无法下载 Docker 官方软件源配置。'
    # Podman's docker shim conflicts with Docker Engine; only the shim is replaced.
    dnf install -y -q --allowerasing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null ||
      fail DOCKER_INSTALL_FAILED 'Docker 安装失败。'
  fi
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
say 'Docker 已就绪。'

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
say '正在下载安装包...'
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
  say '提示：检测到 ufw 防火墙已启用。若使用内置 HTTPS，请放行 80 与所选 HTTPS 端口，例如：ufw allow 80,443/tcp'
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  say '提示：检测到 firewalld 已启用。若使用内置 HTTPS，请放行 80 与所选 HTTPS 端口，例如：'
  say '      firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp && firewall-cmd --reload'
fi
say '提示：云服务器还需要在安全组中放行 TCP 80 与所选 HTTPS 端口。'

PRODUCT_HUB_SUGGESTED_IP="$public_ip" sh "$work/bundle/setup.sh" </dev/tty
