# 安全模型

## Hard Delete security contract

Worker secret 单独挂载于独立 production overlay，App/Migrator 无该挂载。安全 DTO 与错误仅输出允许字段。删除 stdout event 仅 operationId/entityType/fingerprint/status/timestamp，无标签/SKU/username/key。变更预览不能自动沿用旧摘要；生产操作必须由部署者独立授权。

## 1. 保护目标

最高优先级资产：厂家之间的报价/包装/重量/图片隔离、认证凭据与会话、Admin 权限、产品/分配完整性、价格和操作历史、数据库与上传备份。

主要威胁：IDOR/越权、伪造 factoryId、会话盗用、弱口令暴力尝试、恶意图片/表格、路径遍历、公式注入、CSRF/XSS、SQL 注入、日志泄密、磁盘耗尽、备份不可恢复、依赖供应链风险。

## 2. 信任边界

- 浏览器与任何请求内容均不可信。
- Next.js server 是权限执行点，但仍需校验数据库结果和存储对象。
- PostgreSQL 与上传卷仅在内部 Docker network/挂载内可达，不暴露公网端口。
- Reverse proxy 终止 TLS、限制请求体/速率并处理异常连接；应用仍执行自身认证授权。
- 备份离开主机后属于更高敏感区，必须加密并限制访问。

## 3. 访问控制

- 默认拒绝、最小权限、逐请求验证，规则见 `AUTHORIZATION.md`。
- `proxy.ts` 可在生产执行通用请求入口的精确 Host/Origin 拒绝规则，但不能代替每个 service/action/route 在读写前重新认证与授权。
- Factory 的数据库 query 必须包含 session-derived factoryId。
- 统一 404 处理未授权对象，防止枚举；内部审计保留拒绝原因。
- 生产数据库应用用户不使用 superuser；迁移账号与运行账号可分离。

## 4. 认证与会话

- Better Auth secret 至少 32 字节高熵，使用版本化 secret 轮换；不提交仓库。
- 密码 8–128 位是明确需求底线；UI 提供强密码提示但不擅自提高导致业务冲突。
- 登录错误统一，按用户名/IP 组合限速并渐进退避；监测异常失败。
- Cookie：Secure、HttpOnly、SameSite=Lax/Strict、host-only、HTTPS；认证 token 不进 localStorage。
- 禁用账号、重置密码、厂家禁用时撤销 session。敏感 Admin 操作使用 fresh session。
- 初始 Admin 通过受控一次性 CLI/部署步骤创建，密码不出现在 compose、shell history 或仓库。

## 5. 输入、输出与数据库

- Zod 在服务端验证所有边界；客户端校验仅提升体验。
- Prisma 参数化查询；raw SQL 仅在有必要时使用 tagged parameter，并集中评审。
- 富文本不在 V1；备注按纯文本存储和渲染，禁止 `dangerouslySetInnerHTML`。
- 设置 CSP、HSTS、X-Content-Type-Options、Referrer-Policy、frame-ancestors 等安全头；上线前验证与现有反代兼容。
- 状态改变只使用非 GET；依赖 Better Auth/框架 CSRF 与 Origin 校验，并为自定义上传/导入 route 明确校验 same-origin。

### 通用镜像的运行时来源边界

生产镜像不得包含客户域名作为构建时可信来源。每个实例在运行时配置唯一 `APP_DOMAIN`、同 Host 的 HTTPS `BETTER_AUTH_URL` 和仅包含该 URL 的 `BETTER_AUTH_TRUSTED_ORIGINS`，启动时不一致即失败。Next.js Server Actions 保留框架内置的 Origin 与 Host/X-Forwarded-Host 同源比较，不配置 wildcard 或额外跨域 `allowedOrigins`。由于 Next.js 对缺失 Origin 的 Server Actions 请求只警告，生产请求入口对所有状态改变请求额外要求精确 Origin；对不匹配的 Host、X-Forwarded-Host、X-Forwarded-Proto 或客户端传入的 Forwarded 头拒绝。仅 localhost 的健康探针可不带公网 Host。入口过滤不替代 Auth、Route Handler、Server Action 和 service 的既有鉴权。

