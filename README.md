# Product Hub

Product Hub 是一个中文、自托管的内部产品资料与厂家报价数据库。Admin 管理产品、厂家、分配、报价、图片、导入导出、账号和审计；Factory 用户只处理分配给所属厂家的产品与报价。桌面端和移动端都是正式支持界面。

适合需要把产品资料、厂家私有报价、图片和历史记录集中管理的小型团队。V1 不是 CRM、订单、物流、支付、客户报价、Invoice 或聊天系统。

## 核心功能

- Admin / Factory 角色与服务端租户隔离
- 产品、分类、材质、厂家和稳定分配关系
- 人民币整数分报价、精确包装数据、CBM 与不可变价格历史
- Business Activity Log、安全事件和账号生命周期审计
- 受控图片、CSV/XLSX 预览确认式导入与安全导出
- 独立最小权限 Worker 执行的 durable Hard Delete
- 一条命令备份、只读 doctor 和 digest 固定的安全升级流程

## 一键安装

在一台全新的 Ubuntu 24.04 x86_64 服务器上，以 root 或有 sudo 权限的用户复制运行这一条命令：

```bash
curl -fsSL https://github.com/cobrander-dev/product-hub-oss/releases/latest/download/install.sh -o install.sh && bash install.sh
```

只有安装脚本完整下载成功后才会执行（`&&`）；非 root 用户会自动通过 sudo 运行。安装程序全程中文交互，并按“检查系统 → 安装依赖 → 下载镜像 → 配置服务 → 安装成功”显示进度：

1. 检测系统；未安装 Docker 时询问后从 Docker 官方源安装（校验官方 GPG 密钥指纹）。
2. 下载发布安装包并校验 SHA-256；已安装 `gh` 并登录时额外验证 GitHub 来源证明（attestation）。
3. 选择 HTTPS 端口（直接回车使用 443；同一服务器安装多个项目时可用 9443 等其他端口），填写访问地址：**有域名填域名，没有域名直接回车使用服务器公网 IP**。
4. 自动生成数据库与认证密钥，初始化数据库并启动服务。
5. 创建管理员账号（密码隐藏输入）。

推荐配置 4 vCPU / 8 GiB 内存 / 80 GiB 磁盘。云服务器请在安全组放行 TCP 80 和所选 HTTPS 端口。再次运行同一命令会打开管理菜单，不会覆盖已有安装。安装指定版本（包括测试版）：把 `latest/download` 换成 `download/版本号`，并把 `bash install.sh` 写成 `PRODUCT_HUB_VERSION=版本号 bash install.sh`，例如 `v0.9.0-rc.1`。

## HTTPS

| 场景                                        | 证书                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 有域名，80/443 空闲                         | 内置 Caddy 自动申请并续期 Let's Encrypt 证书                                                                                                                                           |
| 无域名，使用公网 IP                         | 自动申请 Let's Encrypt 6 天短期 IP 证书并自动续期；申请失败时改用本机 CA 签发的证书，`product-hub https` 显示根证书指纹与文件，导入后即可安全访问                                      |
| 自定义 HTTPS 端口（如 9443）                | 80 端口空闲或由同一服务器上的另一个 OSS 项目占用时自动申请并续期证书；80 被无关程序占用时明确提示，只能选择本机 CA 证书或已有反向代理。详见 [docs/HTTPS_PORTS.md](docs/HTTPS_PORTS.md) |
| 已有 Nginx 等提供 HTTPS（端口一步输入 `p`） | 不启用内置 HTTPS，在 `/opt/product-hub/proxy` 生成反向代理示例，由你自己的代理提供 HTTPS                                                                                               |

应用本身只监听 `127.0.0.1:3000`，数据库不开放任何端口，任何模式都不会以明文 HTTP 对外提供登录。

## 日常管理

```bash
sudo product-hub            # 中文管理菜单
sudo product-hub status     # 运行状态
sudo product-hub doctor     # 只读健康检查
sudo product-hub backup     # 备份数据库与上传文件
sudo product-hub upgrade    # 下载最新版本，先备份再更新
sudo product-hub logs       # 查看应用日志
sudo product-hub https      # HTTPS 证书信息
```

`update` / `upgrade` 先执行 doctor 和新备份，再执行只前进的数据库迁移，依次更新 Worker、App 与 HTTPS 代理，绝不重建 PostgreSQL。普通 CLI 不提供 restore、reset、`down -v` 或任意 Compose 参数透传。升级说明见 [升级指南](docs/user/UPGRADE.md)，常见失败码见 [故障排查](docs/user/TROUBLESHOOTING.md)。

## 文档

- [用户安装](docs/user/INSTALL.md)
- [备份与升级](docs/user/UPGRADE.md)
- [故障排查](docs/user/TROUBLESHOOTING.md)
- [运维契约](docs/OPERATIONS.md)
- [Backup / Restore](docs/BACKUP_RESTORE.md)
- [架构、安全、数据库与测试索引](docs/README.md)

## 开发

开发环境仍使用 Node.js 24.21.0、pnpm 11.19.0、Next.js 16.3.8、PostgreSQL 18 与 Prisma 7；依赖由 `pnpm-lock.yaml` 固定。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# 先将 .env 中的 CHANGE_ME 和空白测试凭据替换为本地专用随机值
pnpm db:up
pnpm prisma:migrate:deploy
pnpm dev
```

合并前至少运行 `pnpm ci:check`。生产禁止 `docker compose down -v`、`prisma migrate reset`、`prisma db push` 和 test seed。

## License

[MIT](LICENSE)。第三方组件许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
