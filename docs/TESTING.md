# 测试策略

## Hard Delete test contract

必须使用全新 disposable PostgreSQL 与临时 uploads，验证九类 UI、阻断、stale、强确认、重复提交、retry/shared file/final completion/navigation/旧 URL、Admin-only/IDOR，390px 和 dialog accessibility；同时完整 CI、迁移重放/权限回归、三个实际 amd64 artifact 与 Trivy/secret/dependency/Codex Security。

## Production release gates

Release 回归包括：production env fail-closed、health/ready/security headers、5000-row preview/Serializable confirm、接近 10 MiB 图片、2500 万像素边界、3 路图片并发、全新 migration replay、runtime DB privilege denial、生产 Compose smoke/persistence、备份—空库恢复、checksum corruption detection、orphan dry-run 和 Trivy runner scan。

Release architecture regression 必须验证唯一正式 build package script、三个 target 的 `docker buildx build --platform linux/amd64 --load`、Production Compose 的 App/Migration platform guard，以及最终 image inspect gate 对 missing/unknown/arm64/aarch64 fail closed。静态检查 tag、Dockerfile 或命令字符串不能替代正式 artifact 构建后的实际 inspect。

完整门禁必须 0 failed；skip 只能是明确的重复浏览器/视口设计项。最终报告分别记录 passed/skipped/failed，不把未运行项写成通过。Deep Scan 单独记为 NOT RUN。

备份恢复、Compose persistence、bootstrap 和镜像扫描属于外部 harness，不由 Playwright passed 数量代替。详细步骤见 `BACKUP_RESTORE.md` 与 `RELEASE_RUNBOOK.md`。

Phase 3 安装验证：`pnpm test:production-bootstrap` 检查阶段停止和安全错误/输入边界；`pnpm test:production-install` 构建本地 amd64 release，在带随机后缀的独立 Docker project/config volume 运行真实 Linux host controller，再执行 fresh install、重复 install/数据保留、独立 Admin、只读 doctor、Admin/Factory/Quote/Hard Delete smoke、权限故障注入与 backup/checksum。其 HTTPS 入口仅为本地测试 proxy，不修改 host Caddy；浏览器使用完整 Chromium 的 headless 模式，将示例域名映射到 localhost，不使用不支持本机该映射的 headless shell。测试不连接真实 Production；finally 仅删除匹配本次精确 project/label 的 disposable containers/networks/volumes，保留其他开发资产。不要将这个 root + Docker socket 的测试 controller 部署为 Production service。

测试 controller 的软件副本位于本次 config volume 的独立 checkout 子目录，使 Compose 中的只读脚本 bind mount 源路径对 Docker daemon 真实可见；不会假定 daemon 能访问 controller image 内的 `/app`。依赖链接仅在 controller 内使用，正式容器仍复用正式 release image。

Installer fixture 子进程仅继承必要 host/Docker 工具配置，不继承外层 CI 的数据库/认证环境变量；否则 Compose shell environment 的优先级会覆盖 fixture 的 `--env-file`，破坏配置隔离。正式 installer 的子进程同样使用最小环境。

## 1. 原则

测试金字塔以快速业务单元测试为底，数据库/授权集成测试为核心，Playwright 验证少量完整关键旅程。权限隔离、历史不可丢失、导入一致性和文件隐私属于发布阻断项。

测试不得连接生产数据库、生产 volume 或真实备份。每个 suite 使用独立数据库 schema/数据库和临时上传目录，fixture 名称明确含 `test`。

## 2. 层级

### 静态检查

- ESLint/Biome（Phase 01 决策其一）、TypeScript strict、format、`prisma validate`。
- migration SQL review：外键、partial unique、check constraint、不可逆操作。
- `docker compose config`、Dockerfile lint/scan、secret scan。

### 单元测试

