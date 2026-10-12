# 数据库设计

## Hard Delete preview refresh contract

固定 `refresh_hard_delete_preview` 使用目标 advisory lock + operation 行锁，只刷新 PREVIEWED 同一任务并递增 version，不删除数据。PUBLIC EXECUTE 撤销；runtime grant allowlist 只包含该预览函数，ActivityLog/PriceHistory 的 App DELETE 继续拒绝。

数据库：独立 PostgreSQL 18.x。所有业务表使用内部不可变 ID（建议 UUIDv7；若 Prisma/数据库支持不一致则由应用生成 UUID）。时间为 `timestamptz`，统一存 UTC。

## 1. 实体关系

```text
Factory 1 ── * User
Factory * ── * Product                 via ProductFactoryAssignment
Product 1 ── * ProductFactoryAssignment
ProductFactoryAssignment 1 ── 0..1 FactoryQuote
ProductFactoryAssignment 1 ── 0..1 FactoryPrivateImage
Product 1 ── 0..1 ProductMainImage
ProductMainImage 1 ── 1 StoredObject
FactoryPrivateImage 1 ── 1 StoredObject
FactoryQuote 1 ── * PriceHistory
User 1 ── * PriceHistory               as actor
User 1 ── * ActivityLog                as actor
ImportJob 1 ── * ImportRow
Material 1 ── * Product
Category 1 ── * Product
```

Better Auth 还生成/拥有 session、account、verification 等认证表。认证 schema 由 Better Auth CLI 生成后纳入 Prisma migration 并人工评审，不手写密码哈希。

### Phase 02 实际迁移范围

Phase 02 只迁移认证与授权所需的 `Factory`、`User`、`Session`、`Account`、`Verification`、`RateLimit`。当时不会创建 Product、Category、Material、Assignment、Quote、PriceHistory、FactoryPrivateImage、StoredObject、ImportJob 或 ActivityLog。

- Factory 仅含 `id, name, status, createdAt, updatedAt`，状态为 `ACTIVE/DISABLED`。
- User 使用 Better Auth 核心字段、username plugin 字段、admin plugin 的 role/ban 字段，以及 nullable `factoryId` 外键。
- role 只允许 `ADMIN/FACTORY`；数据库 check 强制 ADMIN 的 `factoryId IS NULL`，FACTORY 的 `factoryId IS NOT NULL`。
- username 在 Phase 02 认证方式下为必填 canonical lowercase unique 值；hidden email 是随机 `.invalid` 地址，不从 username 推导。
- `banned` 是 User 认证状态的单一来源，不创建重复的 enabled/status 列。
- RateLimit 使用 Better Auth 官方数据库模型，为单机登录限速持久化计数。

### Phase 04 实际迁移范围

Phase 04 migration `20260918183000_phase_04_master_data` 新增 `Category`、`Material`、`Product`，并把 Phase 02 的最小 `Factory` 扩展为正式主数据。没有创建 Assignment、Quote、History、图片或 StoredObject 表，也没有写入正式 seed。

- Category/Material 使用 `ACTIVE/DISABLED`，名称由展示值和不可对外暴露的 canonical key 共同保证 trim 后不区分大小写唯一。
- Product 使用 `ENABLED/DISABLED`；`sku` 可空，`skuNormalized` 对非空 SKU 提供 trim 后不区分大小写的数据库唯一约束；关系始终引用不可变 UUID，不引用 SKU。
- Product `name`、`categoryId`、`materialId` 为必填。Phase 00 将产品名列为正式字段；本阶段不增加更复杂的命名规则。
- Factory 新增 `contactName`、`phone`、`notes` 与名称 canonical key；没有加入 code、shortName、地址、银行、税号、账期或 ERP 字段。
- 本阶段不创建 Product main image 外键；StoredObject 与图片能力继续留到图片阶段。

### Phase 05 实际迁移范围

