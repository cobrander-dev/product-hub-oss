# Phase 11｜Production Hardening & Release Readiness Report

> **Historical development record — not deployment instructions.** 本文件仅保留当时的验收证据；第三方安装与当前发布必须遵循 `DEPLOYMENT.md`、`OPERATIONS.md` 和 `RELEASE_RUNBOOK.md`。

审查基线：`main` / `216b8bc5d713`（Phase 10C Feature Freeze）。本阶段未访问服务器、未部署、未修改 DNS/Cloudflare、未 push、未创建 tag，也未开始 Phase 12。

## A. Feature Freeze verification

通过。未新增 V1 业务能力；业务页面只做了长文本、表格和筛选区的响应式溢出修复。其余改动限定在生产配置、运行安全、灾备、验证和文档。

## B. Baseline validation

通过。依赖冻结安装、格式、ESLint、TypeScript、Prisma schema、7 个既有 migration、全部既有测试和生产构建均成功。

## C. Dependency security audit

`pnpm audit --prod`：2 High、1 Moderate、0 Critical，来自 Prisma/工具链传递依赖 `deepmerge-ts`、`mysql2`；均未进入 Next standalone runner。Deep Scan 状态为 **NOT RUN**，准确原因是 **managed filesystem permission profile unavailable**。本报告中的逐模块人工审查、自动化安全回归、依赖审计和 Trivy 是独立替代证据，绝不表述为 Deep Scan 通过。

## D. Dependency changes（如有）

无依赖版本或 lockfile 变更；未用 override 强行升级不兼容的大版本。

## E. Environment hardening

新增生产环境 fail-closed 校验：PostgreSQL URL、至少 32 字节 auth secret、单一且精确匹配的 HTTPS trusted origin、local storage driver、绝对 POSIX storage path。容器入口在加载 Next 前校验，instrumentation 提供应用侧复核。

## F. Secret management

生产示例只保留占位符；migration 与 runtime DB 凭据分离；Compose 使用必填插值，不把正式 secret 写入镜像。运维文档要求宿主机受限 env 文件和高熵独立 secret。

## G. Secret scan

通过。Git 跟踪内容未发现私钥、常见云 token/API key 模式；无跟踪的真实 `.env`，无私钥文件；最终 runner 镜像环境中未持久化 password、secret、token 或 DATABASE_URL。

## H. Authentication hardening

复核通过。公开注册、email 登录、账号枚举、账号自助变更和 Better Auth 高权限管理端点保持关闭；用户名标准化、禁用用户/厂家拒绝、密码变更撤销其他 session、登录失败不枚举账号均有真实数据库回归。

## I. Session/cookie security

生产 Cookie 为 Secure、HttpOnly、SameSite=Lax、Path=/；session 8 小时、1 小时更新、无 cookie cache；密码重置/变更的 session 撤销已验证。

## J. CSRF/origin

生产只允许与 `BETTER_AUTH_URL` 完全相同的单一 HTTPS origin；图片、导入和密码等 mutation 校验 Origin；Server Actions 仅允许正式域名。跨站密码请求测试被拒绝。

## K. Security headers

已配置 CSP、DENY frame policy、nosniff、no-referrer 和受限 Permissions-Policy。生产 CSP 不含 `unsafe-eval`；HSTS 放在 TLS reverse proxy 层，避免应用在非 TLS 直连时误发。

## L. Authorization matrix

Admin、Factory、未登录三类矩阵通过页面与 API 回归。Factory 访问 Admin 页面为重定向/拒绝，Import、Export、Activity、Users 等管理接口返回拒绝。

## M. IDOR / tenant isolation

通过。tenant identity 继续从服务端 session 和数据库关系派生；篡改 ID、跨厂家产品和私图访问均返回不可见语义。生产 smoke 中 Factory A 读取 Factory B 私图为 404。

## N. Factory data leakage review

人工复核 Factory list/detail/quote/image read model，未暴露内部备注、其他厂家报价、历史或私图。长内容浏览器矩阵也覆盖 Factory 页面。

## O. Database constraints audit

在真实 PostgreSQL 查询并复核主键、外键、唯一约束、状态相关索引和 Restrict 删除关系；与 Prisma schema/migrations 一致。

## P. Database runtime privilege strategy

