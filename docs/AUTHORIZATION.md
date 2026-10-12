# 认证与授权模型

## Hard Delete authorization contract

每个 Preview、Confirm、Status 入口独立 requireAdminFromHeaders，先认证授权再校验输入；Factory 默认拒绝。确认短语服务端生成并精确重验。固定 refresh_hard_delete_preview 仅可刷新 PREVIEWED；Confirm 由既有固定函数最终加锁，不授予普通 App UPDATE/DELETE 操作表或历史表。

## 1. 原则

认证回答“是谁”，授权回答“是否能对这个资源执行这个动作”。所有服务端入口默认拒绝，并在每次请求验证；UI 隐藏、路由命名和不可猜 ID 都不是安全控制。

## 2. Actor

服务端将 Better Auth session 映射为：

```ts
type Actor =
  | { userId: string; role: "ADMIN"; factoryId: null }
  | { userId: string; role: "FACTORY"; factoryId: string };
```

Actor 只从已验证会话和数据库构造。任何表单、query string、header 或 JSON 中的 role/factoryId 均忽略或拒绝。用户禁用、厂家禁用、会话过期任一成立时视为未授权。

## 3. 权限矩阵

| 资源/动作              | Admin                                | Factory                                     |
| ---------------------- | ------------------------------------ | ------------------------------------------- |
| Product 列表/详情      | 全部                                 | 仅存在活动 assignment 的产品                |
| Product 创建/编辑/启停 | 允许                                 | 拒绝                                        |
| Material/Category 管理 | 允许                                 | 只读可见名称，且仅随已分配产品              |
| Factory 列表/详情/编辑 | 允许                                 | 仅自己厂家必要资料；V1 profile 范围受限     |
| Assignment 创建/撤销   | 允许                                 | 拒绝                                        |
| Quote 查看             | 全部                                 | 仅 `assignment.factoryId = actor.factoryId` |
| Quote 填写/提交/更新   | 可管理/代录时需审计                  | 仅所属活动 assignment                       |
| Price History          | 全部                                 | 仅自己厂家的记录（若 V1 UI 开放）           |
| Product Main Image     | 管理                                 | 仅已分配产品可读                            |
| Factory Private Image  | 全部                                 | 仅所属厂家可读写                            |
| 用户创建/禁用/重置密码 | 允许                                 | 拒绝                                        |
| 自己修改密码           | 允许                                 | 允许                                        |
| Activity Log           | 全部                                 | V1 拒绝                                     |
| Import/Export          | Product import、Product/Quote export | 全部拒绝                                    |
| Settings               | 允许                                 | 拒绝                                        |

## 4. 资源授权规则

### 列表

Factory 产品列表必须从 session factoryId 开始查询：

```text
Product
WHERE EXISTS active ProductFactoryAssignment
  AND assignment.factoryId = actor.factoryId
```

不能先查全量再在 JS 中过滤，也不能接受 `?factoryId=` 来决定范围。

### 详情与修改

FactoryQuote 的查询/更新必须在单次受限查询中同时包含：quote/assignment ID、活动 assignment、`factoryId = actor.factoryId`。先按 ID 获取再忘记检查归属属于禁止模式。

### 图片

`GET /api/files/:id` 先查业务引用再授权：

- Product main：Admin，或 Factory 对该 Product 有活动 assignment。
- Factory private：Admin，或 `FactoryPrivateImage.assignment.factoryId = actor.factoryId` 且 assignment 活动。
- 没权限统一返回 404，减少资源枚举；安全日志可内部记录 403 原因。

不能直接把 storage key 返回给 Factory，也不能通过反向代理暴露整个上传卷。

### 导出

导出服务复用列表 query policy。所谓“当前筛选结果”是“actor 有权数据 ∩ 经 Zod 校验的筛选条件”，不是客户端提交的一组任意 ID。

## 5. 服务接口模式

每个用例显式接收 Actor：

```ts
submitQuote(actor, { assignmentId, expectedVersion, values });
getProduct(actor, productId);
streamFile(actor, storedObjectId);
```

Repository 不暴露无范围的 Factory 查询给页面。建议提供 `findAssignedProduct(actorFactoryId, productId)` 等语义方法，Admin 全局查询使用独立方法。

## 6. 认证配置边界

- 登录 UI 仅用户名 + 密码。
- 关闭 public sign-up endpoint；只有受保护 Admin application service 可创建用户。
- 关闭或屏蔽 `/is-username-available` 等公开用户名可用性接口，认证错误不得帮助枚举 username。
- Better Auth 所需 `.invalid` 内部 email 不在 UI 返回或允许 Factory 修改；不启用邮件找回密码。
- 密码 8–128 位；错误消息不区分用户名不存在、密码错误或账号禁用。
- Admin 账号不得绑定 factoryId；Factory 账号必须绑定一个有效且启用的 Factory。
- 修改自己的密码需验证当前密码；Admin 重置生成/设置新密码并撤销目标用户 sessions。
- Cookie 在生产环境使用 Secure、HttpOnly、SameSite；只通过 HTTPS。
- 高风险 Admin 操作建议缩短 fresh-session 要求；V1 不要求 MFA，但架构不应阻碍未来启用。

