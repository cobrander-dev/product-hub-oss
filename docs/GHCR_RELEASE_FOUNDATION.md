# Immutable GHCR Release Foundation

本文件定义通用镜像的受控发布契约。仓库中的 workflow 和 parser 只是发布基础；提交它们不会运行 workflow、发布 package、改变 GHCR/repository visibility、创建 GitHub Release 或创建 tag。每次真实发布仍须单独授权。

## 1. 手动发布边界

`.github/workflows/release-images.yml` 保留名称 `Publish immutable production images`，只有 `workflow_dispatch`，绑定 `ghcr-release` environment。显式模式为 `verification` 或 `release`，两者都必须提供经审查的完整 source SHA 与确认短语。Tooling 从 workflow 的完整 commit 检出到 `tooling/`；实际 Docker context 从 input source SHA 独立检出到 `source/`。两棵 checkout 都验证 HEAD，镜像 revision 只能使用 source SHA，不能使用 workflow SHA。

Verification 不接受 version 输入或 promotion run id，自动生成唯一 tag `sha-<source SHA>` 与 manifest version `verification-<source SHA>`。后续发布必须显式使用完成 Release Readiness Repair 并经审查的新 candidate 完整 SHA；不再使用旧 tooling-only 修复之前的 image source。该 candidate 同时包含应用、Migrator installer-control 和 verification 工具，source/distribution 可以相同，也继续允许未来两个不同的完整 SHA。Release 模式只接受合法 SemVer，并要求同 workflow 的成功 verification run；仅可将该 run 的已签名 manifest 所绑定 digest 晋升为 semantic image tag，不重新构建、不创建 Git tag 或 GitHub Release。

Workflow 权限只包含 `contents: read`、`actions: read`、`packages: write`、`id-token: write` 和 `attestations: write`；actions read 仅用于读取已完成 verification run。所有第三方 Action 固定完整 commit SHA；不读取 Production env、客户域名或 Production secret。

Clean runner 在完整 CI 前创建本次 run 专属的临时 PostgreSQL test container 与随机凭据文件，安装 Chromium/WebKit，并生成 Prisma client。Domain A/B Gate 前先构建本地 amd64 三镜像并传入同一个验证 tag；不依赖开发机缓存或 `.env.test`。临时测试容器与凭据在 always cleanup 中按本次 run identity 删除，不接触 Production。

## 2. 四项不可变 artifact

### Publish Runner 磁盘边界

Source Verification 与 Publish 必须在独立 GitHub-hosted Ubuntu 24.04 Runner 上运行，Publish 严格 `needs: source-verification`。完整 CI、audit、secret scan 不得因容量修复削减。

