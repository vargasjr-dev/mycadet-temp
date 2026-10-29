#!/usr/bin/env bash
# postinstall.sh — runs after every `bun install` (wired in the root package.json).
#
# This file is the home for install-time hygiene that should hold on every
# machine that installs this repo (dev laptops, CI runners, containers).
# Add new steps as their own commented, self-contained block so each one can
# be removed or extended independently.
set -euo pipefail

STORE="node_modules/.bun"

# ---------------------------------------------------------------------------
# prune: musl (Alpine libc) variants of native optional dependencies
#
# bun installs BOTH glibc and musl builds of native optionals (next-swc,
# sharp, @napi-rs/canvas, rolldown bindings, ...) because it has no libc
# filter yet (no `bun install --libc`). Every OS this repo ships on is
# Debian-based (all Dockerfiles + the oven/bun image), so the musl copies
# are dead weight everywhere we install.
#
# Safe everywhere: macOS/Windows installs never contain linux-musl dirs, so
# the glob matches nothing and rm -f exits clean. If we ever ship an Alpine
# image, revisit this block.
# ---------------------------------------------------------------------------
echo "[postinstall] pruning musl variants from ${STORE}"
rm -rf "${STORE}"/*musl* 2>/dev/null || true

# ---------------------------------------------------------------------------
# prune: electron packaging armada (ONLY outside CI)
#
# The installer toolchain (electron-builder + app-builder + sign/notarize
# helpers, ~250M) is only needed when building installers, and installers
# are built in CI (which sets CI=true automatically). Everywhere else —
# dev laptops, containers, docker image builds — it is dead weight, so we
# prune it right after install.
#
# Escape hatch: pretend to be CI with `CI=true bun install` when you need
# to package locally; `rm -rf node_modules && bun install` restores afterwards.
#
# Scope: ONLY the installer-factory packages. We deliberately keep
# electron@*, electron-vite, @electron/{get,asar,fuses}, electron-store,
# electron-log, electron-updater and electron-to-chromium — the desktop
# shell needs those to build and run on every machine.
#
# Reversible: nothing here changes the lockfile; a clean
# `rm -rf node_modules && bun install` (or CI) brings the toolchain back.
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# git hooks: point the repo's git at .githooks (fresh clones)
#
# Idempotent repo hygiene — a no-op when core.hooksPath is already set.
# (This used to live in the @mycadet/assistant and @mycadet/gateway package
# postinstalls; those packages now carry NO lifecycle scripts at all, so
# consumer installs run nothing repo-flavored.)
# ---------------------------------------------------------------------------
if ! git config core.hooksPath >/dev/null 2>&1; then
  git config core.hooksPath .githooks 2>/dev/null || true
fi
