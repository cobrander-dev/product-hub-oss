# Hard Delete 正式设计

## Phase 3 Admin workflow（2026-09-30）

沿用下述删除矩阵，不增改表结构。九类目标使用 Danger Zone → server impact preview → exact phrase confirm → durable operation → final verification → completed navigation。确认短语大小写与空格逐字匹配：Product `DELETE <SKU>`，无 SKU 为 ID 后八位；Factory/Category/Material `永久删除 <精确名称>`；User `DELETE <username>`；Assignment/Quote/Image `DELETE <ID 后八位>`。

新增 migration 11 固定 preview refresh function：enabled Admin 校验、target advisory lock、PREVIEWED 行锁、更新同一 operation/version/digest/expiry；已确认只返回既有 ID，不创建第二任务。不修改 Phase 1/2 migration，不允许普通 App 更新 operation 或删除历史。Confirm 最终锁在已有 SECURITY DEFINER function，预览过期/变化必须显式重新预览与重新输入。

DTO 只输出 safe target/删除与保留计数/文件数量/阶段/时间/重试摘要。只在 COMPLETED 导航并提示永久删除完成。FILES_PENDING 自动重试，不新增手动 retry。永久删除当前数据库和专属 uploads；历史 backup/log 按 retention 过期，不修改快照。Worker 独立 secret/production overlay，无 Auth secret/public ports。所有本阶段验证使用 disposable 环境，生产/push/tag 禁止。

状态：Phase 3 Admin UI / Danger Zone / End-to-End Integration（本地）

日期：2026-09-30

本文件细化 `PRODUCT_REQUIREMENTS.md`、`AUTHORIZATION.md`、`SECURITY.md`、`DATABASE.md` 与 `ARCHITECTURE.md` 已确认的永久删除规则；冲突时仍按项目总 source-of-truth 优先级处理。

## 1. 已确认产品裁定

### User

- 永久删除 User、Account 与 Session。
- 删除该 User 作为目标对象的 `USER_CREATED`、`USER_ENABLED`、`USER_DISABLED` Business ActivityLog。
- Quote、PriceHistory、StoredObject、ProductMainImage、FactoryPrivateImage、ImportJob 与其他共享业务对象不随 User 删除。
- 共享对象上的 User provenance 外键改为 nullable + `ON DELETE SET NULL`；现有价格历史和业务审计继续保留。
- 保留的 ActivityLog 若原 actor 是被删 User，必须清空 `actorUserId` 并把 actor snapshot 匿名化为“已永久删除用户”；价格历史等没有 actor snapshot 的界面在外键为空时使用同义文案。
- 禁止删除任何 Admin、当前确认操作的 Admin 以及唯一 enabled Admin。Phase 1 数据库函数进一步收窄为只接受 disabled Factory User，因此 Admin 保护不依赖仅有的 enabled Admin 计数。
- 第一版只允许 disabled Factory User；enabled Factory User 必须先走正式停用与 session 撤销流程。

### Security Event、backup 与运维日志

- stdout Security Event 不进入逐对象 Hard Delete 闭包，继续遵循现有容器日志 retention。
- Hard Delete 只承诺当前安装的 PostgreSQL 与 uploads 中的对象清理；历史 backup、restore artifact 与运维日志按既有 retention 自然过期。
- 不为了单个对象改写历史 backup；任何未来 backup retention 变更必须作为独立运维决策。

### Import provenance

- 从本 migration 起，Import confirm 对每个成功 CREATE/UPDATE/NO_CHANGE 行写入稳定 `resolvedProductId`。
- `resolvedProductId` 是 Product FK；Product 将来被永久删除时使用 `ON DELETE SET NULL`，禁止用 SKU/name 反推或补写旧行。
- 旧 ImportRow 不做启发式 backfill。当前旧 SMOKE ImportJob 将来只能作为独立 `IMPORT_JOB` Hard Delete 对象处理。

## 2. Phase 2 产品矩阵与依赖闭包

