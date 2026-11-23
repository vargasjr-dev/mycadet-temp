#!/usr/bin/env bash
set -euo pipefail

# Both release workflows download canary artifacts into these directories.
# Copy to canonical filenames: gh's # suffix is a display label, not a rename.
release_tag="${1:?release tag is required}"
asset_dir=$(mktemp -d)
trap 'rm -rf "$asset_dir"' EXIT

attach() {
  local source_dir="$1" pattern="$2" name="$3" source_file
  source_file=$(find "$source_dir" -type f -name "$pattern" -print -quit 2>/dev/null || true)
  if [ -z "$source_file" ]; then
    echo "::warning::$name unavailable; its desktop build produced no installer"
    return
  fi
  cp "$source_file" "$asset_dir/$name"
  gh release upload "$release_tag" "$asset_dir/$name" --clobber
}

attach electron-artifacts '*.dmg' mycadet.dmg
attach electron-artifacts-x64 '*.dmg' mycadet-electron-x64.dmg
attach linux-artifacts '*.AppImage' mycadet-linux-x64.AppImage
attach windows-artifacts '*.exe' mycadet-windows-x64.exe
