#!/usr/bin/env bash
# build-capture-sources.sh: build the native capture-sources addon into
# resources/capture-sources.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/native/capture-sources"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-capture-sources: skipping non-macOS host"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "build-capture-sources: xcrun not found; install Xcode command line tools" >&2
  exit 1
fi

# The packaged app's architecture comes from ELECTRON_TARGET_ARCH, which pack.sh
# exports so a pack always builds the addon for the app it is packing:
# electron-builder packs whatever is under resources/capture-sources, so a
# host-shaped addon in an arm64 pack ships an app that quietly falls back to
# the helper. Unset, the architecture is the host's, because a local
# `bun run setup` builds an addon for the Electron running on this machine.
# `uname -m` reports x86_64 on Intel, which is also what `lipo -archs` calls
# the x64 slice.
REQUESTED_ARCH="${ELECTRON_TARGET_ARCH:-$(uname -m)}"
case "$REQUESTED_ARCH" in
  arm64)      ARCH=arm64; EXPECTED_SLICE=arm64 ;;
  x64|x86_64) ARCH=x64;   EXPECTED_SLICE=x86_64 ;;
  *)
    echo "build-capture-sources: unsupported architecture: $REQUESTED_ARCH (use arm64 or x64)" >&2
    exit 1
    ;;
esac

# The addon links against Electron's V8/Node ABI, so it is compiled against the
# headers for the exact Electron the app ships with.
ELECTRON_VERSION="$(node -p "require('$ROOT_DIR/package.json').devDependencies.electron")"
if [ -z "$ELECTRON_VERSION" ] || [ "$ELECTRON_VERSION" = "undefined" ]; then
  echo "build-capture-sources: could not read the electron version from package.json" >&2
  exit 1
fi

NODE_GYP_BIN="$(cd "$PACKAGE_DIR" && node -e "process.stdout.write(require.resolve('node-gyp/bin/node-gyp.js'))" 2>/dev/null || true)"
if [ -z "$NODE_GYP_BIN" ]; then
  echo "build-capture-sources: node-gyp not found; run bun install in clients/macos" >&2
  exit 1
fi

cd "$PACKAGE_DIR"
node "$NODE_GYP_BIN" rebuild \
  --target="$ELECTRON_VERSION" \
  --arch="$ARCH" \
  --dist-url=https://electronjs.org/headers \
  --devdir="${HOME}/.electron-gyp"

BUILT="$PACKAGE_DIR/build/Release/cadet_capture_sources.node"
if [ ! -f "$BUILT" ]; then
  echo "build-capture-sources: node-gyp produced no addon at $BUILT" >&2
  exit 1
fi

# One build produces one architecture, and electron-builder packs whatever is
# under resources/capture-sources, so a previous build for another arch is
# cleared rather than shipped alongside this one.
rm -rf "$ROOT_DIR/resources/capture-sources"
OUTPUT_DIR="$ROOT_DIR/resources/capture-sources/$ARCH"
mkdir -p "$OUTPUT_DIR"
OUTPUT="$OUTPUT_DIR/cadet-capture-sources.node"
cp "$BUILT" "$OUTPUT"

# A toolchain that ignores --arch produces a host-architecture binary, and
# electron-builder signs and packs whatever it finds, so the mismatch has to
# fail here rather than at the user's first Teach picker.
SLICES="$(lipo -archs "$OUTPUT")"
case " $SLICES " in
  *" $EXPECTED_SLICE "*) ;;
  *)
    echo "build-capture-sources: $OUTPUT is built for $SLICES, not $EXPECTED_SLICE ($ARCH)" >&2
    exit 1
    ;;
esac

echo "build-capture-sources: wrote $OUTPUT ($SLICES)"
