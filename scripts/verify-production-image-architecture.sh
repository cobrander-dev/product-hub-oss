#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <runner-image> <migrator-image> <worker-image>" >&2
  exit 64
fi

for image_ref in "$@"; do
  inspected="$({
    docker image inspect "$image_ref" \
      --format '{{.Id}}|{{.Os}}|{{.Architecture}}'
  } 2>/dev/null)" || {
    echo "Production image is missing or cannot be inspected: $image_ref" >&2
    exit 1
  }

  case "$inspected" in
    *'|'*'|'*) ;;
    *) echo "Production image inspect returned an invalid result: $image_ref" >&2; exit 1 ;;
  esac

  image_id=${inspected%%|*}
  inspected_rest=${inspected#*|}
  image_os=${inspected_rest%%|*}
  image_architecture=${inspected_rest#*|}

  if [ -z "$image_id" ] || [ "$image_os" != "linux" ] || [ "$image_architecture" != "amd64" ]; then
    echo "Production image architecture rejected: $image_ref id=${image_id:-missing} os=${image_os:-missing} architecture=${image_architecture:-missing}" >&2
    exit 1
  fi

  printf '%s|%s|%s|%s\n' "$image_ref" "$image_id" "$image_os" "$image_architecture"
done

echo "PRODUCTION_IMAGE_ARCHITECTURE=PASS"
