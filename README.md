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

### 📦 Phase 1: Installer & First-Run Polish
* **Custom DMG Installer Window**: Replace the blank Finder DMG layout with a guided install window showing the Folio app icon, Applications folder shortcut, and clear "Drag Folio to Applications" instruction.
* **DMG Background Design**: Add a simple branded background image so non-technical users immediately understand what to do after opening the installer.
* **Release Asset Consistency**: Ensure the DMG, app tarball, bundled Touch ID helper, and release notes are generated from the same app bundle before upload.
* **First-Run Install Guidance**: Improve README and in-app messaging around unsigned macOS builds, quarantine clearing, and safe installation.

### 🎨 Phase 2: Frontend/UI UX Redesign
* **Professional App Shell Refresh**: Redesign the sidebar, catalog grid, settings modal, toolbar actions, empty states, and batch HUD into a calmer, more consistent photo-management interface.
* **Clearer Visual Hierarchy**: Make primary actions obvious, reduce decorative noise, tighten spacing, and improve scanability for folders with hundreds or thousands of media items.
* **Settings Rework**: Split Settings into focused panels for General, Catalog, Cache, Security, Export, and Shortcuts with better labels and less cramped controls.
* **Catalog Workflow Upgrade**: Improve selection states, smart filters, duplicate review, ratings/favorites, and batch progress so they feel cohesive rather than bolted on.
* **Accessibility Polish**: Verify text contrast, focus rings, keyboard navigation, reduced motion behavior, and high-contrast mode across viewer, catalog, modals, and settings.

### 🚄 Phase 3: Backend Optimization & Cache Reliability
* **Fix Cache Clearing Behavior**: Cache clearing should never leave an open folder with an empty sidebar. After purge/prune, Folio should preserve the current folder, rebuild thumbnails/indexes, and refresh the visible catalog automatically.
* **Cache Error Hardening**: Make cache purge/prune resilient when files are locked, already removed, or still referenced by the viewer; report partial failures without making the settings flow feel broken.
* **Job Queue Refinement**: Move more heavy operations onto cancellable jobs with progress, retry, and final accounting so the UI stays responsive during large folders.
* **Protocol Streaming Upgrade**: Continue reducing memory spikes by replacing buffered media responses with streaming where Tauri allows it.
* **Database Maintenance**: Tighten SQLite checkpointing, incremental vacuuming, metadata writes, and cache index consistency after folder changes.
* **Thumbnail Pipeline Optimization**: Continue SIMD/downscale tuning, failure caching, and prefetch heuristics for faster catalog browsing.

### 🍏 Phase 4: Apple Hardware & Security Platform integrations
* **Live Photos AVPlayer**: Seamless pairing of HEIC+MOV formats, rendering active Live Photo sequences on hold clicks.
* **CoreML Asset Auto-Taggers**: On-device classification via Apple's Neural Engine using mobile neural classifiers.
* **CoreHaptics Trackpad Snapping**: Generating physical haptic ticks on Apple Trackpads when scales lock to fit margins or 100%.
* **Native Share Sheet Replacement**: Replace AppleScript share triggering with a direct native Cocoa/Tauri implementation.
* **Vault Hardening**: Continue tightening Secure Album behavior around export, reveal, trash, auto-lock, and recovery edge cases.

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
