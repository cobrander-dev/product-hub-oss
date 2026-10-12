# Upgrade and Backup

## 一键升级（推荐）

```bash
sudo product-hub upgrade
```

下载最新 GitHub Release 的 `product-hub-release.manifest` 并校验其 SHA-256，放到 `/opt/product-hub/releases/target.manifest`，执行 `update --check`，确认后执行下文的 `update`（先 doctor 与新备份）。指定版本：`sudo PRODUCT_HUB_VERSION=v1.0.1 product-hub upgrade`。公开镜像无需填写 GHCR 凭据，提示时直接回车。启用内置 HTTPS 时，更新会把 `product-hub-https` 切换到新版本的同一 Runner digest。

## Check a reviewed target

Obtain the target release manifest from the approved workflow/release channel and place it at:

```text
/opt/product-hub/releases/target.manifest
```

The file is public metadata, not a credential. Do not edit its digest or commit fields.

```bash
sudo product-hub update --check
```

`update --check` parses the current and target manifests, rejects downgrade/same revision/PostgreSQL image drift, and reports the target version/commit. It does not pull images, create a backup, migrate, start, stop or recreate installed services. Like other CLI commands, it uses an automatically removed control container.

## Apply an update

```bash
sudo product-hub update
```

For private GHCR packages, enter the optional username and hidden read token. Update holds an exclusive lock and performs:

1. current release doctor;
2. target manifest and four digest pull/amd64/revision verification;
3. a fresh database + uploads backup and checksum verification;
4. target operations bundle installation;
5. forward-only pending migrations and runtime grants;
6. Worker role check/update, then Worker replacement;
7. App replacement;
8. database privilege, Worker, health and ready verification.

Only Worker and App use `--force-recreate`; PostgreSQL is never recreated, stopped, deleted or upgraded by this command. A target changing the PostgreSQL digest stops for a separately reviewed database rollout. Update never runs `down -v`, DROP DATABASE, reset, db push, reverse migration or automatic destructive rollback.

## Backup

```bash
sudo product-hub backup
```

Successful output contains only:

- `BACKUP_PATH`
- `MANIFEST`
- `CHECKSUMS`
- `COMPLETE`

The command reuses the existing database + uploads backup workflow, requires the exact four-file checksum set, verifies each checksum, and never overwrites an existing backup.

Restore is intentionally absent from the routine CLI. Follow [Backup and Restore](../BACKUP_RESTORE.md) with an explicitly authorized empty target and recovery window.
