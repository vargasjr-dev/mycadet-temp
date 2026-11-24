#!/usr/bin/env bash
set -euo pipefail

image_ref=$1
errors=$(mktemp)
trap 'rm -f "$errors"' EXIT
if manifest=$(docker buildx imagetools inspect --raw "$image_ref" 2>"$errors"); then
  jq -e '[.manifests[]? | select(.platform.os == "linux") | .platform.architecture] |
    (index("amd64") != null and index("arm64") != null)' <<< "$manifest" >/dev/null
  echo "published=true" >> "$GITHUB_OUTPUT"
  echo "::notice::$image_ref already published; keeping the released manifest."
elif grep -Eiq 'manifest unknown|: not found$' "$errors"; then
  echo "published=false" >> "$GITHUB_OUTPUT"
else
  cat "$errors" >&2
  exit 1
fi
