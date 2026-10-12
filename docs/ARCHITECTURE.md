# 系统架构

## Hard Delete workflow contract

报价工作台原 URL 使用 Assignment ID，分配保留时它仍是合法工作台。新增稳定 Quote record URL `/admin/quotes/records/[quoteId]`，由 Admin service 先验证 Quote 存在，最终展示时再次绑定同一 Quote ID；并发删除/重建不能把新报价显示在旧记录 URL。该记录永久删除后旧 record URL 为安全 NOT_FOUND，不影响保留 Assignment 的待报价工作台。

Admin 预览→精确确认→独立 operation route→durable worker→DB/file/final verification→完成导航。已确认 target 返回既有任务；PREVIEWED 可显式刷新同一 ID。服务 DTO 仅安全计数和阶段，不暴露持久化内部预览。Worker production overlay/secret 与 Web/Migrator 隔离。

## 1. 架构结论

采用模块化单体（modular monolith），而不是微服务：一个 Next.js 应用、一个独立 PostgreSQL、一个 Storage abstraction、一个后台任务边界。以当前 100+ 产品和单服务器资源，微服务会增加部署、事务和权限复杂度，不能带来实际收益。

```text
Browser
  -> HTTPS reverse proxy (TLS, body/rate limits)
    -> Next.js web container
       -> Auth / authorization / application services
       -> Prisma 7 adapter
          -> dedicated PostgreSQL container + volume
       -> Storage interface
          -> Local volume (V1)
          -> S3-compatible adapter (future)
       -> bounded background jobs/import processing
```

## 2. 分层

### Presentation

- `src/app`：路由、layout、loading/error/not-found、Server Components。
- `src/components`：共享 UI；业务组合组件按 feature 放置。
- 页面不直接编排复杂事务或拼装权限过滤。

### Application

- `src/features/<feature>/application`：用例，例如 assignProducts、submitQuote、promoteFactoryPrivateImage、confirmImport。
- 每个用例负责输入校验、授权、事务边界、审计与返回 DTO。
- 客户端传入 ID 只是查找候选，不构成归属证明。

### Domain

- `src/features/<feature>/domain`：业务规则、值对象、状态变化和计算。
- 金额、尺寸、重量、状态转换在此集中定义，避免 UI/Action/Import 各自实现。

### Infrastructure

- `src/lib/db`：Prisma Client、事务工具。
- `src/lib/auth`：Better Auth 配置、会话与 actor 映射。
- `src/lib/storage`：Local/S3 adapters。
- `src/lib/audit`：Activity Log 构造与字段脱敏。
- `src/lib/import-export`：CSV/XLSX 解析与生成。

## 3. 建议代码结构

```text
.
├── docs/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── public/                         # 仅代码随附公开静态资源，禁止用户上传
├── src/
│   ├── app/
│   │   ├── (auth)/login/
│   │   ├── (admin)/admin/...
│   │   ├── (factory)/factory/...
│   │   ├── api/auth/[...all]/route.ts
│   │   ├── api/files/[id]/route.ts
│   │   ├── api/imports/[id]/.../
│   │   └── api/health/route.ts
│   ├── components/
│   │   ├── ui/
│   │   └── shared/
│   ├── features/
│   │   ├── products/
│   │   ├── factories/
│   │   ├── assignments/
│   │   ├── quotes/
│   │   ├── activity/
│   │   ├── users/
│   │   └── imports/
│   ├── lib/
│   │   ├── auth/
│   │   ├── db/
│   │   ├── storage/
│   │   ├── audit/
│   │   └── validation/
│   └── generated/prisma/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
├── compose.yaml
├── compose.production.yaml
├── Dockerfile
└── AGENTS.md
```

## 4. 页面与数据加载

- Layout 获取最小 session/actor 信息并渲染对应导航。
- 列表页在 Server Component 中解析 `searchParams`，经 Zod 归一化后调用 query service。
- 搜索、筛选、分页写入 URL，便于刷新、返回和分享；Factory 请求忽略/拒绝任意客户端 factory filter。
- 交互密集的小组件使用 Client Component；数据主体保持服务端渲染。
- `loading.tsx` 使用与最终布局同构的 skeleton；`error.tsx` 提供安全错误文案和 retry；`not-found.tsx` 不泄露对象是否属于其他厂家。

