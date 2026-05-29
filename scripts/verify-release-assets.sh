#!/usr/bin/env bash
# DMG-7: verify release bundle contents before upload.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="$(uname -m)"
APP_SRC="$ROOT_DIR/target/release/bundle/macos/folio.app"
DMG_OUT="$ROOT_DIR/target/release/bundle/macos/Folio-${ARCH}.dmg"
TARBALL="$ROOT_DIR/target/release/bundle/macos/Folio_1.5.0_${ARCH}.app.tar.gz"

fail() { echo "verify-release-assets: $*" >&2; exit 1; }

[[ -d "$APP_SRC" ]] || fail "Missing app bundle. Run: npm run build:macos-release"
[[ -x "$APP_SRC/Contents/MacOS/folio" ]] || fail "Missing folio executable in bundle"
[[ -x "$APP_SRC/Contents/MacOS/touchid_helper" ]] || fail "Missing touchid_helper (run scripts/package-macos.sh)"
[[ -x "$APP_SRC/Contents/MacOS/folio_macos_helper" ]] || fail "Missing folio_macos_helper (run scripts/package-macos.sh)"
[[ -f "$TARBALL" ]] || fail "Missing app tarball: $TARBALL"
[[ -f "$DMG_OUT" ]] || fail "Missing DMG: $DMG_OUT (run scripts/create-release-dmg.sh)"

MOUNT="$(hdiutil attach -nobrowse -readonly "$DMG_OUT" | awk '/\/Volumes\// {print $3; exit}')"
trap '[[ -n "${MOUNT:-}" ]] && hdiutil detach "$MOUNT" -quiet || true' EXIT

[[ -d "$MOUNT/Folio.app" ]] || fail "DMG does not contain Folio.app"
[[ -L "$MOUNT/Applications" ]] || fail "DMG missing Applications symlink"

echo "OK: app bundle, helpers, tarball, and DMG layout verified."
