# Folio

![Folio banner](assets/brand/folio-readme-banner.png)

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

## v1.4.0 Release Snapshot

Folio v1.4.0 turned the viewer into a safer catalog workflow tool:

- Secure Album Vault with Touch ID unlock, auto-lock behavior, and protected command boundaries.
- Cancellable backend jobs for transcode, EXIF scrub, vault import/export, thumbnail warmup, ratings, favorites, and trash.
- Smarter catalog organization through favorites, 0-5 ratings, smart filters, saved smart albums, and metadata sidecars.
- Better operational controls with thumbnail cache quotas, prune actions, decode failure caching, and navigation-aware prefetch.
- More native macOS workflow affordances with Finder actions in breadcrumbs, recent folders, duplicate resolver cards, and batch selections.

## 🗺️ Roadmap & Upcoming Changes

We are actively engineering installation polish, a cleaner professional interface, deeper backend performance work, and cache reliability fixes. Here is what is currently planned after v1.4.0:

### 📦 Phase 1: Installer & First-Run Polish ✅
* **Custom DMG Installer Window** ✅ — `scripts/create-release-dmg.sh` (create-dmg) with Folio icon + Applications drop link.
* **DMG Background Design** ✅ — Branded background via `assets/brand/folio-readme-banner.png`.
* **Release Asset Consistency** ✅ — `npm run build:macos-release` → package helpers → DMG → `scripts/verify-release-assets.sh`.
* **First-Run Install Guidance** ✅ — README Gatekeeper / `xattr` steps below.

### 👋 Phase 1.5: In-App Onboarding ✅
* **First-Launch Wizard** ✅ — Welcome, trust/Gatekeeper, open folder, permissions, UI tour, preferences.
* **Calm Empty State** ✅ — Home hub and open-folder flow without decorative aurora.
* **Show Again** ✅ — Settings → General can replay onboarding.

### 🎨 Phase 2: Frontend/UI UX Redesign ✅
* **Professional App Shell** ✅ — 3-pane shell, home hub, inspector, catalog grid, batch HUD, viewer toolbar.
* **Settings Rework** ✅ — General, Appearance, Catalog, Cache, Export, Shortcuts, Security, Advanced.
* **Catalog Workflow** ✅ — Smart filters, duplicates resolver, ratings/favorites, batch jobs panel.
* **Accessibility** ✅ — Focus rings, reduced motion, high contrast (`modules/a11y.js`).

### 🚄 Phase 3: Backend Optimization & Cache Reliability ✅
* **Fix Cache Clearing Behavior** ✅ — Active folder is re-indexed after purge/metadata clear; UI refreshes via `refresh_active_library` / `get_folder_items`.
* **Cache Error Hardening** ✅ — Locked/missing cache files are skipped with warnings; partial clears complete successfully.
* **Job Queue Refinement** ✅ — Jobs emit `job-update` events; per-path retry; thumbnail warmup uses failure cache + retry.
* **Protocol Streaming Upgrade** ✅ — Range/chunked responses for video and ranged reads; large images buffer up to 64MB (no broken 416 gate).
* **Database Maintenance** ✅ — WAL checkpoint + incremental vacuum after index builds and metadata clears.
* **Thumbnail Pipeline Optimization** ✅ — Bounded parallel warmup, thumb/decode failure caches, navigation prefetch jobs.

### 🍏 Phase 4: Apple Hardware & Security Platform integrations ✅
* **Live Photos AVPlayer** ✅ — Long-press a Live Photo opens native AVPlayer preview; hover still plays inline.
* **CoreML Asset Auto-Taggers** ✅ — `classify_image_path` uses Vision on-device (`macos_haptic_tick` / helper).
* **CoreHaptics Trackpad Snapping** ✅ — Haptic tick when zoom snaps back to fit (100%).
* **Native Share Sheet Replacement** ✅ — `NSSharingServicePicker` via `folio_macos_helper` (no Finder AppleScript).
* **Vault Hardening** ✅ — Block export into vault dir, repair catalog command, configurable auto-lock refresh.

### ⚙️ Phase 5: Performance (partial ✅)
* **Predictive Preload Queue** ✅ — Direction-aware still/video preload + 640px thumbs + RAW decode prefetch for ±1 neighbors.
* **Decode / cache tuning** ✅ — CPU-aware parallelism (2–8 workers), decoded cache limit + LRU prune, parallel thumbnail jobs.
* **libraw / Metal** — Not planned (diminishing returns vs. maintenance cost for this app).

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
