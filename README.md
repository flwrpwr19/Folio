# Folio

Folio is a folder-based photo viewer focused on raw performance and a modern UI. Fully in Rust.

Early build: the UI is [Rune](https://github.com/anomalyco/rune), a native GPU-rendered Rust UI framework.

## Run

```sh
cargo run -p folio -- /path/to/photos
```

Or start without a folder and use **Choose Folder** / drag a folder onto the window.
Viewer: click a thumbnail to open (shared-element flight), wheel/drag to pan, pinch to zoom,
←/→ navigate, Esc closes.

## Formats

A decode chain that tries, in order:

1. **macOS ImageIO** (via `objc2-image-io`): hardware-accelerated scaled decode with orientation
   applied — JPEG, PNG, HEIC/HEIF, TIFF, GIF, WebP, BMP, AVIF, and camera RAW
   (CR2/CR3/NEF/ARW/RAF/ORF/RW2/DNG/…, via embedded previews).
2. **`image` crate**: cross-platform fallback plus DDS, QOI, TGA, PNM, HDR, EXR, ICO, farbfeld.
3. **`jxl-oxide`**: JPEG XL.

EXIF orientation is applied everywhere (ImageIO transform flag; `image` decoder orientation).

## Performance architecture

- **Parallel scan**: `jwalk`-based recursive enumeration in `core/folio-scanner` (also a JSON CLI).
- **Background pipeline**: decodes run on a worker pool; results land through a mailbox drained
  in `poll`, so the UI thread never blocks and idle windows draw nothing.
- **On-disk thumbnail cache**: 512 px JPEGs under `~/Library/Caches/Folio/thumbs`, keyed by
  path + mtime + size — a second launch is instant.
- **Priority decode**: first screens eagerly, viewer neighbours jump the queue.
- **Virtualized grid**: only visible rows build and lay out (Rune growth stack).
- **GPU camera**: viewer zoom/pan lives in Rune `Live` values with `tx.live_only()`, so pans and
  pinches draw without re-running the view.

## Layout

- `app/` — the Rune UI app (`folio` crate): `decode.rs` (format chain), `pipeline.rs` (workers,
  cache), `state.rs` (state + actions), `view.rs` (UI).
- `core/folio-scanner/` — scanner library + `folio-scanner` CLI (prints scan results as JSON).
