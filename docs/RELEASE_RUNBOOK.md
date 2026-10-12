# Release and Rollback Runbook

本 runbook 适用于部署者自己的基础设施。执行服务器、DNS、TLS、migration、Worker 或数据操作前，必须取得对应环境的明确授权。

**首次安装与普通 release 分流：** 全新 Linux 主机按 `PRODUCTION_QUICK_START.md`，使用 source env 完成 `production:install`、独立 `production:bootstrap-admin` 和只读 `production:doctor`。以下 ordinary release 步骤保持显式 `--no-deps`，不管理 PostgreSQL lifecycle。不得用 install 静默升级已有 App/Worker 镜像。

## 1. Preflight

1. 核对获批 commit、干净工作树、手动 workflow 输入和变更审查结果。正式安装只接受受控 workflow 产出的 digest manifest；tag 不是 artifact identity。
2. 为每个运行实例设置精确匹配的 `APP_DOMAIN`、HTTPS `BETTER_AUTH_URL` 和单一 `BETTER_AUTH_TRUSTED_ORIGINS`；镜像构建不接收客户域名。
3. 运行 format、lint、typecheck、Prisma validation、完整 CI、dependency audit 和 secret scan。
4. 构建三个 amd64 artifacts，并按 registry digest 重新 pull/inspect OS/Architecture、RepoDigest、revision/version；拒绝 missing、unknown、arm64、aarch64 或 revision 不同。PostgreSQL 同样使用 manifest 固定的 amd64 digest。
5. 对 Runner、Migrator、Worker 的实际 amd64 镜像运行漏洞扫描；任何未接受的 Critical/High 都停止发布。
6. 确认独立 bootstrap/migration/runtime/Worker 身份、受限 secrets、磁盘余量、监控、维护窗口、回滚镜像和已验证的 off-host backup。
7. 确认 Product Hub project 的 port/network/volume/database/path 不与其他服务冲突。

本地正式构建回归示例（不会发布）：

```bash
pnpm release:build:amd64 <commit-or-release-tag>
```

## 2. Prepare host configuration

从 `.env.production.example` 创建不进入 Git 的受限 env file。默认路径为 `/opt/product-hub/config/product-hub.env`；可在调用脚本时用 `PRODUCT_HUB_ENV_FILE` 覆盖。Release override 默认位于项目目录的 `compose.release.yaml`，可用 `PRODUCT_HUB_RELEASE_FILE` 覆盖。

在任何部署授权之前，可先运行 `PRODUCT_HUB_ENV_FILE=<source-env> pnpm production:preflight`。通用分发使用同一 commit 的受审 manifest，并先 pull 其中四个 digest，再运行 `PRODUCT_HUB_ENV_FILE=<source-env> pnpm release:configure -- --manifest <reviewed-manifest>`。它验证 digest/amd64/revision 后，只生成 mode 0600 的 `product-hub.resolved.env` 和无 secret 的 release override，不执行后续生产步骤。后续脚本使用 `PRODUCT_HUB_ENV_FILE=<resolved-env>` 与 `PRODUCT_HUB_RELEASE_FILE=<generated-compose>`；旧生产显式配置不必迁移。字段分类、权限与兼容细节见 `INSTALLER_FOUNDATION.md`。

PostgreSQL init artifact 默认安装到 `/opt/product-hub/config/postgres/init-production`，也可用 `PRODUCT_HUB_POSTGRES_INIT_DIR` 覆盖。它必须是稳定、只读的绝对 host path；普通 release 不更新该目录。

## 3. Backup

暂停业务写入，创建 database + uploads 的一致 backup set，验证 `COMPLETE`、顶层 checksums、逐 StoredObject checksum 和异机副本可用性。没有可验证恢复点不得继续。

## 4. PostgreSQL bootstrap

只有全新空 PGDATA 才运行 init artifacts。确认 bootstrap admin 是唯一需要的 cluster 管理身份；migration/runtime 为独立非 superuser login，migration 拥有应用 schema，PostgreSQL 无 published host port。

已有 PGDATA 不会重新运行 init scripts。角色、ownership 或数据库配置不符合时停止，使用单独审查的修复计划；禁止通过删除 volume 重新初始化。

## 5. Migrations and runtime privileges

在 PostgreSQL 已运行且 healthy 后执行：

