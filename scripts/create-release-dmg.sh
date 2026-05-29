#!/usr/bin/env bash
# Branded macOS DMG: dmgbuild for structure, then Finder layout for Tahoe 26+ backgrounds.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Folio"
ARCH="$(uname -m)"
STAGING="$ROOT_DIR/target/release/bundle/macos/dmg-staging"
APP_SRC="$ROOT_DIR/target/release/bundle/macos/folio.app"
DMG_OUT="$ROOT_DIR/target/release/bundle/macos/Folio-${ARCH}.dmg"
BG_SRC="$ROOT_DIR/assets/brand/dmg-installer-background.png"
BG_640="$ROOT_DIR/assets/brand/dmg-installer-background-640x400.png"
ICON_ICNS="$ROOT_DIR/src-tauri/icons/icon.icns"
SETTINGS="$ROOT_DIR/scripts/dmg_settings.py"
LAYOUT_SCRIPT="$ROOT_DIR/scripts/apply-dmg-finder-layout.applescript"

if [[ ! -d "$APP_SRC" ]]; then
  echo "App bundle not found. Run: npm run build (or npm run build:macos-release) first." >&2
  exit 1
fi

if [[ ! -x "$APP_SRC/Contents/MacOS/touchid_helper" ]] || [[ ! -x "$APP_SRC/Contents/MacOS/folio_macos_helper" ]]; then
  echo "Helpers missing. Run scripts/package-macos.sh first." >&2
  exit 1
fi

if ! python3 -c "import dmgbuild" 2>/dev/null; then
  echo "Installing dmgbuild (pip)…"
  python3 -m pip install --user "dmgbuild>=1.6.7"
fi

if [[ -f "$ICON_ICNS" ]]; then
  cp "$ICON_ICNS" "$APP_SRC/Contents/Resources/icon.icns"
fi

if [[ -f "$BG_SRC" ]]; then
  sips -z 400 640 "$BG_SRC" --out "$BG_640" >/dev/null
elif [[ ! -f "$BG_640" ]]; then
  echo "Missing DMG background: $BG_SRC" >&2
  exit 1
fi

rm -rf "$STAGING"
mkdir -p "$STAGING"
ditto "$APP_SRC" "$STAGING/${APP_NAME}.app"

rm -f "$DMG_OUT"
echo "Building DMG with dmgbuild…"
python3 -m dmgbuild \
  -s "$SETTINGS" \
  -D "application=${STAGING}/${APP_NAME}.app" \
  -D "background=${BG_640}" \
  -D "app_name=${APP_NAME}" \
  --no-hidpi \
  "$APP_NAME" \
  "$DMG_OUT"

apply_finder_layout() {
  local rw="${DMG_OUT%.dmg}-rw.dmg"
  rm -f "$rw"

  # Eject any stale mounts of this volume name.
  while IFS= read -r m; do
    [[ -n "$m" ]] && hdiutil detach "$m" -force 2>/dev/null || true
  done < <(mount | awk -v n="$APP_NAME" '$3 ~ "/Volumes/" n {print $3}')

  echo "Applying Finder window layout (macOS 26+ background fix)…"
  hdiutil convert "$DMG_OUT" -format UDRW -o "$rw" >/dev/null

  local attach_line mount_path vol_name
  attach_line="$(hdiutil attach "$rw" -readwrite -nobrowse | grep Apple_HFS)"
  mount_path="$(echo "$attach_line" | awk '{print $NF}')"
  vol_name="$(basename "$mount_path")"

  mkdir -p "${mount_path}/.background"
  cp "$BG_640" "${mount_path}/.background/background.png"

  osascript "$LAYOUT_SCRIPT" "$mount_path" "$vol_name" "$APP_NAME"

  if command -v SetFile >/dev/null 2>&1; then
    SetFile -a V "${mount_path}/.background.png" 2>/dev/null || true
    SetFile -a V "${mount_path}/.background" 2>/dev/null || true
    SetFile -a V "${mount_path}/.background/background.png" 2>/dev/null || true
  fi

  sync
  hdiutil detach "$mount_path" >/dev/null

  rm -f "$DMG_OUT"
  hdiutil convert "$rw" -format UDZO -imagekey zlib-level=9 -o "$DMG_OUT" >/dev/null
  rm -f "$rw"
}

apply_finder_layout

echo ""
echo "Created branded installer: $DMG_OUT"
echo "Open this DMG to verify the install background and icon positions."
