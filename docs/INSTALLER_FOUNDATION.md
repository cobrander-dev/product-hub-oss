# Generalization Phase 2 — Installer Foundation

Phase 2 foundation 提供安全的配置检查与 release override 生成。`production:preflight` 与 `release:configure` 仍不部署、不启动容器、不修改数据库、不创建 Admin、不运行 migration 或 Worker provisioning。Phase 3 在此基础上新增独立 `production:install`/`production:bootstrap-admin`/`production:doctor`/`production:backup`；完整首次安装入口见 `PRODUCTION_QUICK_START.md`，不能把 foundation 的只读边界误用于 install。

## 配置分类

| 类别                       | 字段                                                                                                                                                                                                                                               | 规则                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Required                   | `APP_DOMAIN`、`BETTER_AUTH_URL`、`BETTER_AUTH_TRUSTED_ORIGINS`、`BETTER_AUTH_SECRET`、`POSTGRES_DB`、四组数据库用户及独立密码                                                                                                                      | Auth origin 精确 HTTPS 同源；role 名是安全 PostgreSQL identifier；密码不可复用；Auth secret 至少 32 UTF-8 bytes。         |
| Optional with safe default | `POSTGRES_HOST=postgres`、`POSTGRES_PORT=5432`、`APP_PORT=3000`、`PRODUCT_HUB_CONFIG_ROOT=/opt/product-hub/config`、`PRODUCT_HUB_POSTGRES_INIT_DIR=<config-root>/postgres/init-production`、`PRODUCT_HUB_RELEASE_FILE=<repo>/compose.release.yaml` | 使用绝对 host 路径；端口 1–65535。可选 `PRODUCT_HUB_BACKUP_ROOT` 存在时检查权限。                                         |
| Optional, worker gated     | `HARD_DELETE_WORKER_DATABASE_URL_SECRET_FILE`                                                                                                                                                                                                      | 未部署 Worker 时可留空；一旦设置则严格检查父目录、文件、URL 身份和密码。不会自动创建或修复。                              |
| Generated                  | `ADMIN_DATABASE_URL`、`MIGRATION_DATABASE_URL`、`APP_DATABASE_URL`、Worker URL（仅用于核对 file secret）、`product-hub.resolved.env`、`compose.release.yaml`                                                                                       | URL 百分号编码；runtime env mode 0600 且不跟踪，Compose override 不含 secret。旧生产显式 URL 若存在必须与结构化字段一致。 |
| Secret                     | `BETTER_AUTH_SECRET`、四个数据库密码、三个显式 URL、Worker URL file、生成的 runtime env                                                                                                                                                            | 不作为 CLI 参数、不打印、不写入 tracked 文件。生成输出发生错误时只报告安全错误代码。                                      |
| Internal software default  | 四个默认 role 名、`/data/uploads`、`/run/secrets/hard_delete_worker_database_url`、Compose project `product-hub`                                                                                                                                   | 保留既有安全模型；不添加可变开关。                                                                                        |

新字段名为 `POSTGRES_ADMIN_USER/PASSWORD`、`POSTGRES_MIGRATION_USER/PASSWORD`、`POSTGRES_APP_USER/PASSWORD`、`HARD_DELETE_WORKER_DB_USER/PASSWORD`。旧生产使用的 `POSTGRES_USER/PASSWORD`、`MIGRATION_DB_USER/PASSWORD`、`APP_DB_USER/PASSWORD` 仍可输入；两套同时填写时必须一致。生成的 runtime env 用既有 Compose 所需的旧内部字段，不改变 Production Compose 或现有部署脚本。Worker role override 同时供 provisioning、Worker environment 和 secret URL 校验使用。

数据库 host 支持 DNS、IPv4 和方括号形式 IPv6。显式 URL 的 host、port、database、username、password 必须与结构化字段语义相同；不会因显式 URL 优先而悄悄采用另一个身份。Worker URL 不会写进普通 runtime env；Worker secret 仍须由获授权运维人员放在独立文件中。

URL 生成支持上述 host 格式，但 Phase 2 不负责配置外部 PostgreSQL 的网络、TLS、初始化或迁移。现有内置 Compose PostgreSQL 的正常连接仍是 `postgres:5432`；若改用外部地址，部署拓扑须另行审查。

## 使用流程

