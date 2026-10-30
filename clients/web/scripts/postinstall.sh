#!/usr/bin/env bash
# postinstall.sh — regenerate the API clients from the committed specs.
#
# Runs on every install of this package: repo checkouts (bun install) and
# consumer node_modules alike. Published tarballs ship dist/ (no transform
# scripts, no specs) and consumer machines may not have bun, so the regen
# only runs when its inputs are present — best-effort, it never fails the
# install.

cd "$(dirname "$0")/.." || exit 0

if [ -f scripts/transform-daemon-spec.ts ] && command -v bun >/dev/null 2>&1; then
  bun run openapi-ts || true
fi
