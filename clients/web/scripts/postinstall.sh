#!/usr/bin/env bash
# postinstall.sh — regenerate the API clients when they're stale.
#
# Runs on every install of this package: repo checkouts (bun install) and
# consumer node_modules alike. Published tarballs ship dist/ (no generate
# script, no specs) and consumer machines may not have bun, so the regen
# only runs when its inputs are present — best-effort, it never fails the
# install. Freshness is decided inside generate-clients.ts (content-hash
# stamp), so an up-to-date tree pays nothing.

cd "$(dirname "$0")/.." || exit 0

if [ -f scripts/generate-clients.ts ] && command -v bun >/dev/null 2>&1; then
  bun run openapi-ts || true
fi
