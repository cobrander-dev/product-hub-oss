# 安装 Product Hub

## 支持的主机

全新的 Ubuntu 24.04 `x86_64`（`linux/amd64`）服务器，root 或 sudo 权限。Ubuntu 22.04 / 26.04、Debian 12/13 可以安装但未经正式验证。推荐 4 vCPU、8 GiB 内存、80 GiB 磁盘。主机不需要 Node.js 或 pnpm。

## 一键安装

```bash
curl -fsSL https://github.com/cobrander-dev/product-hub-oss/releases/latest/download/install.sh -o install.sh && bash install.sh
```

`&&` 保证只有完整下载成功才会运行安装脚本；非 root 用户运行时会自动通过 sudo 重新执行。交互输入始终从终端读取。安装指定版本：把 `latest/download` 换成 `download/v1.0.0`，并写成 `PRODUCT_HUB_VERSION=v1.0.0 bash install.sh`。

`install.sh` 依次执行：

1. 检查 root、Linux、x86_64 和终端；已安装时直接打开 `product-hub` 管理菜单，绝不覆盖。
2. 缺少 `curl`、`openssl`、`ss`、`tar`、`sha256sum`、`gpg` 时通过 apt 安装。
3. 缺少 Docker Engine 或 Compose 插件时询问是否安装；确认后只使用 Docker 官方 apt 源，并在信任前核对官方 GPG 密钥指纹 `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`。
4. 通过 `api.ipify.org` 获取本机公网 IP，仅作为“无域名”时的默认值。
5. 从 GitHub Release 下载 `product-hub-installer.tar.gz` 与 `SHA256SUMS`，校验 SHA-256；若已安装并登录 `gh`，额外执行 `gh attestation verify`。
6. 运行安装包内的 `setup.sh`。

## setup.sh 的交互

1. **域名或 IP**：有域名请填写（需已解析到本服务器）；没有域名直接回车使用检测到的 IP。
2. **内置 HTTPS**：80/443 空闲时默认启用；IP 模式必须使用内置 HTTPS。若 80/443 已被占用，只能使用域名并由你现有的反向代理提供 HTTPS。
3. **管理员账号**：用户名、显示名称、密码（隐藏输入并确认）。

Better Auth 密钥与四个独立数据库密码由系统 CSPRNG 生成，不会出现在命令行参数、shell 历史、普通日志、Git 或镜像元数据中。

## 安装过程做了什么

固定 digest 的 Migrator 镜像以一次性控制容器运行：只读根文件系统、无网络命名空间、仅保留 CHOWN/DAC_READ_SEARCH 能力、no-new-privileges、非特权；唯一可写的主机目录是 `/opt/product-hub`，Docker socket 只在这次命令中挂载，结束即删除。它校验配置、启动内置 PostgreSQL、执行只前进的迁移、配置最小权限数据库角色、启动 Worker 与 App、创建管理员并做最终健康与权限检查。

## HTTPS

内置 HTTPS 作为独立 Compose 项目 `product-hub-https` 运行，使用与 App 相同的、已扫描并签名的 Runner 镜像中的 Caddy（官方 v2.11.7 源码以 Go 1.26.9 构建）。它以非 root 用户、只读根文件系统、去除全部 capability 运行，只加入 App 的 frontend 网络，访问不到数据库网络。

- **域名**：Caddy 自动申请并续期 Let's Encrypt 证书，并发送 HSTS。
- **IP**：先申请 Let's Encrypt 6 天短期 IP 证书（`shortlived` profile，自动续期）；失败时（例如内网 IP、80/443 未放行）改用 Caddy 本机 CA 签发的证书，HTTPS 仍然加密，但浏览器会提示不受信任。运行 `sudo product-hub https` 查看当前证书；若为本机 CA，命令会导出 `/opt/product-hub/config/https/local-root.crt` 并显示其 SHA-256 指纹，核对后导入你的电脑即可正常访问。

外部反向代理模式下，`/opt/product-hub/proxy` 中生成 `Caddyfile.snippet`、`nginx-product-hub.conf`、`nginx-proxy-headers.conf`，安装程序不会修改或重载你的代理。App 始终只绑定 `127.0.0.1:3000`，PostgreSQL 没有主机端口。

## 安装后

```bash
sudo product-hub          # 中文管理菜单
sudo product-hub doctor
sudo product-hub backup
```

## 已有安装保护

在拉取镜像、生成密钥、创建目录或任何 Docker 变更之前，`setup.sh` 检查 `/opt/product-hub`、CLI、Compose 项目的容器/卷/网络以及 3000 端口。发现已有安装即停止，不会自动覆盖或修复。

## 手动安装（不使用 install.sh）

从 Release 下载 `product-hub-installer.tar.gz` 与 `SHA256SUMS`，校验后解压并运行：

```bash
sha256sum --check --ignore-missing SHA256SUMS
mkdir product-hub && tar -xzf product-hub-installer.tar.gz -C product-hub
sudo sh product-hub/setup.sh
```