Phase 05 migration `20260918193000_phase_05_product_factory_assignments` 新增稳定的 `ProductFactoryAssignment`。每个 Product/Factory 组合在数据库中只能有一行；撤销与重新分配通过状态变化复用同一 ID。本阶段没有创建 Quote、History、ActivityLog、图片或 StoredObject。

### Phase 06 实际迁移范围

Phase 06 migration `20260918210000_phase_06_factory_quotes_price_history` 新增 `FactoryQuote` 与 `PriceHistory`。一个 Assignment 最多一份当前 Quote；Quote 与首次/后续价格历史在同一事务创建。CBM 为服务端确定性派生值，不持久化。本阶段没有创建 ActivityLog、图片、StoredObject、导入导出表或正式 Quote UI。

### Phase 07 实际迁移范围

Phase 07 migration `20260918223000_phase_07_business_activity_audit` 新增 USER/SYSTEM actor source、稳定 ActivityEventType/ActivityEntityType enum 与 `ActivityLog`。Master Data、Assignment、Quote mutation 已接入同事务审计；没有创建图片、StoredObject、导入导出或正式 Activity UI。

### Phase 08 实际迁移范围

Phase 08 migration `20260919090000_phase_08_secure_image_storage` 新增 `StoredObject`、`ProductMainImage`、`FactoryPrivateImage` 和 LOCAL storage provider enum，并扩展图片 Activity events。一个 Product/Assignment 各最多一张当前图片；所有对象引用与 User/Product/Assignment 使用 RESTRICT。没有创建 Import/Export 表或正式图片 UI。

### Phase 09 实际迁移范围

Phase 09 migration `20260919130000_phase_09_product_import_export` 新增 `ImportJob`、`ImportRow` 以及 PRODUCT/PREVIEW_READY/CONFIRMED、CREATE/UPDATE/NO_CHANGE/ERROR 稳定 enum。原 CSV/XLSX bytes 与临时路径不入库；数据库只保存安全文件名、SHA-256、统计、规范化行、diff/error、目标 Product 与 `updatedAt` snapshot。导出不新增持久化表。

## 2. 核心实体

### Factory

| 字段                | 类型/约束       | 说明                    |
| ------------------- | --------------- | ----------------------- |
| id                  | UUID PK         | 不可变                  |
| name                | text            | 厂家名称                |
| nameNormalized      | text unique     | 内部唯一键，不返回 UI   |
| contactName         | text nullable   | 联系人                  |
| phone               | text nullable   | 联系电话                |
| status              | ACTIVE/DISABLED | 禁用后用户不能登录/访问 |
| notes               | text nullable   | Admin 内部纯文本备注    |
| createdAt/updatedAt | timestamptz     | 审计时间                |

不硬删除已产生分配、报价或历史的厂家。

Phase 02 的最小 Factory 不含联系人、电话和备注；上述字段由 Phase 04 正式加入。Factory 名称唯一，现有 Phase 02 行在 migration 中先 trim/backfill canonical key 再设置 NOT NULL。

### User（Better Auth user 扩展）

| 字段                | 类型/约束        | 说明                                             |
| ------------------- | ---------------- | ------------------------------------------------ |
| id                  | text/UUID PK     | 由 Better Auth 策略决定，业务引用该 ID           |
| username            | text unique      | canonical lowercase 登录名；创建后不可由用户修改 |
| email               | text unique      | Better Auth 必需的内部占位值，不展示             |
| role                | ADMIN/FACTORY    | 服务端拥有字段                                   |
| factoryId           | UUID nullable FK | FACTORY 必填，ADMIN 必须为空                     |
| banned/status       | auth-owned       | 禁用账号                                         |
| createdAt/updatedAt | timestamptz      | 时间                                             |

数据库增加 check：username 必填且为 trim 后小写、email 使用 `.invalid` 域；`role=FACTORY` 时 `factoryId IS NOT NULL`，`role=ADMIN` 时 `factoryId IS NULL`。一个 Factory 可关联多个 User。

### Material / Category

