# Product Hub 产品需求基线

本文件定义产品行为，不记录某一私人部署、Gate 或 rollout 的即时状态。Hard Delete 的正式产品规则见 `HARD_DELETE.md`。

## 1. 产品目标与范围

Product Hub 是自托管的“内部产品资料 + 厂家报价数据库”。初期约 100+ 产品、1 个厂家，须在不改变核心模型的前提下扩展到更多产品、厂家以及每个厂家多个用户。

V1 不是 CRM、客户报价、订单、物流或客户管理系统。除非获得后续明确授权，不增加 Lead Time、Delivery Time、交期、客户/销售价格、客户管理、订单状态、发货、Invoice、Customer Quotation 或其他 CRM 功能。

角色：

- Admin：管理产品、厂家、账号、分配、报价总览、活动记录和系统设置。
- Factory：仅查看被分配给所属厂家的产品，填写和更新该厂家的报价与私有资料。

界面为中文，同时支持桌面和手机。V1 不包含厂家自助注册、草稿、审核、批准、拒绝、支付、订单或外部客户门户。

## 2. 不可妥协的业务规则

1. Product 与 Factory 为多对多，通过 ProductFactoryAssignment 明确分配。
2. Factory 用户只可访问自己所属厂家的分配、报价、包装、重量、备注、图片和账号数据。
3. 厂家隔离必须在服务端逐请求执行；修改 URL、ID、查询参数或 API 请求不能绕过。
4. Product 使用不可变内部 ID；SKU 不是主键，可空，非空时唯一，可修改。
5. FactoryQuote 与 Product 分离；同一产品可有多个厂家报价。
6. 厂家点击提交后为“已提交”，后续仍可编辑并“更新提交”；不做审核。
7. 每次价格实际变化必须产生不可变 Price History。
8. 关键修改产生 Activity Log，包含操作者、时间、对象、动作及前后值。
9. 金额以整数分存储。CBM 由服务端按包装长宽高计算，界面值仅作即时预览。
10. Product Main Image 可由所有获分配厂家查看；Factory Private Image 只可由所属厂家和 Admin 查看。

## 3. 功能需求

### 3.1 账号

- 登录：用户名 + 密码。
- 密码长度：8–128 位；V1 不强制首次登录修改。
- 厂家不能自助注册；Admin 创建、禁用、重置密码。
- 厂家用户可在已登录状态主动修改自己的密码。
- 数据模型允许一个厂家对应多个用户；V1 UI 可主要按一厂一账号呈现。
- 禁用与 Admin 重置密码后撤销该用户全部既有会话。

### 3.2 产品

字段至少包含：主图、SKU、名称、分类、材质、状态、备注、创建时间、更新时间。

产品状态仅为 `ENABLED`（启用）与 `DISABLED`（停用），V1 不设计复杂生命周期。

Category 与 Material 均为后台可维护字典；一个 Product 对应一个 Category。材质初始值：黄铜、ABS、铝合金 - 浇铸铝、铝合金 - 型材铝。分类和材质不得硬编码到前端。

Phase 04 决策：产品名称、Category 与 Material 均必填；SKU 仍可空且非空唯一。上述材质名称是业务所需表达能力，不由 migration 写入 production seed，首次正式值由 Admin 创建。V1 Material 不建父子树；两类铝合金作为独立记录。产品、字典和 Factory 以停用为业务删除方式，本阶段不暴露 hard delete。

### 3.3 厂家报价

Phase 06 正式字段：人民币工厂价格、MOQ、包装长/宽/高 cm、净重 kg、毛重 kg、装箱数量、厂家备注、首次提交时间和最后更新时间。FactoryQuote 以 `assignmentId` 唯一绑定稳定的 ProductFactoryAssignment；同一 Product 可通过不同 Assignment 拥有多份厂家报价。

没有 FactoryQuote 表示待填写，存在 FactoryQuote 表示已提交；不建立 PENDING/SUBMITTED 字段，也不持久化草稿。首次提交必须有大于 0 的价格；价格由服务端把最多两位小数的人民币输入规范化为整数分。MOQ 与装箱数量为可空正整数，默认单位分别为 PCS 与 PCS/Carton。尺寸和重量使用 `decimal(12,3)`、可空且填写时必须大于 0；毛重不得小于净重。