- 金额格式与分/元转换，无浮点误差。
- CBM 精度、空尺寸、边界、舍入展示。
- Quote 状态与按钮文案。
- Zod schemas、CSV injection escaping、文件名清理。
- authorization policy 纯函数与 Activity diff 脱敏。
- Storage contract 的 shared test suite，Local 与未来 S3 adapter 共用。

### 数据库/集成测试

- SKU 多 null、非空唯一、修改不破坏关系。
- 一产品多厂家、活动 assignment 唯一、一厂多用户。
- Factory scoped repositories 不返回其他厂家记录。
- Quote 更新 + PriceHistory + ActivityLog 原子性；中途异常全部 rollback。
- 相同价格不新增历史，价格变化新增且旧记录不改变。
- 乐观锁冲突不覆盖数据。
- 禁用账号/厂家、撤销分配后访问失败。
- 私图授权、主图提升复制语义、orphan cleanup。
- 导入 preview/confirm、幂等、逐行错误和 all-or-nothing。

### Playwright E2E

项目至少包括 Desktop Chromium、Desktop WebKit、Mobile Chrome、Mobile Safari；关键 smoke 可加 Firefox。使用 setup project 创建 Admin、Factory A、Factory B 和隔离数据。

关键旅程：

1. Admin 登录 → 创建厂家/账号/产品 → 分配产品。
2. Factory A 登录 → 只见自己的产品 → 填写并提交 → 更新价格。
3. Admin 查看当前报价、Price History 与 Activity Log。
4. Factory A 手改 B 的 product/quote/image/action payload → 全部拒绝且 B 数据不变。
5. Admin 禁用 Factory A 用户 → 旧 session 失效。
6. 图片上传、预览、私有下载、Admin 提升为主图。
7. 导入错误 preview → 修正/确认 → 导出全部/筛选结果。
8. 手机导航、产品卡、全屏报价表单、键盘和触控操作。

## 3. 授权测试矩阵

每个 resource/action 至少测试：未登录、Admin、Owner Factory、Other Factory、Disabled User、Revoked Assignment、缺失对象、畸形 ID。列表、详情、mutation、文件、export 必须分别覆盖，不能用一个页面测试代替。

## 4. UI 与可访问性

- axe 自动扫描关键页，人工验证键盘顺序、焦点 trap/restore、错误播报、label、对比度、200% zoom。
- 视觉回归覆盖 login、产品表格/画廊、报价编辑、空/加载/错误、移动卡片/Sheet。
- 视口：375×812、390×844、768×1024、1440×900。
- 不把 snapshot 当主要业务断言；断言用户可见结果和数据库副作用。

## 5. 导入与属性测试

- 基于模板做 golden files：正常、空 SKU、重复 SKU、非法数字、超长文本、公式、隐藏 worksheet、坏 zip、极大行数。
- 解析结果包含稳定的 sheet/row/field/error code。
- Preview 统计必须等于 confirm 实际结果；源 hash 或 parser version 改变则拒绝旧确认。
- 对金额/尺寸/重量使用 property-based 边界测试，包含极值、精度和本地化字符串。

## 6. 生产相似验证

- CI 在 PostgreSQL 容器运行真实 migration，不用 SQLite 替代。
- 构建 `output: standalone` 镜像并做 health/readiness、非 root、volume 权限 smoke test。
- 恢复测试在隔离 compose project 中执行：空库 restore、上传文件 restore、校验行数/checksum、登录与跨租户测试。

## 7. 合并与发布门禁

PR/提交前：format/lint、typecheck、unit、integration、migration validate、关键 Chromium E2E、build。

发布前：完整浏览器矩阵、移动、accessibility、backup preflight、restore 演练状态、镜像/依赖扫描。任何跨厂家数据泄露、历史丢失、无法回滚的 migration 或备份不可恢复均阻断发布。

## 8. 测试数据纪律

