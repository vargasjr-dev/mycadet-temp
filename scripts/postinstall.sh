#!/usr/bin/env bash
# postinstall.sh — disk hygiene after every `bun install` (wired in the root
# package.json; the root package never ships to npm, so consumers never run
# this).
#
# Why: the electron installer toolchain (electron-builder + app-builder +
# sign/notarize helpers, ~244M) is only needed when BUILDING installers, and
# installers are built in CI (which sets CI=true automatically). Everywhere
# else — dev laptops, containers, docker image builds — it is dead weight on
# disk, so we prune it right after install.
#
# Escape hatch: pretend to be CI with `CI=true bun install` when you need to
# package locally; `rm -rf node_modules && bun install` restores afterwards.
#
# Reversible: nothing here changes the lockfile; a clean
# `rm -rf node_modules && bun install` (or CI) brings the toolchain back.
#
# (The old musl-variant prune is gone: bun 1.3.x now filters libc variants at
# install. Git-hooks setup lives in setup.sh, not here.)
set -euo pipefail

STORE="node_modules/.bun"

if [[ -z "${CI:-}" ]]; then
  echo "[postinstall] CI not detected — pruning electron packaging armada (CI=true bun install to keep)"
  rm -rf "${STORE}"/app-builder-bin@* \
         "${STORE}"/app-builder-lib@* \
         "${STORE}"/builder-util@* \
         "${STORE}"/electron-builder@* \
         "${STORE}"/electron-builder-squirrel-windows@* \
         "${STORE}"/electron-publish@* \
         "${STORE}"/electron-winstaller@* \
         "${STORE}"/@electron+osx-sign@* \
         "${STORE}"/@electron+notarize@* \
         "${STORE}"/@electron+windows-sign@* \
         "${STORE}"/@electron+universal@* \
         "${STORE}"/@electron+rebuild@* 2>/dev/null || true
else
  echo "[postinstall] CI detected — keeping electron packaging armada"
fi