1. 将 `.env.production.example` 复制到 Git 仓库外受限目录，设置 mode 0600，填写真实值。创建 config root、PostgreSQL init source 和 release 目录；init source 需安装经过审查的 tracked init artifact。生成高熵独立 secret 不属于此 CLI 的自动功能。
2. 设置 `PRODUCT_HUB_ENV_FILE=/restricted/config/product-hub.env`，运行 `pnpm production:preflight`。只输出 `PASS` 或安全的 `FAIL` 代码，不打印配置值。路径检查：env file 0400/0600、config/init/release/可选 backup 目录非 group/other writable；Worker secret 设置时必须符合 root:root 0700 parent 与 1001:1001 0400 file。父目录阻止 host UID 1001 通过原路径读取；正式 Worker bind mount 后可由 UID 1001 读取。此阶段不修改权限。
3. 从同一审查 commit 本地构建三个 `linux/amd64` 镜像；或者取得受控 workflow 生成的 `product-hub-release/v1` manifest，并按 digest 拉取 Runner、Migrator、Worker 与固定 PostgreSQL artifact。Manifest 路径使用 `release:configure -- --manifest <path>`；它实际核对四项 RepoDigest/architecture 及三个 Product Hub image 的 revision/version，missing、tag、`latest`、arm64、unknown 或 revision 不同均拒绝。
4. 旧有本地审查流程仍可显式提供三个 image ref；通用分发流程运行：

   ```bash
   PRODUCT_HUB_ENV_FILE=/restricted/config/product-hub.env \
   pnpm release:configure -- \
     --manifest /reviewed/path/product-hub-release.manifest
   ```

   结果是与 source env 同目录的 `product-hub.resolved.env`（0600）和 `PRODUCT_HUB_RELEASE_FILE` 指定的 `compose.release.yaml`。已有输出默认拒绝覆盖；显式 `--force` 才可逐文件原子替换。Manifest 路径生成的 Compose 固定四个 digest；Worker image 同时写入非敏感 metadata 和 runtime env，由单独的 Hard Delete overlay 使用；普通 release 不启动 Worker。

5. 后续运维命令仍使用现有显式参数：`PRODUCT_HUB_ENV_FILE=<resolved-env> PRODUCT_HUB_RELEASE_FILE=<generated-compose> scripts/deploy-production-*.sh`。该步骤只说明接口，不授权执行。不要直接运行 `docker compose config` 并将完整输出贴入日志，因为现有 Compose 模型包含必要的 secret environment；使用 `config --quiet`。

输入 env 与 Worker secret 均不得位于仓库内。`PRODUCT_HUB_RELEASE_COMPOSE` 不是另一种受支持的 release path 名称；只使用 `PRODUCT_HUB_RELEASE_FILE`。`PRODUCT_HUB_COMPOSE_PROJECT` 默认 `product-hub`，用于不同安装的独立 project/network/volumes。Phase 3 install 只支持内置 `postgres:5432`；外部数据库与 upgrade 不是本次安装器能力。Doctor 永远只检查，不自动修复权限。

生成的 runtime env 必须在真实 Compose 中保持 credential 的原始字节，而不只是 URL 编码正确。普通值保持 literal single-quote；末尾反斜杠会影响 closing quote 时采用 escaped double-quote，并保护 literal dollar 不参与变量插值。Source env 仍不进行 shell expansion；禁止 source/eval。首次 PostgreSQL ready 后再次比较实际 container credential 与配置，任何差异停止，不继续 migration。

若将 release override 输出到仓库内，文件名必须符合已忽略的 `compose.release*.yaml` 规则；其他仓库内路径会被拒绝。输入 env 和 Worker secret 的仓库边界会检查实际解析后的路径，不能通过符号链接绕过。

## 人工步骤变化估计

Phase 1 audit 的约 21 个主要人工步骤，按相同粒度，Phase 2 后约 15 个。消除或合并的是手拼 Admin/Migration/App URL、手写 release override、逐项对照 origin/role/path/权限、人工判断镜像架构等约 6 项。仍需人工完成 VPS/网络/TLS、secret 生成及受限安放、PostgreSQL 首次启动、备份及恢复、migration/role provisioning、Worker file secret、Admin bootstrap、部署与 smoke；这些不是本阶段自动动作。

Phase 3 将首次 PostgreSQL 初始化、pending migrations、runtime grants、Worker role/file-secret、启动与内部探测合并为受控 install，主流程约 8 项（Quick Start 粒度，backup 计入）。已有数据库、密码和容器不被覆盖或重建；不替代 release 审查、TLS、外部 smoke 与恢复演练。