- Factory A/B 命名明确，不复用同一 ID 或账号。
- 每个测试独立创建数据或可靠 reset；并行 worker 不共享可变状态。
- 不把真实厂家名称、价格、图片或生产 dump 放入 fixture/CI artifact。
- Playwright trace、截图和日志视为可能敏感，设短保留并在失败产物中脱敏。
- Release verification 失败时，在销毁随机 CI 凭据之前生成安全诊断包，再上传 7 天保留的 artifact。禁止直接上传原始 `test-results`：trace 只保留动作/时间/位置、脱敏 DOM 与无 headers/body 的请求状态；移除原始截图、源码、请求/响应正文、Cookie、认证参数和控制台正文。浏览器失败截图由测试 fixture 遮挡表单与已知凭据后单独采集。脱敏失败必须阻断上传，不得阻断 always cleanup。

## 9. Phase 01 基线

当前 Playwright 仅包含 `/api/health` request smoke，并在 desktop Chromium、mobile Chrome、mobile WebKit 三个项目中发现/执行。它验证 HTTP 200、稳定 JSON `{ "status": "ok" }` 和 `Cache-Control: no-store`；不创建浏览器业务 fixture，也不连接数据库。业务 E2E 和真实多浏览器页面测试从相应 Phase 开始补充。

## 10. Phase 02 认证测试门禁

- Admin Operations 的 UI 登录先监听真实 `/api/auth/sign-in/username` POST 完成并断言 HTTP 200，再执行原有 5 秒角色 URL 断言；不能把异步认证请求（包括开发服务器首次编译）与后续导航混为一个 URL deadline。不得增加 timeout、retry 或固定 sleep 掩盖认证失败。
- Admin 自助改密回归必须实测：当前密码验证、当前浏览器收到轮换后的有效 session 且刷新仍留在受保护页面、旧 session IDs 全部失效、另一客户端 get-session 返回 null、旧密码拒绝及新密码可登录。限流状态只可在已经通过 `_test` 数据库保护的 fixture 中于场景开始前隔离，不在场景请求之间重置；生产限流和专门的 429 回归保持不变。
- Admin 重置 Factory User 密码的成功边界是服务已等待官方密码写入与全部目标 session 撤销、Action 返回 `ok: true`。Users UI 测试须在点击前监听该 Server Action POST，确认 HTTP 200 并等待仅在业务成功后关闭的重置弹窗，再立即用新密码登录；HTTP 200 本身不能代替业务成功。回归同时断言新登录的 cookie/数据库 session 有效、旧密码 HTTP 401，以及在账号重新启用后新建且已证明有效的旧 session 全部失效（不能复用停用时已撤销的 session 充当 reset 证据）。服务层回归在 reset promise 完成后立即登录，不插入 sleep、重试或限流重置。Users 场景用 `_test` 保护的 helper 在场景开始前隔离限流，并在全部断言结束后清理自己的配额，避免影响共享服务器上的后续场景；场景请求之间不得清理。

- 使用 Product Hub 专用 PostgreSQL 18 test database、真实 Prisma migration、真实 Better Auth hash/session/cookie，不以 mock 代替认证。
- 测试 fixture 仅在 test database 创建 Admin、Factory A/B 与各自 User；不进入 production seed。
- Playwright 验证未登录路由拒绝、Admin/Factory 正负角色矩阵、统一错误文案、logout、旧 session 撤销、PostgreSQL 登录限流、Origin 拒绝与基础移动端登录可用性。
- integration/policy 验证 User disabled、Factory disabled、Admin reset、Factory self password change、公开枚举路径关闭，以及 Factory A 不能用 `factoryId=FactoryB` 改变 session tenant。
- 测试命令在执行 destructive reset 前必须验证 database 名称以 `_test` 结尾。

## 11. Phase 03 UI 测试门禁

