#!/usr/bin/env bash
# Read-only diagnostics on the current GitHub-hosted runner. Never prune images,
# builders, volumes, archives, credentials, or other jobs' data to make room.
set -euo pipefail

checkpoint=${1:?checkpoint required}
minimum_mib=${2:?minimum free MiB required}
[[ "$checkpoint" =~ ^[a-z][a-z0-9-]*$ ]] || exit 64
[[ "$minimum_mib" =~ ^[0-9]{1,6}$ ]] || exit 64
: "${GITHUB_WORKSPACE:?GitHub workspace required}"
: "${RUNNER_TEMP:?Runner temporary directory required}"

printf 'Disk checkpoint: %s; minimum free: %s MiB\n' "$checkpoint" "$minimum_mib"
docker_root=$(docker info --format '{{.DockerRootDir}}')
[[ "$docker_root" = /* && -d "$docker_root" ]] || {
  echo '::error::Cannot identify local Docker storage filesystem'
  exit 1
}

insufficient=0
for disk_path in "$GITHUB_WORKSPACE" "$RUNNER_TEMP" "$docker_root"; do
  df -h "$disk_path"
  df -i "$disk_path"
  available_kib=$(df -Pk "$disk_path" | awk 'NR == 2 {print $4}')
  [[ "$available_kib" =~ ^[0-9]+$ ]] || exit 1
  if (( available_kib < 10#$minimum_mib * 1024 )); then
    printf '::error::Insufficient disk at %s: %s KiB available, %s MiB required\n' \
      "$checkpoint" "$available_kib" "$minimum_mib"
    insufficient=1
  fi
done

# Summaries only: no environment dumps, file contents or credential paths.
docker system df
docker buildx du || echo 'BuildKit usage unavailable at this checkpoint'
for disk_path in \
  "$GITHUB_WORKSPACE/source/node_modules" \
  "$GITHUB_WORKSPACE/source/.next" \
  "$GITHUB_WORKSPACE/source/test-results" \
  "$GITHUB_WORKSPACE/tooling/node_modules" \
  "$RUNNER_TEMP/product-hub-release"; do
  if [[ -d "$disk_path" ]]; then du -sh "$disk_path"; fi
done
pnpm_store=$(pnpm store path)
if [[ -d "$pnpm_store" ]]; then du -sh "$pnpm_store"; fi

exit "$insufficient"