Verification 模式下，Source Verification 与 Publish 两台独立 Runner 各自在 identity 校验后、首个磁盘 baseline（source-baseline / oci-baseline）检查前，只允许回收固定目录 `/usr/local/lib/android/sdk` 中的预装 Android SDK/NDK。它不参与 Node/pnpm tooling、Docker 内构建、Trivy、BuildKit SBOM、Skopeo 或 GitHub provenance attestation。目录来源为 [GitHub Ubuntu 24.04 软件清单](https://github.com/actions/runner-images/blob/ubuntu24/20261004.327/images/ubuntu/Ubuntu2404-Readme.md) 与 [SDK 安装脚本](https://github.com/actions/runner-images/blob/ubuntu24/20261004.327/images/ubuntu/scripts/build/install-android-sdk.sh)。不能扩展为 Docker prune、apt autoremove、toolcache 或其他 SDK 的全局清理。

回收脚本只接受 GitHub-hosted、Linux/X64、Ubuntu 24.04、`source-verification` 或 `publish` job、verification 模式；删除目标不可由参数或环境变量改写。删除前验证真实路径、root owner、无嵌套挂载，并拒绝与 workspace、temp、Docker root、toolcache 或 Node 路径重叠。缺失 SDK 仅记录 skip；任何不安全布局或命令错误立即失败。记录 SDK 的 `du -sk`、文件系统回收前后 KiB 和差值，不输出环境、凭据或文件内容。Docker、源代码、OCI archive、安全/SBOM/provenance 工具保留。

保留原 12 GiB baseline/before-runner 门槛及后续 8/6/4 GiB 门槛。12 GiB 是保守停止线，不是实测 peak-space 保证。Run 38253111399 的 Source Verification Runner 在 before-fixtures 仅剩 7,829,012 KiB，低于 8 GiB 门槛（未执行 SDK 回收）；Run 38221700100 的 Publish Runner 实测回收 11,560,780 KiB。Run 38145116445 的新 Publish Runner 在 OCI 前仅有 12,363,124 KiB，低于门槛 219,788 KiB；当时 BuildKit cache 为 0，未测得 SDK 大小。预装清单包含多个 Android platforms/build-tools 和三个 NDK，具备回收依据，但不能把清单当作精确回收容量证据。真实可回收量及 OCI/SBOM/scan 峰值必须在下一次单独授权的 GitHub verification 中测量；本地 mock 测试不能代替该证据。若仍不足，停止并评估更大容量 Runner，不自动降低门槛或扩大删除范围。

三个 Product Hub target 必须从同一 commit 构建为 `linux/amd64`：

| Docker target        | GHCR repository                                            |
| -------------------- | ---------------------------------------------------------- |
| `runner`             | `ghcr.io/cobrander-dev/product-hub-oss-app`                |
| `migrator`           | `ghcr.io/cobrander-dev/product-hub-oss-migrator`           |
| `hard-delete-worker` | `ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker` |

Verification 先在本地构建三个 OCI archive，写入 source revision 与 verification version，并生成 BuildKit provenance/SBOM。三个实际 archive 必须全部通过 Trivy vulnerability + secret scan 才允许任何 GHCR push：每个镜像先生成不经 `--ignore-unfixed` 过滤的全严重级别完整清单（`scan-reports/<image>.full.json`，日志列出全部 Critical/High 及有无修复版本，作为 90 天 artifact 上传；secret 只保留规则与位置，不保留匹配内容），再以同一漏洞库运行 Trivy 官方 `--severity CRITICAL,HIGH --ignore-unfixed --exit-code 1` 门禁。存在任何有修复版本的 Critical/High 或 Critical/High secret 即失败；两次结果不一致也失败。尚无上游修复的 Critical/High 不阻断，但必须保留在完整清单中，并在 `RISK_REGISTER.md` 逐次复核实际可利用性；发现可被直接利用的严重风险时停止发布。扫描后不重建；以 archive checksum 和 manifest digest 绑定扫描对象，通过 `skopeo copy --all --preserve-digests` 推送原 OCI 内容，回读 registry digest/config 并验证 provenance/SBOM，再签名 attestation、生成带 checksum 的 manifest。任何失败停止后续步骤。

扫描或工具失败时只输出有界、脱敏的诊断（URL 凭据、auth header、token/password 键值均替换为 `[REDACTED]`），不再只显示 `DOCKER_FAILED`。

扫描输入使用 Trivy 支持的 OCI layout 目录：从原 archive 做 digest-preserving 本地复制，并验证 index digest 未改变后扫描；不能把 OCI tarball 当作 Docker tarball 传入 Trivy。发布仍使用 checksum 绑定的原 archive。

SemVer promotion 同样重新扫描三个既有 digest，全部通过才复制为 semantic tag；digest、OCI source revision、verification version、BuildKit provenance/SBOM 都保持原样。正式 manifest 的 SemVer 是分发版本，不能伪造镜像已被重建。安装/运行最终引用始终是 digest。

PostgreSQL 也是 release closure 的一部分。`deploy/releases/postgres-linux-amd64.txt` 固定经检查的 `postgres@sha256:...` Linux/amd64 platform manifest；生成的 release Compose 同时固定这第四个 digest，不能退回可变 `postgres:18`/`latest`。

## 3. Release manifest

Manifest 是 UTF-8、固定顺序、逐行 `key=value` 的非可执行数据，不能 `source`/`eval`。Parser 严格接受合法 SemVer 或与 source SHA 一致的 `verification-<40 lowercase hex>`；source/distribution SHA 独立验证，允许不同。拒绝任意版本、短 SHA、未知/重复/乱序字段、CR/NUL、非 canonical 时间、错误 repository、tag image、非 amd64 和 `latest`。新工具保留旧字段名格式的只读兼容；新输出采用以下 canonical 字段：

```text
schema_version=1
version=verification-<完整 source SHA> 或 vX.Y.Z[-prerelease]
source_commit=<完整 40 字符 Git SHA>
distribution_commit=<release tooling 的完整 Git SHA>
platform=linux/amd64
runner=ghcr.io/cobrander-dev/product-hub-oss-app@sha256:<digest>
migrator=ghcr.io/cobrander-dev/product-hub-oss-migrator@sha256:<digest>
worker=ghcr.io/cobrander-dev/product-hub-oss-hard-delete-worker@sha256:<digest>
postgres=postgres@sha256:<linux/amd64 platform digest>
workflow_run_id=<GitHub Actions run id>
created_at=<canonical UTC ISO-8601>
```

Workflow 只上传 manifest artifact，不修改仓库、不创建 tag/Release。受控 verification publish 后，人工审查 workflow、digest、scan、provenance/SBOM 和 manifest，再决定 package visibility、正式版本和后续 release 操作。

`product-hub-release.manifest.sha256` 绑定原始 manifest 字节；verifier 可显式要求 checksum。成功 verification run 还签名 manifest，用于后续 promotion 的来源验证。

## 4. Installer contract

`release:configure -- --manifest <path>` 只接受已在本机按 digest pull 的 manifest：先验证四个本地 RepoDigest/architecture 与三个 Product Hub image labels，再生成 mode 0600 runtime env 和无密钥 Compose override。Override 固定 Runner、Migrator、Worker metadata 与 PostgreSQL digest。

每个安装实例仍须提供严格匹配的 `APP_DOMAIN`、HTTPS `BETTER_AUTH_URL` 与单一 `BETTER_AUTH_TRUSTED_ORIGINS`。Manifest 不包含密码、token、域名或部署主机信息；App localhost-only、独立 DB roles、Worker file secret 和 reverse-proxy header contract 保持不变。

新的 candidate 必须将当前 manifest parser/verifier 与 operator CLI 一起打入 Migrator；setup 和 product-hub wrapper 使用同一 namespace/digest/revision 校验。Verification 安装只接受与 source SHA 精确匹配的 verification image version，不能通过任意版本绕过身份检查。旧镜像不视为已升级；真实 registry 发布和 clean VPS 验证仍需独立授权。

Canonical repository 为公开仓库 `cobrander-dev/product-hub-oss`，三个 package 位于同一账号 namespace，并通过 OCI `image.source` 关联该仓库。公开仓库可使用 GitHub 原生 artifact attestation。首次发布后三个 package 需由 Owner 在 GitHub Packages 设置中确认为 Public，供一键安装匿名拉取；workflow 不修改 package visibility。正式 SemVer 发布额外生成**草稿** GitHub Release（安装包、`install.sh`、manifest、`SHA256SUMS` 及其 attestation），由 Owner 审核后手动发布。