- `tests/e2e/design-system.spec.ts` 在开发路由验证 Design System Showcase；fixture 不写数据库。
- Chromium 精确循环检查 375×812、390×844、768×1024、1024×768、1280×800、1440×900，断言无 document horizontal overflow，并验证 768px 的 Table → Product Card 切换。
- Desktop Chromium、Desktop WebKit、Mobile Chrome、Mobile WebKit 均执行 Dialog、Sheet、Tabs、Toast 交互与键盘 Esc 关闭。
- `axe-core` 以 WCAG 2 A/AA 与 WCAG 2.2 AA tags 扫描 `/login` 和 `/design-system`；任何 violation 阻断。
- reduced-motion 测试强制 `prefers-reduced-motion: reduce` 并验证非必要 transition 接近 0。
- Phase 02 的 12 项真实 PostgreSQL auth suite 必须继续通过，确保登录错误、角色跳转、logout、禁用 session、tenant tampering、Admin reset 与 Factory self password change 未被视觉改造破坏。
- 人工目视检查桌面 1440×900、移动 390×844 的 Showcase，以及移动 Login；重点检查信息层级、中文断行、表单密度和卡片重排。

## 12. Phase 04 Master Data 测试门禁

- `pnpm test:master-data` 只连接数据库名以 `_test` 结尾的 Product Hub PostgreSQL，先执行正式 migration，再通过真实 session 调用 application service。
- Product 覆盖多 NULL SKU、trim/case canonical 唯一、并发重复 SKU、修改 SKU、停用、无效/停用 Category/Material、分页搜索筛选排序与 Factory 拒绝。
- Category/Material 覆盖创建、canonical 重名、改名、被引用时停用仍保留关系，以及数据库 RESTRICT 阻止物理删除。
- Factory 覆盖创建、更新、停用，并验证停用与 session 撤销的认证行为；测试 fixture 与 migration/production seed 分离。
- `pnpm test:auth` 的 12 项真实 PostgreSQL Phase 02 套件和 Phase 03 Playwright UI/axe/reduced-motion 套件继续作为回归门禁。

## 13. Phase 05 Assignment 测试门禁

- `pnpm test:assignments` 在 `_test` PostgreSQL 上执行正式 migration，并用真实 Admin、Factory A/B session 调用 service。
- Admin 覆盖首次 assign、ACTIVE 幂等 assign、并发 duplicate assign、revoke、double revoke、显式 reactivate、通过 assign 重新激活、禁用 Product/Factory 拒绝与双向分页/search read models。
- Factory 覆盖自身 list/detail、Product notes 不泄露、Factory A 无法读取 Product B、伪造 query/body factoryId 无法切换租户，以及 assign/revoke/reactivate 全部拒绝。
- REVOKED、Product DISABLED、Factory DISABLED、User disabled 必须立即拒绝读取；Factory 恢复后原 ACTIVE Assignment 在重新登录后重新生效。
- 数据库测试验证 Product/Factory `ON DELETE RESTRICT` 与 `(productId, factoryId)` unique；Phase 02 Auth、Phase 03 UI、Phase 04 Master Data 全部继续回归。

## 14. Phase 06 Quote 与 Price History 测试门禁

- `pnpm test:quotes` 在 `_test` PostgreSQL 上部署正式 migration，并通过真实 Admin、Factory A/B/C session 调用 application service。
- 首次提交覆盖价格必填、人民币分规范化、首条历史；可选字段覆盖 NULL/正值/整数/三位 Decimal 边界、毛重关系、5000 字备注限制和 HTML 仅作为普通字符串。
- 更新覆盖价格变化追加历史、同价修改包装不追加、version 递增，以及两个相同 expectedVersion 并发提交只有一个成功。
- 三厂家对同一 Product 分别报价并由 Admin 看到三份；Factory A 通过 quote/assignment/product/factory 参数均不能读取或修改 B/C。
- 生命周期覆盖 REVOKED、Product DISABLED、Factory DISABLED、重新激活/启用与重新登录；验证 Quote/History 保留且继续使用原 Quote 追加历史。
- 数据库测试验证 Quote/Assignment/User actor 的 RESTRICT、正值/重量/version check 与 assignment unique。Phase 02 Auth、Phase 03 UI、Phase 04 Master Data、Phase 05 Assignment 继续作为回归门禁。

## 15. Phase 07 Business ActivityLog 测试门禁