`id, name, nameNormalized unique, status(ACTIVE/DISABLED), createdAt, updatedAt`。Product 引用不可变 ID。V1 不加入 code、sortOrder 或 hierarchy；材质业务值由 Admin 创建，不作为 enum 或 production migration seed。已被引用的字典可停用，现有 Product 关系保留；停用记录不能用于新建或改绑 Product。

### Product

| 字段                | 类型/约束        | 说明                                           |
| ------------------- | ---------------- | ---------------------------------------------- |
| id                  | UUID PK          | 内部不可变 ID                                  |
| sku                 | text nullable    | 非空时唯一；写入前 trim；空字符串归一化为 null |
| name                | text not null    | 产品名                                         |
| categoryId          | UUID FK not null | V1 每个 Product 对应一个后台 Category          |
| materialId          | UUID FK not null | V1 一个 Product 对应一个后台 Material          |
| status              | ENABLED/DISABLED | 启用/停用，不扩展复杂生命周期                  |
| notes               | text nullable    | Admin 内部纯文本备注                           |
| createdAt/updatedAt | timestamptz      | 时间                                           |

数据库中 `skuNormalized` 为 nullable unique：多个 NULL 合法，非空值以 trim + uppercase canonical 形式唯一；check constraint 强制展示 SKU 与 canonical key 成对一致。名称、外键、enum 和时间戳也由数据库约束。V1 搜索用 PostgreSQL 对 SKU/名称做简单不区分大小写 contains；SKU 唯一索引及列表筛选索引已建立，不引入全文搜索系统。

### ProductFactoryAssignment

| 字段                | 类型/约束            | 说明             |
| ------------------- | -------------------- | ---------------- |
| id                  | UUID PK              | 分配 ID          |
| productId           | UUID FK              | 产品             |
| factoryId           | UUID FK              | 厂家             |
| status              | ACTIVE/REVOKED       | 当前关系状态     |
| assignedAt          | timestamptz          | 最近一次激活时间 |
| revokedAt           | timestamptz nullable | 最近一次撤销时间 |
| createdAt/updatedAt | timestamptz          | 时间             |

`createdAt` 表示这对 Product/Factory 关系第一次建立的时间；`assignedAt` 表示首次分配或最近一次从 REVOKED 重新激活的时间；ACTIVE 时 `revokedAt` 必须为 NULL，REVOKED 时记录最近撤销时间。同一 `(productId, factoryId)` 有全局 unique constraint，重新分配必须复用原行并保持 ID/createdAt 不变。Phase 07 已用 `ASSIGNMENT_ASSIGNED/REVOKED/REACTIVATED` 追加完整业务时间线。

### FactoryQuote

| 字段                             | 类型/约束              | 说明                                 |
| -------------------------------- | ---------------------- | ------------------------------------ |
| id                               | UUID PK                | 报价 ID                              |
| assignmentId                     | UUID unique FK         | 一项稳定分配最多一份当前报价         |
| priceCents                       | bigint not null        | RMB 分，必须 > 0                     |
| moq                              | integer nullable       | 正整数，默认单位 PCS                 |
| packingLengthCm/WidthCm/HeightCm | decimal(12,3) nullable | 填写时 > 0，最多三位小数             |
| netWeightKg/grossWeightKg        | decimal(12,3) nullable | 填写时 > 0；两者存在时 gross >= net  |
| pcsPerCarton                     | integer nullable       | 正整数，默认含义 PCS/Carton          |
| factoryNotes                     | text nullable          | 厂家私有纯文本，服务校验最多 5000 字 |
| submittedAt                      | timestamptz not null   | 首次正式提交时间                     |
| version                          | integer default 1      | 乐观锁，每次正式更新 +1，必须 >= 1   |
| createdAt/updatedAt              | timestamptz            | 创建与最近更新提交时间               |

待填写状态由“不存在 FactoryQuote”表达；存在即已正式提交，因此没有 status、草稿或 autosave。CBM 不落库：服务端按 `packingLengthCm * packingWidthCm * packingHeightCm / 1_000_000` 使用 Prisma Decimal 计算到足够内部精度，任一尺寸为空则 DTO 返回 null；客户端不能传 CBM。BigInt 与 Decimal 在 DTO 中序列化为字符串，不经 JavaScript number。