CBM 不接受客户端输入，也不作为重复字段持久化；服务端仅在三项尺寸齐全时用 Decimal 按 `长 × 宽 × 高 ÷ 1,000,000` 计算，任一尺寸缺失返回 NULL，未来 UI 默认显示 4 位小数。厂家备注为最多 5000 字的纯文本，不渲染 HTML/Markdown。每次更新提交须携带 `expectedVersion`，旧版本返回冲突而不静默覆盖。

### 3.4 历史

- Price History：通过 Quote/Assignment 关联产品与厂家，保存原价格、新价格、真实修改用户和修改时间；首次提交旧价格为 NULL，仅真实价格变化时追加。
- Activity Log：至少覆盖价格、包装尺寸、净重、毛重、MOQ、装箱数量、产品分配、产品图片、厂家图片、用户账号、Factory、Product、Category、Material。
- 历史记录追加写入，不随当前值变化而覆盖，不提供常规 UI 删除能力。

Phase 07 已建立正式 Business ActivityLog：Master Data、Assignment 与 Quote 的真实 mutation 在服务端生成稳定 event/entity 类型、actor/factory 归属和字段级 before/after diff。无变化请求不生成事件；Quote 首次提交与更新分别使用 `QUOTE_SUBMITTED/QUOTE_UPDATED`。PriceHistory 继续专门保存价格序列，ActivityLog 专门回答谁在何时做了什么，两者不能互相替代。

Frozen V1 的 User lifecycle Business ActivityLog 必须覆盖 `USER_CREATED`、`USER_ENABLED`、`USER_DISABLED`。创建事件以不存在的账号状态为 before，并只记录 username、`ENABLED` 状态与所属 factoryId；启停事件明确记录 `ENABLED ↔ DISABLED`。actor 必须来自服务端 Admin Auth Context，目标 User 由服务端读取；重复启用/停用不产生空业务事件。原有 Factory User create/enable/disable Security Event 同时保留，Business ActivityLog 不替代认证安全日志。

ActivityLog 不自动过期，不提供普通 update/delete service。短备注保留字段 diff；超过 200 字的备注只记录长度与短 SHA-256 摘要，避免永久复制大段文本。审计 payload 采用事件级字段 allowlist，禁止密码、session、hidden email、secret 等认证数据。Admin 可分页筛选读取全部业务审计；Factory 本阶段不获得 ActivityLog list 权限。

### 3.5 图片

- Phase 08 已建立 Product Hub 专用持久化 uploads volume 与 Storage Provider contract；V1 只实现 Local provider，未来 S3-compatible adapter 复用相同业务 service，不向客户端暴露 storage key。
- 一个 Product 最多一张 Product Main Image，由 Admin 管理；拥有 ENABLED Product 的 ACTIVE Assignment 的 Factory 可读。一个 Assignment 最多一张 Factory Private Image，仅对应 Factory 与 Admin 可读。
- 上传只接受 JPEG、PNG、WebP，原始文件最大 10 MB、单边不超过 8000 px、总像素不超过 2500 万。服务端同时校验 Content-Type、扩展名、魔数、Sharp 实际解码、格式、帧数与尺寸。
- 所有接受的输入经 EXIF orientation 处理后重新编码为静态 WebP（quality 88），默认剥离 EXIF/GPS/ICC 等 metadata；不保存或直接服务原始 bytes。
- Assignment REVOKED、Product DISABLED 或 Factory/User disabled 会立即阻断 Factory 图片访问，但不删除图片；Admin 仍可管理/读取，恢复有效状态后原图重新可见。
- Admin 将 Factory Private Image 提升为主图时创建独立 StoredObject 副本；Factory 后续替换或删除私图不会破坏主图。
- 文件与 PostgreSQL 不构成 ACID：先写新文件，再以事务写 StoredObject、业务关系和 ActivityLog；事务失败补偿删除新文件，提交成功后再清理旧对象。

### 3.6 导入导出

