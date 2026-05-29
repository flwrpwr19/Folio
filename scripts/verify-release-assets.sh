#!/usr/bin/env bash
# Verify release bundle contents before upload.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="$(uname -m)"
VERSION="$(node -p "require('$ROOT_DIR/src-tauri/tauri.conf.json').version")"
APP_SRC="$ROOT_DIR/target/release/bundle/macos/folio.app"
DMG_OUT="$ROOT_DIR/target/release/bundle/macos/Folio-${ARCH}.dmg"
TARBALL="$ROOT_DIR/target/release/bundle/macos/Folio_${VERSION}_${ARCH}.app.tar.gz"

fail() { echo "verify-release-assets: $*" >&2; exit 1; }

[[ -d "$APP_SRC" ]] || fail "Missing app bundle. Run: npm run build:macos-release"
[[ -x "$APP_SRC/Contents/MacOS/folio" ]] || fail "Missing folio executable in bundle"
[[ -x "$APP_SRC/Contents/MacOS/touchid_helper" ]] || fail "Missing touchid_helper (run scripts/package-macos.sh)"
[[ -x "$APP_SRC/Contents/MacOS/folio_macos_helper" ]] || fail "Missing folio_macos_helper (run scripts/package-macos.sh)"
[[ -f "$TARBALL" ]] || fail "Missing app tarball: $TARBALL"
[[ -f "$DMG_OUT" ]] || fail "Missing DMG: $DMG_OUT (run scripts/create-release-dmg.sh)"

DIST_JS="$(ls -1 "$ROOT_DIR/frontend/dist/assets"/index-*.js 2>/dev/null | head -1 || true)"
[[ -n "$DIST_JS" ]] || fail "Missing frontend dist build"
DIST_STEM="$(basename "$DIST_JS")"
rg -aq "$DIST_STEM" "$APP_SRC/Contents/MacOS/folio" 2>/dev/null \
  || fail "App bundle missing embedded frontend ($DIST_STEM) — stale release binary"

MOUNT="$(hdiutil attach -nobrowse -readonly "$DMG_OUT" | awk '/\/Volumes\// {print $3; exit}')"
trap '[[ -n "${MOUNT:-}" ]] && hdiutil detach "$MOUNT" -quiet || true' EXIT

[[ -d "$MOUNT/Folio.app" ]] || fail "DMG does not contain Folio.app"
[[ -L "$MOUNT/Applications" ]] || fail "DMG missing Applications symlink"

echo "OK: app bundle, helpers, embedded UI, tarball, and DMG layout verified."