- `pnpm test:activity` 在 `_test` PostgreSQL 部署正式 migration，用真实 Admin、Factory A/B session 调用现有业务 service 与 Admin read service。
- Product/Category/Material/Factory 覆盖 create、真实 field diff、语义 enable/disable 事件和 no-op 不写日志；actor ID、role、username snapshot 正确。
- Assignment 覆盖 assign、duplicate assign、revoke、duplicate revoke、reactivate，只有真实状态转换产生事件；product/factory metadata 与 tenant factoryId 正确。
- Quote 覆盖 Quote + PriceHistory + ActivityLog 首次原子提交、价格更新、仅重量/长备注更新、no-op 不增 version/event，以及 PriceHistory 与业务审计数量保持独立。
- 测试库临时 BEFORE INSERT trigger 强制 ActivityLog 失败，证明 Quote/PriceHistory 全部回滚；生产代码不留 debug flag。
- allowlist 负向测试尝试注入 password、session token、auth secret、hidden email，writer 必须拒绝且数据库不留记录。跨 Factory mutation 失败且不污染审计。
- User lifecycle 覆盖 Admin 创建、停用、启用 Factory User 的 `USER_CREATED/USER_DISABLED/USER_ENABLED`，校验真实 actor、目标 User、factoryId、timestamp 与明确状态 before/after；Factory caller、非法目标和重复目标状态不得写事件，payload 不得出现 password、hash、session/token、credential、hidden email、`AUTH_SECRET` 或 `DATABASE_URL`。
- Admin read 覆盖 pagination、newest-first、event/entity/actor/factory/date filters；Factory read 拒绝。Phase 02–06 全部继续回归。

## 16. Phase 08 Secure Image Storage 测试门禁

- `pnpm test:images` 在 `_test` PostgreSQL 部署正式 migration，并把 `LOCAL_STORAGE_ROOT` 强制设置为项目内忽略提交的隔离 test uploads 目录；reset 同时验证数据库名和精确 storage root，绝不接触生产 volume。
- validation 覆盖有效 JPEG/PNG/WebP、伪造/损坏图片、SVG/GIF/不支持 MIME、超过 10 MB、超过 8000 px、超过 2500 万像素、正常 1600 万像素，以及带 EXIF 的输入经 WebP normalization 后不保留 EXIF/ICC。
- Local provider contract 覆盖原子 put/read/stat/delete/copy 所需路径规则，并拒绝 `../../`、绝对路径和用户控制文件名作为 key。
- 主图覆盖 Admin upload/replace/remove、Assigned/Unassigned Factory read、DISABLED Product、DISABLED/恢复 Factory、Admin read、HTTP `image/webp`/private cache/nosniff/ETag 与 DTO 不泄露 storage key。
- 私图覆盖 Factory A upload/read/replace/remove，Factory B 即使持有 image/assignment/product/object 候选也不能读写删除；REVOKED/REACTIVATED 与 Product enabled/disabled 生命周期保留对象并即时改变授权，Admin 保持读取。
- Promotion 断言新主图使用独立 StoredObject/storage key；Factory 后续替换和删除私图不影响主图。产品不匹配的 promotion 安全失败。
- 测试库临时 ActivityLog trigger 强制 DB transaction 失败，断言新 file 被补偿删除且旧图不变；注入只在 test 中拒绝旧 file cleanup，断言新关系已提交、旧对象/文件保留为可检测 cleanup candidate，生产代码无 debug flag。
- Phase 02–07 套件、production build、migration replay 与 Docker read-only/non-root/writable-volume smoke 继续作为回归门禁。

## 17. Phase 09 Product Import & Data Export 测试门禁

