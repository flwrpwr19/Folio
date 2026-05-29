# Folio

A lightweight photo and video viewer built in rust.

Folio is a high-performance, macOS-native media viewer. It uses Tauri for its architecture, leveraging a native Rust backend for lightning-fast media decoding and a modern Vanilla JS/CSS frontend for a polished UI.

## Features

- **Blazing Fast I/O**: Multi-threaded metadata extraction and aggressive caching via SQLite WAL mode.
- **Media Support**: Full native support for JPG, PNG, WEBP, AVIF, TIFF, GIF, and chunked streaming for video files (MP4, MOV, MKV).
- **Editorial Metadata Overlay**: Press `I` to bring up a beautiful frosted glass overlay with EXIF data (Aperture, Shutter, ISO, Focal Length).
- **Customizable Keybindings**: Fully customizable shortcuts and mouse modifiers via the Settings menu.
- **Native macOS Feel**: Cinematic hardware-accelerated mesh gradient backgrounds, dynamic color tinting based on the active image, and custom magnetic cursors.
- **Precise Zoom**: Buttery smooth, customizable `Shift+Scroll` variable zoom that perfectly tracks the cursor with drag panning.
- **Simple Photo Editing**: Non-destructive adjustments for Brightness and Vibrance, plus instant Horizontal/Vertical flipping.

- **Full-Screen Media Catalog**: A zoomable grid view with thumbnail shimmer loading, multi-select (⇧/⌘+Click), batch format transcoding (WebP, PNG, JPEG, AVIF, TIFF), duplicate detection via perceptual hashing, and inline folder creation.
- **Tag Filtering**: Sidebar tag filter panel with color-coded chips to isolate images by custom tags.
- **GPS Map Popup**: Tap EXIF GPS coordinates to launch an inline map view of the image's capture location.
- **Format Transcoding**: Batch convert selected images between WebP, PNG, JPEG, AVIF, and TIFF directly from the catalog grid.
- **Duplicate Finder**: Perceptual hash-based visual similarity detection to flag duplicate or near-duplicate images.
- **Accessibility Color Simulator**: Real-time Protanopia, Deuteranopia, and Tritanopia filters for designers auditing assets.
- **Export Watermarking**: Optional text watermark overlay applied dynamically on image export.
- **Custom SVG Icon System**: Every icon in the app uses crisp, consistent inline SVGs — no emoji fallbacks.
- **Window Vibrancy**: Optional macOS-native window transparency and background tinting.
- **Secure Album Vault**: Touch ID-gated encrypted vault storage for sensitive media, backed by macOS Keychain key material where available.
- **Smart Catalog Workflows**: Ratings, favorites, smart filters, saved smart albums, sidecar metadata export/import, and job-tracked batch operations.
- **Release-Grade Packaging**: macOS packaging now validates and bundles the Touch ID helper required for biometric vault security.

## v1.4.0 Roadmap Snapshot

Folio v1.4.0 focuses on turning the viewer into a safer catalog workflow tool:

- Secure Album Vault with Touch ID unlock, auto-lock behavior, and protected command boundaries.
- Cancellable backend jobs for transcode, EXIF scrub, vault import/export, thumbnail warmup, ratings, favorites, and trash.
- Smarter catalog organization through favorites, 0-5 ratings, smart filters, saved smart albums, and metadata sidecars.
- Better operational controls with thumbnail cache quotas, prune actions, decode failure caching, and navigation-aware prefetch.
- More native macOS workflow affordances with Finder actions in breadcrumbs, recent folders, duplicate resolver cards, and batch selections.

## 🗺️ Roadmap & Upcoming Changes

We are actively engineering several high-performance upgrades, workflow enhancements, and deep native macOS integrations. Here is what is currently in active development:

### 🚄 Phase 1: High-Performance Engine & Caching (Engine Sweep)
* **Direct Memory-Mapped SQLite Mirroring**: Syncing hyper-active read indices to in-memory databases (`:memory:`) to drop search and filter query latencies to near-zero.
* **SIMD-Accelerated Downscaler**: Re-architecting thumbnail generation with AVX-2, SSE, and NEON instruction sets using the `fast_image_resize` crate.
* **Zero-Copy Chunk Streaming**: Updating our custom Tauri asset protocol to stream media via asynchronous `ReaderStream` and `tokio::fs::File` pipelines, drastically shrinking memory overhead.
* **Auto-Vacuuming & Database Tuning**: Actively managing cache footprints with incremental vacuum scheduling (`PRAGMA incremental_vacuum`) and background WAL database checkpoints.

### 🎨 Phase 2: Responsive Workspaces & Custom Cursor HUDs
* **Pane Partitions & Dynamic Grid pack**: Integrating draggable canvas dividers to scale workspace sections dynamically alongside pixel-perfect adaptive grid cols.
* **Compact Cursor Ring & Pointer HUDs**: Reducing the primary magnetic ring footprint to an elegant, minimal target pointer, transitioning to specialized pointer vectors (double arrows, crosshairs) on sliders and timelines.
* **Storage Diagnostics Dashboard**: Adding a Cache Control settings menu allowing users to monitor database/thumbnail directory sizes on disk and clear all local caches with a single click.

### 📸 Phase 3: Professional Creative & Audit Utilities
* **Before/After Comparators**: Implementing dual-viewport slider controls to inspect brightness, vibrance, or tone curve adjustments side-by-side.
* **Visual Duplicates Resolver overlay**: A clean, side-by-side metadata and visual resolver grid to instantly review, compare, and prune low-quality duplicates.
* **Mapbox/Leaflet GPS Geolocation Mapping**: Upgrading static coordinates into dynamic interactive Leaflet mapping networks, clustered with photo thumbnails.
* **Selection Modification HUD**: Sliding metadata panel with EXIF adjustments, tagging tools, and an integrated catalog file delete controller.

### 🍏 Phase 4: Apple Hardware & Security Platform integrations
* **Live Photos AVPlayer**: Seamless pairing of HEIC+MOV formats, rendering active Live Photo sequences on hold clicks.
* **CoreML Asset Auto-Taggers**: On-device classification via Apple's Neural Engine using mobile neural classifiers.
* **CoreHaptics Trackpad Snapping**: Generating physical haptic ticks on Apple Trackpads when scales lock to fit margins or 100%.

> **Note:** The auto-updater is currently on hold due to signature and certificate issues. Please download manual updates from the GitHub Releases page.


### "App is damaged and can't be opened" (macOS)
Because Folio is a free, open-source app, it is not cryptographically "notarized" using a paid Apple Developer account ($99/year). Because of this, modern macOS Gatekeeper intentionally marks the downloaded app as "damaged" to force developers into their paid ecosystem, completely hiding the "Open Anyway" button.

**The ONLY way to bypass Apple's block for free apps is a one-time terminal command:**
1. Drag the **Folio** app from the `.dmg` into your **Applications** folder.
2. Open your Mac's **Terminal** app.
3. Copy and paste this exact command and press Enter:
```bash
xattr -cr /Applications/Folio.app
```
This simply strips Apple's "quarantine" flag from the file. You will now be able to open Folio normally forever!