## 7. 防止越权的强制测试

为 Factory A/B 创建独立产品分配、quote、图片和用户。对每个入口验证 Factory A：

- 手改 `/factory/products/:id` 为 B 的 Product/Assignment/Quote ID。
- 修改 Server Action payload、隐藏字段、query 参数和分页 cursor。
- 请求 B 的图片 ID、导出 ID、导入 job ID。
- 使用已撤销 assignment、被禁用账号、旧 session。
- 通过搜索、错误文案、计数、时间或文件头推断 B 的存在。

预期：不返回内容、不产生修改、不写错误的历史；响应不泄露资源是否存在。Admin 的正向访问另行验证。

## 8. Better Auth Organization 决策

V1 不启用 Organization plugin。Factory 已经是业务租户，User.factoryId 能满足“一厂家多账号”。只有确认出现一用户多厂家、组织邀请或组织级角色后，才评估 organization/membership；迁移前 Factory 仍是业务数据隔离的权威实体。

## 9. Phase 02 实现约定

- 数据库角色固定为 `ADMIN` 与 `FACTORY`。Admin plugin 只把 `ADMIN` 视为管理角色；`FACTORY` 没有 Better Auth 管理权限。
- Better Auth 的 `banned` 字段是 User 启用/禁用的认证权威状态：`false/null = ENABLED`、`true = DISABLED`。不再增加第二个可能漂移的 User status 字段。
- Factory 状态固定为 `ACTIVE` 与 `DISABLED`。Factory 禁用时撤销其全部用户 session；即使撤销失败或存在竞态，逐请求 Auth Context 仍必须查询 Factory 状态并拒绝。
- username 保存为 trim 后的小写 canonical value、数据库唯一、创建后不可由用户修改；客户端只显示/提交 username，不接触内部 email。
- 公开 sign-up、email sign-in、email recovery、username availability、通用用户更新/删除、Admin impersonation 以及直接浏览器调用通用 Admin mutation endpoint 均关闭。
- `getAuthContext()` 每次从 Better Auth 数据库 session 重新解析 User、role、banned、factoryId 与 Factory status；session cookie cache 关闭。
- `requireUser()`、`requireAdmin()`、`requireFactoryUser()` 与 tenant policy 是服务端唯一授权入口。页面重定向只是 UX，不能代替这些检查。
- `/admin` 仅 `ADMIN`；`/factory` 仅启用的 `FACTORY` 且 Factory 为 `ACTIVE`。Admin 不 impersonate Factory。
- Admin 创建 Factory User、禁用/启用用户、重置密码、禁用/启用 Factory 均通过封装的 server-only capability；不能让浏览器直接提交 role、factoryId 或内部 email 给 Better Auth 通用 Admin API。

## 10. Phase 04 Master Data 授权