- `pnpm test:import-export` 在 `_test` PostgreSQL 部署正式 migration，并通过真实 Admin/Factory session 同时测试 application service 与 Route Handler。
- CSV 覆盖 UTF-8 BOM 与 105 行 CREATE；XLSX 覆盖 CREATE、immutable-ID UPDATE、NO_CHANGE。Preview 必须只创建 job/rows，不修改 Product/ActivityLog；Confirm 后 Product 数与逐 Product ActivityLog 对齐，重复 confirm 冲突。
- row validation 覆盖文件内重复 SKU/product_id、已存在 CREATE SKU、missing/disabled Category/Material、非法 status/UUID/required/length；任一 ERROR 阻止整个 job confirm。
- safety 覆盖公式 cell、多/隐藏 worksheet、坏 magic/archive、宏/外链/嵌入 entry、10 MB、5001 行、30 列、错误表头与 UTF-8。Factory 对 preview/job/rows/confirm/template/Product export/Quote export 全拒绝。
- consistency 覆盖 Preview 后 Product 被正式 API 修改产生 stale conflict，并断言同 job 的 CREATE 也完全回滚；并发 SKU/审计/字典失败同样必须依靠单事务回滚。
- Export 覆盖 Product filters/main-image 与三厂家 Quote factory/search/status/date filters、10000 行上限、BigInt RMB 两位、Decimal CBM 四位、CSV BOM/quote escaping/formula prefix，以及 XLSX frozen header、width/format/string cell 不生成公式。

## 18. Phase 10A Admin Operational UI 测试门禁

- 多页面读场景、报价详情，以及图片/分配、厂家、字典写场景分别执行；不得把这些独立流程的导航、开发模式编译和提交累加到单个 30 秒预算。保持每个场景默认 30 秒、原有精确断言、单 worker 和零 retry；新增导航/提交完成断言不得替代业务结果断言。失败证据包含动作耗时、脱敏请求状态、当前 URL、DOM 与遮挡截图。
- Admin UI 每个独立场景开始前，仅通过 `_test` 数据库保护的 fixture 清理限流计数，避免多个成功登录场景共用额度；不在场景请求之间重置，也不修改 Auth 专项 429 测试。登录等待匹配真实 POST 响应并显式断言 200，非 200 必须立即失败，不能用只匹配 200 的监听器把限流等错误隐藏成总超时。
- `pnpm test:admin-ui` 使用 `_test` PostgreSQL 与隔离 test storage，fixture 含 12 个 Product、3 Category、4 Material、3 Factory、同产品 ¥328/¥315/¥345 三份报价、待报价、缺失字段、停用项、长中文和横/竖/透明/无图状态。
- Desktop Chromium 覆盖登录、真实 Dashboard、Product 搜索与详情比较、Factory/Quote 导航，以及 Product 创建和编辑；Factory session 直达 Admin 路由必须返回 Factory workspace。
- Mobile Chromium 覆盖 Admin 关键路由无 document horizontal overflow，以及 Product 列表 WCAG 2.2 AA axe 扫描。Phase 03 的 Chromium/WebKit 桌面/移动 UI 基线继续回归。
- `ci:check` 在 Phase 02–09 全套回归之外新增 Admin UI suite，并继续执行 format、lint、typecheck、Prisma validate、build。

## 19. Phase 10B Factory Portal Operational UI 测试门禁

- `pnpm test:factory-ui` 使用 `_test` PostgreSQL 与隔离 test storage，fixture 包含 12 个本厂产品、三类/三材质、待报价/已报价、同产品三厂家报价、主图、厂家私图、长中文和多条价格历史。
- Desktop Chromium 覆盖真实 Dashboard、URL 搜索/筛选/分页、产品详情/主图、首次报价、完整字段更新、包装单独更新不追加价格历史、无修改禁用与 expectedVersion 冲突。
- 图片用例覆盖上传替换、再次替换、确认移除、跨租户 Product 直达不可用与已知私图 ID 404。生命周期用例覆盖 Assignment 撤销/恢复、Product 禁用/恢复和 Factory 禁用即时失效。
- 账户用例覆盖资料、当前密码验证后的改密、退出与新密码重新登录。375/390/768/1024/1440 viewport matrix 检查无横向溢出、触控尺寸、数字键盘提示，并运行 axe WCAG 2.2 AA 扫描。
- `ci:check` 在 Phase 02–10A 全套门禁之外新增 Factory UI suite；重复 fixture 登录清理测试库 rate-limit 行，正式 rate-limit 行为继续由 auth suite 独立验证。

