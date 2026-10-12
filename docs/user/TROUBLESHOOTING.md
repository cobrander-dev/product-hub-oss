# Troubleshooting

Start with read-only commands:

```bash
sudo product-hub status
sudo product-hub doctor
sudo product-hub logs --service app --lines 100
```

`logs` accepts only `app`, `postgres` or `hard-delete-worker`, with 1–500 lines. It has no `--follow`, arbitrary service, Compose argument or shell passthrough.

Common stops:

- `RELEASE_MANIFEST_REQUIRED`: no controlled GHCR manifest has been supplied. Do not invent digests.
- `EXISTING_INSTALLATION` / `EXISTING_COMPOSE_PROJECT`: setup found prior state and will not overwrite it.
- `LINUX_AMD64_DOCKER_REQUIRED`: Docker daemon is not a real linux/amd64 target.
- `GHCR_AUTH_REQUIRED`: package is private or unavailable; retry the authorized setup/update and enter a read-only token through the hidden prompt.
- `IMAGE_DIGEST_MISMATCH` / `IMAGE_REVISION_MISMATCH`: registry artifact does not match the reviewed manifest. Stop; do not substitute a tag.
- `POSTGRES_UPDATE_REQUIRES_SEPARATE_ROLLOUT`: routine update cannot change the PostgreSQL image.
- `UPDATE_ALREADY_RUNNING_OR_STALE_LOCK`: confirm no update is active before separately reviewing any stale lock. Never delete it blindly.
- `APP_HEALTH_FAILED`: preserve database and volumes; inspect bounded App/PostgreSQL logs and reverse-proxy configuration.

The CLI never performs automatic repair, reset, restore or volume cleanup. Do not use `docker compose down -v`, `prisma migrate reset`, `prisma db push`, `chmod 777` or password reuse to bypass a stop.

## 一键安装与 HTTPS

- `TTY_REQUIRED`：请通过 SSH 交互式终端运行安装命令。
- `DOCKER_KEY_MISMATCH`：下载到的 Docker 官方 GPG 密钥指纹不符，安装已停止；检查网络是否被劫持后重试。
- `RELEASE_CHECKSUM_MISMATCH` / `RELEASE_ATTESTATION_INVALID`：安装包或发布清单校验失败，不要继续，重新下载或检查网络。
- `IP_ACCESS_REQUIRES_BUILTIN_HTTPS`：80/443 已被占用时不能使用 IP 访问；释放端口或改用域名加现有反向代理。
- `INVALID_APP_DOMAIN_OR_IP` / `UNUSABLE_IP_ADDRESS`：填写有效域名或可访问的 IPv4，不能用 127.0.0.1 等回环/保留地址。
- `HTTPS_PROXY_START_FAILED`：运行 `docker ps -a --filter label=com.docker.compose.project=product-hub-https` 查看代理容器状态。
- 证书一直未就绪：确认云安全组与 ufw 已放行 TCP 80/443，然后运行 `sudo product-hub https`。证书签发者为 “Caddy Local Authority” 表示公网证书申请未成功，按提示核对指纹并导入根证书。