新增独立 non-superuser runtime role 初始化和 migration 后授权脚本。实测该角色不能 superuser、createdb、createrole、replication 或建 schema；普通业务 CRUD 可用。

## Q. PriceHistory append-only decision

runtime role 在数据库层撤销 UPDATE、DELETE、TRUNCATE；应用保持只追加。实测直接 UPDATE 被 PostgreSQL 拒绝。

## R. ActivityLog append-only decision

与 PriceHistory 相同，在数据库层撤销 UPDATE、DELETE、TRUNCATE；审计写入仍与业务事务原子提交。

## S. Migration replay

通过。7 个 migration 在全新 PostgreSQL 数据库从零回放成功；既有测试库显示无 pending migration。

## T. Migration failure strategy

migration 是一次性 operations profile job，失败即停止，不启动/切换 App；禁止 `migrate reset`、`db push` 或现场篡改 schema。失败后保留现场并从已验证备份和旧镜像判断回滚。

## U. Database backup

新增不可覆盖的 `pg_dump` custom-format backup set。真实数据演练覆盖 9 类核心记录，dump checksum 和 manifest 均通过。

## V. Uploads backup

上传目录与数据库同一维护窗口打包；演练备份 3 个真实图片对象，并生成逐文件 SHA-256。

## W. Backup manifest

manifest 记录 UTC、release revision、最新 migration、StoredObject 数、上传文件数和摘要；`COMPLETE` 最后写入，缺失时拒绝恢复。

## X. Restore drill

通过。恢复到新空数据库和新空 volume，拒绝错误数据库确认与非空目标。最终复跑还验证恢复脚本把 storage 所有权设为 runner 的 `1001:1001`。

## Y. Restore verification

通过。自动核对顶层 checksum、记录数、文件数、对象存在性和每个文件内容 checksum；9 类记录与 3 个文件一致。

## Z. Corruption detection

通过。故意追加字节破坏恢复图片后，验证器非零退出并准确报告 checksum mismatch。

## AA. Image storage security

继续使用 opaque storage key、root confinement、格式/魔数/decode/像素/10 MiB 限制、元数据剥离和 WebP 重编码；生产 volume 是唯一持久写路径。

## AB. Orphan reconciliation

新增只读 dry-run scanner，报告 DB_WITHOUT_FILE、DB_WITHOUT_REFERENCE、FILE_WITHOUT_DB；演练为 0/0/0。V1 不自动删除。

## AC. Disk-space strategy

定义 volume/主机 80% 告警、90% 阻止人工上传并扩容的运维契约；V1 不加入应用内 disk watermark，列为 accepted risk。

## AD. Import security

固定表头映射、UUID-only update、ACTIVE 字典精确匹配、有界 CSV/XLSX 解析、creator-owned staging、Admin-only confirm 和 Serializable 全回滚继续通过；5,000 行上限已实测。

## AE. Export formula-injection verification

CSV BOM 与公式前缀转义、XLSX 值处理、Admin-only 和 10,000 行上限回归通过。

## AF. Rate limiting

应用登录使用 PostgreSQL 持久化 5 次/60 秒；Nginx 模板补充单机 client-IP 登录、图片和导入限流。未引入 Redis，明确记录为单机 V1 边界。

## AG. Health endpoint

`/api/health` 保持依赖无关 liveness；容器 HEALTHCHECK 使用该端点。生产式 smoke 返回 200。

## AH. Readiness endpoint

新增 `/api/ready`，真实执行数据库 `SELECT 1` 并检查 storage 可写；成功 200，依赖失败只回 503/unavailable、不泄露细节。恢复权限错误曾准确触发 503，修复后为 200。

## AI. Docker production architecture

multi-stage build 增加独立 migrator；runner 只包含 standalone 应用与必要静态资源。App 仅发布到 `127.0.0.1`，PostgreSQL 无 host port；backend network 为 internal，App 另接 frontend network。

## AJ. Docker security

App 以 UID/GID 1001 non-root 运行，root filesystem read-only，`/tmp` tmpfs，drop ALL capabilities，no-new-privileges，init 和 30 秒 graceful stop。实测一致。

## AK. Docker persistence

真实 Compose `down`（无 `-v`）后重新 `up`，数据库测试记录与上传图片 checksum 均保留。文档明确生产禁止 `down -v`。