## 20. Phase 10C Admin Operations 测试门禁

- `pnpm test:admin-operations` 使用 `_test` PostgreSQL、真实 Better Auth session 与 Chromium desktop/mobile projects。
- Import UI 覆盖 CSV/XLSX 模板下载、有效 CSV preview/confirm、产品出现、错误行阻断和预览后并发修改冲突；Phase 09 suite 继续覆盖 hostile files、事务与大批量边界。
- Import 上传测试先监听并验证 preview POST 201 与同一 job 的 rows GET 200、行 action，再断言原有预览提示或校验错误；不以默认 DOM 断言窗口替代完整异步预览链路。保留原超时、零重试、确认及 UUID 更新/并发冲突断言。Admin Operations 复用安全请求/服务端时序与失败 trace 诊断，不记录凭据或原始请求正文。
- Export UI 覆盖 Product/Quote CSV+XLSX 下载、当前 search/status/factory filter 与可导出数量；文件内容与 formula/Decimal 安全由 Phase 09 suite 回归。
- Activity UI 覆盖 list/filter、集中中文映射、金额/重量可读 diff 与不含 metadata 的安全详情。Users 覆盖 create、重复用户名、disable/enable、reset、旧 session 失效和新密码登录。
- Factory negative 覆盖 Import/Activity/Users/Settings 页面和 template/preview/Product Export/Quote Export endpoints；响应式矩阵与 axe 覆盖 Import、Activity、Users。
- `ci:check` 保留 Phase 02–10B 所有 suite，并新增 Phase 10C suite、format/lint/typecheck/Prisma validate/build；V1 Feature Freeze 后不得以删除回归换取速度。

## 21. Hard Delete Phase 1 测试门禁

- 空库 replay 全部 forward-only migrations，Prisma validate/generate、format、lint、typecheck 与 production build 全部通过。
- disposable `_test` PostgreSQL 验证 app role 仍不能 UPDATE/DELETE/TRUNCATE ActivityLog/PriceHistory，不能 DELETE User，不能执行 privileged function，也不能删除 operation/file task。
- worker 必须无 table grants、无 membership、无 cluster privilege，只可执行固定 User function；验证 SECURITY DEFINER、migration owner、`search_path=pg_catalog` 与 PUBLIC revoke。
- PREVIEWED、非 USER target、Admin、enabled Factory User 全部拒绝；confirmed disabled Factory User 的 User/Account/Session、lifecycle audit、共享历史 SET NULL/匿名状态与 operation 完成必须在测试事务内验证并 ROLLBACK。
- Import confirm 必须覆盖 CREATE/UPDATE/NO_CHANGE resolvedProductId；旧行 NULL 不做 SKU/name 推断。
- security diff scan 必须覆盖 migration、provisioning、runtime grant、service 与 tests；Phase 1 不运行生产 smoke 或真实删除。

## 22. Hard Delete Phase 2 测试门禁

- planner matrix 覆盖 User、Product、Factory、Category、Material、Assignment、Quote、Main Image、Private Image，以及 blocker、shared StoredObject 与 stable ImportRow。
- Admin-only backend 覆盖 Factory deny、tampered extra fields、double confirm、expired/stale preview 与 active-operation conflict。
- durable worker 覆盖 concurrent claim、lease takeover、database rollback、DB commit 后 crash、单文件/全部文件删除后 crash、retry 与 repeated execution。
- 所有物理删除测试只使用 disposable PostgreSQL 与临时 filesystem，并验证数据库名和 uploads 路径不是 production。
- isolated privilege regression 验证 App/Worker/PUBLIC、function owner/search_path/参数、ActivityLog/PriceHistory protections 与 worker 无直接 table grants。
- completion 必须证明数据库 closure 为空、files absent、preserved objects/ImportJob counters 未变且没有新增 unknown orphan。