V1 批量导入对象为 Product；Factory 与厂家账号由 Admin 后台创建，不提供批量导入。导入固定流程：上传 → 解析 → 校验 → Preview → 显示新增/更新/错误 → Admin 确认 → 事务性正式导入。错误必须含工作表/具体行号/字段/原因，并提供官方 XLSX/CSV 模板。

Phase 09 决策：CSV 使用 UTF-8（官方文件带 BOM）；XLSX 只允许一个可见数据 worksheet。固定表头为 `product_id, SKU, 产品名称, 分类, 材质, 状态, 内部备注`，按表头名称映射且顺序可变。空 `product_id` 创建，非空只按 immutable UUID 更新；SKU 永不作为更新匹配键。Product 每行是 full-row semantics，空 SKU/备注写 NULL，必填业务字段不得为空。

导出支持 Product 与 Factory Quote 的 XLSX、CSV，以及全部数据或当前服务端筛选结果。权限过滤必须在生成导出文件之前执行，CSV 必须防 Formula Injection。

### 3.7 分配撤销

撤销 ProductFactoryAssignment 后，Factory 立即失去 Product 及相关 Quote 私有信息的访问权限。Assignment、FactoryQuote、PriceHistory、FactoryPrivateImage、ActivityLog 均不得物理删除，Admin 永久保留历史；以后重新分配同一 Product/Factory 也不能丢失旧历史。

Phase 05 决策：每个 Product/Factory 组合只保留一个稳定 Assignment，使用 `ACTIVE/REVOKED` 状态和 pair unique。撤销记录最近 revokedAt；重新分配清空 revokedAt、更新代表最近激活的 assignedAt，并保持 Assignment ID 与首次 createdAt 不变。Product 或 Factory 禁用不自动改写 Assignment 状态，但会立即阻断 Factory 读取。完整多次状态变化以后由 ActivityLog 记录。

### 3.8 认证补充

Better Auth 使用 username 登录并关闭 public sign-up。底层所需 email 使用隐藏的 `.invalid` 内部地址，不在 UI 暴露、不可由 Factory 编辑，也不提供邮件找回密码。关闭或屏蔽公开 username availability 能力，避免用户名枚举。

## 4. 页面基线

公共：`/login`

Admin：

- `/admin`
- `/admin/products`
- `/admin/products/[id]`
- `/admin/factories`
- `/admin/factories/[id]`
- `/admin/quotes`
- `/admin/activity`
- `/admin/users`
- `/admin/settings`

Factory：

- `/factory`
- `/factory/products`
- `/factory/products/[id]`
- `/factory/profile`

可使用 route groups 组织代码，但公开 URL 与业务范围保持不变。

## 5. 非功能需求

- 安全：默认拒绝、最小权限、逐请求授权、HTTPS、受控上传与下载。
- 可用性：清晰的空/加载/错误/重试状态；关键写操作反馈明确。
- 响应式：375px 起的移动体验与桌面体验分别设计。
- 性能：100+ 产品时无需微服务或搜索集群；服务端分页、筛选与索引足够，并为增长留出路径。
- 可恢复：数据库与上传文件均有独立备份、保留、校验和恢复演练。
- 可审计：关键业务修改可追溯且不记录密码或令牌。

## 6. 验收原则

任何功能只有在正向流程、失败状态、移动端以及跨厂家负向权限测试通过后才算完成。数据库约束和服务端授权是最终边界，前端可见性不是安全证明。

## 7. 待业务确认

仍需在对应阶段确认：

1. 清空已有价格为 NULL 时，Price History 的展示文案和纠错流程。
2. 备份保留期、异地备份位置和加密密钥管理。目标已确定为 RPO 24 小时、RTO 约 4 小时；完整 restore drill 在 Phase 10 完成。

## 8. Phase 10A Admin 日常工作台

- Admin 首页展示真实产品、厂家、有效分配、待报价/已报价与资料待补计数，以及最近产品和价格变化；禁止伪造趋势图。
- Product 支持 URL 驱动的搜索、状态/分类/材质筛选、排序、分页和 Table/Gallery；详情维护现有字段、主图、厂家分配、报价比较、Price History 与私图提升。
- Factory 支持搜索、状态筛选、分页、现有字段 CRUD，以及详情中的账号只读摘要、分配和报价覆盖。
- Quote workspace 以 Assignment 为任务来源，明确区分没有 Quote 的待报价与已提交；Admin 只读查看全部报价字段、派生 CBM、厂家备注、私图和价格历史。
- Settings 仅管理 Category/Material 的创建、改名与启停，并显示使用量。本阶段不包含 Factory Portal、Import/Export、Activity 或完整 Users UI。

