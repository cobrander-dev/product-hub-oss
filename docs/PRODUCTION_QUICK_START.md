# Production Quick Start

面向普通用户的正式入口是：

```bash
git clone --branch <approved-release> https://github.com/cobrander-dev/product-hub-oss.git
cd product-hub
sudo ./setup.sh
```

适用真正的 Ubuntu 24.04 linux/amd64 主机。Host 只需要 Git、Docker Engine 与 Docker Compose plugin；不要求 Node/pnpm。使用经审查 release 随附的 `product-hub-release.manifest`，不能用 tag、`latest` 或自填 digest 代替。

安装器在任何写入前执行已有安装保护，只询问域名、必要时的私有 GHCR read credential、初始 Admin 身份与隐藏密码；其余 Auth/DB/Worker secret 自动生成。数据库初始化、pending migration、runtime grants、Worker role/file secret、Worker/App 启动、Admin bootstrap 与内部验证复用既有 production installer 自动完成。

安装后人工审查并启用 `/opt/product-hub/proxy` 中的 Caddy/Nginx snippet；安装器不会安装、覆盖、reload 或 restart reverse proxy。然后运行：

```bash
sudo product-hub doctor
sudo product-hub backup
```

完整说明见 [Install](user/INSTALL.md)，升级见 [Upgrade](user/UPGRADE.md)，错误码见 [Troubleshooting](user/TROUBLESHOOTING.md)。需要手工 source env、独立 production command 或非默认拓扑的高级流程继续遵循 `INSTALLER_FOUNDATION.md` 与 `RELEASE_RUNBOOK.md`，不得用 guided setup 覆盖已有安装。
