# 开发阶段计划

> **Historical development roadmap — not deployment instructions.** 已完成/等待审查等状态仅记录研发过程，不代表第三方安装或当前生产状态。

> Distribution simplification Stage 2 adds the immutable GHCR workflow, strict release manifest, guided `setup.sh`, bounded `product-hub` operations CLI and layered end-user documentation. It does not publish packages, change Production, create a tag, change business logic/Prisma schema or add a migration. Controlled GHCR verification publish and real Ubuntu amd64 clean-host verification remain separate gates.

## Generalization Phase 3 — Production Bootstrap 授权基线

Phase 2 foundation 已人工审查 GO。Phase 3 仅新增首次安装编排、独立安全 Initial Admin、只读 doctor 与 disposable full-install/backup 验证；保持业务、schema、11 个既有 migrations 与 runtime 不可变表权限。只在本地隔离 Docker project 使用一次性凭据和自建 volume，不访问真实 Production。完成验证后提交 `feat(distribution): add production bootstrap` 并停止；不 push/tag、部署 Production 或进入 Phase 4。首次安装实际操作契约见 `PRODUCTION_QUICK_START.md`。

## Hard Delete Phase 3 授权基线（2026-09-30）

Hard Delete Phase 3 仅 Admin workflow 与隔离端到端验收；提交 feat(hard-delete): add admin deletion workflow 后停止，等待人工审查。Phase 4/production rollout、push/tag/生产迁移或 worker provisioning/start 未授权。

每个 Phase 都有明确入口、交付、验证和停止条件。Phase 完成后先报告，不自动进入下一阶段。

## Phase 00｜总控与架构（已完成）

交付：需求、技术选型、架构、数据、授权、设计系统、安全、测试、部署/备份、开发计划、AGENTS.md、Git baseline。

完成条件：文档内部一致、无页面/业务实现、Git clean、报告风险与待确认事项。停止并等待用户确认。

## Phase 01｜工程基础与可运行骨架（已完成，审查通过）

范围：

- 锁定 Node/包管理器和经验证依赖，创建 Next.js 16 App Router + TypeScript strict + Tailwind v4 + shadcn 基础。
- 建立目录、lint/format/typecheck/test/build、环境校验、错误边界、health/readiness。
- Compose 开发数据库、Prisma 7 初始化、migration 流程、独立测试数据库。
- 仅建立设计 token 与 App shell 骨架，不批量开发业务页。

验证：依赖安装、format、lint、typecheck、Prisma 空 schema、Playwright health smoke 和 production build 已建立；无 secret 入库。当前环境没有 Docker，容器实际构建留作工具可用时补验。停止等待确认。

## Phase 02｜认证、账号与授权地基（已完成，审查通过）

范围：Better Auth username/admin/Prisma、禁用注册、Admin bootstrap、login/logout/change password、Admin 创建/禁用/reset、User.factoryId、统一 Actor/policies。

验证：真实 PostgreSQL 18.6 migration 与 Better Auth E2E 已覆盖未登录、Admin、Factory A/B、禁用与旧 session、登录限流、来源校验、退出、密码重置/自助修改；手改 `factoryId` 不越权。

约束：只创建最小 Factory 与 Better Auth schema；已独立完成且不进入 Product/Quote/UI framework。等待审查后才可进入下一阶段。

## Phase 03｜设计系统与响应式应用框架（已完成，等待审查）

范围：基础组件审查、桌面 Sidebar、移动导航、页面 header、表单/表格/卡片模式、loading/empty/error、toast/dialog/sheet、accessibility baseline。

验证：规定视口、键盘、axe、reduced motion；不做假 dashboard 数据。

实际交付：正式 semantic token、Admin/Factory 响应式 Shell、Login 视觉、Radix/shadcn 基础组件、开发专用 Design System Showcase、桌面 Table/移动 Product Card、表单单位模式和完整视觉状态。未创建业务表、Dashboard 数据或 CRUD。

验证结果：六个精确 viewport 无横向溢出；Chromium/WebKit 桌面与移动交互通过；Login/Showcase axe WCAG 2.2 AA baseline 通过；Phase 02 真实 PostgreSQL 认证套件继续通过。Phase 03 完成后停止，不进入 Phase 04。

## Phase 04｜产品与厂家主数据（已完成，审查通过）

本次获准范围：Material/Category、Product、Factory 数据库模型与 Admin-only CRUD/启停 service、Server Actions、校验、错误模型、搜索筛选分页、正式 migration 与自动化测试。