- `USER`：只允许 disabled Factory User；删除 User/Account/Session 与三类 user lifecycle audit，其他业务数据保留并匿名化 provenance。
- `PRODUCT`：只允许 DISABLED；删除 Product、Assignment、Quote、PriceHistory、主图、私图、相关 ActivityLog，以及没有任何 surviving image relation 的 StoredObject；稳定 FK 命中的 ImportRow 保留但清空 Product 引用，ImportJob 与 counters 保留。
- `FACTORY`：只允许 DISABLED；删除 Factory User/Account/Session、Assignment、Quote、PriceHistory、厂家私图、相关 ActivityLog，以及无 surviving image relation 的 StoredObject；Product、Product Main Image、Category、Material 与 promoted main image 保留。
- `CATEGORY` / `MATERIAL`：只允许 DISABLED 且引用 Product 数为 0；否则 preview 返回 blocker，worker 必须拒绝。
- `ASSIGNMENT`：只允许 REVOKED；删除该 Assignment、Quote、PriceHistory、厂家私图及相关 ActivityLog；Product、Factory、Product Main Image 保留。
- `QUOTE`：仅父 Assignment 为 REVOKED；删除 Quote、PriceHistory 与 Quote ActivityLog；Assignment、Product、Factory、私图保留。
- `PRODUCT_MAIN_IMAGE` / `FACTORY_PRIVATE_IMAGE`：删除 relation 与相关图片 ActivityLog；只有跨两张图片关系表均无 surviving reference 时才删除 StoredObject 并创建文件任务。不能根据 uploader/creator actor ownership 推断文件归属。
- `IMPORT_JOB` 仍保留为已建模但 Phase 2 未授权执行的独立 target；旧行不得依 SKU/name 推断。

Planner 仅接受 target type/id，并从 PostgreSQL 当前状态计算全部 dependency IDs、稳定版本、文件引用与计数。客户端不得提交 dependency IDs、file keys、counts、factoryId、activity IDs 或删除 SQL。安全 preview 只返回 label、状态、计数、blocker/preservation 摘要、digest、version 与 expiry；内部闭包保存在 operation 中，不回传不必要 ID、storage key、账号、token、hidden email、报价内容或日志正文。

## 3. Phase 2 durability additions

- canonical digest 绑定 target type/id、target version、完整数据库闭包、StoredObject 引用以及 preview 时的文件 existence/checksum/size。确认与 worker 执行前均重新计算；变化即 stale/conflict。
- Operation 增加 version、expiry、attempt、lease 与 final verification；FileTask 增加 safe error code 与独立 task lease。
- 并发控制同时使用 active-target partial unique、确认 CAS、operation lease、row lock 与 advisory transaction lock。只有 lease 过期后才能接管。

## 4. Phase 1 数据结构（保留的基础）

`HardDeleteOperation` 是预览、确认、执行与结果的耐久控制记录：

- `targetType + targetId` 标识固定类型对象；活动 operation 有部分唯一索引，避免同一对象并发出现多条活动删除。
- `preview` 为结构化计数/闭包摘要，`previewSha256` 固定确认时的预览；不得放密码、token、hidden email、原始文件内容或不必要的个人数据。
- `requestedBy/confirmedBy` 同时保留 nullable FK 与必要 username snapshot；FK 使用 `SET NULL`。
- 状态只允许 `PREVIEWED → CONFIRMED → EXECUTING/FILES_PENDING → COMPLETED` 或 `FAILED`，数据库 CHECK 约束各状态时间字段。
- 完成 User 删除时 `targetLabelSnapshot` 改为“已永久删除用户”。Operation 不得由普通业务流程删除。

`HardDeleteFileTask` 是 PostgreSQL 提交后 uploads 收敛的耐久任务：

- 固定保存 operation、原 StoredObject（可空 FK）、provider、opaque storage key、checksum 与 size。
- 状态为 `PENDING/PROCESSING/RETRYABLE/DELETED/FAILED`，包含 attempts、nextAttemptAt、lastError 与 deletedAt；CHECK 保证状态字段一致。
- `(operationId, storageKey)` 唯一；worker 必须幂等处理“文件已不存在”。
- Phase 1 不创建真实 task；User 删除不会创建 file task，因为共享图片与对象必须保留。

## 5. Phase 1 historical privileged deletion boundary

Phase 1 曾提供的唯一特权入口为：

`public.execute_confirmed_user_hard_delete(operation_uuid)`

Phase 2 migration 已将此旧入口替换为固定报错的 disabled stub；当前 worker 必须使用第 9 节列出的 Phase 2 固定函数，不能回退到旧入口。

其安全边界固定如下：

- `SECURITY DEFINER`，owner 必须是 migration identity，`search_path=pg_catalog`，所有业务对象使用 schema-qualified 固定名称。
- 只接收 operation UUID；不接收 table name、column name、SQL、任意 ID 列表或 JSON 删除计划。
- operation 必须存在、被行锁定、状态为 `CONFIRMED`、target type 为 `USER`，requester/confirmer 必须仍是 enabled Admin。
- 目标必须是 disabled Factory User，且不得等于 requester/confirmer；任何 Admin 与 enabled Factory User 均拒绝。
- 函数删除目标 User 的三个 lifecycle events，匿名化其在其他 ActivityLog 的 actor provenance，删除 User；Account/Session 由 FK cascade，其他 provenance 由 `SET NULL`，共享业务对象保留。
- User operation 不得含 file task。函数在同一数据库事务中把 operation 完成；失败全部回滚。
- Phase 1 时 `PUBLIC` 与 `product_hub_app` 均无 EXECUTE，独立 worker login 无 table/sequence 权限、无 role membership。Phase 2 的当前授权矩阵见第 6、9 节。