## 23. Immutable distribution 测试门禁

- Release candidate 必须将 verification parser/verifier 与 installer-control 一起打入 Migrator，namespace、OCI source labels、shell wrapper 与签名 repository 均使用 `cobrander-dev`。Setup/CLI shell tests 覆盖 canonical verification manifest；same-version update 仍须拒绝重复安装，不为无顺序的 verification SHA 猜测升级顺序。
- `tests/distribution/source-map-security.test.ts` 通过 Next/PostCSS/Tailwind 的真实解析路径验证 `source-map-js` 修补版本，拒绝超大/非法/累计 offset，保留正常 basic/indexed map 和 PostCSS 使用。
- 完成 `pnpm build` 后可运行 `node node_modules/tsx/dist/cli.mjs tests/distribution/domain-runtime-smoke.ts`：两个 runtime domain 复用同一 standalone build，使用不可连接的 test-only DB 地址，不访问数据库，验证正常登录页/未登录跳转及 Host/Origin 拒绝。这不替代 Docker A/B 同镜像完整安装、已认证流程和 clean VPS 验证；Docker 可用时仍执行 `pnpm test:domain-neutral-release`。
- `pnpm test:distribution` 验证固定字段/顺序、SemVer/verification 版本、独立 source/distribution SHA、四项 digest、amd64、checksum、错误 repository 与 latest 拒绝；覆盖模式混用、短/错 SHA、image revision 使用 source SHA。
- Workflow 必须验证两棵 checkout，build context 仅为 source tree；真实命令替身验证任一 image scan 失败后零 push、OCI layout digest 变化拒绝、扫描后 archive 变化拒绝、三个 Gate 全过才推送且无重建；promotion 拒绝失败 run、错误 tooling SHA 和未验证签名，release 模式仅晋升已验证 digest。命令替身测试不是实际 registry 发布证据。
- 静态 workflow regression 必须确认只有 `workflow_dispatch`、所有 Action 固定完整 SHA、三个 target 都生成 provenance/SBOM 并执行 vulnerability/secret scan，PostgreSQL 只使用固定 digest。
- Clean-runner fixture 测试验证随机 test-only credential、`_test` 数据库、已有 env 拒绝、run identity cleanup、argv/log 无密码及 workflow 浏览器/Prisma/本地 Domain A/B 镜像前置顺序。
- 发布 workflow 的真实受控运行仍须按最终 registry digest pull，验证 RepoDigest、OS/Architecture、OCI revision/version，再保存 manifest；Stage 2 implementation 不运行该发布。

## 24. Guided installer and operations CLI 测试门禁

- `pnpm test:installer-stage2` 覆盖 CSPRNG secret 独立性、Admin password 不进 env、forward-only target、PostgreSQL digest drift stop、backup exact checksums/COMPLETE、`update --check` mutation-before-return 静态回归。
- Shell harness 必须证明 existing install 在 pull/run 前停止，并验证 control container `--rm`、read-only、tmpfs、cap drop、no-new-privileges、network none、非 privileged 与 Docker socket 仅在 operator wrapper。
- 本地 full-install harness 固定 PostgreSQL amd64 digest，不 retag 开发机 PostgreSQL；install/doctor controller 使用 network none，验证 App 内 health probe 和一次性只读数据库检查。它仍不是原生 amd64 clean VPS 的最终证据。
- TTY/token regression 必须证明 hidden input + `--password-stdin`，禁止 token/password argv/env、`set -x`、持久 Docker config。App/Worker/Migration Compose 必须持续没有 Docker socket。
- 真实 clean-host Gate 仍必须在 Ubuntu 24.04 amd64、受控 GHCR digest 上完成 fresh install、Admin/login、tenant/business/image/Hard Delete、backup/restore、same-version/idempotency、credential isolation、localhost port、secret/log scan；本地 shell simulation 不能替代该 Gate。
