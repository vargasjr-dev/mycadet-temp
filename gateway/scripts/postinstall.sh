#!/usr/bin/env bash
# postinstall.sh — best-effort repository setup for @mycadet/gateway.
#
# Runs on every install of this package: repo checkouts (bun install) and
# consumer node_modules alike. Consumer installs have no git checkout, so
# the arm is guarded — a missing repo is skipped, never a failed install.
# (The old bundled-copies sync arm died with the feature-flag machinery,
# #444.)

root="$(cd "$(dirname "$0")/.." && pwd)"

# Fresh clones: point the repo's git hooks at .githooks (a no-op outside a
# git checkout).
if ! git -C "$root" config core.hooksPath >/dev/null 2>&1; then
  git -C "$root" config core.hooksPath .githooks 2>/dev/null || true
fi