App 仅绑定宿主机回环地址，唯一受信任的反向代理必须只接受本实例域名，并覆盖 Host、X-Forwarded-Host、X-Forwarded-Proto，丢弃客户端 Forwarded 头；不得将客户端提供的转发头原样传入应用。错误、缺失或重复的代理头必须 fail closed。唯一例外是本机回环 GET/HEAD 健康与就绪端点：Next.js 会在进入应用 Proxy 前把缺失的转发 Host/Proto 填为回环 Host/`http`，该精确组合允许安装器通过映射的回环端口探测；例外不覆盖任何状态改变请求或业务页面。正式验收须用同一 Runner image ID 在两个独立域名、数据库和上传卷下完成登录、Server Actions、表单及跨域/伪造头负向测试。

## 6. 文件上传与下载

基于 OWASP File Upload：

- 图片 allowlist 固定为 JPEG/PNG/WebP，单文件最大 10 MB；同时检查扩展名、实际魔数/MIME、解码成功、宽高、总像素和字节上限。
- 由应用生成 UUID storage key；原始文件名仅作经过清理的显示元数据，不能参与路径。
- 本地卷位于 webroot 之外，文件无执行权限；容器进程使用非 root。
- 图片可在隔离流程中解码并重新编码以移除活动内容/异常 metadata；资源允许时增加恶意软件扫描。
- 上传数量、请求体、并发和磁盘水位受限；达到阈值拒绝新上传并告警。
- 下载通过授权 Route Handler，设置准确 Content-Type、`nosniff`、安全 Content-Disposition 和私有缓存头。
- Factory 私图绝不返回永久公开 URL；未来 S3 使用短时 signed URL 或应用代理，并把租户授权放在签发前。

## 7. CSV/XLSX 安全

- 仅 Admin 上传导入；限制文件大小、worksheet 数、行数、列数、压缩比和解析时间，防 ZIP bomb。
- 解析库固定并及时修补；不执行宏、公式、外部链接或嵌入对象。
- Preview 展示纯文本，不渲染 HTML。
- CSV/XLSX 导出时，任何以 `=`, `+`, `-`, `@`, tab 或 CR 开头的文本需转义，防 spreadsheet formula injection。
- 导入正式写入前重新授权、验证 job owner/status/hash，使用幂等确认。

## 8. 审计与日志

- 业务 Activity Log 与 Price History 追加写入，应用 UI 不提供删除/编辑。
- 记录管理员账号管理、分配、导入导出、文件操作、登录失败/禁用和权限拒绝摘要。
- 永不记录密码、hash、session token、secret、完整 connection string 或原始敏感文件。
- 对来自用户的日志字段去除 CR/LF 等注入字符；日志访问受限，配置轮转和磁盘上限。

## 9. 基础设施

- Reverse proxy 仅暴露 443（80 只跳转）；web 与 db 使用 Product Hub 独立 network。
- PostgreSQL 不发布 host port；卷、容器名、环境、备份目录与现有服务隔离。
- 镜像使用受支持 Node/PostgreSQL 版本并固定 digest/补丁；运行非 root、只读 root filesystem（除明确 writable mounts）、drop capabilities。
- secrets 使用宿主机受限文件或 Compose secrets；`.env` 权限最小化且不进 Git。
- 定期依赖/镜像漏洞扫描，Critical/High 有修补 SLA；Next.js 安全补丁优先升级。

Release Readiness Repair 将间接依赖 `source-map-js` 的单一锁文件 resolution 从 1.2.1 修复到 1.2.2（GHSA-68fv-2mgg-jv7q）。现有 PostCSS/Tailwind 依赖范围已兼容，不升级 Next.js 或其他直接依赖。须用恶意 indexed source-map offset 与正常 source-map control 验证解析边界，并重新验证 production build 和 audit；不据此声称 Product Hub 已存在可利用的远程上传路径。

## 10. 安全验收门槛

- 授权矩阵集成/E2E 全通过，特别是跨厂家负向用例。
- 上传绕过、路径遍历、错误 MIME、超限、私图直链均失败。
- CSRF、XSS、CSV injection、SQL injection 基础用例验证。
- Cookie/安全头/TLS 配置检查通过。
- 备份恢复到隔离环境成功，且恢复后授权仍正确。

## 11. Phase 02 认证安全机制