### PriceHistory

`id, factoryQuoteId, oldPriceCents nullable, newPriceCents, changedByUserId, changedAt`。

- 首次提交追加 `NULL → 首次价格`，以后仅实际价格变化时追加；相同价格修改包装等字段不生成重复行。
- 不冗余 assignment/product/factory；稳定的 `PriceHistory → FactoryQuote → ProductFactoryAssignment` 关系已经保留业务身份并避免多份 source of truth。
- `changedByUserId` 为不可空 User FK 且 `ON DELETE RESTRICT`，禁用账号不影响历史；读取时关联当前 actor 标识。
- service 只有 create/read，没有 UPDATE/DELETE；Quote、Assignment 与 actor 的外键均保护历史不被级联删除。

### ActivityLog

| 字段                  | 类型/约束                     | 说明                                                  |
| --------------------- | ----------------------------- | ----------------------------------------------------- |
| id                    | UUID PK                       | 审计事件 ID                                           |
| eventType             | ActivityEventType             | 稳定机器事件值                                        |
| entityType/entityId   | enum + text                   | 业务对象类型与不可变 ID snapshot                      |
| entityLabelSnapshot   | text                          | SKU/名称等最多 500 字的少量显示快照                   |
| actorSource           | USER/SYSTEM                   | Phase 07 当前事件均为 USER；为未来系统任务预留 SYSTEM |
| actorUserId           | User FK nullable, RESTRICT    | USER 必填，SYSTEM 必须为空                            |
| actorRole             | ADMIN/FACTORY/SYSTEM snapshot | 操作时角色                                            |
| actorUsernameSnapshot | text                          | 操作时 username；不存 hidden email                    |
| factoryId             | UUID nullable                 | 有租户语义时保存稳定 ID，不设级联外键                 |
| changes               | jsonb object, non-empty       | allowlist 字段的 `{ field: { before, after } }`       |
| metadata              | jsonb object nullable         | event policy 允许的稳定关联 ID                        |
| createdAt             | timestamptz                   | 事件时间；没有 updatedAt                              |

事件 enum 覆盖 Product/Category/Material/Factory 的 create/update/enable/disable、Assignment assign/revoke/reactivate、Quote submit/update、User create/enable/disable，以及主图 set/replace/remove/promote、私图 set/replace/remove；User lifecycle 使用 USER entity。event/entity 对应关系、USER/SYSTEM actor 组合、非空 object changes 均有数据库 CHECK。

短文本可进入 diff；超过 200 字的 notes 只存长度与短 SHA-256 摘要。writer 的编译期类型和运行时策略共同限制字段，BigInt/Decimal/Date 分别规范为字符串/字符串/ISO timestamp。密码、hash、session/cookie、hidden email、auth/database secret 不属于任何 event allowlist。

### StoredObject / ProductMainImage / FactoryPrivateImage

StoredObject：`id, storageProvider(LOCAL), storageKey unique, mimeType, sizeBytes, width, height, checksumSha256, originalFilename nullable, createdByUserId, createdAt`。

- 数据库不保存绝对路径；`storageKey` check 固定为 `objects/<UUIDv4>.webp`，MIME 固定 `image/webp`。
- size 必须大于 0；宽高必须为正、单边最多 8000、乘积最多 2500 万；checksum 必须为 64 位 lowercase SHA-256。
- `originalFilename` 仅为清理后的可选显示 metadata，最多 200 字；不参与 storage path 或 Content-Type。

ProductMainImage：`id, productId unique, storedObjectId unique, createdByUserId, createdAt, updatedAt`。一个 Product 最多一个当前主图；替换复用关系行并切换到新的 StoredObject。

FactoryPrivateImage：`id, assignmentId unique, storedObjectId unique, uploadedByUserId, createdAt, updatedAt`。一个稳定 Assignment 最多一个当前厂家私图；tenant 从 Assignment 推导，不冗余第二个可漂移的 factoryId。

