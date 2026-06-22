# Folio

Folio is a native macOS media browser rebuilt around a cinematic dark home screen and an immersive, minimal image viewport.

## Stack

- SwiftUI/AppKit-native macOS frontend
- Rust scanner helper for fast folder enumeration
- ImageIO thumbnail decoding with in-memory caching
- Local-first folder browsing; no import requirement

## Run

```bash
./scripts/run-dev.sh
```

The dev runner builds the Rust scanner, exports `FOLIO_SCANNER_PATH`, and launches the Swift app.

## Build Checks

```bash
cargo test --manifest-path core/folio-scanner/Cargo.toml
swift build
```