```bash
PRODUCT_HUB_ENV_FILE=/restricted/path/product-hub.env \
PRODUCT_HUB_RELEASE_FILE=/reviewed/path/compose.release.yaml \
scripts/deploy-production-migration.sh
```

脚本使用 `run --rm --no-deps migration`，随后配置 runtime role。确认 migration 全部 applied、unknown relation 为零、Prisma migration history 对 runtime 拒绝、普通业务 CRUD 正常，以及 `PriceHistory`/`ActivityLog` UPDATE/DELETE/TRUNCATE 被拒绝。

任一 migration 或 privilege check 失败时停止，不启动新 App，不运行 `migrate reset`、`db push` 或手工宽泛 GRANT。

## 6. Initial Admin

全新 install 完成后仅执行一次 `PRODUCT_HUB_ENV_FILE=<source-env> pnpm production:bootstrap-admin -- --username <name> --name <display-name>`。密码由隐藏 TTY prompt 输入/确认，或通过显式 `--password-stdin` 的安全输入源提供；不得使用密码 env、参数或 shell 字面量。一次性 service 无端口、无长期 secret，stdin 只传必要 App DB identity 与管理员输入，使用正式 Better Auth hash 和事务创建 User/Account。已有任何 Admin 时拒绝（包括并发 bootstrap），不重置、不 seed。

## 7. Optional Hard Delete Worker rollout

只有明确授权 Hard Delete rollout 时执行：

1. migrations 和 runtime grants 已完成；
2. bootstrap admin 运行 `ops:provision-hard-delete-worker-role`；
3. provisioning 使用的 `HARD_DELETE_WORKER_DB_USER` 与 secret URL username、Worker environment 完全一致；
4. Worker file secret 仅 Worker 可挂载，App/Migrator 无访问；
5. 运行 `scripts/deploy-production-hard-delete-worker.sh`，只启动 Worker且不带 dependencies；
6. 验证 role 无 table/sequence/membership 权限，只拥有固定函数 EXECUTE。

停止 Worker不会丢失 durable tasks；不得把 App credential 作为替代，也不得为失败 operation 创建重复 operation。

## 8. App rollout

执行：

```bash
PRODUCT_HUB_ENV_FILE=/restricted/path/product-hub.env \
PRODUCT_HUB_RELEASE_FILE=/reviewed/path/compose.release.yaml \
scripts/deploy-production-app.sh
```

脚本使用 `up -d --no-deps app`，不管理 PostgreSQL。验证 App 非 root、read-only、cap drop、resource/log limits、uploads mount，然后检查 `/api/health` 和 `/api/ready` 均为 200。

## 9. Reverse proxy and smoke

安装部署者定制的 Nginx 或 Caddy 配置，确认 HTTPS、证书续期、HTTP→HTTPS、Host/X-Forwarded headers、12 MiB body limit、timeouts、rate limits 与安全头。

从内部和外部执行受控 smoke：Admin/Factory 登录、租户隔离、产品/厂家/分配、报价与历史、图片权限、导入导出、Activity、账号与 Hard Delete 页面只读状态。完成后恢复业务写入并创建发布后备份。

## 10. App-only rollback

若 schema 与旧 App 兼容，使用旧获批 release override 重新运行 App deploy script，再验证 health/readiness 与核心业务。App rollback 不逆向 migration、不覆盖数据库或 uploads，也不管理 PostgreSQL。

## 11. Database/data recovery

数据库或数据损坏时停止写入并保留现场。创建新的空数据库和空 uploads 目标，按 `BACKUP_RESTORE.md` 恢复匹配版本的已验证 backup set；完成 checksum、migration/privilege 和业务 smoke 后再切换。不得直接覆盖当前生产目标。

已完成的 Hard Delete 不能通过停止 Worker 或 App rollback 撤销；只能依据已批准 backup retention 和独立恢复授权处理。

## 12. Stop conditions

以下任一情况立即 NO-GO：SHA 或 artifact 不一致、可修复 Critical/High、secret 暴露、备份/恢复失败、migration/权限失败、Worker role 边界失败、ready 非 200、租户隔离失败、TLS/origin 错误、磁盘不足或缺少回滚/值班安排。

禁止用 `down -v`、`migrate reset`、`db push`、重建 volume、force push 或历史改写解决发布问题。