实际交付：产品状态固定为 ENABLED/DISABLED，Category/Material 为后台字典；SKU nullable canonical unique 且可修改；Factory 扩展联系人/电话/备注；停用优先且外键限制破坏性删除。没有 production seed、主图 metadata、Assignment、Quote、图片或正式 CRUD UI。

验证：真实 PostgreSQL migration 与 replay、Master Data 服务/数据库/并发/权限集成测试、Phase 02 Auth 回归、Phase 03 UI 回归、静态检查和 production build。用户本阶段明确这是“数据库与 API 对话”，因此原计划中的桌面 Table/Gallery、移动 Cards 与正式 Admin 页面不在本次实现中，须在后续单独授权的 Admin UI 阶段消费现有 service。

## Phase 05｜产品分配与 Factory 产品视图（已完成，审查通过）

本次获准范围：稳定 Product/Factory Assignment、撤销/复用式重新激活、Admin 双向 read models、Factory scoped Product list/detail、正式 migration 与跨租户测试。

实际交付：一个 Product 可分配多个 Factory，一个 Factory 可拥有多个 Product；关系使用全局 pair unique 与 ACTIVE/REVOKED 状态。Factory read query 同时限制 session factoryId、ACTIVE Assignment、ENABLED Product，并排除 Product notes。

验证：重复/并发 assign、double revoke、reactivate 稳定 ID、禁用 Product/Factory/User、Factory A/B 列表/详情/搜索隔离、删除限制与完整 migration replay。本阶段按明确授权不做 Admin assignment UI、Factory Product UI、Product main image、Quote 或 ActivityLog；这些继续等待各自阶段授权。

## Phase 06｜报价、提交与历史（已完成，审查通过）

本次获准范围：稳定绑定 Assignment 的 FactoryQuote、人民币分、MOQ、包装尺寸、服务端派生 CBM、重量、PCS/Carton、纯文本备注、提交/更新提交、PriceHistory、事务、权限与乐观并发。

实际交付：不存在 Quote 即待填写，存在即已提交，不建 status/draft/autosave。价格为必填正 BigInt 分；尺寸和重量为 `decimal(12,3)`；CBM 不落库且缺项为 NULL；version 条件更新阻止 lost update。首次报价与首条历史、价格更新与新历史均在同一事务，非价格变化不制造重复历史。

验证：真实 PostgreSQL 上覆盖价格/可选字段边界、Decimal CBM、三厂家同产品报价隔离、Admin 全局只读、append-only PriceHistory actor、并发冲突、撤销/停用/恢复生命周期与历史删除保护。Phase 06 当时按明确授权不做正式 Quote UI、图片、导入导出或 ActivityLog；Quote 审计已在 Phase 07 接入原事务。

## Phase 07｜Business Activity Log & Audit Trail（已完成，审查通过）

本次获准范围：正式 ActivityLog schema、稳定 event/entity taxonomy、USER/SYSTEM actor model、字段级 JSONB diff、display snapshot、typed allowlist writer、Admin-only read model，以及 Master Data、Assignment、Quote mutation 的原子事务接入。

实际交付：Product/Category/Material/Factory create/update/enable-disable、Assignment assign/revoke/reactivate、Quote submit/update 均记录真实 USER actor；no-op 不产生日志。Quote、PriceHistory、ActivityLog 三者原子；长备注只存长度与 hash 摘要；Admin filters 在数据库执行，Factory 不扩权。认证/密码事件继续保留在 Phase 02 security log，未为接入审计重写 Better Auth。

Phase 12 Gate 4C-S 冻结需求修复：Factory User create/enable/disable 补齐 `USER_CREATED/USER_ENABLED/USER_DISABLED` Business ActivityLog，保留既有 Security Event；actor 仅来自 Admin session，状态沿用 `User.banned`，不新增账号状态模型或其他 User 管理能力。

验证：真实 PostgreSQL 覆盖事件语义、actor/snapshot、分页筛选、跨租户、敏感字段 allowlist，以及通过测试库临时 trigger 强制审计失败后的事务整体回滚。本阶段没有正式 Activity UI、图片、导入导出或服务器操作。

## Phase 08｜图片存储与主图提升（已完成并审查通过）

本次获准范围：Storage contract、Local adapter、受控上传/下载、每 Product 一张主图、每 Assignment 一张厂家私图、Admin 独立复制提升、ActivityLog、补偿与 Docker volume 验证。

实际交付：上传只接受最大 10 MB 的 JPEG/PNG/WebP，经 magic/decode/frame/8000 px/2500 万像素验证后处理 orientation、剥离 metadata 并统一输出静态 WebP。所有文件位于非 public 的 Local provider；受控 route 返回 private/no-store WebP。主图与私图分别绑定 Product/Assignment，replacement 与 promotion 使用独立 StoredObject 和文件/DB 补偿。