## 5. API 与 Server Action 边界

### Server Actions

适合第一方 UI 发起的写操作：

- Admin 创建/更新产品、厂家、用户、分配。
- Factory 提交/更新报价。
- 用户修改自己的密码。
- Admin 确认导入和设置主图。

每个 Action 只负责解析 FormData/JSON、调用 application service、映射可展示错误、revalidate/redirect。授权和事务留在 service 中，保证将来 Route Handler 或任务复用时不会绕过。

### Route Handlers

- `/api/auth/[...all]`：Better Auth handler。
- `/api/files/[id]`：受控下载/图片响应；服务端授权后流式读取。
- `/api/imports/*`：大文件上传、预览结果分页或后台任务状态。
- `/api/exports/*`：服务端权限过滤后的流式文件生成。
- `/api/health`：liveness；`/api/ready`：有限依赖检查，不泄露配置。

不为 Server Component 的内部读取建立通用 REST 层。未来若开放外部 API，再版本化并单独认证、限流与审计。

## 6. 一致性与并发

- Quote 增加 `version` 乐观锁。更新条件包含 `id + version`，冲突返回“资料已被他人更新”，防止覆盖。
- 报价主记录、Price History 与 Activity Log 同一数据库事务。
- 图片采用“先暂存、验证、落盘，再事务写元数据”的补偿模式；数据库失败时清理新对象，清理失败进入 orphan cleanup。
- 导入 preview 保存源文件 hash、目标类型和规范化行结果，不持久化原文件；确认时锁定 creator-owned job、验证状态/错误与 Product timestamp snapshot，并用事务状态转换保证幂等。

## 7. 缓存策略

认证业务默认动态读取。不得跨用户缓存 Factory 私有数据。静态字典可做进程内短缓存，但更新后必须明确失效。V1 单实例不引入 Redis；若未来水平扩容，再评估共享 cache、任务队列和 session 策略。

## 8. 可观测性

- 结构化 JSON 应用日志：requestId、actorId、route、action、result、duration；不记录密码、token、连接串或完整私有字段。
- 健康检查、容器 restart policy、磁盘/卷容量、数据库连接和备份失败告警。
- Activity Log 是业务审计，不替代运维日志；两者生命周期和访问权限分离。

## 9. 架构决策触发点

以下变化必须新增 ADR：多实例部署、对象存储迁移、一用户多厂家、外部 API、异步队列、全文搜索、Prisma 主要版本升级、跨区域备份或身份提供商变更。

## 10. Phase 01 已实现边界

Phase 01 当时只实现 `src/app` 根占位页、`/api/health`、Tailwind/shadcn token、`src/lib/env.ts`、空 Prisma PostgreSQL schema、Playwright health smoke、Docker/Compose 骨架与工程检查。认证 handler、Actor 与最小角色 route 已在 Phase 02 增加；repository、feature module、业务模型与 storage adapter 仍未创建。

## 11. Phase 02 认证边界

- `src/lib/db` 持有唯一 Prisma Client；`src/lib/auth` 持有 Better Auth 配置、session 到 Actor 的映射、server-only account capability 和安全事件 abstraction。
- `/api/auth/[...all]` 只承载 Better Auth handler；公开危险路径由配置禁用。第一方账号管理通过 server-only service，不建立通用业务 REST API。
- `/login` 是唯一公共认证页；`/admin` 与 `/factory` 均为动态 Server Component，并在读取内容前执行数据库级 session + policy 检查。
- Factory tenant identity 仅来自 Auth Context。query、FormData、JSON、header 或 URL 中的 factoryId 只能作为不可信候选，绝不能覆盖 actor.factoryId。
- 本阶段页面仅用于验证认证边界，不创建 Dashboard、Sidebar、产品或报价 UI。

## 12. Phase 03 UI 架构