- Better Auth 仅开放 username/password 登录、session、logout 与已认证用户 change-password 所需路径；公开注册、email 登录/找回、username availability、删除账号、角色修改和 impersonation 路径显式禁用。
- Better Auth 内置 rate limiter 在开发与生产都启用，单机使用 PostgreSQL storage；username 登录使用更严格的 endpoint rule。生产反向代理还需按真实 client IP 对登录路径限流，但 Phase 02 不虚构 Redis/distributed rate limit。
- `trustedOrigins` 来自受验证环境变量；保持 Better Auth 默认安全检查，并由认证 Route Handler 对每个 POST 强制要求精确匹配的 Origin，不启用 `disableCSRFCheck` 或 `disableOriginCheck`。
- Session 使用数据库记录和 HttpOnly、SameSite=Lax、host-only cookie；生产强制 Secure。关闭 cookie session cache，使账号/厂家禁用能在下一请求重新落到数据库授权。
- 登录错误在 UI 统一为“用户名或密码错误”，不区分不存在、密码错误、账号禁用或厂家禁用；内部日志也不记录 username、password、hidden email、token 或完整 IP。
- 认证安全事件通过 server-only abstraction 记录事件类型、结果、actorId/targetUserId（可用时）和时间；Phase 02 不创建正式 ActivityLog 页面或业务表。
- Admin reset password 使用 Better Auth 官方 hash，并撤销目标用户全部 session；Factory 自助修改要求 current password，并撤销其他 session。

## 12. Phase 07 Business ActivityLog 安全机制

- Business ActivityLog 与 Phase 02 security/auth logging 分离。登录成功/失败、logout、密码等高频认证事件不进入业务 Activity 页面数据源。
- Frozen V1 的 Factory User create/enable/disable 同时保留既有 Security Event，并新增 allowlist Business ActivityLog；后者只包含 server-derived actor、目标 User ID/username snapshot、factoryId 与状态 before/after。客户端不能提交 actor/event/diff，Factory caller 与非法目标在写入前拒绝。
- typed audit policy 对每个 event 固定 entity、changes fields 与 metadata fields；运行时拒绝非 allowlist key。客户端不能提供 actor、event、before/after 或 factory tenant。
- BigInt、Prisma Decimal、Date 在 writer 内分别规范为十进制字符串、规范 Decimal 字符串和 ISO timestamp；不通过 JSON stringify 整个 Prisma object。
- 备注超过 200 字只记录长度与短 SHA-256 摘要；密码、password hash、session/cookie/token、hidden email、CSRF、auth/database secret 没有可写入业务审计的字段。
- Quote 的 factoryId 由有效 Factory actor 与 Assignment 共同确定；越权和 validation 失败不产生 ActivityLog。Admin read service 是唯一业务读取入口，Factory 一律 FORBIDDEN。
- ActivityLog 不提供 update/delete service，也不自动过期。数据库 actor FK 为 RESTRICT，entity/factory snapshot 不级联；数据库角色/trigger 级禁止 UPDATE/DELETE 留到 Production Hardening。

## 13. Phase 08 图片安全机制

