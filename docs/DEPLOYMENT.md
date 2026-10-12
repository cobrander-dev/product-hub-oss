# Product Hub 部署架构

本文定义通用生产部署目标。具体服务器、域名、证书、端口、维护窗口和备份目标由部署者决定，任何历史 Gate 或 rollout 报告都不是本文件的替代品。

## 1. 隔离边界

Product Hub 必须使用独立 Compose project、PostgreSQL database/roles、networks、volumes、environment 和 backup directory，不得复用其他项目的数据库身份或存储。App 仅绑定主机回环地址，由 HTTPS reverse proxy 暴露；PostgreSQL 不发布 host port。

通用拓扑：

```text
HTTPS reverse proxy
  -> App on 127.0.0.1:APP_PORT
       -> PostgreSQL on internal backend network
       -> product_hub_uploads mounted at /data/uploads
```

## 2. Release artifacts

正式 Runner、Migrator 与 Hard Delete Worker 都是 `linux/amd64` artifact，必须从同一个已审查 commit 通过 `pnpm release:build:amd64 <tag>` 构建。三个 Docker target 均不得要求或固化客户域名；Next.js 构建时 Auth 路由配置收集只使用固定非客户占位 origin，其值不得进入最终镜像的可信来源配置或运行时环境。部署域名仅在各实例运行时提供并校验。正式镜像必须 inspect 架构，发布和安装清单最终固定 digest，不以 `latest` 为 release identity。

未来 GHCR 分发使用 `ghcr.io/cobrander-dev/product-hub-oss-app`、`ghcr.io/cobrander-dev/product-hub-oss-migrator` 与 `ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker`。发布契约和 digest manifest 见 `GHCR_RELEASE_FOUNDATION.md`；本阶段不发布镜像或创建版本 tag。

Apple Silicon native `arm64` 构建只能用于本地验证，不能代替正式 artifact。Release 使用不可变 tag/digest；禁止在服务器临时修改源码。

## 3. Database identities

生产至少分离四个 PostgreSQL login：

- bootstrap admin：仅初始化 cluster 和显式 role provisioning；
- migration：拥有应用 schema，执行 forward-only migrations 与权限配置；
- runtime `product_hub_app`：仅拥有应用所需的表/函数权限；
- Hard Delete Worker：默认 `product_hub_hard_delete_worker`，只获得精确的 SECURITY DEFINER 函数 EXECUTE。

四者必须使用独立密码。bootstrap、migration 和 Worker credential 都不得进入 Web App。Runtime 不能更新或删除 `PriceHistory`、`ActivityLog`，也不能访问 Prisma migration history。

## 4. Configuration and origins

生产配置从 `.env.production.example` 创建到 Git 外的受限文件。部署域名规则：

- `APP_DOMAIN` 是一个精确 DNS hostname，可带明确端口；
- `BETTER_AUTH_URL` 是同一 host 的精确 HTTPS origin；
- `BETTER_AUTH_TRUSTED_ORIGINS` 只包含该 origin；
- wildcard、HTTP、URL path/query/hash、多个可信 origin 或 host 不一致均 fail closed。

Next.js Server Actions 使用内置同源限制，不添加跨域 `allowedOrigins`；生产入口还要对不可信 Host/转发头和状态改变请求的缺失或错误 Origin fail closed。构建不需要这三项客户域名配置；每个实例在启动时必须显式提供并验证。

### Installer foundation（Generalization Phase 2）

`.env.production.example` 是配置入口；`pnpm production:preflight` 只读校验，`pnpm release:configure -- --runner-image <ref> --migrator-image <ref> --worker-image <ref>` 在校验通过后生成受限的 runtime env 和被 Git 忽略的 `compose.release.yaml`。这不是完整安装器，不执行数据库初始化、migration、role provisioning、容器启动或生产变更。

配置优先级及兼容契约：