- `src/components/ui` 持有无业务知识的基础组件；统一使用 semantic token、Radix primitive 和 `cn()` 合并样式。
- `src/components/shared/app-shell.tsx` 是 Admin/Factory 共用的响应式框架，但两类角色使用独立导航清单和信息密度；权限仍由页面 Server Component 在渲染 Shell 前执行。
- `/admin` 与 `/factory` 继续直接调用 `getAuthContext()` 并维持 Phase 02 的 redirect/not-found 行为；Shell Client Component 只处理导航展示、移动 Sheet 与 logout Server Action，不读取或决定角色/tenant。
- `/login` 保留原 username/password API、统一错误和 redirect 行为，只替换视觉组合与 password reveal 控件。
- `/design-system` 是 development-only Server Component route；生产环境直接 `notFound()`。Showcase 的 fixture 只存在于 presentation 层，不导入 Prisma、auth service 或业务 data layer。
- responsive breakpoint：`md`（768px）控制 Table/Card 切换，`lg`（1024px）控制 Sidebar/Mobile Sheet 切换；不得让客户端 viewport 决定服务端授权或数据范围。
- Phase 03 不新增数据库 schema、application service、Product/Factory/Quote CRUD、Dashboard query、上传或导入导出。

## 13. Phase 04 Master Data 架构

- `src/features/products|categories|materials|factories` 分别持有 Zod validation、application service 与薄 Server Actions；页面组件不直接调用 Prisma。
- 所有 service 显式接收请求 headers，并在解析业务输入前调用中央 `requireAdminFromHeaders()`。Factory 当前没有新的 Master Data 读取或写入能力。
- Server Actions 只获取可信请求 headers、调用 service 并将统一业务错误映射为安全中文结果；没有建立公共 REST CRUD API。
- `src/lib/application/errors.ts` 统一区分 validation、unauthenticated、forbidden、not found 与 conflict；未知数据库错误对客户端只返回通用文案。
- Product list 在服务端提供 page/pageSize（每页最多 100）、SKU/name 搜索、status/category/material filter 以及受限字段排序；数据与 count 不拉到客户端全量过滤。
- 单表 CRUD 不使用形式化事务。Factory 禁用与所属用户 session 撤销必须在短事务内同时成功。
- 本阶段按用户明确范围只实现数据库、API/application layer 与测试，不开发 `admin/products`、厂家/字典正式 UI，也不建立图片、Assignment 或 Quote skeleton。

## 14. Phase 05 Assignment 与 Factory Product Read Model

- `src/features/assignments` 独立持有 validation、application service、Admin mutation actions 与 Admin/Factory read models；不把租户逻辑塞入 Product 或 Factory CRUD。
- Admin assign/revoke/reactivate 全部重新执行 `requireAdminFromHeaders()`。assign 对 ACTIVE 关系幂等返回；REVOKED 关系通过条件更新复用；数据库 unique 负责并发最终一致性。
- Factory list/detail 先通过 `requireFactoryUserFromHeaders()` 取得可信 factoryId，再由同一条 Prisma 查询限定 `assignment.factoryId + assignment.ACTIVE + product.ENABLED`。不先查全量再在 JavaScript 过滤。
- Factory Product DTO 只返回 id、SKU、名称、Category、Material、状态与更新时间；不包含 Product internal notes、其他 Factory、Quote、价格、图片或 Assignment 管理字段。
- Product/Factory 禁用不会批量改写 Assignment。Auth Context 拒绝禁用 Factory/User；Product 查询条件拒绝禁用 Product。
- 本阶段只开放三个 Admin mutation Server Actions；read models 由未来 Server Components 直接调用，不建立公共 REST API，也不实现正式 UI。

## 15. Phase 06 Quote 与 Price History 架构

- `src/features/quotes` 独立持有 Zod validation、提交/更新事务、Factory/Admin read models 与薄 Server Action；不把报价逻辑塞入 Assignment service，也不建立通用 REST CRUD。
- “待填写”由不存在 Quote 表达，“已提交”由 Quote 存在表达。没有 status、草稿、autosave 或半完成持久化；首次提交至少要求有效人民币价格。
- `FactoryQuote.assignmentId` unique 是业务身份。Factory 写入先从真实 Auth Context 取得 factoryId，再在事务中用 Assignment ACTIVE、Product ENABLED、Factory ACTIVE 一次性限定候选关系。
- 当前值与 PriceHistory 同事务写入。首次提交记录 `NULL → price`；价格未变时只更新 Quote；价格变化才追加历史。`version` 由服务端递增，更新条件包含 expectedVersion，旧版本安全返回 CONFLICT。
- CBM 不持久化且不接受客户端输入；read DTO 用 Prisma Decimal 从三项尺寸确定性计算，缺项返回 null。BigInt/Decimal 以字符串离开 service 边界。
- Factory 只读写自己的有效 Quote/History；Admin 只读全部 Quote/History。本阶段不提供 Admin 修改报价，不开发正式页面、图片、导入导出或完整 ActivityLog。
- Quote 提交/更新是 ActivityLog 的事务接入点：Phase 07 已把 `QUOTE_SUBMITTED/QUOTE_UPDATED` 与当前 Quote、PriceHistory 放入同一事务。

