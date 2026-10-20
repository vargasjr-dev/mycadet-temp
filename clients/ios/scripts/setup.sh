#!/usr/bin/env bash
#
# clients/ios setup — ensures the iOS toolchain (xcodegen via Homebrew) and
# the workspace dependencies, then delegates the build + sync core to
# scripts/build.sh. Run via `bun run dev` from clients/ios/ — which opens
# Xcode once this settles.
#
set -euo pipefail

IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

info()  { echo "==> $*"; }
error() { echo "error: $*" >&2; exit 1; }

# — iOS builds are macOS-only; exit cleanly elsewhere so scripted callers
#   stay harmless on Linux —
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

# — The build itself (boot bundle + cap sync + xcodegen) —
bash "${IOS_DIR}/scripts/build.sh"
