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

## Verification

- `cargo check --workspace`
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm run build --prefix frontend`
- macOS package script validates `Folio.app/Contents/MacOS/touchid_helper`

## Notes

This release remains macOS-first. The app is not notarized, so unsigned release builds may still require clearing quarantine with `xattr -cr /Applications/Folio.app`.