## 16. Phase 07 Business Activity Audit 架构

- `src/features/activity/writer.ts` 是小型 typed audit writer：事件策略同时固定 entity type、允许的 diff 字段和 metadata 字段；运行时再次拒绝非 allowlist key，不提供 `logAnything(any)`。
- writer 统一把 BigInt 转为十进制字符串、Prisma Decimal 转为规范字符串、Date 转为 ISO timestamp；`changes` 只保存真实变化的 `{ before, after }`。空 diff 不写日志。
- Actor 来自已验证 Auth Context，并保存 User FK、角色和 username snapshot。schema 同时预留 `SYSTEM` actor source，但 Phase 07 的现有事件全部是 USER，不增加 Bot/API Key 等身份体系。
- Product、Category、Material、Factory、Assignment 和 Quote 的关键 mutation 均在原业务 transaction 内写 ActivityLog；审计 INSERT 失败会使业务状态、PriceHistory 一起回滚。
- `entityId`、`factoryId` 与显示 snapshot 不依赖源实体外键，保证业务名称变化或源实体以后移除时日志仍可理解；User actor FK 使用 RESTRICT 防止级联丢失。
- Admin read service 在数据库执行 page/pageSize、event/entity/actor/factory/date-range filters，默认 `createdAt DESC, id DESC`；Factory 不开放 ActivityLog list。本阶段不建立 `/admin/activity` UI、全文搜索或 JSONB 索引。
- Better Auth 登录失败、logout、密码等继续走独立 security-log abstraction，避免把高频安全事件混入业务 ActivityLog。Frozen V1 的 Factory User create/enable/disable 同时保留原 Security Event，并写 `USER_CREATED/USER_ENABLED/USER_DISABLED` Business ActivityLog；两类日志职责独立，均不得包含密码、hidden email、session 或认证密钥。
- User create 继续通过 Better Auth 官方密码 API，成功后由同一 server-only account service 写 allowlist ActivityLog，只有两步均成功才向调用方返回成功；不把跨 Better Auth/Prisma 边界伪装成单一数据库事务。User enable/disable 沿用 `User.banned`，在一个 Prisma transaction 内完成条件状态转换、disable session 撤销与 ActivityLog；重复目标状态不更新、不写空业务事件。

## 17. Phase 08 Secure Image Storage 架构

- `src/lib/storage` 定义最小 `put/open/read/copy/delete/stat` contract；Local provider 只接受服务器生成的 `objects/<uuid>.webp` opaque key，并在解析后再次保证目标位于 `LOCAL_STORAGE_ROOT` 内。业务 service 不直接操作 filesystem。
- 上传边界固定为 10 MB JPEG/PNG/WebP。Sharp 在 2500 万像素安全限制下真实解码，拒绝多帧、单边超过 8000 px 或不匹配的 Content-Type/扩展名/魔数，然后处理 orientation 并重新编码为静态 WebP。默认不调用 metadata 保留 API，因此 EXIF/GPS/ICC 被剥离。
- `ProductMainImage.productId` 与 `FactoryPrivateImage.assignmentId` 分别 unique；每个关系引用独立 StoredObject。Factory 私图绑定稳定 Assignment，不绑定 Quote，也不直接挂 Product。
- upload/replace 使用“授权 → normalize → 写新 opaque file → 锁定 Product/Assignment → DB transaction 写 StoredObject、关系与 ActivityLog → commit 后清旧对象”；DB 失败补偿新文件。旧文件清理失败不回滚已提交的新关系，并保留无引用 StoredObject 作为 cleanup candidate。
- Promotion 读取已规范化私图并复制到新 key/new StoredObject，再以相同主图 replacement 流程切换；原私图关系与文件保持不变。
- 读取 Route 使用 Product/Factory 语义 ID 先做 server-side authorization，再流式打开 storage key；响应固定 `image/webp`、`private, no-store`、`nosniff`、checksum ETag，不暴露物理路径或 storage key。
- Local 与 PostgreSQL 的 orphan 检查以双向对账实现：无任何图片关系的 StoredObject、StoredObject 对应缺失文件，以及 objects prefix 中没有 StoredObject 的文件。V1 不运行定时删除任务。

