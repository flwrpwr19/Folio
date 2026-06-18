#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCANNER_DIR="$ROOT_DIR/core/folio-scanner"

cargo build --manifest-path "$SCANNER_DIR/Cargo.toml" --release

export FOLIO_SCANNER_PATH="$SCANNER_DIR/target/release/folio-scanner"
cd "$ROOT_DIR"
swift run Folio