- 新的结构化数据库字段为 `POSTGRES_ADMIN_USER/PASSWORD`、`POSTGRES_MIGRATION_USER/PASSWORD`、`POSTGRES_APP_USER/PASSWORD`、`HARD_DELETE_WORKER_DB_USER/PASSWORD`；旧字段 `POSTGRES_USER/PASSWORD`、`MIGRATION_DB_USER/PASSWORD`、`APP_DB_USER/PASSWORD` 仍被接受。新旧同时出现时必须完全一致，否则 fail closed。四个角色名和密码必须各不相同。
- 内部 Compose 仍使用旧字段名；生成的受限 runtime env 明确映射到这些字段。`POSTGRES_HOST` 默认 `postgres`、`POSTGRES_PORT` 默认 `5432`；支持 DNS、IPv4 和带方括号的 IPv6。数据库 URL 对用户名、密码和数据库名进行百分号编码。
- 旧生产使用的显式 `ADMIN_DATABASE_URL`、`MIGRATION_DATABASE_URL`、`APP_DATABASE_URL` 保持有效；若提供，必须与结构化 host、port、database、role、password 逐项一致，不能悄悄覆盖不同身份。省略时在内存中推导，并仅写入被 Git 忽略且 mode 0600 的 runtime env。Worker URL 只在内存中计算和核对独立 file secret，不写入普通 runtime env。
- `PRODUCT_HUB_ENV_FILE` 选择输入文件；`PRODUCT_HUB_RELEASE_FILE` 选择生成的 release override，默认项目根目录 `compose.release.yaml`。`PRODUCT_HUB_CONFIG_ROOT` 默认 `/opt/product-hub/config`；`PRODUCT_HUB_POSTGRES_INIT_DIR` 默认该 root 下的 `postgres/init-production`。现有部署脚本对 `PRODUCT_HUB_ENV_FILE`、`PRODUCT_HUB_RELEASE_FILE` 的覆盖方式不变。`PRODUCT_HUB_RELEASE_COMPOSE` 不是受支持的别名，避免同一概念多套优先级。
- 配置文件必须是由当前运维用户或 root 持有的非 symlink regular file，mode 0400/0600；config/init/可选 backup 目录必须存在且不可由 group/other 写入。Worker secret 一旦配置，父目录必须 root:root 0700，文件必须 UID/GID 1001:1001、0400，内容必须匹配独立 Worker URL。此规则只做检查，不自动 chown 或降低权限。
- `STORAGE_DRIVER=local`、容器内 `/data/uploads`、Compose project `product-hub`、`/run/secrets/hard_delete_worker_database_url` 和数据库角色默认名属于软件默认值；不为它们引入不必要的额外参数。上传持久化由现有 `product_hub_uploads` named volume 承担。

Generated release override 仅为 Runner/Migrator 指定镜像并清除 build 定义；Worker 镜像作为非敏感 release 元数据和 runtime env 中的 `HARD_DELETE_WORKER_IMAGE`，由现有独立 `compose.hard-delete.yaml` 使用。普通 App 发布绝不隐式启用 Worker。镜像仍须通过现有 `linux/amd64` inspect gate。

## 5. Containers and storage

Runner 以 UID/GID 1001 非 root 运行，root filesystem 只读，drop all capabilities，并启用 `no-new-privileges`。持久写入仅允许 `/data/uploads`；`/tmp` 为有界 tmpfs。PostgreSQL 和 uploads 使用独立 named volumes。

Production PostgreSQL init artifact 默认从 `/opt/product-hub/config/postgres/init-production` 只读挂载，也可用 `PRODUCT_HUB_POSTGRES_INIT_DIR` 指向另一个经过审查的绝对路径。普通 App/Migration release 不管理 PostgreSQL lifecycle。

## 6. Secrets

真实 `.env`、database URLs、Auth secret、Worker file secret、证书私钥和备份密钥不得进入 Git、Docker build context、镜像层、普通 environment dump 或日志。生产 env 文件应由受限运维账号持有并使用最小权限。

Worker URL 只存在于独立 file secret。Compose 不向 App 或 Migrator 挂载该文件，也不把 secret value 放入普通 environment。

## 7. Reverse proxy

示例位于 `deploy/nginx/` 与 `deploy/caddy/`。部署者必须替换示例域名和证书路径。Proxy 必须：

- 强制 HTTPS，只接受本实例域名；覆盖 Host、X-Forwarded-Host、X-Forwarded-Proto，丢弃客户端 Forwarded 头，不信任客户端提供的转发头；
- 只代理到 `127.0.0.1:APP_PORT`；
- 设置约 12 MiB 的有界 request body；
- 对登录、上传和导入配置限速与合理 timeout；
- 添加 HSTS 等安全响应头；
- 不直接暴露 PostgreSQL。

## 8. Deployment flow

### First installation bootstrap

Generalization Phase 3 新增 `pnpm production:install`、`pnpm production:bootstrap-admin` 与只读 `pnpm production:doctor`。输入仍是 Phase 2 的仓库外 source env 和已生成 release override。首次安装仅支持现有内置 `postgres:5432` 拓扑；外部数据库必须使用单独审查的运维流程。