## AL. Docker resources/logging

App/Postgres 均设 2 CPU、2 GiB memory、512 MiB reservation、256 PIDs；json-file 日志 10 MiB × 5。图片并发峰值在该预算内。

## AM. Application logging

日志规范禁止密码、Cookie、Authorization、session、DATABASE_URL、图片 bytes 和表格内容；安全事件保留结构化最小元数据。

## AN. Error information leakage

错误转换器与生产 smoke 未向客户端暴露 stack、Prisma/SQL 或 filesystem path；readiness 故障只返回 unavailable。测试开发服务器的预期授权 stack 仅存在于测试日志，不是生产响应。

## AO. Bootstrap Admin drill

全新环境第一次 bootstrap 成功创建 1 个 Admin；第二次安全拒绝，Admin 总数仍为 1；未打印密码。

## AP. Fixture/test-data isolation

破坏性 fixture 继续硬性要求数据库名以 `_test` 结尾。生产 smoke 使用隔离恢复栈，不运行 fixture reset。

## AQ. Performance dataset

构造 5,000 Products、1,000 Assignments、500 Quotes、500 PriceHistory、5,002 ActivityLog，并使用接近 10 MiB、25MP 边界和 3 路并发图片样本。

## AR. Product performance

12 次样本：Admin Products p50 14 ms / p95 45 ms；Factory Products p50 12 ms / p95 50 ms。查询实现无逐行 N+1。

## AS. Quote performance

12 次样本：p50 12 ms / p95 43 ms；无逐行 N+1。

## AT. Activity performance

12 次样本：p50 10 ms / p95 49 ms；分页和过滤保持有界。

## AU. Import performance

5,000 行 CSV preview 867 ms、Serializable confirm 15,590 ms，创建 5,000 Product 与 5,000 ActivityLog；原子性测试通过。

## AV. Image performance

9,917,585-byte 图片规范化 717 ms；25MP 边界图 2,078 ms；3 路并发 327 ms；本轮 RSS 增量约 275 MiB，位于 2 GiB 容器预算内。

## AW. Final UI QA

Admin/Factory 核心路由在真实浏览器覆盖；修复 Products/Quotes 筛选布局、表格横向约束和 dashboard 长 SKU 溢出。超长 SKU/name 与 5,000 字符 notes 无页面级水平溢出。

## AX. 200% zoom

使用等效减半 CSS viewport 检查核心 Admin/Factory 页面，全部通过，无不可达控件或页面级水平溢出。

## AY. Browser matrix

Chromium desktop/mobile 与 WebKit desktop/mobile：8/8 Phase 11 核心矩阵通过；基础 E2E 同时覆盖四个 profile。

## AZ. Accessibility

既有 axe WCAG AA 基线、Admin/Factory 响应式页面和 reduced-motion 回归全部通过；未发现阻断性 axe violation。

## BA. Network/double-submit/error recovery

重复 assignment、quote stale version、import confirm 重复/错误、数据库失败回滚、图片写入补偿和 cleanup failure 保留已提交对象均通过。生产式容器重启和依赖失败探针已验证。

## BB. Production build smoke

基于恢复数据的 production Compose 通过：Admin/Factory 登录 200，角色错区 307，模板/两类 export 200，CSV preview 201/confirm 200，主图 200、跨租户私图 404，health/ready 200。

## BC. Docker/image dependency scan

Trivy 0.66 使用最新漏洞库扫描最终 runner：原始 4 Critical、52 High，均为 Debian base package 且没有 `FixedVersion`；可修复 Critical/High 为 0。之前发现的 4 个可修复 npm 工具链 High 已通过从 runner 删除 npm/npx 消除。Phase 12 必须重新拉取 base、重建、扫描并记录差异。

## BD. Docker context review

构建占位环境仅存在于单个 builder RUN，不持久化为 ENV；runner 不含源码开发工具、npm/npx 或正式 secret。`.dockerignore`/Git ignore 边界已复核。

## BE. Reverse proxy configuration

提供 Nginx 主配置与可信 proxy headers 片段，包含 upstream、12 MiB body、timeouts、真实 IP、限流、TLS/HSTS 和 WebSocket-safe headers。Phase 11 未在服务器安装或验证。

## BF. Domain configuration readiness

