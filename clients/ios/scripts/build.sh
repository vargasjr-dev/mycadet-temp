#!/usr/bin/env bash
#
# clients/ios build — the headless core: builds the app-shell boot bundle,
# syncs it into the Xcode project, and regenerates the project file. Run
# via `bun run build` from clients/ios/ — `bun run dev` wraps this with the
# toolchain checks (scripts/setup.sh) and opens Xcode.
#
set -euo pipefail

IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"

info()  { echo "==> $*"; }

# — iOS builds are macOS-only; exit cleanly elsewhere so scripted callers
#   stay harmless on Linux —
if [ "$(uname -s)" != "Darwin" ]; then
  echo "skipping: iOS development requires macOS (Xcode + xcodegen)" >&2
  exit 0
fi

# — Build the baked app-shell boot bundle the sync copies into the project:
#   the initial Cadet screens ship as local assets, and the bundle's stamped
#   `__CADET_CONFIG__.handoffUrl` resolves from this run's environment
#   (defaults to local — the simulator shares the host's loopback) —
info "Building the app-shell boot bundle"
(cd "${IOS_DIR}/../app" && bun run build:capacitor)

# — Sync the Capacitor shell: copies the built boot bundle into the Xcode
#   project and bakes the resolved Capacitor config into the native build —
info "Syncing Capacitor iOS project"
(cd "${IOS_DIR}" && bunx --bun cap sync ios)

# — The local target's plist variant: the shared Info.plist ships with no
#   ATS entry at all (released environments never get localhost support), so
#   the Cadet Local target builds against a generated copy that carries just
#   the loopback cleartext exception. Re-derived from the shared plist on
#   every run so the two can't drift. —
info "Generating the local target's Info.plist"
cp "${IOS_DIR}/App/App/Info.plist" "${IOS_DIR}/App/App/App-Local-Info.plist"
plutil -insert NSAppTransportSecurity -json '{"NSAllowsLocalNetworking":true}' \
  "${IOS_DIR}/App/App/App-Local-Info.plist"

# — Regenerate App.xcodeproj from App/project.yml —
info "Generating Xcode project"
(cd "${IOS_DIR}/App" && xcodegen generate --spec project.yml)

info "iOS build + sync complete — open App/App.xcodeproj to build."