Phase 1 不实现其他 target type 的删除函数、闭包 planner、uploads worker、最终 Admin UI 或生产运行。Phase 2 必须为每一对象类型单独证明闭包、共享 StoredObject 检查、数据库提交与 file task 收敛顺序，不得把本函数改成动态 SQL dispatcher。

## 6. Runtime 与凭据边界

- Web App 只使用 `product_hub_app`，永远不接收 worker username/password、worker DATABASE_URL 或可执行特权函数的代理能力。
- `product_hub_app` 对 ActivityLog/PriceHistory 保持 `SELECT, INSERT`，无 UPDATE/DELETE/TRUNCATE。
- Web App 对 User 保持 SELECT/INSERT/UPDATE、无 DELETE；对 HardDeleteOperation 只有 SELECT 与创建 preview 所需列级 INSERT、无表级 INSERT/UPDATE/DELETE；对 HardDeleteFileTask 只有 SELECT。
- Web App 只可 EXECUTE 无副作用 `plan_hard_delete`、CAS `confirm_hard_delete_operation` 与 Phase 3 固定 `refresh_hard_delete_preview`（只创建/刷新 PREVIEWED，不执行删除）；不能 claim、execute、retry、fail、finalize 或读取 privileged storage catalog。业务闭包删除只能由独立 worker 调用固定函数。
- 独立 worker credential 只在未来 worker runtime secret scope 中提供，不加入 app service environment、client bundle、日志或仓库文件。
- `scripts/provision-hard-delete-worker-role.ts` 必须由 bootstrap role 以独立 secret 显式运行；它验证 function owner、SECURITY DEFINER 与固定 search_path 后才创建/轮换 worker login 并授予最小 EXECUTE。

## 7. 文件与事务边界

未来含文件对象的顺序固定为：确认预览 → worker 在数据库事务中锁定 operation、生成 immutable file tasks、执行数据库闭包并提交 → 事务外按 task 删除 uploads → 重试/核对 → 完成 operation。不得先删文件后提交数据库；不得因一次文件删除失败回滚已提交业务闭包或静默丢弃 task。

## 8. Phase 1 历史验证与停止条件

Phase 1 必须在 disposable `_test` PostgreSQL 中从空库 replay 全部 migration，并验证：

- migration/schema CHECK、index、FK 与 enum；
- app role 对两类历史表仍无 DELETE，对函数无 EXECUTE；
- worker 无直接 table 权限、只可执行固定函数；
- PREVIEWED、错误 target type、Admin、enabled Factory User 均拒绝；
- confirmed disabled Factory User 闭包在事务内正确，随后测试事务 ROLLBACK，生产数据与正式 uploads 不受影响；
- Import CREATE/UPDATE/NO_CHANGE 在确认后均写稳定 resolvedProductId；旧行保持 NULL。

Phase 1 当时禁止部署、push、tag、创建真实 HardDeleteOperation、删除正式数据或实现最终 Hard Delete UI。

## 9. Phase 2 privileged execution 与文件一致性

Phase 2 使用固定的只读 planner，以及 operation claim/lease、confirmed closure execution、file task claim/complete/retry、operation fail/finalize 函数。全部为 `SECURITY DEFINER`、`search_path=pg_catalog`、schema-qualified static SQL；不接受 table/column/SQL、客户端 dependency IDs 或任意删除列表。App 在 Admin 服务端授权后仅调用 planner、confirm 和 Phase 3 preview-refresh 控制；执行/lease/file/finalize 函数只授予独立 worker，App/PUBLIC 均无 EXECUTE。

执行顺序固定为：确认 preview → worker claim/lease → 重算 planner/digest → 单一数据库 transaction 生成 immutable file tasks 并删除数据库闭包 → `FILES_PENDING` → 事务外通过 Storage abstraction 幂等 delete/stat → durable retry/crash takeover → final verification → `COMPLETED`。数据库 transaction 中会再次生成 planner 并与 confirmed internal preview 完整比较；stale/blocked/missing 全部回滚。

orphan scanner 将尚未 `DELETED` 的 FileTask key 标记为 pending deletion，不计作未知 orphan。preview 保存基线 unknown-orphan 集合，完成时不得产生新增未知 orphan。Phase 3 worker 删除事件日志严格只允许 operation ID、entity type、不可逆 fingerprint、result/status 与 timestamp；attempt/task counts 和 safe error code 不进入该事件。禁止 storage key/path、账号/token/hidden email、ActivityLog 正文或报价内容。

Phase 2 仅在 disposable PostgreSQL 与临时 filesystem 执行测试。禁止部署、push、tag、正式 operation/数据删除、最终 Admin UI 与 Phase 3。
