#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_DIR="$BUILD_DIR/ClaudeTelemetry.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

swiftc -O -parse-as-library \
    -framework AppKit -framework WebKit \
    "$SCRIPT_DIR/ClaudeTelemetry.swift" \
    -o "$MACOS_DIR/ClaudeTelemetry"

cp "$SCRIPT_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"

codesign --force --sign - "$APP_DIR"

echo "Built $APP_DIR"