StoredObject 不跨业务关系共享。Promotion 即使 checksum 相同也创建新的 storage key、StoredObject 与 ProductMainImage 引用，保证私图生命周期不影响主图。

### ImportJob / ImportRow

ImportJob：`id, type(PRODUCT), status(PREVIEW_READY/CONFIRMED), originalFilename, checksumSha256, totalRows, createRows, updateRows, noChangeRows, errorRows, createdByUserId, createdAt, confirmedAt`。数据库 check 强制 1–5000 行、各统计非负且总和一致；只有无错误的 job 可以进入 CONFIRMED。

ImportRow：`id, jobId, rowNumber, action(CREATE/UPDATE/NO_CHANGE/ERROR), targetProductId nullable, normalizedData JSONB nullable, changes JSONB nullable, errors JSONB, targetUpdatedAtSnapshot nullable, createdAt`。唯一 `(jobId, rowNumber)`；action shape check 强制 create 不绑定目标，update/no-change 必须带目标与 timestamp snapshot，error 必须有非空错误数组。

ImportJob 只允许创建它的 Admin 读取与确认。ImportRow 保存确认所需的完整规范化 Product 值，但不保存原始工作簿、宏、公式、外部链接或任意 raw row。Product/User/Job 外键均为 RESTRICT。

## 3. 事务规则

1. 报价写入：在短事务中校验 session factory 对 ACTIVE Assignment、ENABLED Product、ACTIVE Factory 的归属；首次创建 Quote + PriceHistory + QUOTE_SUBMITTED，更新则按 `id + expectedVersion` 条件写 Quote、按需追加 PriceHistory，并写 QUOTE_UPDATED。任一步失败全部回滚。
2. Master Data 与 Assignment：读取 before、执行真实变化、写语义 ActivityLog 均在同一 transaction；no-op 不更新业务时间戳也不写空事件。Assignment 并发幂等路径只有成功改变状态的一方写事件。
3. User lifecycle：创建继续通过 Better Auth 官方密码 API，随后由 server-only service 写 `USER_CREATED`，不把两个数据库边界伪装成单一事务；只有审计写入也成功才向调用方返回成功。启用/停用在单一 Prisma transaction 内按 `User.banned` 条件更新、按需撤销 session，并写 `USER_ENABLED/USER_DISABLED`；重复目标状态不写事件。原 Security Event 保留，密码、hash、session、hidden email 与 secret 不进入 Business ActivityLog。
4. Import confirm：Serializable 事务先锁定 creator-owned PREVIEW_READY job，再按稳定顺序锁定全部目标 Product；逐行校验 `updatedAt` snapshot，并调用与正式 Product API 相同的 create/update + ActivityLog writer。任一 stale、dictionary、SKU、审计或数据库错误全部回滚；成功后在同一事务置 CONFIRMED，二次确认返回 conflict。
5. 图片写入：先授权并把输入规范化为 WebP，再写新 storage file；事务锁定 Product/Assignment 行，创建 StoredObject、切换唯一图片关系并写 ActivityLog。失败删除新 file；成功后再清理旧 file/object，清理失败不回滚新业务状态。

## 4. 索引与约束

- Factory：canonical 名称 unique；status。
- Category/Material：canonical 名称 unique；status。
- Product：nullable canonical SKU unique；`(status, updatedAt desc)`；category；material。
- Assignment：unique `(productId, factoryId)`；`(factoryId, status)` 支持 Factory 产品列表；`(productId, status)` 支持 Admin 产品分配视角。
- Quote：assignment unique；`updatedAt desc`。
- History：`(factoryQuoteId, changedAt desc)`、`(changedByUserId, changedAt desc)`。
- Activity：`createdAt desc`、`(eventType, createdAt desc)`、`(entityType, entityId, createdAt desc)`、`(actorUserId, createdAt desc)`、`(factoryId, createdAt desc)`；V1 不索引 JSONB。
- Image：ProductMainImage product unique/object unique；FactoryPrivateImage assignment unique/object unique；StoredObject storageKey unique、createdBy/time 与非唯一 checksum。V1 不按 checksum 去重。

