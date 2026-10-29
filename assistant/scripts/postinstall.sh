#!/usr/bin/env bash
# postinstall.sh — best-effort repository setup for @mycadet/assistant.
#
# Runs on every install of this package: repo checkouts (bun install) and
# consumer node_modules alike. Consumer installs have no git checkout, no
# meta/ dir, and may not have bun at all, so every arm is guarded — a
# missing tool or missing file is skipped, never a failed install.

root="$(cd "$(dirname "$0")/../.." && pwd)"

# Fresh clones: point the repo's git hooks at .githooks (a no-op outside a
# git checkout).
if ! git -C "$root" config core.hooksPath >/dev/null 2>&1; then
  git -C "$root" config core.hooksPath .githooks 2>/dev/null || true
fi

# Fresh installs: keep the bundled feature-flag registry copies in sync with
# the canonical source (source checkouts only).
if [ -f "$root/meta/sync-bundled-copies.ts" ] && command -v bun >/dev/null 2>&1; then
  (cd "$root" && bun run meta/sync-bundled-copies.ts 2>/dev/null) || true
fi
