# Product Hub Production Operations

本文件定义任一 Product Hub 安装的运行契约，不记录私人服务器或历史 Gate 状态。

## Runtime contract

- 正式 Runner、Migrator、Hard Delete Worker 均为经 inspect 的 `linux/amd64` artifact。
- App 以 UID/GID 1001 非 root 运行，只发布到 `127.0.0.1:APP_PORT`。
- App 使用 read-only rootfs、64 MiB `/tmp` tmpfs、cap drop、`no-new-privileges`、资源限制和日志轮转。
- PostgreSQL 只连接 internal backend network，不发布 host port。
- `/data/uploads` 是唯一持久应用写入点；不能用 `chmod 777` 解决权限。

默认主机配置目录是 `/opt/product-hub/config`。以下变量允许部署者采用其他受限绝对路径：

- `PRODUCT_HUB_ENV_FILE`
- `PRODUCT_HUB_RELEASE_FILE`
- `PRODUCT_HUB_POSTGRES_INIT_DIR`

Installer foundation 通过 `PRODUCT_HUB_ENV_FILE` 读取仓库外受限 source env；`pnpm production:preflight` 仅检查、不修复。`pnpm release:configure` 必须先 inspect 三个本地 `linux/amd64` 镜像，然后生成同目录 mode 0600 的 `product-hub.resolved.env` 与 `PRODUCT_HUB_RELEASE_FILE` 指定的无 secret Compose override。已有文件默认不覆盖，`--force` 是显式替换。部署者随后仍须显式选择生成的 env/release 文件；旧生产显式 env/URL 路径保持有效。完整字段与边界见 `INSTALLER_FOUNDATION.md`。

## First install and read-only doctor

Phase 3 commands读取同一仓库外 **source env**（不是 resolved env）。按 `PRODUCTION_QUICK_START.md` 显式选择项目、路径和同源 amd64 release。`production:install` 需要由操作员主动在 root 环境调用，不自行 sudo；root 仅用于受限 Worker secret 安放及部署操作，App/Worker 不变为 root。

阶段顺序：host/release → init artifact → PostgreSQL start/ready → DB identity/history → pending migrations → runtime grants → Worker role → file secret → Worker → App → final verification。全部 container 启动明确 `--no-deps --no-build --no-recreate`。已有 PostgreSQL 必须匹配 project/volume/config/ownership/history，未知库、孤立 volume、failed migration 和 release image 差异直接停止。重复 install 不创建 Admin、不改密码、不删除业务记录、不 reset DB；存在 Worker role 时先验证，再以 `--check` 检查精确 grants。

`production:doctor` 只检查现有对象，不启动/重建容器，不迁移、GRANT、创建账号或 claim operation。DB 检查使用只读事务和 provisioning scripts 的 `--check` 模式；Worker connection probe 仅在既有 Worker 内以其自身 file secret 执行；App ready 检查前先确认已有 storage 目录。失败输出安全阶段代码，不自动修复。

所有阶段失败即停，不执行后续阶段；不做 destructive rollback。保留数据库与 volume，排除失败项后可重试；App rollback/数据恢复仍使用各自受审 runbook，migration 不 downgrade。锁目录残留需操作员确认无活跃 install 后单独处理，不能盲目删除。新的 backup 命令只创建新备份集合，不覆盖旧集合。

## Configuration and secrets

生产 origin 必须由 `APP_DOMAIN`、`BETTER_AUTH_URL`、`BETTER_AUTH_TRUSTED_ORIGINS` 三项精确一致地定义。Auth URL 必须是 HTTPS origin，trusted origins 只能包含同一个值。

必须独立生成 bootstrap、migration、runtime、Worker 密码和至少 32 字节 Better Auth secret。不得把 secret 写入 Compose、镜像、Git、命令行参数、shell history 或日志。

Worker file secret 只挂载到 Worker。App/Migrator 不得获得 Worker credential，Worker 不得获得 `DATABASE_URL`、Better Auth secret 或 Admin credential。

Installer 自动使用 CSPRNG 生成 Better Auth、bootstrap、migration、runtime 与 Worker passwords；初始 Admin password 和私有 GHCR read token 只从隐藏 TTY 读取。GHCR credential 写入 `/run` 下 mode 0700 临时 Docker config（无 `/run` 时使用受限 `/tmp`），命令结束删除；不进入 argv/env/history/logs。不得打印完整 Compose config。

Worker secret parent 必须 root:root 0700，文件必须 UID/GID 1001:1001、0400。preflight 在配置 Worker secret 路径后检查 ownership、mode、URL 身份及与结构化 Worker credential 的一致性；不自动创建/chown。若当前运维用户无法穿越 root-owned 目录，应由有权限的操作员运行该只读检查，而不能放宽目录或文件权限。

