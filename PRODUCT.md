# Product

<!-- impeccable:product-schema 1 -->

## Platform

macOS-first desktop app (native, Rune GPU UI). Cross-platform is not a current requirement.

## Stack

Rust workspace: `rune` (GPU-rendered UI framework, git-pinned to `dev`) + `core/folio-scanner` (parallel filesystem scan) + `image` / `objc2-image-io` / `jxl-oxide` decode chain. Chosen for the performance mandate; already built and working.

## Users

Primary: people who collect high-quality photos and photographers working from large local folders (mixed formats: RAW, HEIC, JPEG, and everything else). It must remain approachable for casual photo browsing too. Confirmed by the user.

## Product Purpose

Folio is a folder-based photo viewer: point it at any folder on disk and every image in that tree is browsable immediately — no import, no library building, no wait. It reads files in place, decodes essentially every photo format (ImageIO + image crate + JPEG XL), and is engineered so the UI thread never blocks: parallel scan, worker-pool decode, disk thumbnail cache, GPU camera zoom/pan, virtualized grid. Success = opening a folder of 100k mixed photos feels instant and stays fluid.

## Positioning

A local-first, zero-import, format-universal photo browser that stays GPU-fast on huge folder trees — a Lightroom-class decoder pipeline with none of the import/catalog ceremony.

## Non-goals

No cloud, no upload, no library import, no editing pipeline (beyond viewing). Files are read in place, never moved or copied.