Install 分阶段验证配置、Docker/Compose 和镜像、已存在 project/volume、init artifact，随后仅创建或启动 PostgreSQL，等待 ready，验证角色/schema 与空库或已识别 migration history，执行 pending migration、runtime grants、独立 Worker provisioning，准备 file secret，启动 Worker/App，并核验进程、权限、secret 隔离及 localhost health/ready。已有 PostgreSQL container 不 recreate；孤立的已有 database volume、未知 schema、失败 migration、身份不符或更换运行镜像均停止，不能用 install 代替普通 release/repair。

四项数据库凭据由一次性 `database-job` 接收相应阶段所需的 stdin JSON；不进入其 Docker environment/argv。该容器复用 Migrator release image，只连接 backend，运行后删除，无端口或长期高权限 service。初始 Admin 使用同一镜像的一次性 `admin-bootstrap`，只接收 App runtime DB URL 和 Admin 输入；以 Better Auth 官方 password hash、事务与 advisory lock 创建 User/Account，已有任何 Admin 时拒绝。

Worker secret 默认在 `<config-root>/worker-secrets/database-url`，仍为 root:root 0700 parent 与 1001:1001 0400 file。需要操作员显式使用有 root 权限的环境；安装器不调用 sudo。已有 secret 不覆盖，身份/密码/权限不同即停止。`PRODUCT_HUB_COMPOSE_PROJECT` 默认 `product-hub`，可为独立部署或 disposable 测试设置安全项目名。

Doctor 只执行配置/文件/Compose/inspect、数据库 catalog 与只读连接探测、容器状态和 HTTP GET；不 apply grants、不 claim Worker operation、不启动容器、不创建用户。失败输出安全阶段代码与恢复方向，不输出 stack、Compose env 或凭据。应用失败可在审查后停用/回退 App/Worker；已应用 migration 不自动 downgrade，数据库和 volumes 不自动删除。完整可执行步骤见 `PRODUCTION_QUICK_START.md`。

标准顺序是：完整验证与扫描 → 维护窗口 → 发布前备份及恢复可用性确认 → 已运行 PostgreSQL 的 migration job → runtime privilege regression → 初始 Admin（仅全新安装）→ 可选 Worker provisioning/secret/start → App-only update → health/readiness → 内部业务 smoke → reverse proxy/外部 HTTPS smoke → 发布后备份。

普通入口：

- `scripts/deploy-production-migration.sh`：`run --rm --no-deps migration`
- `scripts/deploy-production-app.sh`：`up -d --no-deps app`
- `scripts/deploy-production-hard-delete-worker.sh`：仅启动 Worker，且必须单独授权

`PRODUCT_HUB_ENV_FILE` 和 `PRODUCT_HUB_RELEASE_FILE` 可覆盖默认 `/opt/product-hub` 布局。

## 9. Backup, monitoring and capacity

数据库与 uploads 共同构成恢复点。至少监控容器状态、health、ready、PostgreSQL 连接/锁、错误率、CPU、memory、主机和 volume 磁盘、最近成功备份及异机副本。实际 RPO、RTO、retention、告警水位和 off-host 目标由部署者批准并演练。

详细流程见 `BACKUP_RESTORE.md`、`OPERATIONS.md` 和 `RELEASE_RUNBOOK.md`。

## 10. 禁止操作

生产禁止 `docker compose down -v`、`prisma migrate reset`、`prisma db push`、test/dev seed、广泛 GRANT、公开数据库端口、复用其他项目 credential、在普通 release 中重建 PostgreSQL，以及未经确认的 orphan/data 删除。

Hard Delete 只覆盖当前 PostgreSQL 与当前 uploads。历史 backup 和运维日志按 retention 自然过期，不为单个对象改写历史备份。

## 11. Guided distribution entry

受控 GHCR release 的普通首次安装入口是 `sudo ./setup.sh`。它只支持真正的 Ubuntu/linux amd64、内置 PostgreSQL 拓扑与四项 digest manifest；Host 不要求 Node/pnpm。缺少 Docker/Compose 时只链接官方安装文档，不自动 apt、curl pipe、repository 修改或 sudo。

首次安装在任何写入前检查 `/opt/product-hub`、CLI、Compose project/containers/volumes/network 与 port。通过后由固定 Migrator digest 的一次性 control container 调用既有 bootstrap。安装只生成 Caddy/Nginx snippet，不安装、覆盖、reload 或 restart reverse proxy。

routine CLI 只提供 `status`、`doctor`、`backup`、`update`、`update --check` 与 bounded `logs`。Update 固定顺序是 lock → current doctor → target manifest/digest/amd64/revision → fresh verified backup → pending migrations/grants → Worker → App → doctor/health；禁止由该命令改变 PostgreSQL digest 或 lifecycle。
