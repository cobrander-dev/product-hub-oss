# Backup and Restore

Product Hub 的 PostgreSQL 数据与 uploads 共同构成一个恢复点。两者不是 ACID 原子资源；正式备份应在维护窗口暂停业务写入。RPO、RTO、retention、加密和 off-host 目标由部署者明确批准。

## Backup

Phase 3 首次安装实例可以在写入维护窗口运行 `PRODUCT_HUB_ENV_FILE=<source-env> pnpm production:backup`。使用一次性 PostgreSQL tools service、只读 uploads mount 与配置的 backup root，复用下方现有 backup script。Migration 连接参数经 stdin 进入 job 内存，不进入 Docker Config.Env/argv 或日志；password 只放在容器 tmpfs 的 mode 0600 password file，其他参数使用 libpq 环境变量。`PGDATABASE` 只放数据库名，不能直接放完整 URI。Bootstrap admin 与 Worker credential 不参与备份。脚本不负责自动暂停 App/Worker，维护窗口仍由操作员控制。

一次性 backup service 对 uploads 只读挂载，但需要读取 App UID/GID 1001 的 mode 0640 私有文件与 0750 子目录；drop ALL 后仅添加 `DAC_READ_SEARCH` 读取能力，不添加写入绕过能力。它只挂载 uploads、指定 backup root 与只读脚本，stdin 接收 migration credential，完成即退出。Disposable 验证必须包含真实上传图片文件，而不是只验证空 uploads archive。

直接调用现有 `scripts/backup.sh` 时仍可提供受限 `DATABASE_URL`；Node helper 将其解析为 libpq 参数和受限临时 password file，再执行同一脚本，不把 URL/password 放进 `pg_dump`/`psql` argv。支持 Phase 2 的单 host PostgreSQL URI，以及明确 allowlist 的 TLS/timeout 参数；未知 URI 参数拒绝，不静默忽略。

在受限运维环境提供 migration-owned `DATABASE_URL`、`LOCAL_STORAGE_ROOT`、`BACKUP_ROOT` 和当前小写 Git revision：

```bash
RELEASE_REVISION="$(git rev-parse --short=12 HEAD)" scripts/backup.sh
```

每个不可覆盖的 backup set 包含：

- `database.dump`：PostgreSQL custom-format dump；
- `uploads.tar.gz`：保留 storage keys 的 uploads archive；
- 逐 StoredObject/file checksum；
- `manifest.txt`：UTC 时间、revision、migration、记录/文件数量和 SHA-256；
- 顶层 `CHECKSUMS`；
- 最后创建的 `COMPLETE` 标记。

只有存在 `COMPLETE` 且顶层和逐对象 checksums 全部通过的集合才可复制到加密 off-host 目标。建议每日、发布前和发布后创建备份，但具体频率必须与业务 RPO 一致。

## Restore prerequisites

Cluster bootstrap admin 只负责空 PGDATA 初始化和必要的空数据库/role ownership；它的 URL 不提供给 App 或普通 migration job。恢复连接必须是非 superuser migration role，并拥有目标 `public` schema。

恢复目标必须是明确确认的空数据库和空 uploads 目录。禁止直接覆盖当前运行数据库或 volume。若已有 cluster 需要新恢复目标，应由 bootstrap admin 创建空数据库，将 schema ownership 交给 migration role，并撤销 PUBLIC 多余权限。

## Restore

```bash
DATABASE_URL='postgresql://migration-user:REDACTED@host/product_hub_restore' \
LOCAL_STORAGE_ROOT='/restore/uploads' \
BACKUP_SET_DIR='/backups/product-hub-backup-id' \
RESTORE_CONFIRM_DATABASE='product_hub_restore' \
scripts/restore.sh
```

脚本拒绝：

- 确认名与实际数据库不一致；
- superuser 或不拥有 `public` schema 的连接；
- 非空数据库或非空 storage；
- 不完整集合或 checksum 错误；
- tar path traversal；
- 目标配置缺失。

`pg_restore` 使用 `--no-owner --no-privileges`。uploads 默认递归设为 Runner UID/GID `1001:1001`；如部署使用经审查的其他非 root identity，通过 `RESTORE_STORAGE_UID` 和 `RESTORE_STORAGE_GID` 覆盖。

## Post-restore verification

`restore.sh` 调用 `verify-restore.sh`：

- 校验 backup set 的所有 SHA-256；
- 比较 StoredObject 行数与文件数；
- 验证每个 StoredObject 对应文件存在且 checksum 一致；
- 任一差异即非零退出。

验证后仍必须：

1. 检查 migration status；
2. 以 migration identity 重跑 `configure-runtime-role.ts`；
3. 验证 runtime 普通 CRUD 及不可变表拒绝；
4. 检查 `/api/ready` 对 storage 可写；
5. 执行 Admin/Factory 登录与租户隔离、产品/报价/历史、图片 200/404、导入和 Activity smoke；
6. 记录实际 RTO。

所有检查完成前不得切换正式流量。

## Orphan reconciliation

`scripts/orphan-scan.sh` 是只读 DRY-RUN，报告 `DB_WITHOUT_FILE`、`DB_WITHOUT_REFERENCE` 与 `FILE_WITHOUT_DB`。未完成 Hard Delete FileTask 应单独标记 pending deletion。工具默认不删除、不设 cleanup cron；任何清理都要先备份、重新确认引用和最小年龄，再获得独立授权。

## Hard Delete and retention

逐对象 Hard Delete 只保证当前 Product Hub PostgreSQL 与当前 uploads 清理干净。历史 backups、restore artifacts、Security Event 和运维日志不进入单对象删除闭包，按已批准 retention 自然过期；不得为单个对象改写或局部删除历史 backup。

如果法规要求立即擦除全部历史副本，必须重新设计并批准备份、日志和合规策略，不能由 Worker 擅自扩大范围。

## Destructive warning

生产禁止：

- `docker compose down -v`
- `prisma migrate reset`
- `prisma db push`
- test/dev seed 或 reset
- 对现有目标执行覆盖式 restore
- 手工删除数据库卷或 uploads

这些命令不是正常 rollback。