验证：真实 PostgreSQL 与隔离上传目录覆盖格式伪造、超限、路径遍历、metadata stripping、HTTP delivery、Assignment/Product/Factory 生命周期、跨厂 ID、独立 promotion、Activity 失败补偿和旧清理失败 orphan。Phase 02–07 回归、全新 migration replay、production build 与 Docker non-root/read-only rootfs/writable named volume 必须继续通过。本阶段不做正式图片 UI、Import/Export、服务器或 S3。

## Phase 09｜导入导出（已完成，等待审查）

范围：Product CSV/XLSX 官方模板、ImportJob/Row、解析/校验/Preview/确认/幂等、行级错误、Product/Factory Quote 全部或筛选导出、公式注入防护。Factory/账号不做批量导入。

实际交付：`product_id` 空为 CREATE、非空只按 immutable ID UPDATE；固定七列表头按名称映射，Category/Material canonical ACTIVE match，最多 10 MB/5000 行。Preview 仅写 staging，Confirm 锁 job/Product 并复用 Product audit mutation，在一个 Serializable transaction 全有或全无。Admin 可下载 CSV/XLSX template，并按服务端筛选导出最多 10000 行 Product/Factory Quote。

验证：真实 PostgreSQL 与真实 Admin/Factory session 覆盖 105 行 CSV、XLSX create/update/no-change、row errors、stale rollback、duplicate confirm、Factory 全拒绝、公式/多 sheet/坏 magic/5001 行、API Route、三厂家 Quote filter、BOM 与 CSV/XLSX injection。Phase 02–08 回归、migration replay、build 与 Docker 门禁继续保留。本阶段不做正式 Import/Export UI、服务器、队列或 Phase 10。

## Phase 10｜Dashboard、Activity 与 UX 完整化

范围：真实查询驱动的 Admin/Factory dashboard、Activity 浏览、全局状态打磨、图片/表格性能、移动端和无障碍修复。

不得硬编码统计。验证结果必须来自权限过滤后的真实数据。

### Phase 10A｜Admin Operational UI（已完成并审查通过）

实际交付：Admin 真实 Dashboard、Product Table/Gallery 与 CRUD、主图、Factory CRUD、双向 Assignment、Quote 待报价/已提交 workspace、详情、三厂家比较、PriceHistory、私图查看/提升、Category/Material 管理。所有 mutation 复用 Phase 04–08 service/action/route，Quote 对 Admin 保持只读。

范围边界：没有 Factory Portal 业务 UI、Import/Export UI、Activity 页面、完整 Users 页面、schema/migration、production seed、部署或服务器操作。

验证：真实 `_test` PostgreSQL/隔离 storage 的 Admin UI Playwright fixture 与 desktop/mobile/axe/权限用例；Phase 02–09 regression、静态检查、production build、diff/secret checks 继续作为提交门禁。

### Phase 10B｜Factory Portal Operational UI（已完成并审查通过）

实际交付：Factory 真实 Dashboard、图片优先产品列表与 URL 筛选、产品详情/主图、自有报价首次提交与乐观锁更新、CBM 预览、PriceHistory、厂家私图上传替换移除，以及账户资料、改密和退出。

范围边界：没有 Factory 主数据/Assignment/Product 编辑，没有其他厂家报价或私图，没有 Import/Export UI、Activity、完整 Users、schema/migration、production seed、部署或服务器操作。

验证：真实 `_test` PostgreSQL/隔离 storage 的 Factory UI Playwright fixture 覆盖 tenant isolation、生命周期、报价/历史/并发、图片、账户、375–1440 响应式和 axe；Phase 02–10A 回归、静态检查、production build、diff/secret checks 继续作为提交门禁。

### Phase 10C｜Admin Operations Completion（已完成，V1 Feature Freeze）

实际交付：Product Import 模板/上传/分页预览/确认/冲突、Product 与 Quote 当前筛选 CSV/XLSX 导出、Business Activity 列表/筛选/可读差异/安全详情、Factory User 创建/停用恢复/重置密码、Admin 改密，以及 Settings/Dashboard 最终信息架构。

范围边界：完全复用 Phase 02/07/09 正式能力；没有 schema/migration、CRM、订单、库存、物流、新角色、MFA、邮件、S3、Redis、服务器、部署或 push。

验证：Phase 10C 独立 Playwright suite 覆盖 Import/Export/Activity/Users/Settings、Factory 页面与 endpoint 负向、375–1440 响应式和 axe；Phase 02–10B regression、静态检查、build、diff/secret checks 继续作为提交门禁。通过审查后 V1 Feature Freeze，仅允许 Phase 11 hardening 类修复。