## 5. 删除和保留

业务实体默认停用/禁用/撤销；Product V1 只使用 ENABLED/DISABLED，不另设归档生命周期。ProductFactoryAssignment 不提供 hard delete，Product、Factory、Quote、PriceHistory actor、StoredObject 与图片关系外键均为 `ON DELETE RESTRICT`。ActivityLog actor User 同样 RESTRICT；entity/factory 仅保存 ID 与显示 snapshot，不因源实体变化级联删除。撤销仅写为 REVOKED，Quote/History/FactoryPrivateImage 保留；重新激活复用同一 Assignment 和 Quote，并恢复符合条件的图片访问。ActivityLog V1 无自动 retention、archive 或普通业务删除。

## 6. Phase 10A 数据影响

Phase 10A 不新增表、列、enum、migration 或 production seed。Dashboard、列表计数、报价完整度、价格变化和字典使用量均从 Phase 04–09 正式关系实时聚合；测试所需 10+ Product、三厂家同产品报价和多比例图片只写入 `_test` 数据库与隔离 test storage。

## 7. Phase 10B 数据影响

Phase 10B 不新增表、列、enum、migration 或 production seed。Factory Dashboard、产品集合、筛选项、Quote/PriceHistory 与私图均从既有 Assignment-rooted 关系实时读取；CBM 继续不持久化。测试所需 12 个本厂 Product、三厂家同产品报价、图片与价格历史只写入 `_test` 数据库和隔离 test storage。

## 8. Hard Delete Phase 1 数据基础

Migration `20260929090000_hard_delete_phase_1_foundation` 新增 HardDeleteTargetType、HardDeleteOperationStatus、HardDeleteFileTaskStatus、HardDeleteOperation、HardDeleteFileTask 以及 ImportRow.resolvedProductId。Operation 保存类型化目标、预览/摘要、request/confirm provenance、状态时间和失败信息；active target 使用 partial unique。FileTask 保存 immutable storage deletion intent，按 operation/storageKey 唯一并具有 retry 状态约束。

PriceHistory.changedByUserId、ActivityLog.actorUserId、StoredObject.createdByUserId、ProductMainImage.createdByUserId、FactoryPrivateImage.uploadedByUserId、ImportJob.createdByUserId 均允许 NULL 且 User FK 为 ON DELETE SET NULL；Session/Account 继续对 User CASCADE。保留 ActivityLog 的 USER actor 可在 hard delete 后为空；函数负责把 snapshot 匿名化。Import confirm 从本 migration 起把 CREATE/UPDATE/NO_CHANGE 的最终 Product ID 写入 resolvedProductId；旧行不 backfill，Product 删除时该 FK SET NULL。

## 9. Hard Delete Phase 2 durability

新的 forward-only migration 为 Operation 增加 version、expiry、attempt、lease 与 verification，为 FileTask 增加 safe error code 和独立 task lease，并更新 CHECK/index。ImportRow.targetProductId 改为 `ON DELETE SET NULL`；被 Product Hard Delete 解除稳定引用的行写入 `hardDeleteOperationId`，因此 action-shape 仍可证明该 NULL 来自已确认 operation，并保留 ImportJob/ImportRow。

只读 planner 与 mutation functions 均由 migration identity 所有、固定 `search_path=pg_catalog`、使用 schema-qualified static SQL。execute 在锁定 transaction 内重新生成并比较 closure，然后先插入 file task，再按固定 target CASE 删除依赖。普通 runtime 仍不能 DELETE ActivityLog/PriceHistory 或执行业务删除函数。

Phase 1 曾提供 `execute_confirmed_user_hard_delete(uuid)`；Phase 2 migration 已把该旧入口替换为固定报错的 disabled stub。当前只读 planner、CAS confirmation 与 worker 固定函数白名单、完整状态、索引、文件顺序和权限边界见 `HARD_DELETE.md`。
