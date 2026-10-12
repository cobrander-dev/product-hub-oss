# 技术选型与官方资料核验

## Hard Delete implementation baseline

Hard Delete 沿用 Next App Router + Server Actions（preview/confirm）+ Node Route Handler（no-store status）+ Prisma/Storage abstraction/固定 SECURITY DEFINER controls。Radix Dialog 提供焦点陷阱/Esc；唯一正式 artifact 构建入口 release:build:amd64。

核验日期：2026-09-19。实现时依赖由 lockfile 固定；补丁升级先通过测试，主要版本升级单独评估。

## 推荐基线

| 技术           | 推荐              | 决策                                                                                                                                                                                 |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js        | 24.21.0 LTS       | Node 官方当前 24.x LTS 安全稳定补丁；满足 Next.js 16 与 Prisma 7 要求。生产镜像使用该补丁，Phase 10 再固定 digest。                                                                  |
| Next.js        | 16.3.x Active LTS | 使用 App Router、React Server Components、Server Actions、Route Handlers、`proxy.ts`，Node runtime，`output: 'standalone'`。当前安全补丁至少 16.3.3；创建项目时锁定当时最新 16.3.x。 |
| React          | 19.3.x            | 与 Next.js 16.3 当前稳定线配套，由 Next.js 兼容范围决定。                                                                                                                            |
| TypeScript     | 5.9.x             | Prisma 7 官方推荐线，生态组合更成熟；启用 strict。TypeScript 7 虽已发布，但不在未完成组合验证前采用。                                                                                |
| Tailwind CSS   | 4.3.x             | 使用 CSS-first、`@theme` 与设计 token；不使用过时 Tailwind v3 初始化教程。                                                                                                           |
| shadcn/ui CLI  | 4.21.x            | 组件源码归项目所有；使用 new-york 风格、Radix 基础、少量按需引入。                                                                                                                   |
| Motion         | 13.4.x            | 包名 `motion`，React 导入 `motion/react`；仅用于必要微交互。                                                                                                                         |
| Better Auth    | 1.7.x             | Email/password 基础 + username + admin 插件 + Prisma adapter；公开注册关闭。                                                                                                         |
| PostgreSQL     | 18.x              | 当前受支持最新主版本，固定当前 minor；项目独立容器、数据库、用户与卷。                                                                                                               |
| Prisma ORM     | **7.10.x**        | Prisma 8 截至核验日仍为 RC，不用于生产。显式安装 `prisma@7.10` 与 `@prisma/client@7.10`，避免 `latest` 指向 RC。                                                                     |
| Zod            | 4.6.x             | 所有不可信输入、环境变量、表单和导入行的共享 schema。                                                                                                                                |
| Playwright     | 1.63.x            | Chromium/WebKit/Firefox + 移动设备项目；授权矩阵必须 E2E。                                                                                                                           |
| ExcelJS        | 4.4.0             | XLSX template/import/export；只处理已通过 ZIP 结构预检的 Node Buffer，不执行公式或外部链接。                                                                                         |
| csv-parse      | 7.0.2             | 严格 UTF-8 CSV parsing、BOM、record-size 与列数检查；无外部依赖。                                                                                                                    |
| yauzl          | 3.4.0             | 在 XLSX 完整解析前 lazy 检查 central directory、entry 数、解压大小、压缩比与危险 OOXML entry。                                                                                       |
| Docker Compose | Compose v2        | 单机生产足够；开发与生产 overlay、健康检查、独立网络/卷/secret。                                                                                                                     |

补丁号来自核验当日官方发布页与 npm registry 快照，不是未来升级承诺。

## 关键方案选择

### Next.js

- 默认 Server Components，直接调用只读 application service，避免内部 HTTP 绕行。
- UI 表单 mutation 使用 Server Actions；认证 catch-all、受控图片、导入导出、外部/机器接口、health/readiness 使用 Route Handlers。
- `proxy.ts` 只做轻量会话存在性检查与路由重定向；数据库授权必须在服务层再次执行，不能把 Proxy 当安全边界。
- 默认 Node.js runtime，因 Prisma、图片处理、XLSX 解析和本地文件系统均更适合 Node；不使用 Edge runtime。
- 单实例 Compose 部署不需要共享 ISR cache。动态认证业务页面默认不做跨用户缓存。

### Better Auth

- 启用 `emailAndPassword.enabled`、`emailAndPassword.disableSignUp: true`、`minPasswordLength: 8`、username plugin 与 admin plugin。
- Better Auth 的 username 能力扩展自 email/password，Admin create-user 仍要求 email。V1 登录页只接受用户名；账号创建时生成唯一且不可投递的内部占位邮箱（建议 `<user-id>@users.invalid`），不显示、不发送邮件、不允许用邮箱登录 UI。
- 厂家角色和 `factoryId` 是服务端拥有字段，客户端不得写入。Admin 创建账号由受保护的应用服务封装，不直接把通用 Admin API 暴露给浏览器。
- 禁用用户/重置密码后撤销全部 session；敏感操作强制从数据库读取会话，不依赖长缓存。
- 不使用 Organization plugin 作为 V1 租户边界：Factory 本身是已有业务实体，重复一套 organization/membership 会增加漂移风险。`User.factoryId` 已支持一厂多用户；若未来出现“一用户属于多厂”再通过 ADR 引入 membership。

### Prisma 与 PostgreSQL

- Prisma 7 使用 ESM、显式 client output 和 `@prisma/adapter-pg`。
- migration 文件必须入库；生产使用 `prisma migrate deploy`，不使用 `db push`。
- 报价更新、Price History、Activity Log 在同一事务中提交。
- 数据库约束兜底：外键、唯一、check constraint、非空和索引。Prisma schema 无法表达的 check/partial index 通过 SQL migration 管理。

