#!/usr/bin/env bash
set -euo pipefail

package_name=$1
version=$2
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT
status=$(curl --silent --show-error --retry 3 --max-time 30 \
  --output "$metadata" --write-out '%{http_code}' \
  "https://registry.npmjs.org/${package_name//\//%2f}/$version")

case "$status" in
  200)
    jq -e --arg name "$package_name" --arg version "$version" \
      '.name == $name and .version == $version and (.dist.tarball | type == "string")' \
      "$metadata" >/dev/null
    echo "published=true" >> "$GITHUB_OUTPUT"
    echo "::notice::$package_name@$version already published; skipping package preparation."
    ;;
  404)
    echo "published=false" >> "$GITHUB_OUTPUT"
    ;;
  *)
    echo "::error::npm lookup for $package_name@$version returned HTTP $status."
    exit 1
    ;;
esac