- Product、Category、Material、Factory 的 create/update/enable-disable service 与 Server Action 全部在服务端重新建立 Auth Context 并要求 ADMIN。
- 本阶段没有 ProductFactoryAssignment，因此 FACTORY 不获得 Product、Category、Material 或其他 Factory 的列表/详情读取能力；不得为“以后会用”提前放宽。
- Factory 发送伪造 ID、role 或 factoryId 不影响授权结果；Master Data service 不接收客户端角色或租户作为权限依据。
- 未登录、FACTORY、缺失对象和唯一性冲突分别安全映射为 `UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`CONFLICT`，不返回 Prisma code、SQL 或 stack。

## 11. Phase 05 Assignment 与 Factory Product 授权

- 只有 ADMIN 可 assign、revoke、reactivate、列出 Product 的 Factories 或列出 Factory 的 Products；FACTORY 调用这些 mutation 一律 FORBIDDEN。
- Factory 产品列表和详情只使用 Auth Context 中的 factoryId。query/body/URL 中额外提交的 factoryId 不能覆盖 actor，并作为无效输入或无权资源处理。
- Factory list 的数据库条件必须同时包含自身 ACTIVE Assignment 和 ENABLED Product；详情使用同一受限查询。不存在、其他租户、REVOKED、Product DISABLED 均统一返回 NOT_FOUND，不泄露具体原因。
- Factory status 必须为 ACTIVE、User 必须未禁用才能建立 FactoryActor。Factory 禁用会撤销 session，但不会改写 Assignment；恢复 Factory 后需重新登录，原 ACTIVE Assignment 可再次读取。
- Product internal notes 是 Admin-only 数据，不进入 Factory read DTO。Factory 当前也不会获得其他 Factory、Quote、价格、包装、重量或图片信息。

## 12. Phase 06 Quote 与 Price History 授权

- Factory 是 Quote writer；Admin 是全局 Quote/History reader。本阶段没有 Admin 修改厂家报价能力。
- Factory submit/update/read 必须使用 Auth Context 的 factoryId，并在同一数据库条件中限制 Assignment ACTIVE、Product ENABLED、Factory ACTIVE。User disabled 或 Factory disabled 无法建立有效 FactoryActor。
- 其他 Factory 的 quoteId、assignmentId、productId 或 factoryId 一律不能改变租户范围。未授权具体资源统一映射为 NOT_FOUND；严格 Zod schema 拒绝额外伪造字段，不透露对象属于哪个厂家。
- REVOKED Assignment、DISABLED Product 对 Factory 立即不可见；Admin 仍可读取保留的 Quote/History。重新激活/启用后，符合条件的 Factory 继续访问同一个 Quote。
- Factory 可分页读取自己的 PriceHistory；Admin 可分页读取任何 Quote 的历史。厂家备注只随所属 Factory Quote DTO 或 Admin DTO 返回，不进入其他 Factory 的 read model。

## 13. Phase 07 Business ActivityLog 授权

- 业务 ActivityLog actor 只能来自服务端 Auth Context。客户端不能提交或覆盖 actorUserId、actorRole、actor factory、event type、before/after。
- Factory User create/enable/disable 必须在 server-only account service 重新执行 `requireAdminFromHeaders()`；目标 User 与 factoryId 由数据库读取，客户端只能提交目标 ID 和期望状态，不能指定 actor 或审计 payload。FACTORY 调用一律 FORBIDDEN，不存在、Admin 或不合法目标统一 NOT_FOUND，且不产生 ActivityLog。
- Factory Quote 事件的 `factoryId` 来自 actor 与受限 Assignment 查询；跨租户 Quote mutation 在写业务数据和审计之前失败，不能制造属于其他厂家的假事件。
- 本阶段只有 ADMIN 可调用 ActivityLog read service。FACTORY 即使拥有相关 Quote 也不能读取完整 ActivityLog list，仍只按 Phase 06 规则读取自己的 PriceHistory。
- Admin filters 由 Zod 严格校验并在数据库执行；支持 eventType、entityType、actorUserId、factoryId 和时间范围，不接受客户端提供任意未授权字段或全量后再过滤。
- ActivityLog 不提供普通 update/delete service。Actor User 外键为 RESTRICT；entity/factory 使用不可变 ID snapshot 而非级联外键，避免源记录变化造成历史消失。

## 14. Phase 08 图片授权

- Product Main Image 仅 Admin 可上传、替换、移除或从私图提升；Admin 可管理 DISABLED Product 的主图。Factory 读取必须同时满足有效 session、ACTIVE Factory/User、ACTIVE Assignment 与 ENABLED Product，未分配、撤销或停用统一 NOT_FOUND。
- Factory Private Image 写入与删除仅允许 Auth Context 中 Factory 对其自身 ACTIVE Assignment 执行；客户端提供的 factoryId、storageKey、checksum、最终 MIME/尺寸一律不参与身份或元数据决策。Admin 可读取所有私图，但 V1 不新增 Admin 删除私图权限。
- 私图读取以 imageId 候选和同一条数据库查询同时限定 `assignment.factoryId = actor.factoryId`、ACTIVE Assignment、ENABLED Product 与 ACTIVE Factory。知道其他 Factory 的 image/object/assignment/product ID 不能改变租户范围。
- Assignment REVOKED、Product DISABLED、Factory/User disabled 只改变授权结果，不删除图片；Admin 始终可读取历史上下文。重新激活/启用并重新建立有效 session 后恢复 Factory 访问。
- 所有未授权具体图片统一为 404；文件 Route 不返回 storage key、物理路径、原始 filename 或隐藏 metadata。Activity actor/factory 只来自 Auth Context 与受限 Assignment 查询。

## 15. Phase 09 导入导出授权

- Product CSV/XLSX template、preview、job/row read、confirm 与 Product/Factory Quote CSV/XLSX export 全部要求真实 ADMIN Auth Context。FACTORY 对每个入口均为 FORBIDDEN，不能通过已知 job ID、format、filter 或文件名改变权限。
- ImportJob 采用 creator-only ownership：Admin 只能读取和确认自己创建的 job；其他 Admin 的 ID 统一按 NOT_FOUND 处理。actor 与 owner 只来自 session/User FK，不接受文件列或请求参数覆盖。
- Preview 不修改 Product、不写 Product ActivityLog；confirm 重新认证、锁 job、验证 owner/status/error count，并只使用已持久化规范化行。Product create/update 与语义 ActivityLog 复用正式 Product transaction primitive。
- 导出 query 经严格 Zod 校验并直接进入 Prisma where/orderBy。Product 支持 search/status/category/material/main-image/sort；Quote 支持 factory/search/assignment status/submitted/updated range。客户端不能提交任意 ID 清单，Factory 不能获得缩小范围后的“部分导出”。

## 16. Phase 10A Admin UI 授权

- `/admin/**` 的 route layout 与每个页面入口先确认 ADMIN；其后所有聚合 read model 和 mutation service 仍分别执行 `requireAdminFromHeaders()`，Factory 不能通过直达 URL、query 或 Action payload 使用 Admin UI。
- Admin Product/Factory/Quote 页面只消费 allowlist DTO；`nameNormalized`、`skuNormalized`、storage key、hidden email、session 与认证字段不进入客户端 props。
- Admin Quote workspace 包含没有 FactoryQuote 的 Assignment，以“待报价”表达；Admin 只能读取 Quote/PriceHistory，不能通过本阶段 UI 代录或修改厂家报价。
- 厂家分配选择器只提交 immutable Product/Factory ID，服务仍重新检查启用状态；撤销/激活继续复用稳定 Assignment ID 并保留 Quote、History 与私图。

## 17. Phase 10B Factory Portal 授权

- `/factory/**`、Factory 聚合 read model、报价 Action 和私图 Route 均以 session/User 的 `factoryId` 为唯一 tenant 来源；客户端提交的 Product/Assignment/Image ID 只能作为目标标识，不能决定归属。
- 可见产品集合为 `own factory ∩ ACTIVE assignment ∩ ENABLED product ∩ ACTIVE factory`。分类/材质筛选项也从该集合生成，不能借筛选枚举推断其他租户数据。
- 详情只返回产品公开业务字段、Product Main Image、自有 Quote/PriceHistory 和自有 FactoryPrivateImage；internal notes、其他厂家身份/价格/包装/备注/私图全部排除。
- Assignment 撤销、Product 禁用、Factory/User 禁用立即影响下一次服务端读取和 mutation；已知 UUID 或私图 ID 对跨租户和不可见资源仍统一 NOT_FOUND/404。
- Factory 只能提交自己的当前报价和管理自己的私图，不能变更 Product、Factory、Assignment、主图或 Activity。密码修改沿用当前密码验证和 session 撤销策略。

## 18. Phase 10C Admin Operations 授权

- Import、Export、全局 Activity、Factory User 管理与 Admin Settings 全部为 ADMIN-only；每个 read model、Server Action 和 Route Handler 独立重验 session/role。
- ImportJob 继续 creator-owned；Factory 即使知道 job ID、模板/导出 URL 或筛选参数也只能得到拒绝，不能读取局部数据。
- Users DTO 只返回 username、Factory、账号/厂家状态和时间；hidden `.invalid` email、Account、Session 与 password hash 不进入页面。
- Factory User 只能绑定 ACTIVE Factory；用户名不可变。停用、恢复、重置密码只允许 FACTORY role 目标，不能借 userId 修改 Admin。
- Admin 改密使用 Better Auth 当前密码验证与 `revokeOtherSessions`，UI 不接触 hash 或 token。

## 19. Hard Delete 授权边界

- 普通 Admin Web session 只能创建、读取并显式确认 `HardDeleteOperation`，不能直接 DELETE 业务表、ActivityLog 或 PriceHistory。
- `product_hub_app` 只可 EXECUTE 无副作用 planner 与 CAS confirmation function；不能 claim、执行数据库闭包、处理文件任务、失败或完成 operation，也不能读取 privileged storage catalog。
- 独立 worker role 无 table/sequence 权限，只可 EXECUTE Phase 2 固定函数白名单；旧 `execute_confirmed_user_hard_delete(uuid)` 已禁用且不授予。Web App 永远不持有 worker credential。
- PUBLIC 对所有 Hard Delete 函数均无 EXECUTE；`product_hub_app` 对 ActivityLog/PriceHistory 仍无 UPDATE/DELETE/TRUNCATE。
- `product_hub_app` 对 User 无 DELETE；账号永久删除不能绕开 operation 与 worker function。
- `IMPORT_JOB`、最终 UI 与 Phase 3 能力仍未授权。详见 `HARD_DELETE.md`。

Phase 2 将授权扩展为九类固定 planner。Admin Web 只能提交 target type/id，并通过服务端生成安全 preview、以 digest/version 显式确认；dependency IDs、file keys、counts、factoryId、activity IDs 等额外字段严格拒绝。Factory 对 preview/read/confirm 全部拒绝。App 只可执行无副作用 planner，仍不能 claim/execute/finalize；worker 无直接 table/sequence 权限，只可执行固定函数白名单。
