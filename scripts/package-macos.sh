#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="folio"
PACKAGE_NAME="folio"
BIN_NAME="folio"
APP_BUNDLE_DIR="$ROOT_DIR/target/release/bundle/macos/${APP_NAME}.app"
CONTENTS_DIR="$APP_BUNDLE_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
TOUCHID_HELPER_SRC="$ROOT_DIR/src-tauri/helpers/touchid_helper.swift"
TOUCHID_HELPER_BIN="$ROOT_DIR/target/release/touchid_helper"
SWIFT_ARCH="$(uname -m)"
SWIFT_TARGET="${SWIFT_ARCH}-apple-macosx14.0"
APP_TARBALL="$ROOT_DIR/target/release/bundle/macos/Folio_1.4.0_${SWIFT_ARCH}.app.tar.gz"

cd "$ROOT_DIR"
cargo build --release -p "$PACKAGE_NAME"
xcrun swiftc \
    -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
    -target "$SWIFT_TARGET" \
    "$TOUCHID_HELPER_SRC" \
    -framework LocalAuthentication \
    -o "$TOUCHID_HELPER_BIN"

if [[ ! -d "$APP_BUNDLE_DIR" ]]; then
    mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
    cp "$ROOT_DIR/target/release/${BIN_NAME}" "$MACOS_DIR/${APP_NAME}"
fi

cp "$TOUCHID_HELPER_BIN" "$MACOS_DIR/touchid_helper"
chmod 755 "$MACOS_DIR/touchid_helper"
test -x "$MACOS_DIR/touchid_helper"

if [[ ! -f "$CONTENTS_DIR/Info.plist" ]]; then
cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>Folio</string>
    <key>CFBundleIdentifier</key>
    <string>com.local.folio</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Folio</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST
fi

tar -C "$(dirname "$APP_BUNDLE_DIR")" -czf "$APP_TARBALL" "$(basename "$APP_BUNDLE_DIR")"
echo "Prepared app bundle at: $APP_BUNDLE_DIR"
echo "Created archive at: $APP_TARBALL"
