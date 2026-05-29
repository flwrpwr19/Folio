#!/usr/bin/env bash
# Full macOS release pipeline: Tauri app bundle → helpers → DMG → verify.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Always build into the repo target/ tree (never a sandbox CARGO_TARGET_DIR).
export CARGO_TARGET_DIR="$ROOT_DIR/target"

echo "==> Building frontend + Tauri app bundle…"
rm -rf "$ROOT_DIR/target/release/bundle/macos/folio.app"
npm run build

BUNDLE="$ROOT_DIR/target/release/bundle/macos/folio.app"
if [[ ! -d "$BUNDLE" ]]; then
  echo "Tauri bundle missing at $BUNDLE" >&2
  exit 1
fi

DIST_JS="$(ls -1 "$ROOT_DIR/frontend/dist/assets"/index-*.js 2>/dev/null | head -1 || true)"
if [[ -z "$DIST_JS" ]]; then
  echo "frontend/dist not built" >&2
  exit 1
fi
DIST_STEM="$(basename "$DIST_JS")"
if ! rg -aq "$DIST_STEM" "$BUNDLE/Contents/MacOS/folio" 2>/dev/null; then
  echo "App bundle does not embed current frontend ($DIST_STEM). Stale or wrong target directory." >&2
  exit 1
fi

echo "==> Copying Touch ID + macOS helpers into bundle…"
"$ROOT_DIR/scripts/package-macos.sh"

echo "==> Creating branded DMG…"
"$ROOT_DIR/scripts/create-release-dmg.sh"

echo "==> Verifying release artifacts…"
"$ROOT_DIR/scripts/verify-release-assets.sh"

ARCH="$(uname -m)"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
echo ""
echo "Release ready:"
echo "  DMG:     target/release/bundle/macos/Folio-${ARCH}.dmg"
echo "  Tarball: target/release/bundle/macos/Folio_${VERSION}_${ARCH}.app.tar.gz"
echo ""
echo "Install: open the DMG, drag Folio to Applications, then run once:"
echo "  xattr -cr /Applications/Folio.app"