## Phase 11｜生产化与上线准备（已完成本地验证，等待审查）

范围：生产 Dockerfile/Compose overlay、reverse proxy 配置草案、secrets、迁移 job、日志/监控、backup/restore scripts 与 runbook、安全 headers/rate limits、完整 E2E。

实际交付：fail-fast runtime env、health/ready 分离、安全头、分离数据库账号与 append-only grants、加固 Compose、backup/restore/checksum/orphan 工具、Nginx 草案、运行/发布/回滚文档与风险登记。

验证：隔离 Docker 全新 migration、non-root/read-only runtime、持久化、Admin bootstrap、备份—空库恢复、corruption detection、5000 行 import、图片边界/并发、依赖与镜像扫描以及完整回归。Deep Scan 因 managed filesystem permission profile unavailable 为 NOT RUN，不能视为通过。仍未连接正式服务器或开始 Phase 12。

## Phase 12｜受控部署（需单独授权）

入口条件：服务器访问、域名/DNS、备份目标、维护窗口、部署范围均获明确批准。

步骤：部署前盘点现有服务且只读 → 验证命名无冲突 → 备份/配置 → 独立 Compose 部署 → migration → TLS/proxy → smoke/隔离测试 → 报告。不得操作 n8n 或 foreign-trade-invoice-generator 容器/数据库。

## 横向门禁

每阶段必须：

1. 先重读 source-of-truth 与待确认项。
2. 只修改本阶段授权范围。
3. 添加对应正向、失败、跨租户和响应式测试。
4. 检查 status/diff/diff-check/测试/构建。
5. 报告文件、风险、未验证项，停止等待确认。

## 已知风险与缓解

| 风险                                       | 影响                        | 缓解                                                              |
| ------------------------------------------ | --------------------------- | ----------------------------------------------------------------- |
| Better Auth 用户名建立在 email/password 上 | Admin 创建用户仍需 email    | 生成隐藏 `.invalid` 占位邮箱，关闭注册/邮件/邮箱 UI，封装创建服务 |
| Prisma `latest` 当前指向 8 RC              | API/功能仍变化且存在缺失    | 显式锁定 7.10.x，不使用 `latest`；GA 后 ADR                       |
| 本地 volume 与 DB 非天然原子               | 图片/元数据或备份可能不一致 | 暂存+补偿+orphan cleanup；维护窗口一致备份；manifest/checksum     |
| Activity JSON 可能泄密/膨胀                | 安全与磁盘风险              | 字段 allowlist、脱敏、批量摘要、索引/保留策略                     |
| Admin 与 Factory 共用同一应用              | 一处漏检可越权              | Actor/policy/service 集中化，逐入口授权矩阵和 A/B 负向测试        |
| 导入可绕过 UI/制造大量写入                 | 数据污染和 DoS              | 严格限额、Preview、hash、幂等、事务、Admin-only                   |
| 手机长报价表单                             | 易误操作/丢数据             | 分组、固定操作、错误定位、冲突保护；不擅自增加草稿                |
| 服务器已有其他 Docker 服务                 | 命名、资源或误操作冲突      | 独立 project/network/volume/db/backup，禁止全局 prune，部署前盘点 |

## 当前需确认但不阻塞 Phase 00

统一清单见 `PRODUCT_REQUIREMENTS.md` 第 7 节。Phase 01 可先完成工程骨架；具体业务决策须在其所属 Phase 开始前确认。

## Hard Delete Phase 1｜Foundation / Schema / Privilege Design（本地实现）

范围只包含 source-of-truth、HardDeleteOperation/FileTask schema、Import resolvedProductId、User provenance SET NULL、最小 disabled Factory User SECURITY DEFINER function、worker role provisioning 与隔离回归。禁止生产部署、真实 operation/data deletion、最终 UI、其他对象闭包与 Final Production Readiness。

## Hard Delete Phase 2｜Planner / Durable Worker / File Consistency Engine（本地实现）

范围包含九类已授权 target planner、Admin-only preview/confirm backend、operation/task lease、固定 privileged closure execution、transaction outbox 文件收敛、retry/crash recovery、final verification、orphan scanner integration 与 disposable PostgreSQL/filesystem 测试。`IMPORT_JOB` 保留为后续独立 target。本阶段禁止最终 UI、生产部署、正式数据删除、push/tag 与 Phase 3。

Phase 2 已获得本地实现授权，并基于 `HARD_DELETE.md` 实现 preview/confirm service、各对象固定闭包与 file worker；最终删除 UI 明确保留给 Phase 3。Phase 1 的旧函数已禁用，当前函数集不使用动态 SQL dispatcher。
