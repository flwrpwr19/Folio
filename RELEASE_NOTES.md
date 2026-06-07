# Folio v1.4.0

Folio v1.4.0 is a major workflow, performance, and interface release. It redesigns the core browsing surfaces, adds stronger catalog and map tooling, fixes viewer/editing regressions, and hardens the macOS release package.

## Highlights

- Redesigned the catalog workspace with denser controls, richer cards, filtering, sorting, selection, and metadata-aware actions.
- Redesigned the photo viewport with a persistent filmstrip/action dock and cleaner top chrome.
- Added the upgraded map workspace with geotagged clusters, preview pins, focused location trays, map filters, and a real Carto Dark default map style.
- Refined settings and inspector workspaces for clearer cache, privacy, metadata, and edit controls.
- Fixed rotation preview rendering so geometric edits replace the image cleanly instead of overlaying a rotated copy.
- Restored and sped up home recent-library thumbnails with backend-warmed preview thumbnails and concurrent hydration.
- Added Secure Album Vault storage using AES-256-GCM with macOS Keychain-backed key material when available.
- Added cancellable backend job tracking for long-running batch operations with progress polling.
- Added ratings, favorites, smart filter presets, saved smart albums, sidecar metadata export/import, and richer Finder actions.
- Improved release packaging with a branded DMG pipeline, bundled macOS helpers, current frontend verification, and cleaner app metadata.

## Verification

- `npm run check --prefix frontend`
- `npm run build --prefix frontend`
- `cargo check --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `npm run build:macos-release`

## Notes

This release remains macOS-first. The app is not notarized, so unsigned release builds may still require clearing quarantine with `xattr -cr /Applications/Folio.app`.

---

# Folio v1.3.2

Improves backend throughput and responsiveness across indexing, metadata inspection, thumbnail generation, cache reuse, and vault I/O. Also restores raw-image metadata inspection and fixes viewer card animations during the first navigation pass.

## Highlights

- Deduplicates concurrent thumbnail and decoded-image work while reusing cached file metadata.
- Reduces indexing and startup filesystem calls, avoids unnecessary SQLite rereads, and keeps WAL work off initial load.
- Streams vault encryption and decryption in authenticated chunks instead of buffering entire files.
- Hydrates inspector metadata lazily, including Spotlight fallback for raw image formats.
- Fixes viewer card animation state when navigating a newly opened folder.
- Refreshes the macOS installer artwork and README banner with a quieter minimal design.

## Verification

- `cargo test --workspace --no-fail-fast`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm run build --prefix frontend`

---

# Folio v1.3.1

Restores instant arrow-key navigation: reuses preloaded full-res images, skips decode/animation delays when moving quickly, and widens the preload window.

---

# Folio v1.3.0

Folio v1.3.0 adds the redesigned shell (onboarding, home hub, settings), a branded macOS installer, unified viewer toolbar with video controls, stronger cache/preload behavior, native macOS helpers, and vault hardening.

## Highlights

- Branded DMG release pipeline (`npm run build:macos-release`) with helper verification for `touchid_helper` and `folio_macos_helper`.
- First-launch onboarding, home hub, and full settings/inspector shell UX.
- Cache reliability: active-folder re-index after purge, granular cache actions, decode failure recovery, WAL maintenance.
- Video controls integrated into the bottom toolbar; direction-aware preload for stills and videos; decoded cache limit with LRU prune.
- macOS platform helpers: native Share Sheet, Vision tag suggestions, CoreHaptics zoom snap, Live Photo long-press AVPlayer preview.
- Vault: export guard, catalog repair, configurable auto-lock; trash dialog truncates long filenames.
- Viewer: sharper image transitions when navigating; settings stays full-screen when clearing cache from Settings.

## Verification

- `cargo check --workspace`
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm run build --prefix frontend`
- `npm run build:macos-release` (branded DMG via `dmgbuild`, drag-to-Applications background)

## Install (macOS)

1. Download **Folio_1.3.0_arm64.dmg**, open it, drag Folio to Applications.
2. Run once (Gatekeeper / quarantine):

```bash
xattr -cr /Applications/Folio.app
```

This release is not notarized. Install updates manually from GitHub Releases.

---

# Folio v1.2.0

See prior releases on GitHub for v1.2.0 and earlier notes.
