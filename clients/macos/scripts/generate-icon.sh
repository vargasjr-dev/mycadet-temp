#!/usr/bin/env bash
set -euo pipefail

# Generate a per-environment AppIcon.icns for the Electron build.
# Reads CADET_ENVIRONMENT (default: local) and renders the matching icon from
# build-resources/icons/{env}/ into build/icon.icns.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CADET_ENVIRONMENT="${CADET_ENVIRONMENT:-local}"
ICONS_DIR="$APP_DIR/build-resources/icons"

if [ -d "$ICONS_DIR/$CADET_ENVIRONMENT" ]; then
    ICON_SOURCE_DIR="$ICONS_DIR/$CADET_ENVIRONMENT"
elif [ -d "$ICONS_DIR/production" ]; then
    echo "generate-icon: no icons for '$CADET_ENVIRONMENT', falling back to production"
    ICON_SOURCE_DIR="$ICONS_DIR/production"
else
    echo "generate-icon: no icon sources found at $ICONS_DIR" >&2
    exit 1
fi

echo "generate-icon: using $CADET_ENVIRONMENT icon from $ICON_SOURCE_DIR"

OUTPUT_DIR="$APP_DIR/build"
mkdir -p "$OUTPUT_DIR"

MASTER_PNG=$(mktemp /tmp/appicon-master-XXXXXX).png
ICONSET_DIR=$(mktemp -d)/AppIcon.iconset
mkdir -p "$ICONSET_DIR"

trap 'rm -rf "$MASTER_PNG" "$(dirname "$ICONSET_DIR")"' EXIT

swift - "$ICON_SOURCE_DIR" "$ICONS_DIR" "$MASTER_PNG" <<'SWIFT_SCRIPT'
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let iconDir = CommandLine.arguments[1]
let assetsDir = CommandLine.arguments[2]
let outputPath = CommandLine.arguments[3]

let jsonPath = iconDir + "/icon.json"
let jsonData = try! Data(contentsOf: URL(fileURLWithPath: jsonPath))
let json = try! JSONSerialization.jsonObject(with: jsonData) as! [String: Any]

let fillDict = json["fill"] as! [String: Any]
let solidStr = fillDict["solid"] as! String
let colorParts = solidStr.split(separator: ":")[1].split(separator: ",").map { CGFloat(Double($0)!) }
let fillColor = CGColor(
    colorSpace: CGColorSpace(name: CGColorSpace.displayP3)!,
    components: colorParts
)!

let groups = json["groups"] as! [[String: Any]]
let layers = groups[0]["layers"] as! [[String: Any]]
let layer = layers[0]
let position = layer["position"] as! [String: Any]
let scale = CGFloat(position["scale"] as! Double)
let translationPts = position["translation-in-points"] as! [Double]
let txPoints = CGFloat(translationPts[0])
let tyPoints = CGFloat(translationPts[1])

let imageName = layer["image-name"] as! String
let layerURL = URL(fileURLWithPath: assetsDir).appendingPathComponent(imageName)
guard let source = CGImageSourceCreateWithURL(layerURL as CFURL, nil),
      let mark = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("Failed to read foreground image: \(layerURL.path)")
}

let size = 1024
let colorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

guard let ctx = CGContext(
    data: nil, width: size, height: size,
    bitsPerComponent: 8, bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("Failed to create bitmap context") }

let s = CGFloat(size)

// Full-bleed opaque fill (no rounding). macOS Tahoe inspects edge pixel alpha:
// ≥ 253 → clean system-applied squircle clip; ≤ 252 → "icon jail" (gray border).
// A rounded rect leaves transparent corner pixels (alpha 0) triggering the jail.
// Ref: https://developer.apple.com/forums/thread/797971
ctx.setFillColor(fillColor)
ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))

let markWidth = CGFloat(mark.width) * scale
let markHeight = CGFloat(mark.height) * scale
ctx.interpolationQuality = .high
ctx.draw(mark, in: CGRect(
    x: (s - markWidth) / 2.0 + txPoints,
    y: (s - markHeight) / 2.0 + tyPoints,
    width: markWidth,
    height: markHeight
))

