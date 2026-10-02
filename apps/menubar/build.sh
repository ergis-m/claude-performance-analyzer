#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/ClaudeTelemetry.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

# Without an explicit target, swiftc sets the minimum macOS to the SDK version,
# and the app refuses to launch on older systems (LaunchServices error -10825).
MIN_MACOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$SCRIPT_DIR/Info.plist")"
for arch in arm64 x86_64; do
    swiftc -O -parse-as-library \
        -target "$arch-apple-macos$MIN_MACOS" \
        -framework SwiftUI -framework Charts \
        "$SCRIPT_DIR/ClaudeTelemetry.swift" \
        -o "$BUILD_DIR/ClaudeTelemetry-$arch"
done
lipo -create "$BUILD_DIR"/ClaudeTelemetry-arm64 "$BUILD_DIR"/ClaudeTelemetry-x86_64 -output "$MACOS_DIR/ClaudeTelemetry"
rm "$BUILD_DIR"/ClaudeTelemetry-arm64 "$BUILD_DIR"/ClaudeTelemetry-x86_64

cp "$SCRIPT_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"

codesign --force --sign - "$APP_DIR"

echo "Built $APP_DIR"