## 18. Phase 09 Product Import & Data Export 架构

- `src/features/imports` 持有 CSV/XLSX bounded parser、header/row normalization、Preview staging、creator-owned read 与 atomic confirm；`src/features/exports` 持有严格 query schema、CSV/XLSX serializer 与模板。Route Handler 只负责认证前置、multipart/query、same-origin mutation 与安全文件响应。
- Product import header 按名称映射，顺序可变但列集合固定。`product_id` 空表示 CREATE，存在时只按不可变 UUID UPDATE；绝不以 SKU 推断更新。Category/Material 按现有 canonical name 匹配且必须 ACTIVE，不自动创建字典。
- `src/features/products/mutations.ts` 是 Product 正式 API 与 Import confirm 共用的 transaction primitive，集中 reference、SKU canonicalization、no-op、PRODUCT_CREATED/UPDATED/ENABLED/DISABLED 规则，避免 importer 形成第二套业务逻辑。
- Preview 计算 CREATE/UPDATE/NO_CHANGE/ERROR 并持久化 normalized data、diff、errors、target timestamp；Product 与 ActivityLog 保持不变。Confirm 在单个 Serializable transaction 锁 job/targets，最多 5000 行全有或全无。
- Export 直接复用相同 Product filter 语义，并为 Quote 增加 factory/product search、assignment status 和时间范围；在数据库取数前授权、最多 10000 行，超限要求缩小筛选。RMB cents 与 Decimal CBM 在服务器确定性格式化。
- 本阶段不增加正式 UI、queue、worker、Redis、mail、S3、Factory/User/Assignment/Quote/Image import，也不改变 Factory tenant read model。

## 19. Phase 10A Admin Operational UI

- `/admin` 路由组先执行服务端角色守卫；每个 read model 与既有 Server Action 仍独立重新认证和要求 ADMIN，页面重定向不替代服务授权。
- `src/features/admin/service.ts` 是 Admin UI 的只读聚合层：集中完成 Dashboard、Product、Factory、Assignment/Quote workspace 与字典使用量查询。页面不直接调用 Prisma，也不把 canonical key、storage key 或隐藏认证字段传给客户端。
- Product/Factory/Category/Material/Assignment 的写入继续复用 Phase 04–05 Server Actions；图片上传、移除和提升继续复用 Phase 08 受控 Route Handler。Admin Quote UI 保持只读。
- 列表筛选、排序和分页保存在 URL；桌面表格在手机切换为卡片。详情页只组合既有业务实体，不新增 schema、状态机或数据副本。

## 20. Phase 10B Factory Portal Operational UI

- `/factory/**` layout 与每个 Factory read model 都从真实 session/User 解析 `factoryId`；页面 query、path parameter 与表单不得指定或覆盖 tenant。被禁用账号/厂家会在读取业务数据前退出到登录页。
- `src/features/factory/service.ts` 是 Factory Portal 的只读聚合层。Dashboard、筛选项、列表和详情均从 `ProductFactoryAssignment` 出发，同时约束 Assignment ACTIVE、Factory ACTIVE、Product ENABLED，并只关联当前 Assignment 的 Quote、History 和私图。
- 产品列表将分页 count 和卡片 DTO 分为固定数量查询；详情以一个受限 Assignment 查询组合 Product、主图、自有 Quote、最多 20 条 History 与自有私图，避免逐卡片/逐历史 N+1。
- 报价写入继续复用 Phase 06 `submitOwnQuoteAction` 与 expectedVersion 乐观锁；浏览器 CBM 只用于即时预览，服务端 Decimal 计算仍是权威结果。图片写入继续复用 Phase 08 受控 Route Handler。
- URL 只保存 search/status/category/material/page 等展示状态。不可用、撤销、停用或跨租户产品统一返回不可用列表提示，不泄露实体存在性。