- Sharp 固定为 0.35.5（预编译 librsvg 2.63.2），修补 GHSA-wq5f-xc86-pv6w；应用与 Next.js 的 Sharp 依赖必须共同解析到修补版本。升级不改变下述格式、尺寸、授权或存储契约。
- 上传 Route 先检查可信 Origin 与已认证角色，再读取 multipart；有 Content-Length 时按 10 MB 加有限 multipart overhead 早拒绝，实际 File bytes 再执行 10 MB 硬限制。
- JPEG/PNG/WebP 必须同时通过声明 Content-Type、安全扩展名、magic signature、Sharp decode、真实 format、单帧、8000 px 单边与 2500 万总像素检查。SVG、GIF、BMP、TIFF、PDF、HEIC、AVIF、多帧与损坏输入拒绝。
- 接受的原始 bytes 不持久化。统一 `.rotate().webp({ quality: 88 })` 输出真实静态 WebP；Sharp 默认剥离 EXIF/GPS/ICC 和其他 metadata，读取 Route 永远按数据库验证过的 `image/webp` 服务。
- Local provider 只接受 `objects/<server UUID>.webp`；原始 filename 仅 basename/NFKC/control-character 清理后限 200 字保存，绝不参与路径。resolved path 必须保持在 Product Hub 专用 storage root 内。
- Product Main 与 Factory Private 均不在 `public/`，读取先做对象归属授权；响应使用 `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、固定 inline WebP 与 SHA-256 ETag。
- DB reference 与 ActivityLog 同事务；文件系统采用补偿。审计只记录安全 StoredObject ID 与 Product/Assignment/Factory context，不记录 bytes、绝对路径或原始 metadata。
- Production reverse proxy 必须配置与 10 MB 文件限制匹配的请求体上限、上传 route 限速与超时；应用侧限制不能替代 proxy 防护。

## 14. Phase 09 CSV/XLSX 安全机制

- 上传只接受 `.csv`/`.xlsx` 且最大 10 MB；CSV 必须是 UTF-8（允许 BOM），XLSX 必须匹配 ZIP magic。宏扩展名、损坏 archive、多个/隐藏 worksheet、超过 5000 行或 30 列、未知/重复/缺失表头均拒绝。
- XLSX 在 ExcelJS 解析前用 yauzl lazy central-directory inspection 限制 entry 数、总解压尺寸与单 entry 压缩比，并拒绝 VBA、externalLinks、embedding、OLE 与 ActiveX entries；任意公式或 hyperlink cell 拒绝。库固定为 ExcelJS 4.4.0、csv-parse 7.0.2、yauzl 3.4.0；ExcelJS 间接 uuid 固定覆盖为已修补 11.1.1。
- 原始 bytes 仅在请求内存中解析，不写 Local storage、临时路径或数据库。数据库保存 SHA-256 与规范化 staging rows；Preview 页面未来只能按普通文本渲染。
- confirm 使用 creator ownership、状态锁、错误计数、Product timestamp snapshot、Serializable transaction 与数据库唯一约束。重复 confirm、stale target、并发 SKU 冲突均安全失败且不产生部分 Product/ActivityLog。
- CSV 输出带 UTF-8 BOM；所有 string cell 对等号、加号、减号、@、tab、CR（含前导空白后的危险前缀）加单引号。XLSX 只写 string/number/null cell object，不写 formula object；响应使用 server-generated ASCII filename、attachment、nosniff、private/no-store。

## 15. Phase 10A Admin UI 安全机制

- Admin route guard 仅改善导航体验；每个聚合读取、Server Action 与图片 Route 仍独立验证会话和 ADMIN 权限。
- URL 筛选通过严格 schema 后进入 Prisma where/orderBy；不接受任意字段、SQL、客户端角色或 factoryId 作为授权依据。
- 客户端 DTO 排除 canonical key、storage key、hidden email 与认证数据。备注继续按 React 纯文本渲染，不使用 HTML 注入。
- 图片上传/删除/提升沿用 Phase 08 Origin、MIME、decode、尺寸与存储隔离；UI 不生成公开文件 URL。Factory 直达 Admin 页面在读取业务数据前被拒绝并重定向。

## 16. Phase 10B Factory Portal 安全机制

- Factory 页面和 read model 不信任 URL、表单或隐藏字段中的 factoryId；tenant 始终由已验证 session/User 推导，并在数据库 where 中与 Assignment/Quote/Image 同时约束。
- 跨租户、撤销 Assignment、停用 Product 与已知私图 ID 使用一致的 NOT_FOUND/404/不可用结果，避免资源枚举。Factory DTO 排除 internal notes、其他厂家报价和所有 storage metadata。
- 报价 mutation 沿用 Origin 检查、严格 Zod/Decimal 校验、Assignment 生命周期检查、Serializable transaction 和 expectedVersion 乐观锁。浏览器预览不替代服务端 CBM/金额规则。
- 私图 mutation 沿用 Phase 08 的 Origin、MIME、magic/decode、尺寸、10 MB 限制、对象路径隔离与补偿清理；替换/删除前重新验证当前 tenant 和有效 Assignment。

## 17. Phase 10C Admin Operations 安全机制

- Import/Export 继续使用 Phase 09 的 bounded parser、formula injection 防护、creator ownership、same-origin mutation、Serializable confirm 与安全下载响应；UI 不削弱任何边界。
- Activity 只渲染 allowlist `changes`、actor/entity snapshot、厂家名称和时间；不把 metadata、storage key、session、token 或 hidden email 发送到客户端。
- Factory User 创建使用随机 `.invalid` 内部邮箱但 UI/DTO 永不显示；密码只进入 Better Auth 官方 hashing API，不记录、不回显。reset/disable 撤销目标 session。
- Factory 对新页面和模板、preview、confirm、Product/Quote export API 均由服务端拒绝。URL filter 只经严格 Zod schema 进入 Prisma。
- Phase 10C 不增加角色、MFA、公开注册、邮件恢复、S3、Redis 或外部服务；相应 production hardening 只在 Phase 11 单独审查。

## 18. Phase 11 production hardening

- production 环境在容器入口和 Next instrumentation 双重校验 HTTPS auth origin、单一 trusted origin、secret 长度、PostgreSQL URL 和绝对存储路径；缺失或危险配置在业务监听前非零退出。
- 应用设置 CSP、frame deny、nosniff、no-referrer 与 Permissions Policy；HSTS 只由实际 TLS reverse proxy 设置。开发/测试仅为 React dev tooling 增加 `unsafe-eval`，production 不包含。
- runtime/migration DB role 分离。runtime role 不能 superuser/建库/建角色/建 schema，并在数据库层禁止更新、删除或 truncate PriceHistory/ActivityLog。
- App 只绑定宿主回环，PostgreSQL 无 published port；runner 非 root、read-only rootfs、drop ALL、no-new-privileges、tmpfs、resource/pid/log limits，并移除不需要的 npm/npx。
- Deep Scan status 为 **NOT RUN**，原因是 managed filesystem permission profile unavailable；不得记为 passed。替代证据为逐模块人工审查、真实 PostgreSQL/浏览器回归、dependency audit 与独立 Trivy runner scan。详见 `RISK_REGISTER.md`。

参考：

- <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html>
- <https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html>
- <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>
- <https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html>

## 19. Hard Delete privileged boundary

Hard Delete 使用独立 worker credential 与最小 `SECURITY DEFINER` 固定函数集。函数固定 `search_path=pg_catalog`、所有对象 schema-qualified，不接受 table/column/SQL/客户端 ID list；PUBLIC execute 被撤销。worker 无任何直接表权限，App 无 worker secret，且不能执行 claim/closure/file/finalize 函数。数据库闭包函数在 lease 与锁下重新校验 digest、CONFIRMED provenance、enabled Admin requester/confirmer、fresh planner 与 target blocker，失败全部回滚。

User 删除只移除 User/Account/Session 与目标 User 的三类 lifecycle audit；共享业务历史通过 nullable `SET NULL` provenance 保留，其他 ActivityLog actor 同时匿名化。Security Event、历史 backup 与运维日志不进入逐对象闭包。威胁模型、文件任务与完整约束见 `HARD_DELETE.md`。

Phase 2 worker mutation functions 增加 operation/task lease、row/advisory lock、fresh planner equality、digest/expiry/requester/confirmer 重验与固定 target CASE。worker credential 只存在于独立 secret scope，不进入 Web、client bundle、migration 日常环境、日志或错误正文。PUBLIC 无这些函数 EXECUTE；App 仅有 planner、confirm 与 Phase 3 preview-refresh 控制函数 EXECUTE，仍不能执行 worker mutation functions；App 对 ActivityLog/PriceHistory 的 UPDATE/DELETE/TRUNCATE 禁止保持不变。

## 20. Production bootstrap boundary

安装器只作用于显式 source env 指定的独立 Compose project。已有 database container/volume 必须具有相符 project label；未知数据库、orphan volume、角色/ownership/failed migration 不匹配均停止。Install 不 reset/drop 数据库，不自动回滚 migration，不 recreate 现有 PostgreSQL。Doctor 仅只读验证，不调用任何 Hard Delete claim/mutation function。

一次性 database-job 的凭据经 stdin 按阶段最小化传入，不写 Docker env/argv、generated Compose 或日志；Migration/App/Worker 的长期容器保持原身份边界。Worker secret 安放需要显式 root 权限，不隐藏 sudo，不放宽 root:root 0700 parent 与 1001:1001 0400 file。App/Migrator 不挂载 Worker secret。

初始 Admin 密码使用 TTY hidden prompt（含确认）或明确 `--password-stdin`，不得以 CLI argument、环境变量或 env file 提供。Bootstrap 复用 Better Auth 官方 hashing，用 App runtime credential 在一个事务与 advisory lock 下创建 User/Account；检查到已有任何 Admin 即拒绝并回滚。容器不开放端口、不常驻，不获得 Admin/Migration/Worker 数据库凭据或 Auth secret。

## 21. Immutable distribution boundary

GHCR workflow 不接收实例 env、客户域名或 Production secret，只使用 job-scoped `GITHUB_TOKEN` 写入 package。发布 manifest 是固定语法的非可执行公开元数据，只包含版本、commit、platform、digest、workflow run 与时间；parser 禁止 `source`/`eval`、未知字段、tag image 和 `latest`。

所有第三方 Action 固定完整 SHA。Tooling 与 source checkout 分离；三个镜像必须从 input source SHA 构建为 linux/amd64，OCI revision 不得使用 distribution SHA。发布前扫描实际 OCI archive：保留未过滤完整漏洞清单，有修复版本的 Critical/High 与 Critical/High secret 必须为零（Trivy `--ignore-unfixed` 仅用于区分有无修复），无修复项须在风险登记中复核，全部通过后才推送同一份 digest-preserving 内容；最终镜像构建时应用 Debian 可用安全更新；禁止扫描后重建。回读 registry 并验证 provenance/SBOM，manifest 同时记录两个 SHA 和 checksum。正式 SemVer 仅允许对已签名且成功 verification run 的 digest 做 promotion，禁止重建或使用 latest。PostgreSQL 同样固定 amd64 digest；原安装器权限边界不变。

## 22. Installer-control Docker socket boundary

Docker socket 等价于 host root，仅允许在 root 操作员显式运行的临时 installer-control container 中出现。Container 必须固定已验证 Migrator digest，使用 `--rm`、read-only rootfs、tmpfs、network none、cap drop、no-new-privileges、非 privileged 和最小 host mounts。operations bundle 与 `/opt/product-hub` 是唯一持久写入，Docker credential mount 只读且在 host 临时目录中随命令删除。

App、Hard Delete Worker、普通 migration、database-job 与 admin-bootstrap Compose service 禁止 Docker socket。Migrator image 内含 Docker CLI 不构成权限本身；没有 socket 时不能控制 daemon。Setup 在 image pull、secret generation、directory creation 或 Docker mutation 前执行 existing-install protection。所有 routine logs 参数固定 allowlist/bounds，不允许 shell/Compose passthrough。

Control container 在 drop ALL 后仅增加 CHOWN 与 DAC_READ_SEARCH，以创建并校验 1001:1001 0400 Worker secret；权限不传递给 App/Worker。network none 下健康探测通过 Docker exec 在 App 内执行，doctor 数据库检查通过既有一次性 database-job 的 verify 分支执行，只使用 read-only transaction，不修改数据库或长期服务。该诊断容器无 socket，结束即删除。

## 22a. Shared HTTPS gateway boundary

共享网关（`docs/HTTPS_GATEWAY.md`）是独立于 Product Hub 的 Compose project `oss-gateway`：官方 Caddy 镜像按 digest 固定，host 网络、只读根文件系统、`cap_drop: ALL` 仅加 `NET_BIND_SERVICE`、no-new-privileges；管理接口只在容器卷内 Unix socket，不监听 TCP。Product Hub 仅向其写入自己的站点文件，内容只能是本域名的单个站点块（不得 import），与安装器生成的反向代理头约定一致（覆盖 Host/X-Forwarded-*、丢弃 Forwarded、HSTS）。App 仍只绑定回环地址。网关无法安全接管的 80/443 占用者不得被停止、覆盖或修改。

## 23. Optional built-in HTTPS boundary

一键安装可选择内置 HTTPS：独立 Compose 项目 `product-hub-https` 复用与 App 相同、已扫描并 attestation 的 Runner digest 中的 Caddy（官方 tag 源码、补丁版 Go 构建），以 UID 1001、只读根文件系统、`cap_drop: ALL`、no-new-privileges 运行，只加入 App frontend 网络，不能访问 backend/PostgreSQL 网络；admin API 关闭，配置文件只读挂载且不含密钥。代理设置 12 MB 请求体上限与读写超时；HSTS 仅在域名模式发送。

无域名时 `APP_DOMAIN` 为公网 IPv4，`BETTER_AUTH_URL` 仍必须是同 Host 的 HTTPS origin。证书先向 Let's Encrypt 申请 `shortlived` IP 证书，失败则由 Caddy 本机 CA 签发，任何情况下都不以明文 HTTP 提供登录。本机 CA 模式下，管理员通过 `product-hub https` 获取根证书与 SHA-256 指纹，带外核对后导入客户端，不得指导用户忽略证书错误。回环、未指定、链路本地、组播与广播地址不能作为访问主机。所选 HTTPS 端口被占用时不得接管，只能换端口或使用现有反向代理（IP 模式不支持现有反向代理）。

自定义 HTTPS 端口时 origin 含端口，Host、X-Forwarded-Host 与 Origin 必须与 `host:port` 精确一致。浏览器 Cookie 不按端口隔离：同一主机名不同端口的其他项目能读取本项目 Cookie（名称不同，不会覆盖），因此多项目共存时推荐每个项目使用独立子域名。共享 80 端口转发（`docs/HTTPS_PORTS.md`）只转发明文 HTTP（ACME HTTP-01 与跳转），目标限定为 `*.acme-relay.invalid`，带防重复转发头；转发网络只连接各项目的 HTTPS 代理，不连接 App 或 PostgreSQL。