## 9. Phase 10B Factory Portal 日常工作台

- Factory 首页只显示当前会话所属厂家的有效产品数、待报价/已报价数和最近自有报价，不显示全局统计或其他厂家信息。
- 产品列表采用图片优先卡片，支持 URL 驱动的关键词、报价状态、分类、材质和分页；数据范围固定为本厂 ACTIVE Assignment 且 Product ENABLED。
- 产品详情只读展示产品主图和基础资料；厂家可首次提交或更新自己的 RMB 报价、MOQ、包装尺寸、重量、每箱数量和备注。CBM 由尺寸实时预览并由服务端最终计算。
- 报价无草稿/自动保存；首次提交、更新、无修改和乐观并发冲突均有明确状态。价格变化才追加 PriceHistory，包装等非价格变化不制造价格历史。
- 每个有效 Assignment 最多管理一张厂家私图，支持 JPEG/PNG/WebP、10 MB 内上传替换、查看与确认移除；永不显示其他厂家私图。
- 账户页只读展示用户名、角色和厂家，支持验证当前密码后修改密码及退出登录。本阶段不允许厂家编辑主数据、分配、产品主图或其他厂家报价。

## 10. Phase 10C Admin Operations Completion 与 V1 Feature Freeze

- `/admin/products/import` 提供固定 CSV/XLSX 模板、安全上传、分页逐行预览、可读 diff/error、确认与 stale conflict 提示；Preview 不写产品，Confirm 复用 Phase 09 原子事务。
- Product 与 Quote workspace 按当前 URL 筛选从服务器导出 CSV/XLSX，下载前明确范围与条数；浏览器不生成业务文件。
- `/admin/activity` 支持事件、实体、厂家、操作者、日期和分页筛选，并提供集中中文映射、人类可读差异与安全详情。
- `/admin/users` 只管理 Factory User：ACTIVE Factory 搜索选择、创建、停用/恢复、重置密码与 session 撤销；账号/厂家状态分开，不显示 hidden email 或明文密码。
- Settings 统一产品字典、数据工具、当前 Admin 账户/改密和只读版本信息；Dashboard 增加真实工作入口。
- Phase 10C 验收后 Product Hub V1 进入 Feature Freeze。除 Phase 11 发现 Bug、安全缺陷、数据完整性问题或 Critical UX blocker 外，不再增加业务功能。

## 11. Hard Delete 正式产品边界

Hard Delete 属于受控 security/data-integrity maintenance，不是常规 CRUD。User 第一版仅允许永久删除 disabled Factory User：删除 User/Account/Session 及该 User 自身的 USER_CREATED/USER_ENABLED/USER_DISABLED 审计；Quote、PriceHistory、图片、ImportJob 等共享业务对象与其他业务历史保留，actor/provenance 变为 nullable/SET NULL，并显示为“已永久删除用户”或等价匿名状态。任何 Admin、当前登录/确认 Admin 与唯一 enabled Admin 均不可删除。

Phase 2 允许后台引擎规划 Product、Factory、User、Category、Material、Assignment、Quote、Product Main Image 与 Factory Private Image。Product/Factory 必须先停用，Category/Material 必须停用且零 Product 引用，Assignment 必须 REVOKED，Quote 的父 Assignment 必须 REVOKED。图片和 StoredObject 只按 surviving relation ref-count 删除，绝不按 creator/uploader ownership 删除。最终 Admin 删除 UI 不属于 Phase 2。

stdout Security Event 不进入逐对象闭包；当前安装的 PostgreSQL 与 uploads 是清理边界，历史 backup/运维日志按 retention 自然过期且不为单个对象改写。未来成功 Import confirm 必须写稳定 `resolvedProductId`；禁止按 SKU/name 推断旧 ImportRow，历史 ImportJob 作为独立 Hard Delete 对象处理。完整设计见 `HARD_DELETE.md`。