## 21. Phase 10C Admin Operations Completion

- `src/features/admin-operations` 只补充 Admin read models、Factory User action wrapper 与交互组件；不建立新业务域、schema 或第二套 Auth/Import/Export 实现。
- Import UI 直连 Phase 09 template/preview/rows/confirm Route，预览行由数据库分页。Product/Quote 下载直连 server-side export，并把 URL filter 映射到严格 query schema。
- Activity 页面复用 Phase 07 read service；集中 presentation 层负责事件、实体、字段、金额和单位映射。详情只消费 allowlist changes/snapshot，不渲染 metadata。
- Factory User list 服务端分页并排除 hidden email；create/reset 复用 Phase 02 Better Auth 正式能力，enable/disable 沿用相同 `User.banned` 状态模型，由 server-only service 原子完成状态、session 撤销与 Business ActivityLog。
- 页面继续使用 URL state、桌面 table/移动 card 与固定数量查询；V1 Feature Freeze 后结构性扩展转入 Phase 11 审查。

## 22. Hard Delete Phase 1 架构

控制面与执行面严格分离：未来 Web/Admin 只形成带 digest 的 preview/confirmation operation；独立 worker 使用独立数据库 login 调用固定 SECURITY DEFINER 函数。Web 不持有 worker credential，worker 不具有直接 table privilege。Phase 1 函数只执行 disabled Factory User 的已确认闭包；其他 target type 明确拒绝，不能以任意表名或 JSON SQL 扩展。

含文件对象采用 transaction outbox 形态：数据库事务生成 HardDeleteFileTask 并提交闭包，事务外 worker 幂等删除 current uploads，再依据 durable task 重试/核对。Phase 1 只建立表和状态约束，不实现文件 worker、其他对象 planner 或最终 UI。详见 `HARD_DELETE.md`。

## 23. Hard Delete Phase 2 执行架构

控制面、数据库执行面与文件收敛面分离：Admin-only service 生成/确认 canonical preview；独立 worker 用 lease claim 并重新计算 planner；固定 SECURITY DEFINER transaction 生成 file outbox 并删除数据库闭包。事务提交后 worker 才通过 Storage abstraction 删除文件、`stat` 复核并 final verify。

Operation 与 FileTask 各自具有 version/expiry/lease/retry 状态；advisory transaction lock、row lock、CAS version 与 active-target partial unique 共同防止重复确认和双 worker。崩溃后只接管过期 lease；已不存在文件按幂等成功处理。完成条件来自 durable task 和数据库/文件/保留对象/orphan 验证，不来自内存成功标志。

## 24. Guided installer control plane

通用 release 的 Migrator image 额外携带 Docker CLI/Compose plugin 与只读 operations bundle，但普通 `migration` service 没有 Docker socket，能力与原数据库迁移边界不变。只有 root 操作员显式运行 `setup.sh` 或 `product-hub` 时，短生命周期 control container 才挂载 Docker socket 和 `/opt/product-hub`；该容器 `--rm`、read-only rootfs、tmpfs、network none、cap drop、no-new-privileges、非 privileged。

Shell 入口不实现 migration、runtime grants、Worker provisioning、Admin bootstrap、doctor 或 backup 规则，只启动固定且已验证的 Migrator digest；实际流程继续调用 `scripts/installer/bootstrap.ts`。App、Hard Delete Worker、普通 migration、database-job 与 admin-bootstrap 永远没有 Docker socket。operations bundle 按 source commit 安装到 `/opt/product-hub/releases/<sha>/bundle`，Compose 的 host bind source 因而与 control container 内路径一致。

Control container 仅保留 CHOWN/DAC_READ_SEARCH 文件权限能力；network none 模式通过 daemon 在 App 内探测 health/ready，并使用既有无 socket 的一次性 database-job verify 做只读诊断。宿主机直接调用的 legacy doctor 保持原直连只读路径。
