#!/usr/bin/env bash
#
# clients/macos setup — installs workspace dependencies and the Electron
# binary, then builds the mac-helper and notifier natives. Run via
# `bun run setup` from clients/macos/ — the root ./setup.sh invokes it for
# every subpackage that defines a setup script, and scripts/dev.ts kicks it
# off on fresh checkouts.
#
set -euo pipefail

MACOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

info()  { echo "==> $*"; }

# — macOS builds only; exit cleanly elsewhere so the root setup.sh fan-out
#   stays harmless on Linux —
if [ "$(uname -s)" != "Darwin" ]; then
  echo "skipping: the macOS client builds only on macOS" >&2
  exit 0
fi

# — Workspace deps: bun install from this package walks up to the workspace
#   root —
info "Installing workspace dependencies"
(cd "${MACOS_DIR}" && bun install)

# — Electron binary for the dev app and pack flows —
info "Installing the Electron binary"
(cd "${MACOS_DIR}" && node node_modules/electron/install.js)

# — mac-helper: the Swift sidecar the app execs for screen/audio control —
info "Building the mac-helper app bundle"
(cd "${MACOS_DIR}" && bash scripts/build-mac-helper.sh)

# — Notifier (optional): notifications fall back to Electron when absent —
info "Building the notifier"
(cd "${MACOS_DIR}" && bash scripts/build-notifier.sh) \
  || echo "notifier unavailable; notifications fall back to Electron"

info "macOS setup complete"
