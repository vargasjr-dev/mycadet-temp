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
