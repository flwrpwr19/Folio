#!/usr/bin/env bash
# Full macOS release pipeline: Tauri app bundle → helpers → DMG → verify (Phase 1).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Building frontend + Tauri app bundle…"
npm run build

echo "==> Copying Touch ID + macOS helpers into bundle…"
"$ROOT_DIR/scripts/package-macos.sh"

echo "==> Creating branded DMG…"
"$ROOT_DIR/scripts/create-release-dmg.sh"

echo "==> Verifying release artifacts…"
"$ROOT_DIR/scripts/verify-release-assets.sh"

ARCH="$(uname -m)"
echo ""
echo "Release ready:"
echo "  DMG:     target/release/bundle/macos/Folio-${ARCH}.dmg"
echo "  Tarball: target/release/bundle/macos/Folio_1.5.0_${ARCH}.app.tar.gz"
echo ""
echo "Install: open the DMG, drag Folio to Applications, then run once:"
echo "  xattr -cr /Applications/Folio.app"