首次 install 可以在上述限定模型下创建新 file secret（默认 `<PRODUCT_HUB_CONFIG_ROOT>/worker-secrets/database-url`），绝不覆盖已有 secret。原始 host path 对普通 UID1001 不可穿越；Docker daemon bind-mount 后 Worker UID1001 可只读使用。DB/admin one-shot credential 通过 stdin 内存传递，不写 Docker Config.Env、argv、生成 Compose 或长期 App/Worker。

## Start and routine release

发布前先按 `RELEASE_RUNBOOK.md` 完成 artifact、扫描、备份与恢复前置条件。普通 release 只允许：

```text
scripts/deploy-production-migration.sh
scripts/deploy-production-app.sh
```

两者都强制 `--no-deps`，不得 create、recreate、start、stop 或 restart PostgreSQL。PostgreSQL lifecycle 只有在数据库维护、image/config upgrade 或 disaster recovery 获独立批准时才可操作。

面向普通安装的固定命令是：

```text
product-hub status
product-hub doctor
product-hub backup
product-hub update --check
product-hub update
product-hub logs --service <app|postgres|hard-delete-worker> --lines <1..500>
```

`status`/`doctor`/`update --check` 不 pull、不写 DB、不启动/停止长期服务；所有 CLI 命令使用结束即删除的 control container，doctor 还使用结束即删除的只读 database verification container。`logs` 不支持 follow、任意 service 或参数透传。`backup` 只创建新恢复点并验证 manifest/CHECKSUMS/COMPLETE。`update` 使用单独锁、先 doctor/backup，之后只 force-recreate Worker 与 App；PostgreSQL 既不作为 dependency 启动，也不 recreate。普通 CLI 不提供 restore/reset/down/remove-volume。

健康契约：

- `/api/health`：不依赖数据库的 liveness，成功返回 200；
- `/api/ready`：检查数据库与 upload storage，可用返回 200，失败返回不泄漏细节的 503。

## Database privilege contract

Migration profile 先执行 forward-only migrations，再运行 `configure-runtime-role.ts`。Runtime 只获得明确白名单对象权限；未知 public relation 会使配置失败。不得用 `ON ALL TABLES` 或宽泛 default privileges 绕过。

`PriceHistory` 与 `ActivityLog` 对 runtime 仅允许 SELECT/INSERT；Prisma migration history 不允许 runtime 访问。每次 schema 变化都必须更新并重跑隔离权限测试。

## Hard Delete Worker

provisioning 与 Worker 共同使用 `HARD_DELETE_WORKER_DB_USER`，默认 `product_hub_hard_delete_worker`。自定义值必须是安全 PostgreSQL identifier，并与 Worker URL username 完全一致。

Worker role 必须保持 NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOINHERIT、NOREPLICATION、NOBYPASSRLS，无 role membership、table 或 sequence grants，只能 EXECUTE 固定 allowlist 的 migration-owned SECURITY DEFINER functions。函数固定 `search_path=pg_catalog`，PUBLIC 无 EXECUTE。

Worker 按 durable operation/task lease 工作：先确认 operation，再由数据库函数执行闭包，数据库提交后处理文件。文件失败进入安全、可重试状态；不得通过创建第二 operation 掩盖失败。日志不得包含 credential、storage key/path、用户数据或审计正文。

## Request and abuse limits

应用登录限制由 PostgreSQL 持久化；单机部署还应在受信任 reverse proxy 按真实 client IP 限制登录、图片和导入。Request body 上限建议 12 MiB，应用仍独立执行 10 MiB 文件限制。

## Backup and maintenance

每日与发布前后备份只是建议起点；部署者必须确定 RPO/RTO/retention、异机副本、加密密钥和演练频率。备份与恢复细节见 `BACKUP_RESTORE.md`。

生产禁止：

- `docker compose down -v`
- `prisma migrate reset`
- `prisma db push`
- test/dev seed 或 reset
- 未审查的自动 orphan cleanup

## Monitoring and incidents

至少监控 App/PostgreSQL/Worker 状态、health/ready、queue/file-task backlog、CPU、memory、disk、PostgreSQL 连接/锁、错误率和备份年龄。发生异常时先阻止进一步写入，记录 release digest、migration status 和 backup manifest，再判断 App-only rollback 或隔离恢复。

日志不得包含密码、Cookie、Authorization、session、完整 database URL、上传 bytes 或导入内容；对外错误不得返回 stack、SQL 或 filesystem path。
