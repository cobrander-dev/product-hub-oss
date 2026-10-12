# Product Hub 项目规则

## 项目目的

Product Hub 是部署在自有服务器上的中文“内部产品资料 + 厂家报价数据库”。Admin 管理产品、厂家、账号和分配；Factory 用户只处理分配给所属厂家的产品与报价资料。桌面端和移动端均为一等公民。本项目不是 CRM、客户报价、订单、物流或客户管理系统。

## Source of truth

发生冲突时，按以下优先级处理：

1. 已确认的用户指令与 `docs/PRODUCT_REQUIREMENTS.md`
2. 安全与租户隔离：`docs/AUTHORIZATION.md`、`docs/SECURITY.md`
3. 数据与系统设计：`docs/TECHNOLOGY.md`、`docs/DATABASE.md`、`docs/ARCHITECTURE.md`
4. UI、测试、部署和计划：`docs/DESIGN_SYSTEM.md`、`docs/TESTING.md`、`docs/DEPLOYMENT.md`、`docs/DEVELOPMENT_PLAN.md`

需求或架构变更必须先更新相应 source-of-truth 文档，再修改实现。不得用代码中的偶然行为反向覆盖文档规则。

## 开发规则

- 采用 TypeScript strict；输入、环境变量、导入文件和外部边界必须运行时校验。
- 默认使用 Next.js App Router、Server Components 和 Node.js runtime；只在需要交互时缩小范围使用 Client Components。
- 页面读取走服务层；UI 触发的写操作优先 Server Actions；认证回调、文件流、导入导出和健康检查使用 Route Handlers。
- Route Handler、Server Action 和服务层都不得直接信任客户端传入的 `factoryId`、角色、价格或文件元数据。
- 多表业务写入必须使用数据库事务；报价价格变化、价格历史和 Activity Log 必须原子提交。
- 金额使用整数分；尺寸和重量使用精确定点十进制；时间统一存 UTC、界面按 Asia/Shanghai 展示。
- 主键使用内部不可变 ID。SKU 可空、非空时唯一、允许修改，绝不作为关系键。
- 不硬删除已有业务历史所引用的厂家、产品、账号、报价或图片；使用禁用、归档或软删除策略。
- 不在业务逻辑中直接调用本地文件系统或 S3 SDK；必须通过 Storage abstraction。
- 依赖使用锁文件固定。升级框架、ORM、认证库或数据库大版本必须单独评估并有迁移与回滚方案。

## 禁止事项

- 禁止公开注册厂家账号。
- 禁止仅靠前端隐藏实现权限控制。
- 禁止跨厂家读取、枚举、修改或下载任何私有数据。
- 禁止将本地上传目录暴露为静态 public 目录，或使用可猜测的文件路径。
- 禁止客户端计算结果作为最终 CBM、权限或审计依据。
- 禁止浮点数存储人民币金额。
- 禁止覆盖价格历史或 Activity Log。
- 禁止绕过 Preview/确认流程直接批量导入正式数据。
- 禁止在日志中记录密码、会话令牌、数据库连接串、认证密钥或完整敏感上传内容。
- 禁止未经授权访问服务器、部署、push、创建标签或修改其他项目。
- 禁止未经确认扩大业务范围，例如审核流、草稿流、注册、支付、订单或聊天功能。
- 禁止添加 Lead Time、Delivery Time、交期、客户价格、销售价格、客户管理、订单状态、发货、Invoice、Customer Quotation 或 CRM 字段与功能。
- 禁止使用 0 表示未报价；未报价为 NULL，正常报价必须大于 0。

## 权限与安全要求

- 每个服务端入口必须先认证，再授权，再校验资源归属；默认拒绝。
- Factory 查询必须由服务端会话中的 `factoryId` 限定，不能以请求参数替代。
- 对具体资源的读写使用“角色 + 动作 + 资源归属”检查，列表和详情同样执行。
- 图片下载经过授权控制器；Factory 私图只允许所属 Factory 和 Admin。
- 账号禁用或密码重置后撤销既有会话。
- 所有关键业务修改写入 Activity Log；价格变化另写不可变 Price History。
- 文件上传执行扩展名、魔数/MIME、尺寸、像素、数量、文件名和权限校验，并重新生成存储键。
- 新增任何数据入口时，必须补充越权、IDOR、伪造参数和跨租户测试。

## UI 要求