### UI

- shadcn/ui 是可拥有的组件源码，不当作黑盒组件包。组件安装按需执行并评审 diff。
- 简单 hover/focus/颜色过渡使用 CSS；Motion 只处理布局变化、Sheet/Drawer 状态和有意义反馈。
- 图像使用 `next/image` 的受控 loader/route；私有图片绝不放入 `public/`。

### Spreadsheet parsing/export

- ExcelJS 4.4.0 是当前正式稳定 release；由于其间接 `uuid@8` 有已修补 advisory，pnpm workspace override 固定为兼容的 `uuid@11.1.1`，并由 Phase 09 test/build 验证。
- csv-parse 7.0.2 仅使用 Node sync API 处理最大 10 MB/5000 行输入，配置 `bom`、`max_record_size`、严格列数；不会把 CSV cell 当代码执行。
- yauzl 3.4.0 使用 `lazyEntries + validateEntrySizes`，不解压到 filesystem。V1 不依赖 worker/queue，10 MB/5000 行上限以内在单次受控请求完成。

## 官方资料

- Next.js 16 与要求：<https://nextjs.org/blog/next-16>
- Next.js self-hosting：<https://nextjs.org/docs/app/guides/self-hosting>
- Next.js App Router：<https://nextjs.org/docs/app>
- Node.js releases：<https://nodejs.org/en/about/previous-releases>
- shadcn/ui Next.js：<https://ui.shadcn.com/docs/installation/next>
- shadcn/ui Tailwind v4：<https://ui.shadcn.com/docs/tailwind-v4>
- Tailwind CSS：<https://tailwindcss.com/docs>
- Motion React：<https://motion.dev/docs/react-installation>
- Better Auth installation：<https://better-auth.com/docs/installation>
- Better Auth username：<https://better-auth.com/docs/plugins/username>
- Better Auth admin：<https://better-auth.com/docs/plugins/admin>
- Better Auth Prisma：<https://better-auth.com/docs/adapters/prisma>
- Better Auth Next.js：<https://better-auth.com/docs/integrations/next>
- Prisma 8 release status（RC 风险）：<https://www.prisma.io/docs/orm/release-status>
- Prisma 7：<https://www.prisma.io/docs/orm/v7>
- PostgreSQL versioning：<https://www.postgresql.org/support/versioning/>
- Zod 4：<https://zod.dev/packages/zod>
- Playwright projects：<https://playwright.dev/docs/test-projects>
- Docker Compose production：<https://docs.docker.com/compose/how-tos/production/>
- OWASP Authorization：<https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html>
- OWASP File Upload：<https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html>
- ExcelJS releases：<https://github.com/exceljs/exceljs/releases>
- CSV Parse：<https://csv.js.org/parse/>
- yauzl：<https://github.com/thejoshwolfe/yauzl>

## Phase 01 安装纪律

- 不运行不带版本策略的 `latest` 安装后直接提交。
- 先生成临时脚手架并审查，再迁入本仓库，防止覆盖 Phase 00 文档。
- 必须确认 Next.js、React、Better Auth、Prisma 7、TypeScript 和 Node 24 的组合通过 build、migration 与最小认证 smoke test。
- Prisma 8 GA 后也不自动升级；缺失功能、生态兼容与迁移成本通过 ADR 评估。

## Phase 01 实际锁定版本

`pnpm-lock.yaml` 当前锁定：Next.js 16.3.5、React/React DOM 19.3.0、TypeScript 5.9.3、Tailwind CSS 4.3.3、shadcn 4.21.0、Motion 13.4.0、Better Auth 与 Prisma adapter 1.7.5、Prisma CLI/Client/adapter-pg 7.10.0、Zod 4.6.5、Playwright 1.63.0、pnpm 11.19.0。ESLint 固定 9.39.5，因为 Next.js 16 当前依赖的 React/import/accessibility plugins 尚未声明支持 ESLint 10；这是经 peer check 验证的兼容选择。

## Hard Delete Phase 1 技术约束

- PostgreSQL 是 operation 状态、对象闭包授权与 provenance 约束的 source of truth；Prisma 描述模型，forward-only SQL migration 承载 CHECK、partial index、FK 与 `SECURITY DEFINER`。
- privileged function 使用 PL/pgSQL、固定 `search_path=pg_catalog` 与完全限定对象名；禁止动态 SQL。
- 独立 PostgreSQL worker login 由受控 provisioning script 创建/轮换，只获固定函数 EXECUTE；Next.js Web runtime 不接收该 credential。
- uploads 删除采用数据库提交后的 durable `HardDeleteFileTask` 收敛，不把 PostgreSQL 与本地 filesystem 伪装成单一事务。Phase 1 不实现 worker runtime。

## Hard Delete Phase 2 技术约束

- canonical JSON 递归排序 key，并要求所有闭包数组稳定排序；SHA-256 同时绑定数据库 planner 与 Storage `stat` 结果。
- worker 只通过独立 `HARD_DELETE_WORKER_DATABASE_URL` 和 fixed SECURITY DEFINER functions 工作；Web runtime module 不读取该变量。
- 数据库 closure 使用单 transaction、fixed SQL、row/advisory lock 与 fresh planner equality；filesystem 使用 transaction outbox、幂等 delete/stat、指数退避和 durable task lease。
- Local Storage Provider 的 key listing 必须继续受根目录和 opaque-key 校验约束；绝对路径不得进入 operation、API 或日志。