当时的应用契约使用一个部署专属 HTTPS origin，容器只回环发布；域名、DNS、证书和代理配置由部署者在当前 runbook 中确认。

## BG. Monitoring contract

监控项定义为容器状态、health、ready、Postgres、主机/volume 磁盘、错误率与资源水位；readiness 不得作为 liveness 以免依赖故障造成重启风暴。

## BH. Backup monitoring

要求监控最近成功时间、COMPLETE/checksum、异机复制与保留策略；每日和发布前后备份为建议，最终 RPO/retention 需业务在 Phase 12 确认。

## BI. Release strategy

备份并校验、启动 DB、运行 migration/权限 job、启动 App、内部 smoke、安装 proxy/TLS、外部 smoke、发布后备份；任一 gate 失败即停止。

## BJ. Rollback strategy

schema 兼容时 App-only 回到已记录 digest；数据库/数据问题停止写入并恢复到新的空目标，不覆盖原库、不假设 migration 可逆。

## BK. Production dangerous-command protections

文档明确禁止 `docker compose down -v`、`prisma migrate reset`、`prisma db push`、test/dev seed/reset 和一键清空脚本；恢复脚本还要求精确数据库确认与空目标。

## BL. Security risk register

已写入 `docs/RISK_REGISTER.md`。Deep Scan 为 **NOT RUN**，原因是 **managed filesystem permission profile unavailable**；人工审查与其他扫描单独记录，不替代、不伪装为 Deep Scan 结果。

## BM. Remaining accepted risks

包括：Deep Scan 未运行（**managed filesystem permission profile unavailable**）、2 High/1 Moderate 非 runner 传递依赖、56 个无可用修复的 Debian base findings、单机/本地 volume、无 MFA/恶意软件扫描/分布式 limiter、业务待确认 RPO/retention、未在正式服务器验证 proxy/TLS/监控。

## BN. Full regression result

`pnpm ci:check` 从 format、lint、typecheck、Prisma validate 开始，逐套运行真实 PostgreSQL/API/UI/Phase 11/browser/E2E，最后 production build；全部通过。

## BO. Total tests passed/skipped/failed

**103 passed / 15 skipped / 0 failed**。skip 均为测试矩阵中刻意由另一 viewport/profile 执行的用例；没有失败或重试后掩盖的失败。

## BP. Documentation

新增 Operations、Backup/Restore、Release/Rollback、Risk Register、本报告与 Nginx 模板；同步 README、SECURITY、TESTING、DEPLOYMENT、DEVELOPMENT_PLAN、AGENTS。

## BQ. Created/modified files

修改生产 env/ignore、Docker/Compose、Next/env instrumentation、ready API、Admin 响应式页面、package scripts、Phase 11 测试与既有 flaky UI 断言；新增 DB role、备份/恢复/验证/orphan 运维脚本、proxy 模板及上述文档。完整精确清单以本阶段单一 commit 为准。

## BR. Git commit

阶段要求的唯一 commit message：`chore: harden Product Hub for production`。最终 SHA 在提交完成后的交付信息中记录。

## BS. Branch/status

目标分支为 `main`；提交前仅包含 Phase 11 范围文件。最终要求提交后 working tree clean，不 push、不 tag。

## BT. GO / NO-GO recommendation for Phase 12

**Conditional GO for Phase 12 planning/execution only after explicit authorization and prerequisites。** Deep Scan 仍是 **NOT RUN**，原因是 **managed filesystem permission profile unavailable**；该事实作为 accepted risk，不得写成通过。当前没有已知可修复的 Critical/High runner finding，但正式部署前必须用当日基础镜像和漏洞库重扫。

## BU. Exact blockers if NO-GO

当前不判定 NO-GO。若 Phase 12 preflight 出现可修复 Critical/High、secret 泄漏、备份/恢复失败、migration/权限失败、ready 非 200、授权隔离失败、TLS/域名错误或磁盘/监控/异机备份未就绪，则立即变为 NO-GO。

## BV. Exact Phase 12 deployment prerequisites if GO

当时的后续清单要求单独授权服务器访问与部署、确认资源无冲突、提供受限 secrets、确认部署者域名/DNS/TLS/可信代理链、批准维护窗口和备份策略，并重新验证 release artifact。它不是当前安装步骤。
