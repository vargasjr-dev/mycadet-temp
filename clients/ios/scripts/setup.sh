#!/usr/bin/env bash
#
# clients/ios setup — ensures the iOS toolchain (xcodegen via Homebrew) and
# regenerates App.xcodeproj from project.yml. Run via `bun run setup` from
# clients/ios/ — the root ./setup.sh invokes it for every subpackage that
# defines a setup script.
#
set -euo pipefail

IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

info()  { echo "==> $*"; }
error() { echo "error: $*" >&2; exit 1; }

# — iOS builds are macOS-only; exit cleanly elsewhere so the root setup.sh
#   fan-out stays harmless on Linux —
if [ "$(uname -s)" != "Darwin" ]; then
  echo "skipping: iOS development requires macOS (Xcode + xcodegen)" >&2
  exit 0
fi

# — xcodegen generates App.xcodeproj from App/project.yml. Homebrew is how
#   the CI workflows (pr-ios.yaml, release-ios.yaml) install it too —
if ! command -v xcodegen &>/dev/null; then
  info "xcodegen not found — installing with Homebrew"
  if ! command -v brew &>/dev/null; then
    error "xcodegen is required and Homebrew is missing. Install Homebrew (https://brew.sh) or xcodegen directly (https://github.com/yonaskolb/XcodeGen)."
  fi
  brew install xcodegen
fi

# — Workspace deps: bun install from this package walks up to the workspace
#   root, which is where the Capacitor plugin packages resolve —
info "Installing workspace dependencies"
(cd "${IOS_DIR}" && bun install)

# — Build the baked app-shell boot bundle the sync copies into the project:
#   the initial Cadet screens ship as local assets, and the bundle's stamped
#   `__CADET_CONFIG__.handoffUrl` resolves from this setup's environment
#   (defaults to local — the simulator shares the host's loopback) —
info "Building the app-shell boot bundle"
(cd "${IOS_DIR}/../app" && bun run build:capacitor)

# — Sync the Capacitor shell: copies the built boot bundle into the Xcode
#   project and bakes the resolved Capacitor config into the native build —
info "Syncing Capacitor iOS project"
(cd "${IOS_DIR}" && bunx --bun cap sync ios)

# — Regenerate App.xcodeproj from App/project.yml —
info "Generating Xcode project"
(cd "${IOS_DIR}/App" && xcodegen generate --spec project.yml)

info "iOS setup complete — open App/App.xcodeproj to build."
