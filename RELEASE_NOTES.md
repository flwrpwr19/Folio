# Folio v1.5.0

Folio v1.5.0 is a polish and performance release: branded macOS installer pipeline, unified viewer toolbar (including video), stronger cache/preload behavior, native macOS helpers, and vault/documentation hardening.

## Highlights

- Branded DMG release pipeline (`npm run build:macos-release`) with helper verification for `touchid_helper` and `folio_macos_helper`.
- First-launch onboarding, home hub, and full settings/inspector shell UX.
- Cache reliability: active-folder re-index after purge, granular cache actions, decode failure recovery, WAL maintenance.
- Video controls integrated into the bottom toolbar; direction-aware preload for stills and videos; decoded cache limit with LRU prune.
- macOS platform helpers: native Share Sheet, Vision tag suggestions, CoreHaptics zoom snap, Live Photo long-press AVPlayer preview.
- Vault: export guard, catalog repair, configurable auto-lock; trash dialog truncates long filenames.

## Verification

- `cargo check --workspace`
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm run build --prefix frontend`
- `npm run build:macos-release` (branded DMG via `dmgbuild`, drag-to-Applications background)

## Notes

This release remains macOS-first and is not notarized. After installing from the DMG, run once:

```bash
xattr -cr /Applications/Folio.app
```

The in-app auto-updater remains disabled; install updates manually from GitHub Releases.

---

# Folio v1.4.0

Folio v1.4.0 is a high-impact workflow and security release focused on protected media, batch operations, smarter catalog organization, and release packaging hardening.

## Highlights

- Added Secure Album Vault storage using AES-256-GCM encryption with macOS Keychain-backed key material when available.
- Added Touch ID gated vault unlock, lock, import, and export command paths.
- Added cancellable backend job tracking for long-running batch operations with progress polling.
- Added ratings, favorites, smart filter presets, saved smart albums, and sidecar metadata export/import.
- Added thumbnail cache quota controls, prune action, decode failure suppression, and navigation-aware prefetch.
- Added Finder actions to breadcrumbs, recent folders, duplicate resolver cards, and batch selections.
- Added richer watermark controls for opacity, scale, font size, and anchor.
- Hardened macOS packaging so the bundled Touch ID helper is compiled and copied into the app bundle.