guard let image = ctx.makeImage() else { fatalError("Failed to create CGImage") }
let url = URL(fileURLWithPath: outputPath)
guard let dest = CGImageDestinationCreateWithURL(
    url as CFURL, UTType.png.identifier as CFString, 1, nil
) else { fatalError("Failed to create image destination") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("Failed to write PNG") }
SWIFT_SCRIPT

if [ ! -f "$MASTER_PNG" ]; then
    echo "generate-icon: failed to render master PNG" >&2
    exit 1
fi

for SIZE in 16 32 128 256 512; do
    DOUBLE=$((SIZE * 2))
    sips -z "$SIZE" "$SIZE" "$MASTER_PNG" --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}.png" > /dev/null
    sips -z "$DOUBLE" "$DOUBLE" "$MASTER_PNG" --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}@2x.png" > /dev/null
done

iconutil --convert icns --output "$OUTPUT_DIR/icon.icns" "$ICONSET_DIR"

echo "generate-icon: wrote $OUTPUT_DIR/icon.icns ($CADET_ENVIRONMENT)"

# actool ships with full Xcode, not the Command Line Tools. Without it there is
# no Assets.car, so Finder falls back to the icon.icns written above via
# CFBundleIconFile. afterPack.js copies Assets.car only when it exists.
if ! xcrun -f actool >/dev/null 2>&1; then
    rm -f "$OUTPUT_DIR/Assets.car"
    echo "generate-icon: actool unavailable (requires full Xcode); skipping Assets.car, using icon.icns fallback." >&2
    exit 0
fi

# Compile the Icon Composer .icon bundle into Assets.car so Finder/Dock can use
# the Liquid Glass icon on Tahoe and actool's rounded raster fallback on pre-Tahoe.
# The .icns above is a full-bleed square (required for Tahoe edge-alpha check) and
# serves as CFBundleIconFile fallback. Assets.car (CFBundleIconName) takes priority
# in Finder, providing proper rounded display on all macOS versions.
ICON_BUNDLE_DIR=$(mktemp -d)/AppIcon.icon
mkdir -p "$ICON_BUNDLE_DIR"
cp "$ICON_SOURCE_DIR/icon.json" "$ICON_BUNDLE_DIR/icon.json"
mkdir -p "$ICON_BUNDLE_DIR/Assets"
cp "$ICONS_DIR/mark.png" "$ICON_BUNDLE_DIR/Assets/mark.png"

ACTOOL_MAX_ATTEMPTS=3
ACTOOL_SUCCESS=0
for attempt in $(seq 1 $ACTOOL_MAX_ATTEMPTS); do
    rm -f "$OUTPUT_DIR/Assets.car"
    if ACTOOL_OUTPUT=$(xcrun actool "$ICON_BUNDLE_DIR" \
        --compile "$OUTPUT_DIR" \
        --platform macosx \
        --minimum-deployment-target 15.0 \
        --app-icon AppIcon \
        --output-partial-info-plist /dev/null \
        2>&1); then
        ACTOOL_SUCCESS=1
        break
    fi
    if [ -f "$OUTPUT_DIR/Assets.car" ]; then
        echo "generate-icon: actool exited non-zero but Assets.car was produced on attempt $attempt; continuing."
        ACTOOL_SUCCESS=1
        break
    fi
    echo "generate-icon: actool attempt $attempt/$ACTOOL_MAX_ATTEMPTS failed; retrying."
done
rm -rf "$(dirname "$ICON_BUNDLE_DIR")"

if [ "$ACTOOL_SUCCESS" = "1" ]; then
    echo "generate-icon: wrote $OUTPUT_DIR/Assets.car ($CADET_ENVIRONMENT)"
else
    echo "generate-icon: actool failed to produce Assets.car after all attempts:" >&2
    echo "$ACTOOL_OUTPUT" >&2
    exit 1
fi