- 中文界面，方向为 modern premium B2B SaaS：克制、清晰、细致，不套廉价后台模板。
- 使用统一 typography、spacing、radius、border、shadow 和语义色 token。
- 所有功能必须设计正常、空、加载、错误、禁用和权限不足状态。
- 移动端必须使用真正的卡片、移动导航、Sheet/Bottom Sheet、全屏编辑与触控尺寸，不得仅缩放桌面表格。
- 动效先用 CSS；Motion 仅用于有意义的状态、布局和手势过渡，并尊重 reduced motion。
- 可访问性目标为 WCAG 2.2 AA：键盘、焦点、语义、标签、对比度和错误提示均需验证。

## 测试要求

- 业务服务需要单元测试；数据库约束、事务、历史记录和授权需要集成测试。
- 每个 Factory 数据入口必须有跨厂家负面测试，包括手改 URL、ID、查询参数、表单和下载地址。
- Playwright 覆盖 Admin、Factory、桌面和移动核心流程；测试数据库和上传目录必须与正式环境隔离。
- 导入必须测试新增、更新、重复、空值、坏格式、行号错误、预览与确认的一致性。
- 合并前至少执行 lint、typecheck、unit/integration、关键 E2E、build 和 migration validation。

## Git 要求

- 保持提交原子且可审查；不要混入无关改动。
- 提交前检查 `git status`、`git diff --check`、暂存文件清单和测试结果。
- 仅暂存本次范围内的命名路径；禁止习惯性使用 `git add -A`。
- 不提交 `.env`、密钥、备份、上传文件、数据库卷或测试产物。
- 未经用户明确授权不得 push、部署、force push、rebase、改写历史或创建 tag。
- 每个 Phase 必须独立完成并停止；收到明确确认前不得进入下一阶段。

## V1 Feature Freeze 与 Phase 11 后的当前边界

- Phase 02 已完成认证、session、最小 Factory tenant、Admin/Factory role、账号启停、密码能力与中心化 server policy。
- Phase 03 已完成 semantic token、共享 UI foundations、响应式 Admin/Factory Shell、Login 视觉、development-only `/design-system` 和 UI/可访问性测试。
- Phase 04 已完成并审查通过：Product、Category、Material 与正式 Factory 主数据的 schema、migration、Admin-only application services、Server Actions、校验、分页/搜索和真实 PostgreSQL 测试。
- Phase 05 已完成并审查通过：稳定 ProductFactoryAssignment、撤销/复用式重新激活、Admin 双向 read models、Factory scoped Product list/detail 和跨租户测试。
- Phase 06 已完成并审查通过：FactoryQuote、整数分价格、Decimal 包装/重量、派生 CBM、乐观锁、append-only PriceHistory、Admin/Factory read models 和三厂家/生命周期测试。
- Phase 07 已完成 Business ActivityLog、typed allowlist writer、Master Data/Assignment/Quote 原子接入、Admin-only read service、回滚/敏感字段/跨租户测试。
- Phase 08 已完成 StoredObject、Local Storage Provider、JPEG/PNG/WebP 安全规范化、Product Main Image、Factory Private Image、受控读取、独立副本提升、文件/数据库补偿与图片 ActivityLog。
- Phase 09 已完成 Product CSV/XLSX Preview/Confirm 与 Product/Quote 导出服务和 API；本阶段仍没有导入导出 UI。
- Phase 10A 已完成 Admin 日常工作台：真实 Dashboard、Product/Factory CRUD UI、Assignment UI、Quote workspace/详情/比较/历史、主图与私图提升，以及 Category/Material 设置。
- Phase 10B 已完成 Factory 日常门户：真实 Dashboard、授权产品浏览/详情、自有报价提交更新、价格历史、厂家私图和账户资料/改密。
- Phase 10C 已完成 Import/Export UI、Activity、Factory Users 与 Settings，V1 功能冻结。Phase 11 只允许 hardening、运行脚本、文档、bug/security/data-integrity 修复。
- Phase 11 本地生产化验证完成后仍禁止进入 Phase 12、访问服务器、部署、DNS/TLS/Cloudflare 操作、push 或 tag，也禁止任何交期/订单/CRM 能力。
- Better Auth 通用 Admin mutation 不直接暴露给浏览器；账号能力由 server-only service 再次执行 `requireAdmin()`。
- User/Factory 禁用、密码重置和跨租户场景必须用真实 PostgreSQL 与真实 session 验证。
- 生产运维必须遵循 `docs/OPERATIONS.md`、`docs/BACKUP_RESTORE.md` 与 `docs/RELEASE_RUNBOOK.md`；禁止 `docker compose down -v`、`prisma migrate reset`、`prisma db push`、production test seed。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
