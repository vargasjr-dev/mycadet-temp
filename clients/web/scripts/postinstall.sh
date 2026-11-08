#!/usr/bin/env bash
# postinstall.sh — regenerate the API clients when they don't exist yet.
#
# Runs on every install of this package: repo checkouts (bun install) and
# consumer node_modules alike. Published tarballs ship dist/ (no transform
# scripts, no specs) and consumer machines may not have bun, so the regen
# only runs when its inputs are present — best-effort, it never fails the
# install.
#
# The regen is skipped when the generated clients are already on disk: the
# pipeline regenerates them explicitly (`bun run openapi-ts`), and a regen
# killed mid-write (short-timeout installs) leaves the output dirs emptied —
# worse than no regen at all.

cd "$(dirname "$0")/.." || exit 0

if [ -f scripts/transform-daemon-spec.ts ] && command -v bun >/dev/null 2>&1; then
  if [ -f src/generated/daemon/sdk.gen.ts ] && [ -f src/generated/gateway/sdk.gen.ts ] && [ -f src/generated/api/sdk.gen.ts ]; then
    echo "[postinstall] generated clients already present — skipping regen"
    exit 0
  fi
  bun run openapi-ts || true
fi
