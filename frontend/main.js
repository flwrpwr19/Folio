import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { save, open } from '@tauri-apps/plugin-dialog';
import { createEventBus } from './modules/state.js';
import { trackJob } from './modules/jobs.js';
import { initOnboarding, isOnboardingComplete, resetOnboarding } from './modules/onboarding.js';
import {
  getPinnedFolders, togglePinnedFolder, isPinned, getHomeLayout, saveHomeLayout,
  formatHomePath, folderDisplayName,
} from './modules/home.js';
import { analyzeDuplicateGroup } from './modules/duplicates.js';
import { renderEmptyState, clearEmptyState, setInlineStatus } from './modules/empty-states.js';
import { initToast, showToast } from './modules/toast.js';
import { initZoomController, queueWheelZoom } from './modules/zoom.js';
import { bindVideoToolbar, detachVideoToolbar, toggleVideoPlayback } from './modules/video-player.js';
import { formatFilenameForDialog, basename, truncateDisplayName } from './modules/format.js';
import { initA11y } from './modules/a11y.js';

/* ── State ── */
let items = [];
let idx = 0;
let zoom = 1;
let panX = 0, panY = 0;
let isDragging = false, startX, startY;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
let overlayVisible = false;
let isFullscreen = false;

/* ── DOM ── */
const app = document.getElementById('app');
app.innerHTML = `
  <div class="home-hub" id="welcome">
    <div class="home-layout">
      <aside class="home-side">
        <div class="home-side-chrome" id="wDrag" data-tauri-drag-region></div>
        <div class="home-side-scroll">
        <div class="home-brand">
          <h1>Folio</h1>
          <p class="tagline">Fast, private media browsing for macOS.</p>
        </div>
        <div class="home-section" id="homeLibrarySection">
          <div class="home-section-title">Library</div>
          <div class="home-actions">
            <button type="button" class="home-btn home-btn-primary" id="openBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg> Open Folder</button>
            <button type="button" class="home-btn" id="homeCatalogBtn" style="display:none">Media Catalog</button>
          </div>
        </div>
        <div class="home-section" id="homePinnedSection">
          <div class="home-section-head">
            <span class="home-section-title">Pinned locations</span>
          </div>
          <div class="home-list" id="pinnedFolders"></div>
        </div>
        <div class="home-section" id="homeRecentsSection">
          <div class="home-section-head">
            <span class="home-section-title">Recent</span>
            <button type="button" class="home-text-btn" id="clearRecentsHomeBtn" title="Clear recent folders list">Clear</button>
          </div>
          <div class="home-list" id="recentFolders"></div>
        </div>
        <div class="home-section" id="homeCustomizeSection">
          <div class="home-section-head">
            <span class="home-section-title">Customize home</span>
          </div>
          <p class="home-customize-hint">Show or hide sections on this screen.</p>
          <div class="home-customize" id="homeCustomizeChips"></div>
        </div>
        </div>
      </aside>
      <main class="home-main">
        <div class="home-dropzone" id="welcomeDropzone">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
          <span>Drop a folder to open</span>
        </div>
        <div class="home-shortcuts">
          <span><kbd>G</kbd> Catalog</span>
          <span><kbd>I</kbd> Metadata</span>
          <span><kbd>E</kbd> Edit</span>
          <span><kbd>B</kbd> Sidebar</span>
        </div>
      </main>
    </div>
  </div>

  <div class="app-shell" id="appShell" style="display:none">
  <div class="sidebar nav-pane" id="sidebar" style="display:none">
    <div class="sidebar-dragbar" id="sDrag" data-tauri-drag-region>
        <div class="breadcrumbs" id="breadcrumbs"></div>
        <button class="grid-toggle-btn" id="gridToggleBtn" data-tooltip="Toggle Grid View (G)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
        </button>
    </div>

    <div class="nav-section">
      <div class="nav-section-label">Library</div>
      <button type="button" class="nav-item active" data-nav="all"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> All Media</button>
      <button type="button" class="nav-item" data-nav="favorites"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.18L12 21z"/></svg> Favorites</button>
      <button type="button" class="nav-item" data-nav="rated"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Rated 3+</button>
      <button type="button" class="nav-item" data-nav="videos"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Videos</button>
    </div>
    <div class="nav-section">
      <div class="nav-section-label">Smart Filters</div>
      <button type="button" class="nav-item" data-nav="gps"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg> GPS</button>
      <button type="button" class="nav-item" data-nav="raw"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg> RAW / HEIC</button>
    </div>
    <div class="sidebar-divider"></div>

    <div class="sidebar-controls">
      <button class="sidebar-btn" id="openBtn2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg> Open Folder</button>
      <button class="sidebar-btn" id="sidebarCatalogBtn" style="margin-top: 6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> Media Catalog</button>
    </div>
    <div class="sidebar-divider"></div>
    <div class="tag-filter-panel" id="tagFilterPanel">
      <span class="tag-filter-header">Filter by Tag</span>
      <div class="tag-filter-list" id="tagFilterList"></div>
    </div>
    <div class="sidebar-resizer" id="sidebarResizer"></div>
  </div>

  <div class="main-pane" id="mainPane">
  <div class="catalog-grid-view" id="catalogGrid" style="display:none">
    <div class="catalog-header" id="cDrag" data-tauri-drag-region>
      <h2 id="catalogTitle">Catalog Grid</h2>
      <div class="catalog-header-actions">
        <button class="catalog-btn" id="catalogMapBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg> Map View</button>
        <select class="catalog-btn" id="smartFilterSelect" style="height: 30px; max-width: 132px;"><option value="">All Media</option><option value="favorites">Favorites</option><option value="rated">Rated 3+</option><option value="gps">GPS</option><option value="raw">RAW/HEIC/TIFF</option></select>
        <button class="catalog-btn" id="saveSmartAlbumBtn" data-tooltip="Save the current catalog filter (dropdown + tags) as a reusable smart album">Save Smart</button>
        <button class="catalog-btn" id="catalogDuplicatesBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg> Find Duplicates</button>
        <button class="catalog-btn" id="catalogFinderBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/></svg> Finder</button>
        <button class="catalog-btn" id="catalogNewFolderBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg> New Folder</button>
        <button class="catalog-btn" data-tooltip="⇧/⌘ + Click to select multiple" style="opacity: 0.5; padding: 6px 8px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></button>
        <button class="catalog-btn" id="catalogCloseBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close Grid</button>
      </div>
    </div>
    <div class="folio-state-host" id="catalogStateHost" aria-hidden="true"></div>
    <div class="catalog-content" id="catalogContent"></div>
    <div class="batch-bar" id="batchBar" role="region" aria-label="Batch actions">
      <header class="batch-bar-head">
        <div class="batch-bar-head-text">
          <span class="batch-bar-eyebrow">Selection</span>
          <span class="batch-bar-count" id="batchCount">0 items</span>
        </div>
        <button type="button" class="batch-bar-close" id="batchClose" aria-label="Clear selection">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>
      <div class="batch-bar-scroll">
        <section class="batch-section">
          <h3 class="batch-section-label">Convert</h3>
          <div class="batch-chip-row">
            <button type="button" class="batch-chip" data-fmt="webp">WebP</button>
            <button type="button" class="batch-chip" data-fmt="png">PNG</button>
            <button type="button" class="batch-chip" data-fmt="jpeg">JPEG</button>
            <button type="button" class="batch-chip" data-fmt="avif">AVIF</button>
            <button type="button" class="batch-chip" data-fmt="tiff">TIFF</button>
          </div>
        </section>
        <section class="batch-section">
          <h3 class="batch-section-label">Organize</h3>
          <div class="batch-organize-row">
            <input type="text" id="batchTagInput" class="batch-tag-input" placeholder="Add tag, press Enter" />
            <button type="button" class="batch-chip" id="batchFavoriteBtn">Favorite</button>
            <button type="button" class="batch-chip" id="batchRateBtn">Rate ★5</button>
          </div>
        </section>
        <section class="batch-section">
          <h3 class="batch-section-label">Files</h3>
          <div class="batch-chip-row">
            <button type="button" class="batch-chip" id="batchFinderBtn">Reveal in Finder</button>
            <button type="button" class="batch-chip" id="batchSidecarBtn">Export sidecar</button>
            <button type="button" class="batch-chip" id="batchVaultBtn">Add to vault</button>
            <button type="button" class="batch-chip batch-chip-warn" id="batchScrubBtn">Scrub EXIF</button>
          </div>
        </section>
        <section class="batch-section batch-section-danger">
          <button type="button" class="batch-chip batch-chip-danger" id="batchTrashBtn">Move to Trash</button>
        </section>
      </div>
      <p class="batch-bar-hint">Progress appears in Inspector → Jobs</p>
    </div>
  </div>

  <div class="viewer" id="viewer" style="display:none">
    <div class="folio-state-host folio-state-host--viewer" id="viewerStateHost" aria-hidden="true"></div>
    <div class="viewer-bg-base"></div>
    <div class="backdrop-glow" id="backdropGlow"></div>
    <div class="viewer-dragbar" id="vDrag" data-tauri-drag-region></div>
    <button class="sidebar-toggle" id="sidebarToggle" data-tooltip="Toggle Sidebar (B)">Sidebar</button>
    <div class="media-wrap" id="media">
      <div class="media-loader" id="mediaLoader" aria-hidden="true">
        <svg class="loader-ring" viewBox="0 0 44 44">
          <circle class="loader-track" cx="22" cy="22" r="18"></circle>
          <circle class="loader-indicator" cx="22" cy="22" r="18"></circle>
        </svg>
      </div>
    </div>
    <div class="editorial-overlay" id="editorialOverlay" aria-hidden="true" style="display:none !important;"></div>
    <button class="nav-arrow prev" id="prev">‹</button>
    <button class="nav-arrow next" id="next">›</button>
    <div class="viewer-bottom">
      <div class="viewer-filmstrip-wrap">
        <div class="filmstrip viewer-filmstrip" id="filmstrip"></div>
      </div>
      <div class="viewer-toolbar" id="viewerToolbar">
        <button type="button" class="vt-btn vt-btn-icon v-play-btn toolbar-video-only" id="viewerVideoPlayBtn" hidden aria-label="Play or pause">
          <svg class="v-icon-play" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="display:none"><polygon points="6,3 20,12 6,21"/></svg>
          <svg class="v-icon-pause" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <div class="viewer-video-scrub toolbar-video-only" id="viewerVideoScrub" hidden>
          <input type="range" class="v-progress" id="viewerVideoProgress" value="0" min="0" max="100" step="0.1" aria-label="Seek">
          <span class="v-time" id="viewerVideoTime">0:00 / 0:00</span>
        </div>
        <div class="viewer-toolbar-actions">
          <div class="viewer-stars" id="viewerStars" aria-label="Rating"></div>
          <button type="button" class="vt-btn vt-btn-icon" id="viewerFavoriteBtn" data-tooltip="Favorite" aria-label="Favorite">
            <svg class="vt-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-4.35-9-7.5C1.5 11 2.5 7 6 5.5c2-.9 4.5-.3 6 2 1.5-2.3 4-2.9 6-2 3.5 1.5 4.5 5.5 3 8.5-2.5 3.15-9 7.5-9 7.5z"/></svg>
          </button>
          <button type="button" class="vt-btn vt-btn-icon" id="viewerPickBtn" data-tooltip="Pick" aria-label="Pick">
            <svg class="vt-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18"/><path d="M5 4h12l-4 4 4 4H5"/></svg>
          </button>
          <div class="v-volume-container toolbar-video-only" id="viewerVideoVolWrap" hidden>
            <button type="button" class="vt-btn vt-btn-icon v-volume-btn" id="viewerVideoVolBtn" aria-label="Mute or unmute">
              <svg class="v-icon-volume-high" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              <svg class="v-icon-volume-muted" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
            </button>
            <input type="range" class="v-volume-slider" id="viewerVideoVolSlider" min="0" max="100" value="100" aria-label="Volume">
          </div>
        </div>
        <span class="viewer-toolbar-divider" aria-hidden="true"></span>
        <div class="zoom-hud-inline">
          <input type="range" id="zoomSlider" min="100" max="800" value="100" step="10" />
          <span class="zoom-label" id="zoomLabel">100%</span>
          <button type="button" class="zoom-reset" id="zoomReset" data-tooltip="Fit to Screen (0)">FIT</button>
          <button type="button" class="zoom-action compare-toggle-btn" id="compareBtn" data-tooltip="Compare (C)" style="display:none">CMP</button>
          <button type="button" class="zoom-action fullscreen-toggle" id="fullscreenBtn" data-tooltip="Fullscreen (F)">FULL</button>
        </div>
      </div>
    </div>
    <button class="edit-toggle-btn" id="editToggleBtn" data-tooltip="Edit Photo (E)">Edit</button>
  </div>
  </div>

  <aside class="inspector-pane visible" id="inspectorPane">
    <button type="button" class="inspector-edge-btn" id="inspectorCollapseBtn" aria-label="Collapse inspector" aria-expanded="true">
      <svg class="inspector-edge-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>
    </button>
    <div class="inspector-inner">
    <div class="inspector-header">
      <div class="inspector-tabs" role="tablist">
        <button type="button" class="inspector-tab active" data-inspector="info" role="tab">Info</button>
        <button type="button" class="inspector-tab" data-inspector="adjust" role="tab">Adjust</button>
        <button type="button" class="inspector-tab" data-inspector="presets" role="tab">Presets</button>
        <button type="button" class="inspector-tab" data-inspector="jobs" role="tab">Jobs</button>
      </div>
    </div>
    <div class="inspector-body">
      <div class="inspector-panel active" id="inspectorInfo" data-panel="info">
        <div class="inspector-card inspector-meta">
          <div class="inspector-card-title">File</div>
          <div class="counter" id="counter"></div>
          <div class="filename" id="fname"></div>
          <div class="dimensions" id="dims"></div>
          <span class="format-badge" id="badge" style="display:none"></span>
        </div>
        <div class="inspector-card">
          <div class="inspector-card-title">Camera</div>
          <div class="editorial-camera" id="edCamera" style="font-size:13px;color:var(--text-primary);margin-bottom:8px;"></div>
          <div class="inspector-exif-grid">
            <div class="inspector-exif-item"><span>Aperture</span><span id="edAperture">—</span></div>
            <div class="inspector-exif-item"><span>Shutter</span><span id="edShutter">—</span></div>
            <div class="inspector-exif-item"><span>ISO</span><span id="edIso">—</span></div>
            <div class="inspector-exif-item"><span>Focal</span><span id="edFocal">—</span></div>
          </div>
          <div class="editorial-tech-data" id="edTechData" style="margin-top:10px;font-size:11px;color:var(--text-tertiary);"></div>
        </div>
        <div class="inspector-card">
          <div class="inspector-card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span>Analysis</span>
            <button type="button" class="settings-update-btn" id="classifySuggestBtn" style="padding:4px 8px;font-size:10px;">Suggest tags</button>
          </div>
          <div id="classifyResults" class="classify-results" style="display:none;flex-wrap:wrap;gap:6px;margin-bottom:8px;"></div>
          <canvas class="editorial-histogram" id="histogramCanvas" width="260" height="56" aria-hidden="true" style="width:100%;max-width:100%;border-radius:6px;"></canvas>
          <canvas class="editorial-waveform" id="waveformCanvas" width="260" height="64" aria-hidden="true" style="width:100%;max-width:100%;margin-top:8px;border-radius:6px;border:1px solid var(--border-subtle);"></canvas>
          <div class="editorial-palette" id="editorialPalette" style="margin-top:12px;display:flex;flex-direction:column;gap:6px;">
            <span class="inspector-card-title" style="margin-bottom:0;">Dominant palette</span>
            <div id="paletteChips" style="display:flex;gap:8px;margin-top:4px;">
              <div class="palette-chip" style="display:none;width:20px;height:20px;border-radius:50%;cursor:pointer;border:1px solid var(--border-hover);"></div>
              <div class="palette-chip" style="display:none;width:20px;height:20px;border-radius:50%;cursor:pointer;border:1px solid var(--border-hover);"></div>
              <div class="palette-chip" style="display:none;width:20px;height:20px;border-radius:50%;cursor:pointer;border:1px solid var(--border-hover);"></div>
              <div class="palette-chip" style="display:none;width:20px;height:20px;border-radius:50%;cursor:pointer;border:1px solid var(--border-hover);"></div>
              <div class="palette-chip" style="display:none;width:20px;height:20px;border-radius:50%;cursor:pointer;border:1px solid var(--border-hover);"></div>
            </div>
          </div>
        </div>
        <div class="inspector-card editorial-gps" id="edGps" style="display:none;flex-direction:column;gap:8px;">
          <div class="inspector-card-title">Location</div>
          <button type="button" class="gps-chip" id="gpsChip"></button>
          <div id="edAddress" class="gps-address"></div>
        </div>
        <div class="editorial-resizer" id="editorialResizer" style="display:none;"></div>
      </div>
      <div class="inspector-panel" id="inspectorAdjust" data-panel="adjust">
        <div class="edit-panel" id="editPanel" aria-hidden="false">
          <div class="edit-panel-header">
            <span class="edit-panel-title">Adjustments</span>
            <div class="edit-panel-actions">
              <button class="edit-action-btn" id="editResetBtn">Reset</button>
              <button class="edit-action-btn edit-export-btn" id="editExportBtn">Export</button>
              <button class="edit-close-btn" id="editCloseBtn" title="Close adjust tab" style="display:none;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </div>
          </div>
          <div class="edit-sliders">
            <div class="edit-section-label">Light</div>
            <div class="edit-row"><label>Exposure</label><input type="range" class="edit-slider" data-param="exposure" min="-100" max="100" step="1" value="0"><span class="edit-val">0</span></div>
            <div class="edit-row"><label>Brightness</label><input type="range" class="edit-slider" data-param="brightness" min="-100" max="100" step="1" value="0"><span class="edit-val">0</span></div>
            <div class="edit-row"><label>Contrast</label><input type="range" class="edit-slider" data-param="contrast" min="-100" max="100" step="1" value="0"><span class="edit-val">0</span></div>
            <div class="edit-section-label">Color</div>
            <div class="edit-row"><label>Saturation</label><input type="range" class="edit-slider" data-param="saturation" min="-100" max="100" step="1" value="0"><span class="edit-val">0</span></div>
            <div class="edit-row"><label>Vibrance</label><input type="range" class="edit-slider" data-param="vibrance" min="-100" max="100" step="1" value="0"><span class="edit-val">0</span></div>
            <div class="edit-row"><label>Warmth</label><input type="range" class="edit-slider" data-param="warmth" min="-100" max="100" step="1" value="0"><span class="edit-val">0</span></div>
          </div>
          <div class="edit-footer" style="flex-direction:column;gap:8px;">
            <div style="display:flex;gap:8px;width:100%;">
              <button class="edit-flip-btn" id="rotateBtn" style="flex:1;">Rotate 90°</button>
              <button class="edit-flip-btn" id="flipHBtn" style="flex:1;">Flip H</button>
              <button class="edit-flip-btn" id="flipVBtn" style="flex:1;">Flip V</button>
            </div>
            <button class="edit-flip-btn" id="cropBtn" style="width:100%;border-color:rgba(212,167,44,0.35);color:var(--accent-gold);">Crop Photo</button>
          </div>
        </div>
      </div>
      <div class="inspector-panel" id="inspectorPresets" data-panel="presets">
        <div class="inspector-card">
          <div class="inspector-card-title">Presets</div>
          <p class="inspector-presets-hint">Apply a look in one tap. Save your current sliders as a custom preset.</p>
          <div class="edit-preset-grid" id="editPresetGrid"></div>
          <button type="button" class="edit-preset-save-btn" id="saveEditPresetBtn">Save current adjustments</button>
        </div>
      </div>
      <div class="inspector-panel" id="inspectorJobs" data-panel="jobs">
        <div class="batch-jobs-list" id="batchJobsList">
          <p class="batch-jobs-empty" id="batchJobsEmpty">No active batch jobs.</p>
        </div>
      </div>
    </div>
    </div>
  </aside>
  </div>

  <div class="gps-popover" id="gpsPopover" aria-hidden="true">
    <iframe class="gps-popover-map" id="gpsPopoverIframe" title="Location map" tabindex="-1"></iframe>
  </div>

  <div class="image-fullscreen" id="imageFullscreen" aria-hidden="true" style="display:none">
    <div class="image-fullscreen-bg"></div>
    <div class="image-fullscreen-ui">
      <button class="image-fullscreen-exit" id="imageFsExit">Exit</button>
      <div class="image-fullscreen-hint" id="imageFsHint">Shift + F to exit</div>
    </div>
  </div>

  <div class="settings-page" id="settingsPage" style="display:none" aria-hidden="true">
    <div class="settings-layout">
      <aside class="settings-nav">
        <div class="settings-nav-chrome" id="settingsDrag" data-tauri-drag-region></div>
        <div class="settings-nav-inner">
          <button type="button" class="settings-back" id="settingsBack">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>
          <h1 class="settings-nav-title">Settings</h1>
          <nav class="settings-categories" role="tablist">
            <button type="button" class="settings-nav-item active" role="tab" data-tab="general">General</button>
            <button type="button" class="settings-nav-item" role="tab" data-tab="appearance">Appearance</button>
            <button type="button" class="settings-nav-item" role="tab" data-tab="catalog">Catalog</button>
            <button type="button" class="settings-nav-item" role="tab" data-tab="cache">Cache</button>
            <button type="button" class="settings-nav-item" role="tab" data-tab="export">Export</button>
            <button type="button" class="settings-nav-item" role="tab" data-tab="shortcuts">Shortcuts</button>
            <button type="button" class="settings-nav-item" role="tab" data-tab="security">Security</button>
            <button type="button" class="settings-nav-item" role="tab" data-tab="advanced">Advanced</button>
          </nav>
        </div>
      </aside>
      <main class="settings-main">
        <header class="settings-main-head" data-tauri-drag-region>
          <h2 class="settings-pane-title" id="settingsPaneTitle">General</h2>
        </header>
        <div class="settings-main-body">

        <div class="tab-pane active" id="tab-general">
          <div class="settings-section-label">Setup</div>
          <div class="setting-row" style="margin-top: 0;">
            <label>Show onboarding again</label>
            <button type="button" class="settings-update-btn" id="resetOnboardingBtn">Replay setup</button>
          </div>
          <div class="setting-row">
            <label>Recent folders on home</label>
            <button type="button" class="settings-update-btn" id="clearRecentsSettingsBtn">Clear recents</button>
          </div>
          <div class="settings-section-label" style="margin-top: 12px;">Default app (macOS)</div>
          <div class="setting-row" style="flex-wrap: wrap; gap: 8px; justify-content: flex-start;">
            <button type="button" class="settings-update-btn" id="setDefaultAppBtn">Set as default for media</button>
            <button type="button" class="settings-update-btn" id="openWithHelpBtn">Finder Open With help</button>
          </div>
          <div class="settings-section-label" style="margin-top: 12px;">Feedback</div>
          <div class="setting-row">
            <label for="soundVolumeSlider">UI Sound Volume</label>
            <div style="display: flex; align-items: center; gap: 8px;">
              <input type="range" id="soundVolumeSlider" min="0" max="100" value="40" style="width: 100px;" />
              <span class="setting-val" id="soundVolumeVal" style="font-size: 0.7rem; color: var(--text-tertiary); min-width: 32px; text-align: right; font-variant-numeric: tabular-nums;">40%</span>
            </div>
          </div>
        </div>
        <div class="tab-pane" id="tab-appearance">
          <div class="setting-row">
            <label for="themeSelect">Theme</label>
            <select id="themeSelect">
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div class="setting-row">
            <label for="colorBlindSelect">Color Blindness Simulator</label>
            <select id="colorBlindSelect">
              <option value="none">None</option>
              <option value="protanopia">Protanopia (Red-Blind)</option>
              <option value="deuteranopia">Deuteranopia (Green-Blind)</option>
              <option value="tritanopia">Tritanopia (Blue-Blind)</option>
            </select>
          </div>
          <div class="setting-row">
            <label for="vibrancyCheck">Enable Window Vibrancy</label>
            <input type="checkbox" id="vibrancyCheck" />
          </div>
          <div class="setting-row">
            <label for="cinematicCheck">Enable Cinematic Transitions</label>
            <input type="checkbox" id="cinematicCheck" checked />
          </div>
          <div class="setting-row">
            <label for="highContrastCheck">High-Contrast Solid Backgrounds</label>
            <input type="checkbox" id="highContrastCheck" />
          </div>
          <div class="setting-row">
            <label for="reducedMotionCheck">Reduce UI Motion</label>
            <input type="checkbox" id="reducedMotionCheck" />
          </div>
        </div>

        <div class="tab-pane" id="tab-catalog">
          <div class="settings-section-label">Library & grid</div>
          <div class="setting-row">
            <label for="sortSelect">Sort media by</label>
            <select id="sortSelect">
              <option value="name">Name</option>
              <option value="date">Date</option>
              <option value="size">Size</option>
            </select>
          </div>
          <div class="setting-row">
            <label for="recentFoldersCheck">Show recent folders on home</label>
            <input type="checkbox" id="recentFoldersCheck" checked />
          </div>
          <div class="setting-row">
            <label for="prefetchCheck">Prefetch adjacent media</label>
            <input type="checkbox" id="prefetchCheck" checked />
          </div>
          <p class="settings-hint">Catalog grid size: ⌘ + / ⌘ − while grid view is open.</p>
        </div>

        <div class="tab-pane" id="tab-cache">
          <div class="settings-section-label">Storage overview</div>
          <div class="settings-stat-grid">
            <div class="settings-stat"><span class="settings-stat-label">Database</span><span class="settings-stat-val" id="dbSizeVal">—</span></div>
            <div class="settings-stat"><span class="settings-stat-label">Thumbnails</span><span class="settings-stat-val" id="cacheSizeVal">—</span></div>
            <div class="settings-stat"><span class="settings-stat-label">Decoded</span><span class="settings-stat-val" id="decodedSizeVal">—</span></div>
          </div>
          <div class="setting-row">
            <label for="thumbCacheLimitInput">Thumbnail limit (GB)</label>
            <input id="thumbCacheLimitInput" type="number" min="0.25" max="100" step="0.25" value="2" class="settings-num-input" />
            <label for="decodedCacheLimitInput">Decoded limit (GB)</label>
            <input id="decodedCacheLimitInput" type="number" min="0.5" max="100" step="0.5" value="4" class="settings-num-input" />
          </div>
          <div class="settings-section-label" style="margin-top: 16px;">Clear cache</div>
          <p class="settings-hint">Cache clears keep tags, ratings, and albums. Use “Reset library metadata” to remove those.</p>
          <p class="folio-inline-status" id="cacheActionStatus" aria-live="polite"></p>
          <div class="settings-action-grid">
            <button type="button" class="settings-action-btn" id="clearThumbsBtn">Clear thumbnails</button>
            <button type="button" class="settings-action-btn" id="clearDecodedBtn">Clear decoded images</button>
            <button type="button" class="settings-action-btn" id="clearMetadataBtn">Clear metadata index</button>
            <button type="button" class="settings-action-btn" id="pruneThumbCacheBtn">Prune to limit</button>
            <button type="button" class="settings-action-btn settings-action-btn-danger" id="purgeCacheBtn">Clear all local cache</button>
            <button type="button" class="settings-action-btn settings-action-btn-danger" id="resetLibraryMetadataBtn">Reset library metadata</button>
          </div>
        </div>

        <div class="tab-pane" id="tab-export">
          <div class="settings-section-label">Privacy</div>
          <div class="setting-row">
            <label for="stripMetadataCheck">Scrub EXIF on export</label>
            <input type="checkbox" id="stripMetadataCheck" />
          </div>
          <div class="settings-section-label" style="margin-top: 12px;">Watermark</div>
          <div class="watermark-toggle-row">
            <label for="watermarkToggle">Add watermark on export</label>
            <input type="checkbox" id="watermarkToggle" />
          </div>
          <div class="watermark-input-row" id="watermarkInputRow" style="display: flex; gap: 8px; margin-top: 8px;">
            <input type="text" id="watermarkInput" placeholder="Watermark text…" style="flex: 1;" />
            <select id="watermarkAnchorSelect" style="width: 120px;">
              <option value="bottom-right">Bottom Right</option>
              <option value="bottom-left">Bottom Left</option>
              <option value="top-right">Top Right</option>
              <option value="top-left">Top Left</option>
              <option value="center">Center</option>
            </select>
          </div>
          <div class="watermark-input-row" id="watermarkAdvancedRow" style="display: flex; gap: 8px; margin-top: 8px;">
            <input type="range" id="watermarkOpacitySlider" min="10" max="100" value="70" title="Opacity" />
            <input type="range" id="watermarkScaleSlider" min="50" max="200" value="100" title="Scale" />
            <input type="range" id="watermarkFontSlider" min="12" max="72" value="32" title="Font size" />
          </div>
        </div>

        <div class="tab-pane" id="tab-shortcuts">
          <div class="setting-row">
            <label style="font-size: 0.85rem; color: var(--text-primary); font-weight: 500;">Keyboard shortcuts</label>
            <button class="settings-update-btn" id="resetKeybindsBtn">Reset defaults</button>
          </div>
          <div class="setting-row">
            <label>Next Image</label>
            <button class="keybind-btn" data-action="nextImage"></button>
          </div>
          <div class="setting-row">
            <label>Previous Image</label>
            <button class="keybind-btn" data-action="prevImage"></button>
          </div>
          <div class="setting-row">
            <label>Reset Zoom</label>
            <button class="keybind-btn" data-action="resetZoom"></button>
          </div>
          <div class="setting-row">
            <label>Toggle Metadata</label>
            <button class="keybind-btn" data-action="toggleMetadata"></button>
          </div>
          <div class="setting-row">
            <label>Play/Pause Video</label>
            <button class="keybind-btn" data-action="playVideo"></button>
          </div>
          <div class="setting-row">
            <label>Zoom Modifier (Scroll)</label>
            <button class="keybind-btn" data-action="modifierZoom"></button>
          </div>
          <div class="setting-row">
            <label>Pan Modifier (Middle Click)</label>
            <button class="keybind-btn" data-action="modifierPan"></button>
          </div>
          <div class="setting-row">
            <label>Toggle Zen Mode</label>
            <button class="keybind-btn" data-action="toggleZen"></button>
          </div>
          <div class="setting-row">
            <label>Toggle Sidebar</label>
            <button class="keybind-btn" data-action="toggleSidebar"></button>
          </div>
          <div class="setting-row">
            <label>Toggle Fullscreen</label>
            <button class="keybind-btn" data-action="toggleFullscreen"></button>
          </div>
          <div class="setting-row">
            <label>Toggle Edit Panel</label>
            <button class="keybind-btn" data-action="editMode"></button>
          </div>
          <div class="setting-row">
            <label>Add Tag</label>
            <button class="keybind-btn" data-action="addTag"></button>
          </div>
          <div class="setting-row">
            <label>Toggle Catalog Grid</label>
            <button class="keybind-btn" data-action="toggleCatalog"></button>
          </div>
          <div class="setting-row">
            <label>Go home (close library)</label>
            <button class="keybind-btn" data-action="goHome"></button>
          </div>
        </div>

        <div class="tab-pane" id="tab-advanced">
          <div class="settings-section-label">Diagnostics</div>
          <div class="setting-row">
            <label for="performanceHudCheck">Show performance HUD</label>
            <input type="checkbox" id="performanceHudCheck" />
          </div>
          <div class="setting-row">
            <span class="setting-label">CPU load</span>
            <span class="setting-val" id="cpuLoadVal">—</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">Memory usage</span>
            <span class="setting-val" id="ramSizeVal">—</span>
          </div>
          <div class="settings-section-label" style="margin-top: 12px;">Viewer</div>
          <div class="setting-row">
            <label for="zoomSensSlider">Zoom sensitivity (Shift + scroll)</label>
            <input type="range" id="zoomSensSlider" min="1" max="10" value="5" style="width: 120px;" />
          </div>
          <div class="settings-section-label" style="margin-top: 12px;">Location</div>
          <div class="setting-row">
            <label for="reverseGeocodeCheck">Look up addresses from GPS</label>
            <input type="checkbox" id="reverseGeocodeCheck" />
          </div>
          <p class="settings-hint">Map popups always try to resolve an address when online.</p>
        </div>

        <div class="tab-pane" id="tab-security">
          <div class="vault-status-banner" id="vaultStatusBanner" role="status" aria-live="polite"></div>
          <div class="setting-row">
            <span style="font-size: 0.85rem; color: var(--text-primary); font-weight: 500;">Secure Album Vault & Platform Settings</span>
          </div>
          <div class="setting-row">
            <label for="biometricVaultCheck">Enable Biometric Album Lock</label>
            <input type="checkbox" id="biometricVaultCheck" />
          </div>
          <div class="setting-row">
            <label for="vaultAutoLockInput">Vault Auto-Lock Minutes</label>
            <input id="vaultAutoLockInput" class="settings-num-input" type="number" min="1" max="120" value="5" />
          </div>
          <div class="setting-row" style="gap: 8px; justify-content: flex-start;">
            <button class="settings-update-btn" id="vaultCreateBtn">Create Vault</button>
            <button class="settings-update-btn" id="vaultUnlockBtn">Unlock</button>
            <button class="settings-update-btn" id="vaultLockBtn">Lock</button>
            <button class="settings-update-btn" id="vaultRepairBtn">Repair catalog</button>
            <span class="setting-val" id="vaultStatusVal">Vault locked</span>
          </div>
          <div class="setting-row" style="margin-top: 10px; flex-direction: column; align-items: flex-start; gap: 8px;">
            <label style="font-size: 0.75rem; color: var(--text-secondary);">Audit Image Integrity (BLAKE3):</label>
            <div style="display: flex; gap: 8px; width: 100%;">
              <button class="settings-update-btn" id="auditImageBtn" style="padding: 6px 12px; font-size: 11px;">Compute File Checksum</button>
              <span id="checksumResult" style="font-size: 11px; font-family: monospace; color: var(--text-tertiary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-self: center;">—</span>
            </div>
          </div>
          <div class="setting-row" style="margin-top: 10px; flex-direction: column; align-items: flex-start; gap: 8px;">
            <label style="font-size: 0.75rem; color: var(--text-secondary);">macOS Native Platform Actions:</label>
            <div style="display: flex; gap: 8px; width: 100%;">
              <button class="settings-update-btn" id="nativeShareBtn" style="padding: 6px 12px; font-size: 11px;">Share Current via Cocoa</button>
              <button class="settings-update-btn" id="spotlightSearchBtn" style="padding: 6px 12px; font-size: 11px;">Spotlight Index Search</button>
            </div>
          </div>
        </div>
        </div>
      </main>
    </div>
  </div>

  <div class="update-bar" id="updateBar" style="display:none">
    <span class="update-text" id="updateText"></span>
    <button class="update-action" id="updateAction">Update</button>
    <button class="update-dismiss" id="updateDismiss"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
  </div>

  <div class="performance-hud" id="performanceHud" style="display: none;">
    <div class="performance-hud-item"><span class="performance-hud-label">FPS</span><span class="performance-hud-value" id="hudFpsVal">60</span></div>
    <div class="performance-hud-item"><span class="performance-hud-label">Display</span><span class="performance-hud-value" id="hudHzVal">60Hz</span></div>
    <div class="performance-hud-item"><span class="performance-hud-label">CPU Load</span><span class="performance-hud-value" id="hudCpuVal">0.0%</span></div>
    <div class="performance-hud-item"><span class="performance-hud-label">App Memory</span><span class="performance-hud-value" id="hudMemoryVal">0 MB</span></div>
  </div>
  <div class="dropzone-glow" id="dropzoneGlow"></div>
  <div id="toastContainer" class="toast-container"></div>
  <svg width="0" height="0" style="position: absolute; pointer-events: none;">
    <defs>
      <filter id="sim-protanopia"><feColorMatrix type="matrix" values="0.567 0.433 0 0 0  0.558 0.442 0 0 0  0 0.242 0.758 0 0  0 0 0 1 0" /></filter>
      <filter id="sim-deuteranopia"><feColorMatrix type="matrix" values="0.625 0.375 0 0 0  0.7 0.3 0 0 0  0 0.3 0.7 0 0  0 0 0 1 0" /></filter>
      <filter id="sim-tritanopia"><feColorMatrix type="matrix" values="0.95 0.05 0 0 0  0 0.433 0.567 0 0  0 0.475 0.525 0 0  0 0 0 1 0" /></filter>
    </defs>
  </svg>
`;

/* ── DOM REFS ── */
const $ = id => document.getElementById(id);
const welcome = $('welcome'), sidebar = $('sidebar'), sidebarResizer = $('sidebarResizer'), sidebarToggle = $('sidebarToggle'), viewer = $('viewer'), media = $('media'), mediaLoader = $('mediaLoader'), filmstrip = $('filmstrip'), breadcrumbs = $('breadcrumbs'), gridToggleBtn = $('gridToggleBtn'), counter = $('counter'), fname = $('fname'), dims = $('dims'), badge = $('badge'), edOverlay = $('editorialOverlay'), edCamera = $('edCamera'), edAperture = $('edAperture'), edShutter = $('edShutter'), edIso = $('edIso'), edFocal = $('edFocal'), edTechData = $('edTechData'), backdropGlow = $('backdropGlow'), editPanel = $('editPanel'), editToggleBtn = $('editToggleBtn'), editCloseBtn = $('editCloseBtn'), editResetBtn = $('editResetBtn'), editExportBtn = $('editExportBtn'), rotateBtn = $('rotateBtn'), flipHBtn = $('flipHBtn'), flipVBtn = $('flipVBtn'), cropBtn = $('cropBtn'), dropzoneGlow = $('dropzoneGlow'), zoomSlider = $('zoomSlider'), zoomLabel = $('zoomLabel'), zoomReset = $('zoomReset'), fullscreenBtn = $('fullscreenBtn'), imageFsExit = $('imageFsExit'), sortSelect = $('sortSelect'), zoomSensSlider = $('zoomSensSlider'), themeSelect = $('themeSelect'), cinematicCheck = $('cinematicCheck'), recentFoldersCheck = $('recentFoldersCheck'), stripMetadataCheck = $('stripMetadataCheck'), vibrancyCheck = $('vibrancyCheck'), reverseGeocodeCheck = $('reverseGeocodeCheck'), soundVolumeSlider = $('soundVolumeSlider'), soundVolumeVal = $('soundVolumeVal'), catalogGrid = $('catalogGrid'), catalogContent = $('catalogContent'), catalogStateHost = $('catalogStateHost'), viewerStateHost = $('viewerStateHost'), catalogTitle = $('catalogTitle'), catalogNewFolderBtn = $('catalogNewFolderBtn'), catalogFinderBtn = $('catalogFinderBtn'), catalogMapBtn = $('catalogMapBtn'), catalogDuplicatesBtn = $('catalogDuplicatesBtn'), catalogCloseBtn = $('catalogCloseBtn'), smartFilterSelect = $('smartFilterSelect'), saveSmartAlbumBtn = $('saveSmartAlbumBtn'), tagFilterPanel = $('tagFilterPanel'), tagFilterList = $('tagFilterList'), sidebarCatalogBtn = $('sidebarCatalogBtn'), edGps = $('edGps'), gpsChip = $('gpsChip'), edAddress = $('edAddress'), compareBtn = $('compareBtn'), batchBar = $('batchBar'), batchCount = $('batchCount'), batchClose = $('batchClose'), colorBlindSelect = $('colorBlindSelect'), watermarkInput = $('watermarkInput'), watermarkAnchorSelect = $('watermarkAnchorSelect'), watermarkOpacitySlider = $('watermarkOpacitySlider'), watermarkScaleSlider = $('watermarkScaleSlider'), watermarkFontSlider = $('watermarkFontSlider'), batchTagInput = $('batchTagInput'), batchTrashBtn = $('batchTrashBtn'), batchFavoriteBtn = $('batchFavoriteBtn'), batchRateBtn = $('batchRateBtn'), batchVaultBtn = $('batchVaultBtn'), batchSidecarBtn = $('batchSidecarBtn'), batchFinderBtn = $('batchFinderBtn');

// DOM Refs for Phase 2 Responsive Workspace & Fine-Grained Controls
const highContrastCheck = $('highContrastCheck'),
      reducedMotionCheck = $('reducedMotionCheck'),
      performanceHudCheck = $('performanceHudCheck'),
      dbSizeVal = $('dbSizeVal'),
      cacheSizeVal = $('cacheSizeVal'),
      decodedSizeVal = $('decodedSizeVal'),
      ramSizeVal = $('ramSizeVal'),
      cpuLoadVal = $('cpuLoadVal'),
      purgeCacheBtn = $('purgeCacheBtn'),
      resetLibraryMetadataBtn = $('resetLibraryMetadataBtn'),
      clearThumbsBtn = $('clearThumbsBtn'),
      clearDecodedBtn = $('clearDecodedBtn'),
      clearMetadataBtn = $('clearMetadataBtn'),
      cacheActionStatus = $('cacheActionStatus'),
      pruneThumbCacheBtn = $('pruneThumbCacheBtn'),
      settingsPage = $('settingsPage'),
      settingsPaneTitle = $('settingsPaneTitle'),
      thumbCacheLimitInput = $('thumbCacheLimitInput'),
      decodedCacheLimitInput = $('decodedCacheLimitInput'),
      prefetchCheck = $('prefetchCheck'),
      performanceHud = $('performanceHud'),
      editorialResizer = $('editorialResizer');

// DOM Refs for Phase 4 Secure Platform APIs
const biometricVaultCheck = $('biometricVaultCheck'),
      auditImageBtn = $('auditImageBtn'),
      checksumResult = $('checksumResult'),
      nativeShareBtn = $('nativeShareBtn'),
      spotlightSearchBtn = $('spotlightSearchBtn'),
      batchScrubBtn = $('batchScrubBtn'),
      vaultCreateBtn = $('vaultCreateBtn'),
      vaultUnlockBtn = $('vaultUnlockBtn'),
      vaultLockBtn = $('vaultLockBtn'),
      vaultStatusVal = $('vaultStatusVal'),
      vaultAutoLockInput = $('vaultAutoLockInput'),
      vaultStatusBanner = $('vaultStatusBanner');

// Utility: Debounce for disk-bound I/O reduction (Finding 3)
function debounce(fn, delay) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

const saveVideoSettings = debounce((volume, muted) => {
  localStorage.setItem('folio_video_volume', volume);
  localStorage.setItem('folio_video_muted', muted);
}, 250);

// Inline Web Worker for off-thread image analytics (Finding 1)
const analysisWorkerCode = `
  self.onmessage = function(e) {
    const data = e.data.data;
    const rB = new Uint32Array(256);
    const gB = new Uint32Array(256);
    const bB = new Uint32Array(256);
    const lB = new Uint32Array(256);
    
    // Waveform density parameters
    const waveCols = 128;
    const waveBuckets = 100;
    const waveR = new Uint32Array(waveCols * waveBuckets);
    const waveG = new Uint32Array(waveCols * waveBuckets);
    const waveB = new Uint32Array(waveCols * waveBuckets);
    
    for (let y = 0; y < 256; y++) {
      const srcRowIdx = y * 256 * 4;
      const targetY = Math.floor((y / 256) * waveBuckets);
      
      for (let x = 0; x < 256; x++) {
        const i = srcRowIdx + x * 4;
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        
        rB[r]++;
        gB[g]++;
        bB[b]++;
        lB[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;
        
        const targetX = Math.floor((x / 256) * waveCols);
        const bucketR = Math.floor((r / 255) * (waveBuckets - 1));
        const bucketG = Math.floor((g / 255) * (waveBuckets - 1));
        const bucketB = Math.floor((b / 255) * (waveBuckets - 1));
        
        waveR[(waveBuckets - 1 - bucketR) * waveCols + targetX]++;
        waveG[(waveBuckets - 1 - bucketG) * waveCols + targetX]++;
        waveB[(waveBuckets - 1 - bucketB) * waveCols + targetX]++;
      }
    }
    
    let peak = 1;
    for (let i = 0; i < 256; i++) {
      if (rB[i] > peak) peak = rB[i];
      if (gB[i] > peak) peak = gB[i];
      if (bB[i] > peak) peak = bB[i];
    }
    
    self.postMessage({ 
      rB, gB, bB, lB, peak,
      waveR, waveG, waveB,
      waveCols, waveBuckets
    }, [
      rB.buffer, gB.buffer, bB.buffer, lB.buffer,
      waveR.buffer, waveG.buffer, waveB.buffer
    ]);
  };
`;
const analysisWorkerBlob = new Blob([analysisWorkerCode], { type: 'application/javascript' });
const analysisWorker = new Worker(URL.createObjectURL(analysisWorkerBlob));
const FolioEvents = createEventBus();

// Unified Folio State & Settings Store (Finding 12)
const FolioState = {
  isSliderActive: false,
  isVolumeActive: false,
  isScrubbingActive: false,
  activeThumbEl: null,
  catalogVisibleCount: 100,
};
globalThis.FolioState = FolioState;

Object.assign(FolioState, {
  settings: {
    get currentSort() { return currentSort; },
    set currentSort(v) { currentSort = v; localStorage.setItem('folio_sort', v); },
    get zoomSens() { return zoomSens; },
    set zoomSens(v) { zoomSens = v; localStorage.setItem('folio_zoom_sens', v); },
    get currentTheme() { return currentTheme; },
    set currentTheme(v) { currentTheme = v; localStorage.setItem('folio_theme', v); },
    get cinematicEnabled() { return cinematicEnabled; },
    set cinematicEnabled(v) { cinematicEnabled = v; localStorage.setItem('folio_cinematic', v); },
    get showRecentFolders() { return showRecentFolders; },
    set showRecentFolders(v) { showRecentFolders = v; localStorage.setItem('folio_show_recents', v); },
    get stripMetadataEnabled() { return stripMetadataEnabled; },
    set stripMetadataEnabled(v) { stripMetadataEnabled = v; localStorage.setItem('folio_strip_metadata', v); },
    get soundVolume() { return soundVolume; },
    set soundVolume(v) { soundVolume = v; localStorage.setItem('folio_sound_volume', v); },
    get vibrancyEnabled() { return vibrancyEnabled; },
    set vibrancyEnabled(v) { vibrancyEnabled = v; localStorage.setItem('folio_vibrancy', v); },
    get gridView() { return gridView; },
    set gridView(v) { gridView = v; localStorage.setItem('folio_grid_view', v); },
    get activeColorBlindMode() { return activeColorBlindMode; },
    set activeColorBlindMode(v) { activeColorBlindMode = v; localStorage.setItem('folio_color_blind', v); },
    get activeWatermark() { return activeWatermark; },
    set activeWatermark(v) { activeWatermark = v; localStorage.setItem('folio_watermark', v); }
  }
});

let catalogModeActive = false;
let inspectorPaneVisible = true;
let openedLibraryPath = null;
const batchJobRows = new Map();

const appShell = $('appShell');
const inspectorPane = $('inspectorPane');
const inspectorCollapseBtn = $('inspectorCollapseBtn');
const gpsPopover = $('gpsPopover');
const gpsPopoverIframe = $('gpsPopoverIframe');
const batchJobsList = $('batchJobsList');
const batchJobsEmpty = $('batchJobsEmpty');
const resetOnboardingBtn = $('resetOnboardingBtn');

function setAppShellVisible(visible) {
  if (appShell) appShell.style.display = visible ? 'flex' : 'none';
}

function isSettingsOpen() {
  return settingsPage && settingsPage.style.display !== 'none';
}

function showHomeHub(animate = false) {
  welcome?.classList.remove('hidden');
  if (welcome) welcome.style.display = '';
  setAppShellVisible(false);
  renderHomeHub();
  if (animate && welcome && !reducedMotionEnabled) {
    welcome.classList.add('home-entering');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => welcome.classList.remove('home-entering'));
    });
  }
}

function goHome() {
  if (!items.length && !openedLibraryPath) return;
  closeGpsPopover();
  const finish = () => {
    catalogModeActive = false;
    closeEditPanel();
    closeCropMode();
    adjustPreviewActive = false;
    editSessionPath = null;
    items = [];
    idx = 0;
    openedLibraryPath = null;
    selectedCatalogPaths?.clear?.();
    if (filmstrip) filmstrip.innerHTML = '';
    if (sidebar) sidebar.style.display = 'none';
    if (viewer) viewer.style.display = 'none';
    if (catalogGrid) catalogGrid.style.display = 'none';
    appShell?.classList.remove('shell-exiting');
    showHomeHub(true);
  };
  if (!appShell || reducedMotionEnabled) {
    finish();
    return;
  }
  appShell.classList.add('shell-exiting');
  setTimeout(finish, 260);
}

function setInspectorVisible(visible) {
  inspectorPaneVisible = visible;
  if (!inspectorPane) return;
  inspectorPane.classList.toggle('visible', visible);
  inspectorPane.classList.toggle('collapsed', !visible);
  inspectorPane.style.display = 'flex';
  inspectorCollapseBtn?.setAttribute('aria-expanded', visible ? 'true' : 'false');
  inspectorCollapseBtn?.setAttribute('aria-label', visible ? 'Collapse inspector' : 'Expand inspector');
  appShell?.classList.toggle('inspector-collapsed', !visible);
  requestAnimationFrame(() => {
    if (zoom > 1) scheduleUpdate();
    else resetZoom();
  });
}

function setInspectorTab(tabId) {
  document.querySelectorAll('.inspector-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.inspector === tabId);
  });
  document.querySelectorAll('.inspector-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tabId);
  });
}

function updateWorkspaceLayout() {
  if (isSettingsOpen()) return;
  if (!items.length) {
    if (openedLibraryPath) {
      welcome?.classList.add('hidden');
      setAppShellVisible(true);
      if (sidebar) sidebar.style.display = catalogModeActive ? 'none' : 'flex';
      if (viewer) viewer.style.display = catalogModeActive ? 'none' : 'flex';
      if (catalogGrid) catalogGrid.style.display = catalogModeActive ? 'grid' : 'none';
    } else {
      showHomeHub();
    }
    return;
  }
  welcome?.classList.add('hidden');
  setAppShellVisible(true);
  if (catalogModeActive) {
    if (sidebar) sidebar.style.display = 'none';
    if (viewer) viewer.style.display = 'none';
    if (catalogGrid) catalogGrid.style.display = 'grid';
    setInspectorVisible(false);
  } else {
    if (catalogGrid) catalogGrid.style.display = 'none';
    if (sidebar) sidebar.style.display = 'flex';
    if (viewer) viewer.style.display = 'flex';
    setInspectorVisible(inspectorPaneVisible);
  }
}

function applyNavFilter(navKey) {
  const map = { all: '', favorites: 'favorites', rated: 'rated', videos: 'videos', gps: 'gps', raw: 'raw' };
  activeSmartFilter = map[navKey] ?? '';
  if (smartFilterSelect) smartFilterSelect.value = activeSmartFilter;
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === navKey);
  });
  applyFilters();
  if (catalogModeActive) buildCatalogContent();
}

function upsertBatchJobRow(jobId, label, status) {
  if (!batchJobsList) return;
  batchJobsEmpty?.style.setProperty('display', 'none');
  let row = batchJobRows.get(jobId);
  if (!row) {
    row = document.createElement('div');
    row.className = 'batch-job-row';
    row.dataset.jobId = jobId;
    row.innerHTML = `
      <div class="batch-job-name"></div>
      <div class="batch-job-bar"><div class="batch-job-fill"></div></div>
      <div class="batch-job-status"></div>`;
    batchJobsList.appendChild(row);
    batchJobRows.set(jobId, row);
  }
  const pct = status?.total ? Math.round((status.completed / status.total) * 100) : 0;
  row.querySelector('.batch-job-name').textContent = label;
  row.querySelector('.batch-job-fill').style.width = `${pct}%`;
  const state = status?.state || 'running';
  row.querySelector('.batch-job-status').textContent =
    state === 'completed' ? `Completed · ${status.completed}/${status.total}` :
    state === 'failed' ? `Failed · ${status.failed || 0} errors` :
    state === 'cancelled' ? 'Cancelled' : `Running · ${status.completed || 0}/${status.total || '?'}`;
  if (['completed', 'failed', 'cancelled'].includes(state)) {
    setTimeout(() => {
      row.remove();
      batchJobRows.delete(jobId);
      if (batchJobRows.size === 0 && batchJobsEmpty) {
        batchJobsEmpty.style.display = 'block';
      }
    }, 8000);
  }
}

let compareModeActive = false;
let compareClipPct = 50;
let selectedCatalogPaths = new Set();
let gridThumbSize = parseInt(localStorage.getItem('folio_grid_thumb_size')) || 160;
let activeTagFilter = null;
let activeColorFilter = null;
let activeSmartFilter = '';
let folderDominantColorsCache = {};
let catalogObserver = null;
const mediaAttributesCache = new Map();

/* ── Settings & State ── */
let currentSort = localStorage.getItem('folio_sort') || 'name';
let zoomSens = parseFloat(localStorage.getItem('folio_zoom_sens')) || 5;
let currentTheme = localStorage.getItem('folio_theme') || 'dark';
let cinematicEnabled = localStorage.getItem('folio_cinematic') !== 'false';
let showRecentFolders = localStorage.getItem('folio_show_recents') !== 'false';
let stripMetadataEnabled = localStorage.getItem('folio_strip_metadata') === 'true';
let soundVolume = parseInt(localStorage.getItem('folio_sound_volume') ?? '40');
let vibrancyEnabled = localStorage.getItem('folio_vibrancy') === 'true';
let gridView = localStorage.getItem('folio_grid_view') === 'true';
let activeColorBlindMode = localStorage.getItem('folio_color_blind') || 'none';
let activeWatermark = localStorage.getItem('folio_watermark') || '';
let reverseGeocodeEnabled = localStorage.getItem('folio_reverse_geocode_enabled') === 'true';
let prefetchEnabled = localStorage.getItem('folio_prefetch_enabled') !== 'false';
let vaultAutoLockMinutes = parseInt(localStorage.getItem('folio_vault_auto_lock_minutes') || '5', 10);
let thumbnailCacheLimitGb = parseFloat(localStorage.getItem('folio_thumbnail_cache_limit_gb') || '2');
let decodedCacheLimitGb = parseFloat(localStorage.getItem('folio_decoded_cache_limit_gb') || '4');
let activeWatermarkOpacity = parseInt(localStorage.getItem('folio_watermark_opacity') || '70', 10);
let activeWatermarkScale = parseInt(localStorage.getItem('folio_watermark_scale') || '100', 10);
let activeWatermarkFont = parseInt(localStorage.getItem('folio_watermark_font') || '32', 10);

// Load settings for Phase 2 features
let highContrastEnabled = localStorage.getItem('folio_high_contrast') === 'true';
let reducedMotionEnabled = localStorage.getItem('folio_reduced_motion') === 'true';
let performanceHudEnabled = localStorage.getItem('folio_performance_hud') === 'true';

let pendingRafUpdate = false;
let editPanelOpen = false;
let adjustPreviewActive = false;
let editSessionPath = null;
let gpsPopoverAnchor = null;
let editDebounceTimer = null;
let editPreviewImg = null;
const editMap = new Map();
const preloadedThumbs = new Map();
const preloadCache = new Map();
const videoPreloadCache = new Map();

// Geocoding Cache & Service
const geocodeCache = new Map();
async function fetchReverseGeocode(lat, lon) {
  if (lat === undefined || lat === null || lon === undefined || lon === null) return 'No coordinates';
  const key = `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) return 'Address search failed';
    const data = await res.json();
    if (data.error) return 'Address not found';
    const addr = data.address || {};
    const parts = [];
    const street = addr.road || addr.pedestrian || addr.subway;
    const house = addr.house_number;
    if (house && street) {
      parts.push(`${house} ${street}`);
    } else if (street) {
      parts.push(street);
    } else {
      const place = addr.amenity || addr.leisure || addr.tourism || addr.office || addr.shop;
      if (place) parts.push(place);
    }
    const city = addr.city || addr.town || addr.village || addr.suburb || addr.municipality;
    if (city) parts.push(city);
    const state = addr.state || addr.region || addr.province;
    if (state) parts.push(state);
    const country = addr.country;
    if (country && parts.length < 3) parts.push(country);
    const address = parts.length > 0 ? parts.join(', ') : (data.display_name || 'Coordinates location');
    geocodeCache.set(key, address);
    return address;
  } catch (err) {
    console.error('Geocoding error:', err);
    return 'Address unavailable';
  }
}

async function reverseGeocode(lat, lon) {
  if (!reverseGeocodeEnabled) return 'Address lookup disabled';
  return fetchReverseGeocode(lat, lon);
}

async function reverseGeocodeForMap(lat, lon) {
  return fetchReverseGeocode(lat, lon);
}

window.reverseGeocode = reverseGeocode;
window.reverseGeocodeForMap = reverseGeocodeForMap;

// Bind existing sessions properties to FolioState dynamically
Object.defineProperties(FolioState, {
  idx: { get() { return idx; }, set(val) { idx = val; } },
  items: { get() { return items; }, set(val) { items = val; } },
  catalogModeActive: { get() { return catalogModeActive; }, set(val) { catalogModeActive = val; } },
  compareModeActive: { get() { return compareModeActive; }, set(val) { compareModeActive = val; } },
  compareClipPct: { get() { return compareClipPct; }, set(val) { compareClipPct = val; } },
  selectedCatalogPaths: { get() { return selectedCatalogPaths; }, set(val) { selectedCatalogPaths = val; } },
  gridThumbSize: { get() { return gridThumbSize; }, set(val) { gridThumbSize = val; } },
  activeTagFilter: { get() { return activeTagFilter; }, set(val) { activeTagFilter = val; } },
  editPanelOpen: { get() { return editPanelOpen; }, set(val) { editPanelOpen = val; } }
});

const defaultKeybinds = { nextImage: 'ArrowRight', prevImage: 'ArrowLeft', resetZoom: '0', toggleMetadata: 'i', playVideo: ' ', modifierZoom: 'Shift', modifierPan: 'Shift', toggleZen: 'z', toggleSidebar: 'b', toggleFullscreen: 'f', editMode: 'e', addTag: 't', toggleCatalog: 'g', goHome: 'h' };
let keybinds = { ...defaultKeybinds, ...JSON.parse(localStorage.getItem('folio_keybinds') || '{}') };

/* ── Init ── */
applyTheme(currentTheme);
if (recentFoldersCheck) {
  recentFoldersCheck.checked = showRecentFolders;
  recentFoldersCheck.addEventListener('change', (e) => {
    showRecentFolders = e.target.checked;
    localStorage.setItem('folio_show_recents', showRecentFolders);
    renderHomeHub();
  });
}
if (stripMetadataCheck) {
  stripMetadataCheck.checked = stripMetadataEnabled;
  stripMetadataCheck.addEventListener('change', (e) => {
    stripMetadataEnabled = e.target.checked;
    localStorage.setItem('folio_strip_metadata', stripMetadataEnabled);
  });
}
let biometricVaultEnabled = localStorage.getItem('folio_biometric_lock') === 'true';
if (biometricVaultCheck) {
  biometricVaultCheck.checked = biometricVaultEnabled;
  biometricVaultCheck.addEventListener('change', async (e) => {
    biometricVaultEnabled = e.target.checked;
    if (biometricVaultEnabled) {
      try {
        const ok = await invoke('authenticate_vault');
        if (!ok) {
          biometricVaultEnabled = false;
          biometricVaultCheck.checked = false;
          showToast('Biometric setup was cancelled');
        }
      } catch (err) {
        biometricVaultEnabled = false;
        biometricVaultCheck.checked = false;
        showToast(`Biometric lock unavailable: ${err}`);
      }
    }
    localStorage.setItem('folio_biometric_lock', biometricVaultEnabled);
  });
}

async function refreshVaultStatus() {
  try {
    const status = await invoke('vault_status');
    const label = `${status.unlocked ? 'Unlocked' : 'Locked'} • ${status.item_count} item${status.item_count === 1 ? '' : 's'}`;
    if (vaultStatusVal) vaultStatusVal.textContent = label;
    if (vaultStatusBanner) {
      vaultStatusBanner.className = 'vault-status-banner' + (status.unlocked ? ' is-unlocked' : ' is-locked');
      vaultStatusBanner.innerHTML = `
        <div class="vault-status-banner-icon">${status.unlocked ? '🔓' : '🔒'}</div>
        <div class="vault-status-banner-text">
          <strong>${status.unlocked ? 'Vault unlocked' : 'Vault locked'}</strong>
          <span>${status.item_count} protected item${status.item_count === 1 ? '' : 's'} · Auto-lock after ${vaultAutoLockMinutes} min</span>
        </div>`;
    }
  } catch (e) {
    if (vaultStatusVal) vaultStatusVal.textContent = 'Vault unavailable';
    if (vaultStatusBanner) {
      vaultStatusBanner.className = 'vault-status-banner is-error';
      vaultStatusBanner.innerHTML = '<div class="vault-status-banner-text"><strong>Vault unavailable</strong><span>Secure storage could not be reached on this system.</span></div>';
    }
  }
}

vaultAutoLockInput && (vaultAutoLockInput.value = vaultAutoLockMinutes);
invoke('vault_set_auto_lock', { minutes: vaultAutoLockMinutes }).catch(() => {});
vaultAutoLockInput?.addEventListener('change', async e => {
  vaultAutoLockMinutes = Math.max(1, Math.min(120, parseInt(e.target.value || '5', 10)));
  localStorage.setItem('folio_vault_auto_lock_minutes', String(vaultAutoLockMinutes));
  try {
    await invoke('vault_set_auto_lock', { minutes: vaultAutoLockMinutes });
    refreshVaultStatus();
  } catch (err) {
    showToast(`Auto-lock update failed: ${err}`);
  }
});
vaultCreateBtn?.addEventListener('click', async () => {
  try {
    const info = await invoke('vault_create', { name: 'Secure Album' });
    showToast(`Vault ready: ${info.item_count} item(s)`);
    refreshVaultStatus();
  } catch (e) { showToast(`Vault create failed: ${e}`); }
});
vaultUnlockBtn?.addEventListener('click', async () => {
  try {
    const ok = await invoke('vault_unlock');
    showToast(ok ? 'Vault unlocked' : 'Vault unlock cancelled');
    refreshVaultStatus();
  } catch (e) { showToast(`Vault unlock failed: ${e}`); }
});
vaultLockBtn?.addEventListener('click', async () => {
  await invoke('vault_lock').catch(() => {});
  showToast('Vault locked');
  refreshVaultStatus();
});
$('vaultRepairBtn')?.addEventListener('click', async () => {
  try {
    const r = await invoke('vault_repair_catalog');
    showToast(`Vault repaired: ${r.removed_rows} row(s), ${r.removed_files} orphan file(s)`);
    refreshVaultStatus();
  } catch (e) {
    showToast(`Vault repair failed: ${e}`);
  }
});
$('classifySuggestBtn')?.addEventListener('click', async () => {
  const item = items[idx];
  if (!item?.path || item.is_video) {
    showToast('Classification works on still images');
    return;
  }
  const host = $('classifyResults');
  const btn = $('classifySuggestBtn');
  if (!host) return;
  btn.disabled = true;
  host.style.display = 'flex';
  host.textContent = 'Analyzing…';
  try {
    const rows = await invoke('classify_image_path', { path: item.path });
    host.innerHTML = '';
    if (!rows?.length) {
      host.textContent = 'No suggestions (macOS Vision required)';
      return;
    }
    rows.slice(0, 8).forEach((row) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'classify-chip';
      chip.textContent = `${row.label} ${Math.round(row.confidence * 100)}%`;
      chip.title = 'Add as tag';
      chip.addEventListener('click', async () => {
        try {
          await invoke('add_tag_to_image', { path: item.path, tagName: row.label, tagColor: '#D4A72C' });
          showToast(`Tagged: ${row.label}`);
        } catch (err) {
          showToast(String(err));
        }
      });
      host.appendChild(chip);
    });
  } catch (e) {
    host.textContent = String(e);
  } finally {
    btn.disabled = false;
  }
});
window.addEventListener('blur', () => invoke('vault_lock').then(refreshVaultStatus).catch(() => {}));
refreshVaultStatus();

if (soundVolumeSlider) {
  soundVolumeSlider.value = soundVolume;
  if (soundVolumeVal) soundVolumeVal.textContent = `${soundVolume}%`;
  
  const updateVol = (e) => {
    soundVolume = parseInt(e.target.value);
    if (soundVolumeVal) soundVolumeVal.textContent = `${soundVolume}%`;
    localStorage.setItem('folio_sound_volume', soundVolume);
  };
  soundVolumeSlider.addEventListener('input', updateVol);
  soundVolumeSlider.addEventListener('change', (e) => {
    updateVol(e);
    playUISound('success');
  });
}
if (vibrancyCheck) {
  vibrancyCheck.checked = vibrancyEnabled;
  vibrancyCheck.addEventListener('change', (e) => {
    vibrancyEnabled = e.target.checked;
    localStorage.setItem('folio_vibrancy', vibrancyEnabled);
    invoke('set_window_vibrancy', { enabled: vibrancyEnabled });
  });
}
// Apply initial vibrancy if enabled
if (vibrancyEnabled) invoke('set_window_vibrancy', { enabled: true });

if (colorBlindSelect) {
  colorBlindSelect.value = activeColorBlindMode;
  colorBlindSelect.addEventListener('change', (e) => {
    activeColorBlindMode = e.target.value;
    localStorage.setItem('folio_color_blind', activeColorBlindMode);
    applyColorBlindMode();
  });
}

if (reverseGeocodeCheck) {
  reverseGeocodeCheck.checked = reverseGeocodeEnabled;
  reverseGeocodeCheck.addEventListener('change', (e) => {
    reverseGeocodeEnabled = e.target.checked;
    localStorage.setItem('folio_reverse_geocode_enabled', reverseGeocodeEnabled);
    geocodeCache.clear();
    if (items[idx]) show(idx);
  });
}

const watermarkToggle = $('watermarkToggle');
const watermarkInputRow = $('watermarkInputRow');
let activeWatermarkAnchor = localStorage.getItem('folio_watermark_anchor') || 'bottom-right';

if (watermarkToggle && watermarkInput && watermarkInputRow && watermarkAnchorSelect) {
  let hasWatermark = localStorage.getItem('folio_watermark_enabled') === 'true';
  watermarkToggle.checked = hasWatermark;
  watermarkInput.value = activeWatermark;
  watermarkAnchorSelect.value = activeWatermarkAnchor;
  
  if (hasWatermark) watermarkInputRow.classList.add('visible');

  watermarkToggle.addEventListener('change', (e) => {
    hasWatermark = e.target.checked;
    localStorage.setItem('folio_watermark_enabled', hasWatermark);
    if (hasWatermark) {
      watermarkInputRow.classList.add('visible');
      watermarkInput.focus();
    } else {
      watermarkInputRow.classList.remove('visible');
      watermarkInput.value = '';
      activeWatermark = '';
      localStorage.removeItem('folio_watermark');
    }
  });
  
  watermarkInput.addEventListener('input', (e) => {
    activeWatermark = e.target.value;
    localStorage.setItem('folio_watermark', activeWatermark);
  });
  
  watermarkAnchorSelect.addEventListener('change', (e) => {
    activeWatermarkAnchor = e.target.value;
    localStorage.setItem('folio_watermark_anchor', activeWatermarkAnchor);
  });
}

if (watermarkOpacitySlider) {
  watermarkOpacitySlider.value = activeWatermarkOpacity;
  watermarkOpacitySlider.addEventListener('input', e => {
    activeWatermarkOpacity = parseInt(e.target.value, 10);
    localStorage.setItem('folio_watermark_opacity', activeWatermarkOpacity);
  });
}
if (watermarkScaleSlider) {
  watermarkScaleSlider.value = activeWatermarkScale;
  watermarkScaleSlider.addEventListener('input', e => {
    activeWatermarkScale = parseInt(e.target.value, 10);
    localStorage.setItem('folio_watermark_scale', activeWatermarkScale);
  });
}
if (watermarkFontSlider) {
  watermarkFontSlider.value = activeWatermarkFont;
  watermarkFontSlider.addEventListener('input', e => {
    activeWatermarkFont = parseInt(e.target.value, 10);
    localStorage.setItem('folio_watermark_font', activeWatermarkFont);
  });
}

if (thumbCacheLimitInput) {
  thumbCacheLimitInput.value = thumbnailCacheLimitGb;
  thumbCacheLimitInput.addEventListener('change', async e => {
    thumbnailCacheLimitGb = Math.max(0.25, Math.min(100, parseFloat(e.target.value || '2')));
    localStorage.setItem('folio_thumbnail_cache_limit_gb', String(thumbnailCacheLimitGb));
    await invoke('set_thumbnail_cache_limit', { limitGb: thumbnailCacheLimitGb }).catch(err => showToast(`Cache limit failed: ${err}`));
  });
}
if (decodedCacheLimitInput) {
  decodedCacheLimitInput.value = decodedCacheLimitGb;
  invoke('set_decoded_cache_limit', { limitGb: decodedCacheLimitGb }).catch(() => {});
  decodedCacheLimitInput.addEventListener('change', async e => {
    decodedCacheLimitGb = Math.max(0.5, Math.min(100, parseFloat(e.target.value || '4')));
    localStorage.setItem('folio_decoded_cache_limit_gb', String(decodedCacheLimitGb));
    await invoke('set_decoded_cache_limit', { limitGb: decodedCacheLimitGb }).catch(err => showToast(`Decoded limit failed: ${err}`));
    await invoke('prune_decoded_cache').catch(() => {});
    loadStorageDiagnostics().catch(() => {});
  });
}
if (prefetchCheck) {
  prefetchCheck.checked = prefetchEnabled;
  prefetchCheck.addEventListener('change', e => {
    prefetchEnabled = e.target.checked;
    localStorage.setItem('folio_prefetch_enabled', prefetchEnabled);
  });
}

function applyColorBlindMode() {
  if (activeColorBlindMode === 'none') {
    viewer.style.filter = '';
    filmstrip.style.filter = '';
    catalogGrid.style.filter = '';
  } else {
    viewer.style.filter = `url(#sim-${activeColorBlindMode})`;
    filmstrip.style.filter = `url(#sim-${activeColorBlindMode})`;
    catalogGrid.style.filter = `url(#sim-${activeColorBlindMode})`;
  }
}
applyColorBlindMode();

/* ── Core UI Methods ── */
function applyTheme(theme) {
  document.body.classList.toggle('light-theme', theme === 'light');
  const root = document.documentElement.style;
  if (theme === 'light') {
    root.setProperty('--folio-surface', '#ffffff');
    root.setProperty('--bg-deep', '#f5f5f6');
    root.setProperty('--bg-sidebar', 'rgba(255, 255, 255, 0.96)');
    root.setProperty('--text-primary', '#1a1a1e');
    root.setProperty('--text-secondary', 'rgba(0, 0, 0, 0.55)');
    root.setProperty('--text-tertiary', 'rgba(0, 0, 0, 0.38)');
    root.setProperty('--border-subtle', 'rgba(0, 0, 0, 0.08)');
    root.setProperty('--border-hover', 'rgba(0, 0, 0, 0.14)');
    root.setProperty('--modal-bg', 'rgba(255, 255, 255, 0.96)');
    root.setProperty('--input-bg', 'rgba(0, 0, 0, 0.05)');
    root.setProperty('--overlay-bg', 'rgba(0, 0, 0, 0.2)');
  } else {
    root.setProperty('--folio-surface', '#1b1b1f');
    root.setProperty('--bg-deep', '#111113');
    root.setProperty('--bg-sidebar', 'rgba(27, 27, 31, 0.96)');
    root.setProperty('--text-primary', '#f5f5f2');
    root.setProperty('--text-secondary', 'rgba(245, 245, 242, 0.55)');
    root.setProperty('--text-tertiary', 'rgba(245, 245, 242, 0.32)');
    root.setProperty('--border-subtle', 'rgba(255, 255, 255, 0.06)');
    root.setProperty('--border-hover', 'rgba(255, 255, 255, 0.12)');
    root.setProperty('--modal-bg', 'rgba(18, 18, 20, 0.88)');
    root.setProperty('--input-bg', 'rgba(255, 255, 255, 0.06)');
    root.setProperty('--overlay-bg', 'rgba(0, 0, 0, 0.45)');
  }
}

/* ── Tooltips ── */
let tooltipEl = null;
function initTooltips() {
  if (tooltipEl) return;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'folio-tooltip';
  document.body.appendChild(tooltipEl);

  window.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (!target) {
      tooltipEl.classList.remove('visible', 'placement-top', 'placement-bottom');
      return;
    }
    tooltipEl.textContent = target.dataset.tooltip;
    
    const r = target.getBoundingClientRect();
    tooltipEl.style.left = `${r.left + r.width/2}px`;
    
    if (r.top < 45) {
      tooltipEl.className = 'folio-tooltip placement-bottom';
      tooltipEl.style.top = `${r.bottom}px`;
    } else {
      tooltipEl.className = 'folio-tooltip placement-top';
      tooltipEl.style.top = `${r.top}px`;
    }
    
    tooltipEl.classList.add('visible');
  });

  window.addEventListener('pointerdown', (e) => {
    if (tooltipEl) tooltipEl.classList.remove('visible');
    const targetRange = e.target.closest('input[type="range"]');
    if (targetRange) {
      FolioState.isSliderActive = true;
    }
  });

  window.addEventListener('pointerup', () => {
    FolioState.isSliderActive = false;
  });

  window.addEventListener('pointercancel', () => {
    FolioState.isSliderActive = false;
  });
}
initTooltips();

function renderMediaError(layer, item, onRetry) {
  layer.innerHTML = '';
  const ext = (item.path.split('.').pop() || '').toLowerCase();
  const rawLike = ['cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'heic', 'heif', 'tif', 'tiff'].includes(ext);
  const host = document.createElement('div');
  host.className = 'folio-state-host folio-state-host--layer is-active';
  renderEmptyState(host, {
    preset: rawLike ? 'media-unsupported' : 'media-error',
    message: rawLike
      ? `${item.path.split(/[/\\]/).pop()} is decoding. Retry if it does not appear shortly.`
      : `${item.path.split(/[/\\]/).pop()} could not be loaded.`,
    actions: [{ label: 'Retry', primary: true, onClick: () => onRetry() }],
  });
  host.style.cssText = 'position:absolute;inset:0;z-index:20;';
  layer.appendChild(host);
}

function makeEditable(element, fieldKey) {
  if (!element) return;
  element.style.cursor = 'pointer';
  element.title = 'Double-click to edit';
  
  element.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const originalText = element.textContent;
    if (element.querySelector('input')) return;
    
    const input = document.createElement('input');
    input.type = 'text';
    input.value = originalText === '—' || originalText === 'Unknown Camera' || originalText === 'No Metadata' ? '' : originalText;
    input.className = 'ed-inline-input';
    
    element.textContent = '';
    element.appendChild(input);
    input.focus();
    
    let saved = false;
    const saveEdit = async () => {
      if (saved) return;
      saved = true;
      const newVal = input.value.trim() || '—';
      element.textContent = newVal;
      
      const item = items[idx];
      if (!item) return;
      if (!item.exif) item.exif = {};
      
      if (fieldKey === 'camera') item.exif.camera = newVal;
      else if (fieldKey === 'aperture') item.exif.aperture = newVal;
      else if (fieldKey === 'shutter') item.exif.shutter_speed = newVal;
      else if (fieldKey === 'iso') item.exif.iso = newVal;
      else if (fieldKey === 'focal') item.exif.focal_length = newVal;
      
      try {
        await invoke('update_exif_metadata', {
          path: item.path,
          camera: item.exif.camera || null,
          aperture: item.exif.aperture || null,
          shutterSpeed: item.exif.shutter_speed || null,
          iso: item.exif.iso || null,
          focalLength: item.exif.focal_length || null
        });
        showToast('Metadata updated');
      } catch (err) {
        showToast('Failed to save metadata');
        element.textContent = originalText;
      }
    };
    
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') saveEdit();
      if (evt.key === 'Escape') {
        saved = true;
        element.textContent = originalText;
      }
    });
    
    input.addEventListener('blur', saveEdit);
  });
}
makeEditable(edCamera, 'camera');
makeEditable(edAperture, 'aperture');
makeEditable(edShutter, 'shutter');
makeEditable(edIso, 'iso');
makeEditable(edFocal, 'focal');

function playUISound(name) {
  const volume = parseFloat(localStorage.getItem('folio_sound_volume') ?? '40') / 100;
  invoke('trigger_macos_sound', { name, volume }).catch(()=>{});
}

initToast({ playSound: (name) => playUISound(name) });
initA11y();

const SETTINGS_PANE_TITLES = {
  general: 'General', appearance: 'Appearance', catalog: 'Catalog', cache: 'Cache',
  export: 'Export', shortcuts: 'Shortcuts', security: 'Security', advanced: 'Advanced',
};
let settingsReturnTo = 'home';

function openSettings() {
  settingsReturnTo = items.length || openedLibraryPath ? 'shell' : 'home';
  welcome?.classList.add('hidden');
  if (appShell) appShell.style.display = 'none';
  if (settingsPage) {
    settingsPage.style.display = 'flex';
    settingsPage.setAttribute('aria-hidden', 'false');
  }
  const activeTab = document.querySelector('.settings-nav-item.active')?.dataset?.tab || 'general';
  if (activeTab === 'cache' || activeTab === 'advanced') loadStorageDiagnostics();
}

function closeSettings() {
  if (settingsPage) {
    settingsPage.style.display = 'none';
    settingsPage.setAttribute('aria-hidden', 'true');
  }
  if (settingsReturnTo === 'shell') {
    setAppShellVisible(true);
    updateWorkspaceLayout();
  } else {
    showHomeHub();
  }
}

getCurrentWindow().setCursorVisible(true).catch(() => {});

async function syncFullscreenState() {
  try { isFullscreen = await getCurrentWindow().isFullscreen(); } catch { isFullscreen = false; }
  if (fullscreenBtn) {
    fullscreenBtn.classList.toggle('active', isFullscreen);
    fullscreenBtn.textContent = isFullscreen ? 'EXIT' : 'FULL';
  }
}

async function toggleFullscreen() {
  try { await getCurrentWindow().setFullscreen(!isFullscreen); await syncFullscreenState(); } catch (err) { console.error(err); }
}

/* ── Viewport & Zoom/Pan ── */
function getActiveImage() { return media.querySelector('.media-layer.media-active img.media-content'); }

function scheduleUpdate() {
  if (pendingRafUpdate) return; pendingRafUpdate = true;
  requestAnimationFrame(() => {
    pendingRafUpdate = false;
    const img = getActiveImage();
    if (img) {
      const t = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
      img.style.transform = t;
      if (editPreviewImg && editPreviewImg.parentElement === img.parentElement) editPreviewImg.style.transform = t;
    }
  });
}



function setZoom(level, cx, cy, opts = {}) {
  const oldZ = zoom;
  const snapToFit = opts.snapToFit !== false;
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));

  if ((zoom === 1 && oldZ !== 1) || (Math.floor(oldZ) !== Math.floor(zoom))) {
    try { playUISound('tick'); } catch (e) {}
  }

  const img = getActiveImage();
  if (img) {
    if (zoom <= 1) {
      zoom = 1;
      panX = 0;
      panY = 0;
      img.classList.remove('zoomed');
      img.style.transform = '';
      if (editPreviewImg) editPreviewImg.style.transform = '';
      const crossedFit = oldZ > 1.02;
      if (snapToFit && crossedFit && !opts.skipBounce) {
        img.classList.add('zoom-snap-bounce');
        setTimeout(() => img.classList.remove('zoom-snap-bounce'), 250);
        invoke('macos_haptic_tick', { style: 'snap' }).catch(() => {});
      }
    } else {
      img.classList.add('zoomed');
      if (cx !== undefined && cy !== undefined && oldZ > 0) {
        const ratio = zoom / oldZ;
        panX = cx - (cx - panX) * ratio;
        panY = cy - (cy - panY) * ratio;
      }
      scheduleUpdate();
    }
  }
  zoomSlider.value = Math.round(zoom * 100);
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
}

function resetZoom() { setZoom(1, 0, 0, { smooth: false }); }

const PICKS_KEY = 'folio_picks';
function getPicks() {
  try { return new Set(JSON.parse(localStorage.getItem(PICKS_KEY) || '[]')); }
  catch { return new Set(); }
}
function savePicks(set) {
  localStorage.setItem(PICKS_KEY, JSON.stringify([...set]));
}
function isPicked(path) { return getPicks().has(path); }
function togglePick(path) {
  const picks = getPicks();
  if (picks.has(path)) picks.delete(path);
  else picks.add(path);
  savePicks(picks);
  return picks.has(path);
}

function createHomeFolderRow(path) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'home-list-item';
  const meta = document.createElement('div');
  meta.className = 'home-item-meta';
  const nameEl = document.createElement('span');
  nameEl.className = 'home-item-name';
  nameEl.textContent = folderDisplayName(path);
  const pathEl = document.createElement('span');
  pathEl.className = 'home-item-path';
  pathEl.textContent = formatHomePath(path);
  meta.append(nameEl, pathEl);
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'home-pin-btn' + (isPinned(path) ? ' pinned' : '');
  pinBtn.innerHTML = '★';
  pinBtn.title = isPinned(path) ? 'Unpin' : 'Pin location';
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePinnedFolder(path);
    renderHomeHub();
  });
  row.append(meta, pinBtn);
  row.addEventListener('click', async () => {
    try {
      const p = await invoke('open_specific_folder', { path });
      await loadFolderData(p);
    } catch (e) {
      showToast('Failed to open folder');
    }
  });
  return row;
}

async function renderPinnedFoldersList() {
  const container = $('pinnedFolders');
  if (!container) return;
  const layout = getHomeLayout();
  const section = $('homePinnedSection');
  if (section) section.style.display = layout.showPinned ? '' : 'none';
  container.replaceChildren();
  const pinned = getPinnedFolders();
  if (!pinned.length) {
    const empty = document.createElement('p');
    empty.className = 'onboarding-hint';
    empty.style.margin = '0';
    empty.textContent = 'Pin folders from recents with ★';
    container.appendChild(empty);
    return;
  }
  pinned.forEach((path) => container.appendChild(createHomeFolderRow(path)));
}

function renderHomeCustomizeChips() {
  const wrap = $('homeCustomizeChips');
  if (!wrap) return;
  const layout = getHomeLayout();
  const section = $('homeCustomizeSection');
  if (section) section.style.display = '';
  const chips = [
    { key: 'showLibrary', label: 'Library' },
    { key: 'showPinned', label: 'Pinned' },
    { key: 'showRecents', label: 'Recent' },
    { key: 'showShortcuts', label: 'Shortcuts' },
  ];
  wrap.replaceChildren();
  chips.forEach(({ key, label }) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'home-chip' + (layout[key] ? ' active' : '');
    chip.textContent = label;
    chip.addEventListener('click', () => {
      saveHomeLayout({ [key]: !layout[key] });
      renderHomeHub();
    });
    wrap.appendChild(chip);
  });
}

async function clearAllRecents() {
  try {
    await invoke('clear_recent_folders');
    await renderHomeHub();
    showToast('Recent folders cleared');
  } catch (e) {
    showToast(`Could not clear recents: ${e}`);
  }
}

$('clearRecentsHomeBtn')?.addEventListener('click', clearAllRecents);
$('clearRecentsSettingsBtn')?.addEventListener('click', clearAllRecents);

async function renderHomeHub() {
  const scrollEl = document.querySelector('.home-side-scroll');
  const savedScrollTop = scrollEl?.scrollTop ?? 0;
  const layout = getHomeLayout();
  const lib = $('homeLibrarySection');
  const pin = $('homePinnedSection');
  const rec = $('homeRecentsSection');
  const shortcuts = document.querySelector('.home-shortcuts');
  if (lib) lib.style.display = layout.showLibrary ? '' : 'none';
  if (pin) pin.style.display = layout.showPinned ? '' : 'none';
  if (rec) rec.style.display = layout.showRecents && showRecentFolders ? '' : 'none';
  if (shortcuts) shortcuts.style.display = layout.showShortcuts ? 'flex' : 'none';
  const catalogBtn = $('homeCatalogBtn');
  if (catalogBtn) {
    catalogBtn.style.display = openedLibraryPath ? '' : 'none';
    catalogBtn.onclick = () => {
      if (items.length) toggleCatalogView(true);
    };
  }
  await renderPinnedFoldersList();
  await renderRecentFolders();
  renderHomeCustomizeChips();
  if (scrollEl) scrollEl.scrollTop = savedScrollTop;
}

async function renderRecentFolders() {
  const container = $('recentFolders');
  if (!container) return;
  const layout = getHomeLayout();
  const section = $('homeRecentsSection');
  if (section) section.style.display = layout.showRecents && showRecentFolders ? '' : 'none';
  if (!showRecentFolders) {
    container.innerHTML = '';
    return;
  }
  try {
    const fullList = await invoke('get_recent_folders');
    container.replaceChildren();
    if (!fullList?.length) {
      const empty = document.createElement('p');
      empty.className = 'onboarding-hint';
      empty.style.margin = '0';
      empty.textContent = 'No recent folders yet';
      container.appendChild(empty);
      return;
    }
    fullList.slice(0, 8).forEach((path) => container.appendChild(createHomeFolderRow(path)));
  } catch (e) {
    console.error('[Folio] Failed to fetch recents:', e);
  }
}

function updateViewerToolbar() {
  const starsEl = $('viewerStars');
  const favBtn = $('viewerFavoriteBtn');
  const pickBtn = $('viewerPickBtn');
  const item = items[idx];
  if (!starsEl || !item || item.is_video) {
    if (starsEl) starsEl.innerHTML = '';
    return;
  }
  const attr = mediaAttributesCache.get(item.path) || {};
  const rating = attr.rating || 0;
  starsEl.replaceChildren();
  for (let s = 1; s <= 5; s++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'viewer-star' + (s <= rating ? ' filled' : '');
    btn.textContent = '★';
    btn.setAttribute('aria-label', `Rate ${s} stars`);
    btn.addEventListener('click', async () => {
      const next = s === rating ? 0 : s;
      try {
        await invoke('set_media_rating', { paths: [item.path], rating: next });
        const a = mediaAttributesCache.get(item.path) || { path: item.path };
        a.rating = next;
        mediaAttributesCache.set(item.path, a);
        updateViewerToolbar();
        buildFilmstrip();
        if (catalogModeActive) buildCatalogContent();
      } catch (err) {
        showToast(`Rating failed: ${err}`);
      }
    });
    starsEl.appendChild(btn);
  }
  if (favBtn) {
    favBtn.classList.toggle('active', !!attr.favorite);
    favBtn.onclick = async () => {
      const next = !attr.favorite;
      try {
        await invoke('set_media_favorite', { paths: [item.path], favorite: next });
        const a = mediaAttributesCache.get(item.path) || { path: item.path };
        a.favorite = next;
        mediaAttributesCache.set(item.path, a);
        updateViewerToolbar();
        buildFilmstrip();
        if (catalogModeActive) buildCatalogContent();
        if (next) playFavoriteBurst(favBtn);
      } catch (err) {
        showToast(`Favorite failed: ${err}`);
      }
    };
  }
  if (pickBtn) {
    pickBtn.classList.toggle('active', isPicked(item.path));
    pickBtn.onclick = () => {
      togglePick(item.path);
      updateViewerToolbar();
    };
  }
}

function processLoadedItems(rawItems) {
  if (!rawItems) return [];
  const movPaths = new Map();
  rawItems.forEach(it => {
    if (it.is_video && it.path.toLowerCase().endsWith('.mov')) {
      const base = it.path.substring(0, it.path.lastIndexOf('.')).toLowerCase();
      movPaths.set(base, it.path);
    }
  });

  rawItems.forEach(it => {
    if (!it.is_video) {
      const extIdx = it.path.lastIndexOf('.');
      if (extIdx !== -1) {
        const ext = it.path.substring(extIdx + 1).toLowerCase();
        if (['heic', 'heif', 'jpg', 'jpeg'].includes(ext)) {
          const base = it.path.substring(0, extIdx).toLowerCase();
          if (movPaths.has(base)) {
            it.isLivePhoto = true;
            it.livePhotoVideoPath = movPaths.get(base);
          }
        }
      }
    }
  });

  const pairedVideoPaths = new Set();
  rawItems.forEach(it => {
    if (it.isLivePhoto && it.livePhotoVideoPath) {
      pairedVideoPaths.add(it.livePhotoVideoPath.toLowerCase());
    }
  });

  return rawItems.filter(it => !pairedVideoPaths.has(it.path.toLowerCase()));
}

async function openMediaFromPath(filePath) {
  try {
    const result = await invoke('open_media_at_path', { filePath });
    await loadFolderData(result.folder, result.file || null);
    return result;
  } catch (err) {
    showToast(`Could not open file: ${err}`);
    return null;
  }
}

async function loadFolderData(p, selectPath = null) {
  openedLibraryPath = p;
  clearEmptyState(catalogStateHost);
  clearEmptyState(viewerStateHost);
  renderEmptyState(catalogStateHost, { preset: 'folder-loading' });
  renderEmptyState(viewerStateHost, { preset: 'folder-loading' });

  try {
    if (localStorage.getItem('folio_biometric_lock') === 'true') {
      showToast('Authenticating Secure Vault…');
      const authenticated = await invoke('authenticate_vault');
      if (!authenticated) {
        showToast('Secure Vault access denied');
        renderEmptyState(viewerStateHost, {
          preset: 'vault-locked',
          message: 'Vault authentication was cancelled or failed. Open Settings → Security to try again.',
        });
        clearEmptyState(catalogStateHost);
        return;
      }
      showToast('Secure Vault unlocked');
    }

    items = processLoadedItems(await invoke('get_folder_items'));
    idx = 0;
    sortItems();
    if (selectPath) {
      const normalized = selectPath.toLowerCase();
      const found = items.findIndex((it) => it.path.toLowerCase() === normalized);
      if (found >= 0) idx = found;
    }
    renderBreadcrumbs(p);
    activeTagFilter = null;
    activeColorFilter = null;
    folderDominantColorsCache = {};

    if (!items.length) {
      const emptyOpts = {
        preset: 'folder-empty',
        actions: [{ label: 'Choose another folder', primary: true, onClick: () => openFolder() }],
      };
      renderEmptyState(catalogStateHost, emptyOpts);
      renderEmptyState(viewerStateHost, emptyOpts);
      updateWorkspaceLayout();
      return;
    }

    clearEmptyState(catalogStateHost);
    clearEmptyState(viewerStateHost);
    editSessionPath = null;
    filmstrip.scrollTop = 0;
    updateWorkspaceLayout();
    playUISound('load');
    if (catalogModeActive) {
      buildCatalogContent();
    } else {
      show(idx);
    }
    buildFilmstrip();
    Promise.all([renderTagFilters(), loadMediaAttributes()]).catch((e) => console.error(e));
  } catch (e) {
    console.error(e);
    const msg = String(e);
    renderEmptyState(catalogStateHost, { preset: 'folder-error', message: msg });
    renderEmptyState(viewerStateHost, {
      preset: 'folder-error',
      message: msg,
      actions: [{ label: 'Try again', primary: true, onClick: () => loadFolderData(p, selectPath) }],
    });
    showToast(`Could not open folder: ${msg}`);
  }
}

function renderBreadcrumbs(path) {
  if (!breadcrumbs) return;
  breadcrumbs.innerHTML = '';
  const parts = path.split('/').filter(Boolean);
  let currentAccum = '';
  if (path.startsWith('/')) currentAccum = '/';

  parts.forEach((p, i) => {
    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = p;
    currentAccum += p;
    const target = currentAccum;
    crumb.onclick = async () => {
        try {
            const res = await invoke('open_specific_folder', { path: target });
            loadFolderData(res);
        } catch(e) { console.error(e); }
    };
    breadcrumbs.appendChild(crumb);
    if (i < parts.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        breadcrumbs.appendChild(sep);
    }
    currentAccum += '/';
  });
  const finderBtn = document.createElement('button');
  finderBtn.className = 'catalog-btn';
  finderBtn.style.cssText = 'padding:2px 6px;font-size:10px;margin-left:6px;';
  finderBtn.textContent = 'Finder';
  finderBtn.onclick = () => openPathInFinder(path, false);
  breadcrumbs.appendChild(finderBtn);
}

/* ── Core Logic ── */
async function openFolder() {
    try {
        const p = await invoke('open_folder_picker');
        if (!p) return;
        await invoke('add_recent_folder', { path: p });
        renderHomeHub();
        await loadFolderData(p);
    } catch (e) {
        console.error(e);
        showToast(`Could not open folder: ${e}`);
    }
}

function currentFolderPath() {
  const activePath = items[idx]?.path || items[0]?.path;
  if (!activePath) return null;
  return activePath.substring(0, activePath.lastIndexOf('/'));
}

async function openPathInFinder(path, reveal = false) {
  if (!path) {
    showToast('Open a folder first');
    return;
  }
  try {
    await invoke('open_in_finder', { path, reveal });
  } catch (e) {
    showToast(`Finder failed: ${e}`);
  }
}

function openCurrentFolderInFinder() {
  openPathInFinder(currentFolderPath(), false);
}


function nav(dir) { if (items.length) show((idx + dir + items.length) % items.length, dir); }

function isRapidViewerNav() {
  const now = performance.now();
  const rapid = now - (window._lastShowAt || 0) < 180;
  window._lastShowAt = now;
  return rapid;
}

function clearMediaContent(keep = null) {
  Array.from(media.children).forEach(c => { if (c !== mediaLoader && c !== keep) c.remove(); });
}

function applyPhysicalExit(node, dir) {
  node.classList.remove('media-active');
  node.style.zIndex = '1';
  node.animate([
    { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1) rotate(0deg)' },
    { opacity: 0, transform: `translate3d(${dir * -60}px, 0, 0) scale(0.97) rotate(${dir * -1}deg)` }
  ], { duration: 700, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }).finished.then(() => node.remove());
}

function preloadImage(item) {
  if (!item || item.is_video) return;
  if (preloadCache.has(item.path)) return;

  const ext = (item.path.split('.').pop() || '').toLowerCase();
  const isNative = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  preloadCache.set(item.path, img);

  if (isNative) {
    img.src = `folio://localhost/${encodeURIComponent(item.path)}`;
  } else {
    invoke('get_full_image', { path: item.path })
      .then(p => {
        img.src = `folio://localhost/${encodeURIComponent(p)}`;
      })
      .catch(() => {
        preloadCache.delete(item.path);
      });
  }
}

function preloadVideo(item) {
  if (!item?.is_video || videoPreloadCache.has(item.path)) return;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;left:-9999px';
  v.src = `folio://localhost/${encodeURIComponent(item.path)}`;
  document.body.appendChild(v);
  videoPreloadCache.set(item.path, v);
}

function evictVideoPreload(path) {
  const v = videoPreloadCache.get(path);
  if (!v) return;
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.remove();
  videoPreloadCache.delete(path);
}

function triggerPreload(currentIdx) {
  if (!items || items.length <= 1) return;

  const now = performance.now();
  let direction = 1;
  let speed = 0;

  if (window.lastPreloadTime > 0) {
    const dt = now - window.lastPreloadTime;
    let diff = currentIdx - window.lastPreloadIdx;

    if (Math.abs(diff) > items.length / 2) {
      diff = diff > 0 ? diff - items.length : diff + items.length;
    }

    if (dt > 0 && diff !== 0) {
      direction = diff > 0 ? 1 : -1;
      speed = Math.abs(diff) / dt;
    }
  }

  window.lastPreloadIdx = currentIdx;
  window.lastPreloadTime = now;

  const keepSet = new Set();
  const offsets = [];
  const fullDecodePaths = [];

  const isFast = speed > 0.003;
  if (isFast) {
    for (let o = 1; o <= 6; o++) offsets.push(o * direction);
  } else {
    offsets.push(-3, -2, -1, 1, 2, 3);
  }

  const currentItem = items[currentIdx];
  if (currentItem) keepSet.add(currentItem.path);

  for (const offset of offsets) {
    const targetIdx = (currentIdx + offset + items.length) % items.length;
    const item = items[targetIdx];
    if (!item) continue;
    keepSet.add(item.path);
    if (item.is_video) {
      preloadVideo(item);
    } else {
      preloadImage(item);
      const ext = (item.path.split('.').pop() || '').toLowerCase();
      const isNative = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);
      if (Math.abs(offset) === 1 && !isNative) {
        fullDecodePaths.push(item.path);
      }
    }
  }

  if (prefetchEnabled) {
    const paths = Array.from(keepSet).filter(Boolean);
    if (paths.length) {
      invoke('prefetch_media', { paths, maxSide: 640 }).catch(() => {});
    }
    if (fullDecodePaths.length) {
      invoke('prefetch_decoded_media', { paths: fullDecodePaths }).catch(() => {});
    }
  }

  // Drop incomplete loads outside the window; cap total cache size.
  for (const [path, img] of [...preloadCache.entries()]) {
    if (keepSet.has(path)) continue;
    if (!img.complete || !img.naturalWidth) preloadCache.delete(path);
  }
  const PRELOAD_CACHE_MAX = 18;
  if (preloadCache.size > PRELOAD_CACHE_MAX) {
    for (const path of preloadCache.keys()) {
      if (!keepSet.has(path)) {
        preloadCache.delete(path);
        if (preloadCache.size <= PRELOAD_CACHE_MAX) break;
      }
    }
  }
  for (const path of videoPreloadCache.keys()) {
    if (!keepSet.has(path)) evictVideoPreload(path);
  }
}

function show(i, dir = null) {
  triggerPreload(i);
  const rapidNav = isRapidViewerNav();
  const prevIdx = idx, direction = dir !== null ? dir : (i > prevIdx ? 1 : i < prevIdx ? -1 : 0);
  idx = i; zoom = 1; panX = 0; panY = 0;
  zoomSlider.value = 100; zoomLabel.textContent = '100%';
  
  const item = items[i];
  if (!item?.is_video) detachVideoToolbar();
  if (editSessionPath && editSessionPath !== item.path) {
    editSessionPath = null;
    removeEditPreview();
  }
  const src = `folio://localhost/${encodeURIComponent(item.path)}`, outgoing = media.querySelector('.media-layer.media-active');
  if (outgoing) {
    if (rapidNav) {
      outgoing.remove();
    } else if (cinematicEnabled && direction !== 0) {
      applyPhysicalExit(outgoing, direction);
    } else {
      outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease-out' }).finished.then(() => outgoing.remove());
    }
  }
  clearMediaContent(outgoing);
  
  const layer = document.createElement('div'); layer.className = 'media-layer media-active';
  layer.style.zIndex = '2';
  
  if (rapidNav) {
    layer.style.opacity = '1';
    layer.style.transform = 'none';
  } else if (cinematicEnabled && direction !== 0) {
    requestAnimationFrame(() => layer.animate([
        { opacity: 0, transform: `translate3d(${direction * 50}%, 0, 0) scale(1.02) rotate(${direction * 1.5}deg)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1) rotate(0deg)' }
    ], { duration: 750, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }));
  } else {
    requestAnimationFrame(() => layer.animate([
        { opacity: 0 },
        { opacity: 1 }
    ], { duration: 400, easing: 'ease-out', fill: 'forwards' }));
    layer.style.transform = 'none';
  }
  
  if (item.is_video) {
    viewer.classList.remove('loading');
    const v = document.createElement('video');
    v.className = 'media-content';
    v.autoplay = true; v.loop = true; v.playsInline = true;
    const warmed = videoPreloadCache.get(item.path);
    if (warmed && warmed.readyState >= 2) {
      v.src = warmed.currentSrc || warmed.src;
    } else {
      v.src = src;
    }

    v.onerror = () => {
      viewer.classList.remove('loading');
      renderMediaError(layer, item, () => {
        v.src = '';
        v.src = src + '?retry=' + Date.now();
      });
    };

    v.onloadeddata = () => {
      v.classList.add('loaded');
      bindVideoToolbar(v, layer);
      setTimeout(() => {
        requestAnimationFrame(() => {
          if (items[idx]?.path !== item.path) return;
          updateAdaptiveGlow(v);
        });
      }, 50);
    };
    layer.appendChild(v);
    media.appendChild(layer);
  } else {
    const cached = preloadCache.get(item.path);
    const preloadReady = cached && cached.complete && cached.naturalWidth > 0;
    const usePlaceholder = !preloadReady && !rapidNav;
    if (!preloadReady) viewer.classList.add('loading');
    if (usePlaceholder) {
      const ts = preloadedThumbs.get(item.path);
      if (ts) {
        const ph = document.createElement('img');
        ph.crossOrigin = 'anonymous';
        ph.src = ts;
        ph.className = 'placeholder-thumb';
        ph.onload = () => ph.classList.add('loaded');
        layer.appendChild(ph);
      }
    }

    const runViewerChrome = (img) => {
      if (items[idx]?.path !== item.path) return;
      img.classList.add('loaded');
      img.style.opacity = '1';
      viewer.classList.remove('loading');
      const ph = layer.querySelector('.placeholder-thumb');
      if (ph) {
        ph.classList.remove('loaded');
        ph.classList.add('fade-out');
        setTimeout(() => ph.remove(), 120);
      }
      requestAnimationFrame(() => {
        if (items[idx]?.path !== item.path) return;
        try { updateAdaptiveGlow(img); } catch (e) { console.error('Adaptive glow error:', e); }
        if (isEditPreviewEnabled()) {
          invoke('prepare_edit_preview', { path: item.path }).then(() => {
            editSessionPath = item.path;
            loadEditForCurrent();
          }).catch(e => console.error(e));
        }
        try { drawHistogram(img); } catch (e) { console.error('Histogram error:', e); }
        try { drawDominantColors(item); } catch (e) { console.error('Dominant colors error:', e); }
      });
    };

    const isNative = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(item.path.split('.').pop().toLowerCase());
    let img;
    let revealToken = 0;

    if (preloadReady) {
      preloadCache.delete(item.path);
      img = cached;
      img.className = 'media-content';
      img.alt = '';
      img.style.opacity = '1';
      layer.appendChild(img);
      runViewerChrome(img);
    } else {
      img = document.createElement('img');
      img.crossOrigin = 'anonymous';
      img.alt = '';
      img.className = 'media-content';

      const revealViewerImage = async () => {
        const token = ++revealToken;
        if (usePlaceholder && img.decode) {
          try { await img.decode(); } catch (_) { /* show anyway */ }
        }
        if (token !== revealToken || items[idx]?.path !== item.path) return;
        if (!img.naturalWidth) return;
        runViewerChrome(img);
      };

      img.onload = () => { revealViewerImage(); };
      img.onerror = () => {
        viewer.classList.remove('loading');
        const ph = layer.querySelector('.placeholder-thumb');
        if (ph) ph.remove();
        renderMediaError(layer, item, () => {
          img.src = '';
          if (isNative) {
            img.src = src + '?retry=' + Date.now();
          } else {
            invoke('clear_decode_failures', { path: item.path }).catch(() => {});
            invoke('get_full_image', { path: item.path, force: true })
              .then(p => { img.src = `folio://localhost/${encodeURIComponent(p)}?retry=${Date.now()}`; })
              .catch(() => { img.src = src + '?retry=' + Date.now(); });
          }
        });
      };

      if (isNative) {
        img.src = src;
        if (img.complete && img.naturalWidth > 0) revealViewerImage();
      } else {
        invoke('get_full_image', { path: item.path })
          .then(p => { img.src = `folio://localhost/${encodeURIComponent(p)}`; })
          .catch(() => { img.onerror(); });
      }
      layer.appendChild(img);
    }

    if (item.isLivePhoto && item.livePhotoVideoPath) {
      const v = document.createElement('video');
      v.className = 'live-video-player';
      v.muted = true; v.loop = true; v.playsInline = true;
      v.src = `folio://localhost/${encodeURIComponent(item.livePhotoVideoPath)}`;
      layer.appendChild(v);

      const badge = document.createElement('div');
      badge.className = 'vp-live-badge';
      badge.innerHTML = `
        <svg class="live-photo-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="10"/>
          <circle cx="12" cy="12" r="6"/>
          <circle cx="12" cy="12" r="2"/>
        </svg>
        <span>LIVE</span>
      `;
      layer.appendChild(badge);

      let liveHoldTimer = null;
      const startLiveHold = () => {
        cancelLiveHold();
        liveHoldTimer = window.setTimeout(() => {
          invoke('play_live_photo_native', { videoPath: item.livePhotoVideoPath }).catch((e) => {
            console.error('Live Photo native playback:', e);
          });
        }, 450);
      };
      const cancelLiveHold = () => {
        if (liveHoldTimer) {
          window.clearTimeout(liveHoldTimer);
          liveHoldTimer = null;
        }
      };
      layer.addEventListener('pointerdown', startLiveHold);
      layer.addEventListener('pointerup', cancelLiveHold);
      layer.addEventListener('pointerleave', cancelLiveHold);
      layer.addEventListener('mouseenter', () => {
        v.play().then(() => { v.style.opacity = '1'; }).catch(() => {});
      });
      layer.addEventListener('mouseleave', () => {
        cancelLiveHold();
        v.style.opacity = '0';
        setTimeout(() => {
          if (v.style.opacity === '0') {
            v.pause();
            v.currentTime = 0;
          }
        }, 300);
      });
    }

    media.appendChild(layer);
  }

  // Update UI Chrome
  counter.textContent = `${i + 1} of ${items.length}`;
  fname.textContent = truncateDisplayName(basename(item.path), 64);
  fname.title = basename(item.path);
  dims.textContent = `${item.width} × ${item.height}`;
  badge.style.display = 'inline-block';
  badge.textContent = (item.path.split('.').pop() || '').toUpperCase();
  badge.className = `format-badge fmt-${badge.textContent.toLowerCase()}`;
  
  if (item.exif) {
    edCamera.textContent = item.exif.camera || 'Unknown Camera';
    edAperture.textContent = item.exif.aperture || '—';
    edShutter.textContent = item.exif.shutter_speed || '—';
    edIso.textContent = item.exif.iso || '—';
    edFocal.textContent = item.exif.focal_length || '—';
    if (item.exif.latitude !== undefined && item.exif.latitude !== null && item.exif.longitude !== undefined && item.exif.longitude !== null) {
      const lat = item.exif.latitude;
      const lon = item.exif.longitude;
      edGps.style.display = 'flex';
      const latRef = lat >= 0 ? 'N' : 'S';
      const lonRef = lon >= 0 ? 'E' : 'W';
      gpsChip.textContent = `${Math.abs(lat).toFixed(4)}° ${latRef}, ${Math.abs(lon).toFixed(4)}° ${lonRef}`;
      gpsChip.onclick = (e) => {
        e.stopPropagation();
        toggleGpsPopover(gpsChip, [{
          lat,
          lon,
          path: item.path,
          name: item.path.split('/').pop(),
        }]);
      };
      if (edAddress) {
        edAddress.className = 'gps-address';
        if (reverseGeocodeEnabled) {
          edAddress.classList.add('is-loading');
          edAddress.textContent = 'Looking up address…';
          reverseGeocode(lat, lon).then(addr => {
            if (items[idx]?.path !== item.path) return;
            edAddress.classList.remove('is-loading');
            if (/unavailable|disabled|failed|not found/i.test(addr)) {
              edAddress.classList.add('is-error');
            } else {
              edAddress.classList.remove('is-error');
            }
            edAddress.textContent = addr;
          }).catch(() => {
            if (items[idx]?.path === item.path) {
              edAddress.classList.remove('is-loading');
              edAddress.classList.add('is-error');
              edAddress.textContent = 'Address unavailable — check your connection';
            }
          });
        } else {
          edAddress.classList.add('is-muted');
          edAddress.textContent = 'Enable address lookup in Settings → Advanced';
        }
      }
    } else {
      edGps.style.display = 'none';
    }
    const isRaw = !['jpg','jpeg','png','webp'].includes(item.path.split('.').pop().toLowerCase());
    if (isRaw && edTechData) { edTechData.style.display = 'block'; edTechData.innerHTML = `<span>Format: ${badge.textContent}</span><span>Bit Depth: 14-bit</span>`; }
    else if (edTechData) edTechData.style.display = 'none';
  } else {
    edCamera.textContent = 'No Metadata'; edAperture.textContent = edShutter.textContent = edIso.textContent = edFocal.textContent = '—';
    edGps.style.display = 'none';
    if (edTechData) edTechData.style.display = 'none';
  }
  
  highlightThumb();
  updateViewerToolbar();
  document.querySelectorAll('.catalog-card').forEach((card) => {
    card.classList.toggle('is-focused', card.dataset.path === items[idx]?.path);
  });
  closeCropMode();
  removeEditPreview();
  triggerPreload(i);
}

function hexToHSL(hex) {
  let r = 0, g = 0, b = 0;
  if (hex.startsWith('#')) hex = hex.substring(1);
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.substring(0, 2), 16);
    g = parseInt(hex.substring(2, 4), 16);
    b = parseInt(hex.substring(4, 6), 16);
  }
  
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100)
  };
}

async function updateAdaptiveGlow(el) {
  if (!backdropGlow || !items || !items[idx]) return;
  try {
    const item = items[idx];
    if (item.is_video) {
      const color = extractDominantColor(el);
      const rgb = color.match(/\d+/g);
      if (rgb && rgb.length >= 3) {
        const r = parseInt(rgb[0]), g = parseInt(rgb[1]), b = parseInt(rgb[2]);
        const c1 = `rgba(${r}, ${g}, ${b}, 0.22)`;
        const c2 = `rgba(${g}, ${b}, ${r}, 0.16)`;
        const c3 = `rgba(${b}, ${r}, ${g}, 0.12)`;
        
        backdropGlow.style.setProperty('--glow-c1', c1);
        backdropGlow.style.setProperty('--glow-c2', c2);
        backdropGlow.style.setProperty('--glow-c3', c3);
      }
      return;
    }
    
    const colors = await invoke('get_dominant_colors', { path: item.path });
    if (colors && colors.length >= 3) {
      const hsl1 = hexToHSL(colors[0]);
      const hsl2 = hexToHSL(colors[1]);
      const hsl3 = hexToHSL(colors[2]);
      
      const c1 = `hsla(${hsl1.h}, ${hsl1.s}%, ${Math.min(50, hsl1.l)}%, 0.24)`;
      const c2 = `hsla(${hsl2.h}, ${hsl2.s}%, ${Math.min(50, hsl2.l)}%, 0.18)`;
      const c3 = `hsla(${hsl3.h}, ${hsl3.s}%, ${Math.min(50, hsl3.l)}%, 0.14)`;
      
      backdropGlow.style.setProperty('--glow-c1', c1);
      backdropGlow.style.setProperty('--glow-c2', c2);
      backdropGlow.style.setProperty('--glow-c3', c3);
    }
  } catch (e) {
    console.error("Glow generation failed:", e);
  }
}

/* ── Filmstrip ── */
const THUMB_CONCURRENCY = 4; let thumbQueue = [], thumbActive = 0, thumbMaxSide = 640;
function enqueueThumb(el, p) { thumbQueue.push({ el, path: p, retries: 0 }); processThumbQueue(); }
async function processThumbQueue() { while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length > 0) { const j = thumbQueue.shift(); thumbActive++; loadThumb(j).finally(() => { thumbActive--; processThumbQueue(); }); } }
async function loadThumb({ el, path, retries }) {
  const fallback = () => {
    const img = el.querySelector('img');
    if (img) {
      img.onload = () => img.classList.add('loaded');
      img.onerror = () => img.classList.add('loaded'); // Show something even if it fails
      img.src = `folio://localhost/${encodeURIComponent(path)}`;
    }
  };

  try {
    const tp = await invoke('get_thumbnail', { path, maxSide: thumbMaxSide });
    const u = `folio://localhost/${encodeURIComponent(tp)}?v=${mediaCacheEpoch}`;
    const img = el.querySelector('img');
    if (img) {
      img.onload = () => img.classList.add('loaded');
      img.onerror = fallback;
      img.src = u;
    }
    const v = el.querySelector('video');
    if (v) {
      v.poster = u;
      el.classList.add('loaded');
    }
    preloadedThumbs.set(path, u);
  } catch (err) {
    if (retries < 2) {
      await new Promise(r => setTimeout(r, 500));
      thumbQueue.push({ el, path, retries: retries + 1 });
    } else {
      fallback();
    }
  }
}
const obs = new IntersectionObserver((entries) => {
  for (const en of entries) { if (en.isIntersecting && !en.target.dataset.loaded) { en.target.dataset.loaded = '1'; enqueueThumb(en.target, en.target.dataset.path); obs.unobserve(en.target); } }
}, { root: filmstrip, rootMargin: '1000px 0px' });

function appendFilmstripThumb(it, i) {
    const d = document.createElement('div');
    d.className = i === idx ? 'thumb active' : 'thumb';
    d.dataset.path = it.path;
    if (i === idx) {
      FolioState.activeThumbEl = d;
    }
    d.onclick = () => show(i, i === idx ? 0 : (i > idx ? 1 : -1));
    d.oncontextmenu = (e) => showContextMenu(e, it.path, i);
    
    if (it.is_video) {
        const v = document.createElement('video');
        v.muted = true; v.loop = true; v.playsInline = true;
        d.appendChild(v);
        
        d.addEventListener('mouseenter', () => { if (!v.src) v.src = `folio://localhost/${encodeURIComponent(it.path)}`; v.play().catch(()=>{}); });
        d.addEventListener('mouseleave', () => { v.pause(); });
        
        const icon = document.createElement('div');
        icon.className = 'vid-icon-small';
        icon.innerHTML = '<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>';
        d.appendChild(icon);
    } else {
        const img = document.createElement('img'); img.crossOrigin = "anonymous"; d.appendChild(img);
        if (it.isLivePhoto) {
            const badge = document.createElement('div');
            badge.className = 'live-photo-badge';
            badge.innerHTML = `
              <svg class="live-photo-icon" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"/>
                <circle cx="12" cy="12" r="6"/>
                <circle cx="12" cy="12" r="2"/>
              </svg>
              <span>LIVE</span>
            `;
            d.appendChild(badge);
        }
    }
    
    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'thumb-tag-dots';
    d.appendChild(dotsContainer);
    
    const cachedTags = folderTagsCache.get(it.path) || [];
    cachedTags.forEach(t => {
      const dot = document.createElement('div');
      dot.className = 'thumb-tag-dot';
      dot.style.background = t.color;
      dot.title = t.name;
      dotsContainer.appendChild(dot);
    });
    
    filmstrip.appendChild(d);
    obs.observe(d);
}

function buildFilmstrip() {
  obs.disconnect();
  filmstrip.innerHTML = '';
  filmstrip.classList.toggle('grid-view', gridView);
  gridToggleBtn?.classList.toggle('active', gridView);
  if (!items.length) return;

  const CHUNK = 48;
  let at = 0;
  const step = () => {
    const end = Math.min(at + CHUNK, items.length);
    for (; at < end; at++) appendFilmstripThumb(items[at], at);
    if (at < items.length) requestAnimationFrame(step);
  };
  step();
}

function highlightThumb() {
  if (FolioState.activeThumbEl) {
    FolioState.activeThumbEl.classList.remove('active');
  }
  const targetThumb = filmstrip.children[idx];
  if (targetThumb) {
    targetThumb.classList.add('active');
    FolioState.activeThumbEl = targetThumb;
    if (filmstrip.classList.contains('viewer-filmstrip')) {
      filmstrip.scrollTo({ left: targetThumb.offsetLeft - filmstrip.clientWidth / 2 + targetThumb.clientWidth / 2, behavior: 'smooth' });
    } else {
      filmstrip.scrollTo({ top: targetThumb.offsetTop - filmstrip.clientHeight / 2 + targetThumb.clientHeight / 2, behavior: 'smooth' });
    }
  }
}

/* ── Simple Edit Engine ── */
const defaultEdit = () => ({
  brightness: 0, vibrance: 0, contrast: 0, saturation: 0, exposure: 0, warmth: 0,
  flip_h: false, flip_v: false, rotate: 0,
});

const BUILTIN_EDIT_PRESETS = [
  { id: 'neutral', name: 'Neutral', edit: defaultEdit() },
  { id: 'vivid', name: 'Vivid', edit: { ...defaultEdit(), vibrance: 28, saturation: 12, contrast: 10 } },
  { id: 'matte', name: 'Matte', edit: { ...defaultEdit(), contrast: -12, brightness: 6, saturation: -8 } },
  { id: 'warm', name: 'Warm glow', edit: { ...defaultEdit(), warmth: 35, exposure: 8, vibrance: 10 } },
  { id: 'cool', name: 'Cool film', edit: { ...defaultEdit(), warmth: -28, contrast: 8, saturation: -5 } },
  { id: 'mono', name: 'Mono punch', edit: { ...defaultEdit(), saturation: -100, contrast: 22, brightness: 4 } },
  { id: 'fade', name: 'Faded', edit: { ...defaultEdit(), contrast: -18, brightness: 10, saturation: -12 } },
  { id: 'pop', name: 'Pop', edit: { ...defaultEdit(), exposure: 12, contrast: 18, vibrance: 20 } },
];

function getCustomEditPresets() {
  try {
    return JSON.parse(localStorage.getItem('folio_edit_presets') || '[]');
  } catch {
    return [];
  }
}

function saveCustomEditPresets(list) {
  localStorage.setItem('folio_edit_presets', JSON.stringify(list));
}

function renderEditPresets() {
  const grid = $('editPresetGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const all = [...BUILTIN_EDIT_PRESETS, ...getCustomEditPresets()];
  all.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'edit-preset-chip';
    btn.textContent = preset.name;
    btn.addEventListener('click', () => {
      const base = defaultEdit();
      const merged = { ...base, ...preset.edit };
      setCurrentEdit(merged);
      loadEditForCurrent();
      setInspectorTab('adjust');
      openEditPanel();
      showToast(`Applied “${preset.name}”`);
    });
    grid.appendChild(btn);
  });
}
function getCurrentEdit() { return editMap.get(items[idx]?.path) || defaultEdit(); }
function setCurrentEdit(edit) { if (items[idx]?.path) { editMap.set(items[idx].path, edit); invoke('set_edit', { path: items[idx].path, edit }).catch(() => {}); } }

function isInspectorAdjustActive() {
  return document.getElementById('inspectorAdjust')?.classList.contains('active');
}

function isEditPreviewEnabled() {
  return editPanelOpen || adjustPreviewActive || isInspectorAdjustActive();
}

async function ensureEditSession() {
  const path = items[idx]?.path;
  if (!path || items[idx]?.is_video) return false;
  adjustPreviewActive = true;
  editPanel?.classList.add('visible');
  editPanel?.setAttribute('aria-hidden', 'false');
  if (editSessionPath !== path) {
    try {
      await invoke('prepare_edit_preview', { path });
      editSessionPath = path;
    } catch (e) {
      console.error(e);
      showToast('Could not prepare edit preview');
      return false;
    }
  }
  loadEditForCurrent();
  return true;
}

async function openEditPanel() {
  const path = items[idx]?.path; if (!path || items[idx]?.is_video) return;
  setInspectorVisible(true);
  setInspectorTab('adjust');
  editPanelOpen = true;
  adjustPreviewActive = true;
  editPanel.classList.add('visible'); editPanel.setAttribute('aria-hidden', 'false'); editToggleBtn.classList.add('active');
  if (compareBtn) compareBtn.style.display = 'inline-block';
  requestAnimationFrame(() => { if (zoom <= 1) resetZoom(); else scheduleUpdate(); });
  try {
    await invoke('prepare_edit_preview', { path });
    editSessionPath = path;
    loadEditForCurrent();
  } catch (e) { console.error(e); }
}

let cropModeActive = false;
let cropCoords = { x: 0, y: 0, w: 1, h: 1 };

function closeCropMode() {
  cropModeActive = false;
  cropBtn?.classList.remove('active');
  const overlay = document.getElementById('cropOverlay');
  if (overlay) overlay.remove();
}

function initCropOverlay() {
  const activeImg = getActiveMediaImg();
  if (!activeImg) return;
  
  let overlay = document.getElementById('cropOverlay');
  if (overlay) overlay.remove();
  
  overlay = document.createElement('div');
  overlay.id = 'cropOverlay';
  overlay.className = 'crop-overlay-container';
  
  for (let i = 1; i <= 2; i++) {
    const hLine = document.createElement('div');
    hLine.className = `crop-grid-line crop-grid-h${i}`;
    overlay.appendChild(hLine);
    
    const vLine = document.createElement('div');
    vLine.className = `crop-grid-line crop-grid-v${i}`;
    overlay.appendChild(vLine);
  }
  
  const hud = document.createElement('div');
  hud.id = 'cropHud';
  hud.className = 'crop-badge-hud';
  hud.textContent = 'Crop Area';
  overlay.appendChild(hud);
  
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  handles.forEach(h => {
    const handle = document.createElement('div');
    handle.className = `crop-handle crop-handle-${h}`;
    handle.dataset.handle = h;
    overlay.appendChild(handle);
  });
  
  const layer = media.querySelector('.media-layer.media-active');
  if (layer) {
    layer.appendChild(overlay);
    updateCropOverlayStyles(activeImg, overlay);
    setupCropEvents(activeImg, overlay);
  }
}

function getActiveMediaImg() {
  const layer = media.querySelector('.media-layer.media-active');
  return layer ? layer.querySelector('.media-content') : null;
}

function updateCropOverlayStyles(img, overlay) {
  if (!img || !overlay) return;
  const w = img.clientWidth;
  const h = img.clientHeight;
  
  const left = cropCoords.x * w;
  const top = cropCoords.y * h;
  const width = cropCoords.w * w;
  const height = cropCoords.h * h;
  
  overlay.style.left = `${img.offsetLeft + left}px`;
  overlay.style.top = `${img.offsetTop + top}px`;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  
  const activeItem = items[idx];
  if (activeItem) {
    const realW = Math.round(cropCoords.w * activeItem.width);
    const realH = Math.round(cropCoords.h * activeItem.height);
    const hud = document.getElementById('cropHud');
    if (hud) hud.textContent = `${realW} × ${realH} (${Math.round(cropCoords.w * 100)}% × ${Math.round(cropCoords.h * 100)}%)`;
  }
}

function setupCropEvents(img, overlay) {
  let isDraggingCrop = false;
  let dragStart = { x: 0, y: 0 };
  let initialCoords = { ...cropCoords };
  let activeHandle = null;
  
  const onMouseDown = (e) => {
    e.stopPropagation();
    isDraggingCrop = true;
    dragStart = { x: e.clientX, y: e.clientY };
    initialCoords = { ...cropCoords };
    
    if (e.target.classList.contains('crop-handle')) {
      activeHandle = e.target.dataset.handle;
    } else {
      activeHandle = 'move';
    }
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };
  
  const onMouseMove = (e) => {
    if (!isDraggingCrop) return;
    e.preventDefault();
    
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    
    const w = img.clientWidth;
    const h = img.clientHeight;
    
    const rdx = dx / w;
    const rdy = dy / h;
    
    let nextCoords = { ...initialCoords };
    
    if (activeHandle === 'move') {
      nextCoords.x = Math.max(0, Math.min(1 - initialCoords.w, initialCoords.x + rdx));
      nextCoords.y = Math.max(0, Math.min(1 - initialCoords.h, initialCoords.y + rdy));
    } else {
      if (activeHandle.includes('w')) {
        const newW = Math.max(0.05, initialCoords.w - rdx);
        const newX = initialCoords.x + (initialCoords.w - newW);
        if (newX >= 0) {
          nextCoords.w = newW;
          nextCoords.x = newX;
        }
      }
      if (activeHandle.includes('e')) {
        nextCoords.w = Math.max(0.05, Math.min(1 - initialCoords.x, initialCoords.w + rdx));
      }
      if (activeHandle.includes('n')) {
        const newH = Math.max(0.05, initialCoords.h - rdy);
        const newY = initialCoords.y + (initialCoords.h - newH);
        if (newY >= 0) {
          nextCoords.h = newH;
          nextCoords.y = newY;
        }
      }
      if (activeHandle.includes('s')) {
        nextCoords.h = Math.max(0.05, Math.min(1 - initialCoords.y, initialCoords.h + rdy));
      }
    }
    
    cropCoords = nextCoords;
    updateCropOverlayStyles(img, overlay);
    
    const currentEdit = getCurrentEdit();
    currentEdit.crop_x = cropCoords.x;
    currentEdit.crop_y = cropCoords.y;
    currentEdit.crop_w = cropCoords.w;
    currentEdit.crop_h = cropCoords.h;
    setCurrentEdit(currentEdit);
    
    applyEditPreview(currentEdit);
  };
  
  const onMouseUp = () => {
    isDraggingCrop = false;
    activeHandle = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
  
  overlay.addEventListener('mousedown', onMouseDown);
}

function closeEditPanel() {
  editPanelOpen = false;
  editToggleBtn.classList.remove('active');
  if (compareBtn) {
    compareBtn.style.display = 'none';
    toggleCompareMode(false);
  }
  closeCropMode();
  if (!isInspectorAdjustActive()) {
    adjustPreviewActive = false;
    editPanel.classList.remove('visible');
    editPanel.setAttribute('aria-hidden', 'true');
    removeEditPreview();
  }
  requestAnimationFrame(() => { if (zoom <= 1) resetZoom(); else scheduleUpdate(); });
}

function loadEditForCurrent() {
  const e = getCurrentEdit();
  cropCoords = {
    x: e.crop_x ?? 0,
    y: e.crop_y ?? 0,
    w: e.crop_w ?? 1,
    h: e.crop_h ?? 1
  };
  
  if (cropModeActive) {
    initCropOverlay();
  }
  
  document.querySelectorAll('.edit-slider').forEach(s => {
    const v = e[s.dataset.param] ?? 0; s.value = v;
    const valEl = s.closest('.edit-row')?.querySelector('.edit-val');
    if (valEl) valEl.textContent = Math.round(v);
  });
  flipHBtn?.classList.toggle('active', e.flip_h);
  flipVBtn?.classList.toggle('active', e.flip_v);
  if (rotateBtn) {
    rotateBtn.classList.toggle('active', e.rotate !== 0);
    rotateBtn.textContent = e.rotate !== 0 ? `Rotated ${e.rotate}°` : 'Rotate 90°';
  }
  applyEditPreview(e);
}

function removeEditPreview() { if (editPreviewImg) { editPreviewImg.remove(); editPreviewImg = null; } }

async function applyEditPreview(edit) {
  const path = items[idx]?.path; if (!path || !isEditPreviewEnabled()) return;
  const layer = media.querySelector('.media-layer.media-active'); if (!layer) return;
  clearTimeout(editDebounceTimer);
  editDebounceTimer = setTimeout(async () => {
    try {
      const b64 = await invoke('edit_image', { path, edit });
      if (!editPreviewImg) {
        editPreviewImg = document.createElement('img');
        editPreviewImg.crossOrigin = "anonymous";
        editPreviewImg.className = 'media-content edit-preview loaded';
        editPreviewImg.style.cssText = 'position:absolute;inset:0;margin:auto;z-index:2;width:100%;height:100%;object-fit:contain;pointer-events:none;';
        layer.appendChild(editPreviewImg);
      }
      editPreviewImg.src = 'data:image/jpeg;base64,' + b64;
    } catch (e) { console.error(e); }
  }, 16);
}

/* ── Interactive Listeners ── */
$('openBtn').addEventListener('click', openFolder);
$('openBtn2').addEventListener('click', openFolder);
$('prev').addEventListener('click', () => nav(-1));
$('next').addEventListener('click', () => nav(1));
$('settingsBack')?.addEventListener('click', closeSettings);
zoomSlider?.addEventListener('input', (e) => setZoom(parseInt(e.target.value) / 100, 0, 0));
zoomReset?.addEventListener('click', resetZoom);
fullscreenBtn?.addEventListener('click', toggleFullscreen);

sidebarToggle.addEventListener('click', () => {
  const visible = sidebar.style.display !== 'none';
  sidebar.style.display = visible ? 'none' : 'flex';
  sidebarToggle.classList.toggle('active', !visible);
  sidebarToggle.classList.toggle('sidebar-closed', visible);
  sidebarToggle.textContent = !visible ? 'Close' : 'Sidebar';
  requestAnimationFrame(() => { if (zoom > 1) scheduleUpdate(); else resetZoom(); });
});

inspectorCollapseBtn?.addEventListener('click', () => {
  setInspectorVisible(!inspectorPaneVisible);
});

$('saveEditPresetBtn')?.addEventListener('click', () => {
  const name = prompt('Preset name');
  if (!name?.trim()) return;
  const custom = getCustomEditPresets();
  custom.push({ id: `custom-${Date.now()}`, name: name.trim(), edit: { ...getCurrentEdit() } });
  saveCustomEditPresets(custom.slice(-12));
  renderEditPresets();
  showToast(`Saved preset “${name.trim()}”`);
});

document.querySelectorAll('.inspector-tab').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const tab = btn.dataset.inspector;
    setInspectorTab(tab);
    if (tab === 'adjust') await ensureEditSession();
    else if (!editPanelOpen) {
      adjustPreviewActive = false;
      removeEditPreview();
    }
    if (tab === 'info' && items[idx]) {
      const img = getActiveImage();
      if (img?.complete) drawDominantColors(items[idx]);
      else img?.addEventListener('load', () => drawDominantColors(items[idx]), { once: true });
    }
  });
});

document.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => applyNavFilter(btn.dataset.nav));
});

$('setDefaultAppBtn')?.addEventListener('click', () => bindDefaultAppAction('setDefault', $('setDefaultAppBtn')));
$('openWithHelpBtn')?.addEventListener('click', () => bindDefaultAppAction('manual', $('openWithHelpBtn')));

resetOnboardingBtn?.addEventListener('click', () => {
  resetOnboarding();
  welcome.classList.remove('hidden');
  setAppShellVisible(false);
  initOnboarding({
    onOpenFolder: () => openFolder(),
    onComplete: () => welcome.classList.remove('hidden'),
    onSkip: () => welcome.classList.remove('hidden'),
    onBindDefaultApp: (action, btn) => bindDefaultAppAction(action, btn),
  });
  showToast('Replay onboarding');
});

document.addEventListener('folio-theme-change', (e) => {
  if (themeSelect) themeSelect.value = e.detail;
  applyTheme(e.detail);
});

document.addEventListener('folio-vibrancy-change', (e) => {
  if (vibrancyCheck) vibrancyCheck.checked = e.detail;
  invoke('set_window_vibrancy', { enabled: e.detail }).catch(() => {});
});

async function bindDefaultAppAction(action, buttonEl) {
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Working…';
  }
  try {
    if (action === 'setDefault') {
      const result = await invoke('set_default_media_handler');
      showToast(result.message);
    } else {
      await invoke('show_file_open_with_help', { samplePath: items[idx]?.path || null });
      showToast('In Finder: choose Folio, then Change All… to set the default.');
    }
  } catch (err) {
    showToast(String(err));
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = action === 'setDefault'
        ? 'Set Folio as default for photos & videos'
        : 'Show Finder “Open with” steps…';
    }
  }
}

if (!isOnboardingComplete()) {
  initOnboarding({
    onOpenFolder: () => openFolder(),
    onComplete: () => welcome.classList.remove('hidden'),
    onSkip: () => welcome.classList.remove('hidden'),
    onBindDefaultApp: (action, btn) => bindDefaultAppAction(action, btn),
  });
}

(async () => {
  try {
    const pending = await invoke('drain_pending_open_paths');
    const last = pending?.length ? pending[pending.length - 1] : null;
    if (last) await openMediaFromPath(last);
  } catch (e) {
    console.warn('Pending open paths:', e);
  }
})();

gridToggleBtn?.addEventListener('click', () => {
  toggleCatalogView(!catalogModeActive);
});

sidebarCatalogBtn?.addEventListener('click', () => {
  toggleCatalogView(!catalogModeActive);
});

let duplicateGroupsCache = null;
let duplicateKeeperPaths = new Set();

catalogDuplicatesBtn?.addEventListener('click', async () => {
  if (!items || items.length === 0) return;
  if (duplicateGroupsCache) {
    duplicateGroupsCache = null;
    duplicateKeeperPaths.clear();
    catalogDuplicatesBtn.classList.remove('active');
    buildCatalogContent();
    return;
  }
  
  catalogDuplicatesBtn.textContent = '⏳ Analyzing...';
  catalogDuplicatesBtn.style.pointerEvents = 'none';
  showToast('Computing perceptual hashes for the catalog...');
  
  try {
    const paths = items.map(i => i.path);
    const groups = await invoke('find_visual_duplicates', { paths });
    
    if (groups.length === 0) {
      showToast('No visual duplicates found!');
    } else {
      showToast(`Found ${groups.length} group(s) of visual duplicates.`);
      const colors = ['#E55E5E', '#4FA8EE', '#5BC2A8', '#D4A72C', '#AB6BFA', '#EE4F92'];
      duplicateGroupsCache = new Map();
      
      duplicateKeeperPaths.clear();
      groups.forEach((group, index) => {
        const color = colors[index % colors.length];
        const { keeperPath } = analyzeDuplicateGroup(group, items, mediaAttributesCache);
        if (keeperPath) duplicateKeeperPaths.add(keeperPath);
        group.forEach(p => {
          duplicateGroupsCache.set(p, color);
        });
      });
      
      items.sort((a, b) => {
        const aHas = duplicateGroupsCache.has(a.path);
        const bHas = duplicateGroupsCache.has(b.path);
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        return 0;
      });
      
      catalogDuplicatesBtn.classList.add('active');
      openDuplicateResolver(groups);
      buildCatalogContent();
    }
  } catch (e) {
    showToast(`Failed to analyze duplicates: ${e}`);
  } finally {
    catalogDuplicatesBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg> Find Duplicates';
    catalogDuplicatesBtn.style.pointerEvents = 'auto';
  }
});

window.openGeotaggedImage = (path) => {
  const index = items.findIndex(it => it.path === path);
  if (index !== -1) {
    closeGpsPopover();
    navTo(index);
  }
};

catalogMapBtn?.addEventListener('click', () => {
  const geotagged = items.filter(it => it.exif?.latitude && it.exif?.longitude).map(it => ({
    lat: it.exif.latitude, lon: it.exif.longitude, path: it.path, name: it.path.split(/[\/\\]/).pop()
  }));
  if (geotagged.length === 0) {
    showToast('No geotagged media found in this folder.');
    return;
  }
  toggleGpsPopover(catalogMapBtn, geotagged);
});

// Duplicates Resolver (UX-6)
let currentDupGroupIndex = 0;
let dupGroupsData = [];

window.openDuplicateResolver = (groups) => {
  dupGroupsData = groups;
  currentDupGroupIndex = 0;
  let modal = document.getElementById('duplicateResolverModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'duplicateResolverModal';
    modal.className = 'dup-resolver-overlay';
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDuplicateResolver();
    });
    document.body.appendChild(modal);
  }
  modal.classList.add('is-open');
  renderDuplicateGroup();
};

window.closeDuplicateResolver = () => {
  const modal = document.getElementById('duplicateResolverModal');
  if (modal) modal.classList.remove('is-open');
};

window.renderDuplicateGroup = () => {
  const modal = document.getElementById('duplicateResolverModal');
  if (!modal) return;
  if (currentDupGroupIndex >= dupGroupsData.length) {
    closeDuplicateResolver();
    showToast('Finished reviewing all duplicate groups.');
    return;
  }

  const groupPaths = dupGroupsData[currentDupGroupIndex];
  const { scored, keeperPath, keeperReason } = analyzeDuplicateGroup(groupPaths, items, mediaAttributesCache);

  const dialog = document.createElement('div');
  dialog.className = 'dup-resolver-dialog';
  dialog.addEventListener('click', (e) => e.stopPropagation());

  const header = document.createElement('header');
  header.className = 'dup-resolver-header';
  header.innerHTML = `
    <div>
      <h2 class="dup-resolver-title">Resolve duplicates</h2>
      <p class="dup-resolver-meta">Group ${currentDupGroupIndex + 1} of ${dupGroupsData.length} · ${groupPaths.length} similar files</p>
    </div>`;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'catalog-btn dup-resolver-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeDuplicateResolver);
  header.appendChild(closeBtn);

  const keeperBanner = document.createElement('div');
  keeperBanner.className = 'dup-resolver-keeper-banner';
  keeperBanner.innerHTML = `
    <span class="dup-resolver-keeper-badge">Recommended keep</span>
    <span class="dup-resolver-keeper-reason">${keeperReason}</span>`;

  const grid = document.createElement('div');
  grid.className = 'dup-resolver-grid';

  scored.forEach((entry) => {
    const { path, item } = entry;
    const isKeeper = path === keeperPath;
    const name = path.split(/[/\\]/).pop();
    const sz = entry.size > 0 ? `${(entry.size / 1024 / 1024).toFixed(2)} MB` : '—';
    const dims = item?.width && item?.height ? `${item.width}×${item.height}` : '';

    const card = document.createElement('article');
    card.className = 'dup-resolver-card' + (isKeeper ? ' is-keeper' : ' is-alt');

    if (isKeeper) {
      const badge = document.createElement('span');
      badge.className = 'dup-resolver-card-badge';
      badge.textContent = 'Keep this one';
      card.appendChild(badge);
    } else {
      const badge = document.createElement('span');
      badge.className = 'dup-resolver-card-badge dup-resolver-card-badge--muted';
      badge.textContent = 'Consider removing';
      card.appendChild(badge);
    }

    const img = document.createElement('img');
    img.src = `folio://localhost/${encodeURIComponent(path)}`;
    img.alt = name;
    img.loading = 'lazy';

    const info = document.createElement('div');
    info.className = 'dup-resolver-card-info';
    info.innerHTML = `<div class="dup-resolver-card-name" title="${name}">${name}</div>
      <div class="dup-resolver-card-meta">${sz}${dims ? ` · ${dims}` : ''}</div>`;

    const actions = document.createElement('div');
    actions.className = 'dup-resolver-card-actions';
    const finderBtn = document.createElement('button');
    finderBtn.type = 'button';
    finderBtn.className = 'catalog-btn';
    finderBtn.textContent = 'Finder';
    finderBtn.addEventListener('click', () => openPathInFinder(path, true));
    const trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    trashBtn.className = 'catalog-btn dup-resolver-trash';
    trashBtn.textContent = 'Trash';
    trashBtn.addEventListener('click', () => trashDuplicate(path));
    actions.append(finderBtn, trashBtn);

    card.append(img, info, actions);
    grid.appendChild(card);
  });

  const footer = document.createElement('footer');
  footer.className = 'dup-resolver-footer';
  footer.innerHTML = '<span class="dup-resolver-hint">Keep the highlighted file; trash extras you do not need.</span>';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'catalog-btn dup-resolver-next';
  nextBtn.textContent = currentDupGroupIndex < dupGroupsData.length - 1 ? 'Next group →' : 'Done';
  nextBtn.addEventListener('click', () => { currentDupGroupIndex++; renderDuplicateGroup(); });
  footer.appendChild(nextBtn);

  dialog.append(header, keeperBanner, grid, footer);
  modal.innerHTML = '';
  modal.appendChild(dialog);
};

window.trashDuplicate = async (path) => {
  try {
    await invoke('delete_physical_file', { path });
    showToast(`Trashed ${path.split(/[\/\\]/).pop()}`);
    
    // Remove from data
    const group = dupGroupsData[currentDupGroupIndex];
    dupGroupsData[currentDupGroupIndex] = group.filter(p => p !== path);
    items = items.filter(it => it.path !== path);
    
    // Refresh the sidebar filmstrip and catalog grid
    buildFilmstrip();
    if (catalogModeActive) buildCatalogContent();
    
    // If only one left in group, auto-advance
    if (dupGroupsData[currentDupGroupIndex].length < 2) {
      currentDupGroupIndex++;
      renderDuplicateGroup();
    } else {
      renderDuplicateGroup();
    }
  } catch(e) {
    showToast(`Failed to trash: ${e}`);
  }
};

catalogNewFolderBtn?.addEventListener('click', () => {
  showNewFolderModal();
});

catalogFinderBtn?.addEventListener('click', openCurrentFolderInFinder);

smartFilterSelect?.addEventListener('change', () => {
  activeSmartFilter = smartFilterSelect.value;
  applyFilters();
});

saveSmartAlbumBtn?.addEventListener('click', async () => {
  const name = prompt('Smart album name:', activeSmartFilter ? `Smart ${activeSmartFilter}` : 'Current Smart Filter');
  if (!name) return;
  const filter = {
    tags: activeTagFilter ? [activeTagFilter] : [],
    rating_min: activeSmartFilter === 'rated' ? 3 : null,
    favorite: activeSmartFilter === 'favorites' ? true : null,
    formats: activeSmartFilter === 'raw' ? ['raw', 'heic', 'tiff'] : [],
    has_gps: activeSmartFilter === 'gps' ? true : null,
    camera: null,
    date_range: null,
    size_range: null
  };
  try {
    await invoke('save_smart_album', { name, filter });
    showToast(`Saved smart album "${name}"`);
  } catch (e) {
    showToast(`Smart album failed: ${e}`);
  }
});

catalogCloseBtn?.addEventListener('click', () => {
  toggleCatalogView(false);
});

let isResizingSidebar = false;
let isResizingExif = false;

// Sidebar Resizer using setPointerCapture
if (sidebarResizer) {
  sidebarResizer.addEventListener('pointerdown', (e) => {
    isResizingSidebar = true;
    sidebarResizer.setPointerCapture(e.pointerId);
    sidebarResizer.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
  });
  sidebarResizer.addEventListener('pointermove', (e) => {
    if (!isResizingSidebar) return;
    const newWidth = Math.min(450, Math.max(180, e.clientX));
    document.documentElement.style.setProperty('--sidebar-w', `${newWidth}px`);
  });
  sidebarResizer.addEventListener('pointerup', (e) => {
    if (isResizingSidebar) {
      isResizingSidebar = false;
      sidebarResizer.releasePointerCapture(e.pointerId);
      sidebarResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    }
  });
  sidebarResizer.addEventListener('pointercancel', (e) => {
    if (isResizingSidebar) {
      isResizingSidebar = false;
      sidebarResizer.releasePointerCapture(e.pointerId);
      sidebarResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    }
  });
}

// Editorial EXIF overlay resizer using setPointerCapture
if (editorialResizer) {
  editorialResizer.addEventListener('pointerdown', (e) => {
    isResizingExif = true;
    editorialResizer.setPointerCapture(e.pointerId);
    editorialResizer.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
  });
  editorialResizer.addEventListener('pointermove', (e) => {
    if (!isResizingExif) return;
    const rect = edOverlay.getBoundingClientRect();
    const newWidth = Math.min(600, Math.max(220, e.clientX - rect.left));
    edOverlay.style.width = `${newWidth}px`;
  });
  editorialResizer.addEventListener('pointerup', (e) => {
    if (isResizingExif) {
      isResizingExif = false;
      editorialResizer.releasePointerCapture(e.pointerId);
      editorialResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    }
  });
  editorialResizer.addEventListener('pointercancel', (e) => {
    if (isResizingExif) {
      isResizingExif = false;
      editorialResizer.releasePointerCapture(e.pointerId);
      editorialResizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    }
  });
}

editToggleBtn.addEventListener('click', () => { if (editPanelOpen) closeEditPanel(); else openEditPanel(); });
editCloseBtn?.addEventListener('click', closeEditPanel);
editResetBtn.addEventListener('click', () => { const p = items[idx]?.path; if (!p) return; editMap.set(p, defaultEdit()); loadEditForCurrent(); showToast('Edit reset'); });

flipHBtn.addEventListener('click', () => { const e = getCurrentEdit(); e.flip_h = !e.flip_h; setCurrentEdit(e); loadEditForCurrent(); });
rotateBtn.addEventListener('click', () => { const e = getCurrentEdit(); e.rotate = (e.rotate + 90) % 360; setCurrentEdit(e); loadEditForCurrent(); });
flipVBtn.addEventListener('click', () => { const e = getCurrentEdit(); e.flip_v = !e.flip_v; setCurrentEdit(e); loadEditForCurrent(); });
cropBtn.addEventListener('click', () => {
  cropModeActive = !cropModeActive;
  cropBtn.classList.toggle('active', cropModeActive);
  if (cropModeActive) {
    initCropOverlay();
  } else {
    const overlay = document.getElementById('cropOverlay');
    if (overlay) overlay.remove();
  }
});

function generateWatermarkPayload() {
  if (!activeWatermark || activeWatermark.trim() === '') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = Math.max(12, Math.min(72, activeWatermarkFont)) * (activeWatermarkScale / 100);
  ctx.font = `bold ${fontSize}px "Georgia", serif`;
  const text = activeWatermark.trim();
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width + 40);
  canvas.height = Math.ceil(fontSize + 40);
  ctx.font = `bold ${fontSize}px "Georgia", serif`;
  ctx.fillStyle = `rgba(255, 255, 255, ${activeWatermarkOpacity / 100})`;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 4;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, canvas.height / 2);
  const dataURL = canvas.toDataURL('image/png');
  const b64 = dataURL.split(',')[1];
  const binaryString = window.atob(b64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return Array.from(bytes);
}

editExportBtn?.addEventListener('click', async () => {
  const p = items[idx]?.path; if (!p) return;
  try {
    const dest = await save({ defaultPath: p.replace(/(\.[^.]+)$/, '_edited$1'), filters: [{ name: 'Image', extensions: ['jpg', 'jpeg', 'png', 'tiff'] }] });
    if (dest) { 
      const watermarkPayload = generateWatermarkPayload();
      await invoke('export_edited', { path: p, dest, stripMetadata: stripMetadataEnabled, watermark: watermarkPayload, watermarkAnchor: activeWatermarkAnchor }); 
      showToast('Exported successfully'); 
    }
  } catch (e) { showToast('Export failed'); }
});

function bindEditSliders() {
  document.querySelectorAll('.edit-slider').forEach((s) => {
    if (s.dataset.bound === '1') return;
    s.dataset.bound = '1';
    const endSliderDrag = () => { FolioState.isSliderActive = false; };
    s.addEventListener('pointerdown', () => {
      FolioState.isSliderActive = true;
      ensureEditSession();
    });
    s.addEventListener('pointerup', endSliderDrag);
    s.addEventListener('pointercancel', endSliderDrag);
    s.addEventListener('input', () => {
      const val = parseFloat(s.value);
      const valEl = s.closest('.edit-row')?.querySelector('.edit-val');
      if (valEl) valEl.textContent = Math.round(val);
      const edit = getCurrentEdit();
      edit[s.dataset.param] = val;
      setCurrentEdit(edit);
      applyEditPreview(edit);
    });
  });
}
bindEditSliders();

/* ── Global Handlers ── */
function modifierActive(e, mod) {
  if (mod === 'Shift') return e.shiftKey || e.getModifierState?.('Shift') === true;
  if (mod === 'Control' || mod === 'Ctrl') return e.ctrlKey || e.getModifierState?.('Control') === true;
  if (mod === 'Alt' || mod === 'Option') return e.altKey || e.getModifierState?.('Alt') === true;
  if (mod === 'Meta' || mod === 'Cmd' || mod === 'Command') return e.metaKey || e.getModifierState?.('Meta') === true;
  const prop = mod.toLowerCase() + 'Key';
  return !!e[prop];
}

function isZoomModifierDown(e) {
  return modifierActive(e, keybinds.modifierZoom || 'Shift');
}

/** Scale wheel deltas so mouse notches and trackpad gestures feel similar. */
function wheelDeltaForZoom(e) {
  let dy;
  let dx;
  switch (e.deltaMode) {
    case 1: // DOM_DELTA_LINE — typical mouse wheel
      dy = e.deltaY * 48;
      dx = e.deltaX * 48;
      break;
    case 2: // DOM_DELTA_PAGE
      dy = e.deltaY * 320;
      dx = e.deltaX * 320;
      break;
    default: // DOM_DELTA_PIXEL — trackpad
      dy = e.deltaY;
      dx = e.deltaX;
      break;
  }
  const shiftHeld = e.shiftKey || e.getModifierState?.('Shift');
  if (shiftHeld) {
    if (Math.abs(dx) > Math.abs(dy) * 0.35) return -dx;
    return dy;
  }
  if (Math.abs(dy) >= Math.abs(dx)) return dy;
  return -dx;
}

function isViewerWheelTarget(e) {
  if (!viewer || viewer.style.display === 'none') return false;
  const t = e.target;
  if (!t || !(t instanceof Node)) return false;
  return viewer.contains(t);
}

function isMediaWheelTarget(e) {
  if (!media) return false;
  const t = e.target;
  if (!t || !(t instanceof Node)) return false;
  return media.contains(t) || t === media;
}

function isFilmstripWheelTarget(e) {
  return !!e.target?.closest?.('.filmstrip');
}

initZoomController({
  getZoom: () => zoom,
  setZoom: (level, cx, cy, opts) => setZoom(level, cx, cy, opts),
  getZoomSens: () => zoomSens,
});

function handleViewerWheel(e) {
  if (!items.length || catalogModeActive || !isViewerWheelTarget(e)) return;
  if (!media) return;

  const wantsZoom = (e.ctrlKey || e.metaKey) || isZoomModifierDown(e);
  const onFilmstrip = isFilmstripWheelTarget(e);
  const onMedia = isMediaWheelTarget(e);

  if (!wantsZoom) {
    if (onFilmstrip) return;
    if (zoom > 1 && onMedia) {
      e.preventDefault();
      panX -= e.deltaX;
      panY -= e.deltaY;
      scheduleUpdate();
    }
    return;
  }

  const delta = wheelDeltaForZoom(e);
  if (!delta) return;

  const rect = media.getBoundingClientRect();
  const focalX = e.clientX - (rect.left + rect.width / 2);
  const focalY = e.clientY - (rect.top + rect.height / 2);

  e.preventDefault();
  e.stopPropagation();
  queueWheelZoom(delta, focalX, focalY);
}

window.addEventListener('wheel', handleViewerWheel, { passive: false, capture: true });

media.addEventListener('mousedown', async (e) => {
  if (zoom <= 1 && e.button === 0) {
    if (e.target.closest('video') || e.target.closest('#viewerToolbar')) return;
    e.preventDefault();
    getCurrentWindow().startDragging();
    return;
  }
  if (zoom > 1) { isDragging = true; startX = e.clientX - panX; startY = e.clientY - panY; }
});
window.addEventListener('mousemove', (e) => { if (isDragging) { panX = e.clientX - startX; panY = e.clientY - startY; scheduleUpdate(); } });
window.addEventListener('mouseup', () => isDragging = false);
media.addEventListener('dblclick', (e) => { if (zoom > 1) resetZoom(); else { const r = media.getBoundingClientRect(); setZoom(2.5, e.clientX - r.left - r.width/2, e.clientY - r.top - r.height/2); } });
media.addEventListener('contextmenu', (e) => {
  if (items && items.length > 0) {
    showContextMenu(e, items[idx].path, idx);
  }
});

// Intercept browser zoom keys at the capture phase to prevent zoom and resize catalog grid (FE-11)
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey) {
    if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') {
      e.preventDefault();
      e.stopPropagation();
      if (catalogModeActive) {
        gridThumbSize = Math.min(400, gridThumbSize + 20);
        localStorage.setItem('folio_grid_thumb_size', gridThumbSize);
        document.documentElement.style.setProperty('--grid-thumb-size', `${gridThumbSize}px`);
      }
    } else if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      e.stopPropagation();
      if (catalogModeActive) {
        gridThumbSize = Math.max(80, gridThumbSize - 20);
        localStorage.setItem('folio_grid_thumb_size', gridThumbSize);
        document.documentElement.style.setProperty('--grid-thumb-size', `${gridThumbSize}px`);
      }
    }
  }
}, true);

window.addEventListener('keydown', (e) => {
    if (['input', 'textarea', 'select'].includes((e.target?.tagName || '').toLowerCase())) return;
    
    const key = e.key;
    const keyLower = key.toLowerCase();
    
    if (keyLower === 'c' && editPanelOpen) {
      e.preventDefault();
      compareBtn?.click();
      return;
    }
    
    if (key === 'Escape' && settingsPage?.style.display !== 'none') {
      closeSettings();
      return;
    }

    if (catalogModeActive) {
      if (key === 'Escape') {
        toggleCatalogView(false);
        return;
      }
    }
    
    const matchesKey = (bindVal) => {
      if (!bindVal) return false;
      return keyLower === bindVal.toLowerCase() || key === bindVal;
    };
    
    if (matchesKey(keybinds.nextImage)) nav(1);
    else if (matchesKey(keybinds.prevImage)) nav(-1);
    else if (matchesKey(keybinds.playVideo)) {
      if (toggleVideoPlayback()) e.preventDefault();
    }
    else if (matchesKey(keybinds.editMode)) editToggleBtn.click();
    else if (matchesKey(keybinds.addTag)) { e.preventDefault(); showTagPill(); }
    else if (matchesKey(keybinds.toggleMetadata)) {
        overlayVisible = !overlayVisible;
        if (overlayVisible) {
            setInspectorVisible(true);
            setInspectorTab('info');
            drawHistogram(getActiveImage());
            drawDominantColors(items[idx]);
        }
    }
    else if (matchesKey(keybinds.toggleFullscreen)) toggleFullscreen();
    else if (matchesKey(keybinds.toggleSidebar)) sidebarToggle.click();
    else if (matchesKey(keybinds.toggleZen)) toggleZenMode();
    else if (matchesKey(keybinds.toggleCatalog)) { e.preventDefault(); toggleCatalogView(!catalogModeActive); }
    else if (matchesKey(keybinds.resetZoom)) resetZoom();
    else if (matchesKey(keybinds.goHome)) { e.preventDefault(); goHome(); }
    else if (key === 'Backspace' || key === 'Delete') {
      if (items && items.length > 0) {
        e.preventDefault();
        showDeleteConfirmation(items[idx].path, idx);
      }
    }
});

/* ── Drag & Drop ── */
window.addEventListener('dragenter', (e) => e.preventDefault());
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

getCurrentWebview().onDragDropEvent(async (event) => {
  const { type, paths } = event.payload;
  if (type === 'enter' || type === 'over') {
    dropzoneGlow?.classList.add('active');
  } else if (type === 'leave') {
    dropzoneGlow?.classList.remove('active');
  } else if (type === 'drop') {
    dropzoneGlow?.classList.remove('active');
    if (!paths?.length) return;
    try {
      const p = await invoke('open_specific_folder', { path: paths[0] });
      await invoke('add_recent_folder', { path: paths[0] });
      renderHomeHub();
      loadFolderData(p);
    } catch (err) { console.error(err); }
  }
});

/* ── Histogram & Utilities ── */
function sortItems() {
  const rects = new Map();
  document.querySelectorAll('.thumb').forEach(t => {
    const path = t.dataset.path;
    if (path) rects.set(path, t.getBoundingClientRect());
  });

  if (currentSort === 'date') {
    items.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  } else if (currentSort === 'size') {
    items.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else {
    items.sort((a, b) => a.path.localeCompare(b.path));
  }
  
  buildFilmstrip();

  const newThumbs = document.querySelectorAll('.thumb');
  newThumbs.forEach(t => {
    const path = t.dataset.path;
    if (path && rects.has(path)) {
      const prevRect = rects.get(path);
      const currentRect = t.getBoundingClientRect();
      const dx = prevRect.left - currentRect.left;
      const dy = prevRect.top - currentRect.top;
      if (dx !== 0 || dy !== 0) {
        t.style.transition = 'none';
        t.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      }
    }
  });

  document.body.offsetHeight; // force reflow

  newThumbs.forEach(t => {
    const path = t.dataset.path;
    if (path && rects.has(path)) {
      t.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.45s ease';
      t.style.transform = 'translate3d(0, 0, 0)';
      t.addEventListener('transitionend', () => {
        t.style.transition = '';
        t.style.transform = '';
      }, { once: true });
    }
  });
}
const histogramCanvas = $('histogramCanvas'), histCtx = histogramCanvas?.getContext('2d'), histSample = document.createElement('canvas'), histSampleCtx = histSample.getContext('2d', { willReadFrequently: true });
const waveformCanvas = $('waveformCanvas'), waveCtx = waveformCanvas?.getContext('2d');
histSample.width = 256; histSample.height = 256;
function clearHistogram() { 
  if (histCtx) histCtx.clearRect(0, 0, histogramCanvas.width, histogramCanvas.height); 
  if (waveCtx) waveCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
}

let currentHistogramTaskId = 0;
function drawHistogram(imgEl) {
  if (!histCtx || !imgEl) return;
  const W = histogramCanvas.width, H = histogramCanvas.height;
  try {
    histSampleCtx.drawImage(imgEl, 0, 0, 256, 256);
  } catch (e) {
    return;
  }
  const imgData = histSampleCtx.getImageData(0, 0, 256, 256);
  const taskId = ++currentHistogramTaskId;

  analysisWorker.onmessage = function(e) {
    if (taskId !== currentHistogramTaskId) return;
    const { rB, gB, bB, lB, peak, waveR, waveG, waveB, waveCols, waveBuckets } = e.data;
    histCtx.clearRect(0, 0, W, H);
    const drawC = (buckets, color) => {
      histCtx.beginPath();
      histCtx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        histCtx.lineTo((i/255)*W, H - (buckets[i]/peak)*H);
      }
      histCtx.lineTo(W, H);
      histCtx.fillStyle = color;
      histCtx.fill();
    };
    drawC(rB, 'rgba(255,75,75,0.4)');
    drawC(gB, 'rgba(75,210,100,0.4)');
    drawC(bB, 'rgba(75,130,255,0.4)');
    drawC(lB, 'rgba(255,255,255,0.65)');

    if (waveCtx && waveR) {
      const wW = waveformCanvas.width;
      const wH = waveformCanvas.height;
      waveCtx.clearRect(0, 0, wW, wH);
      
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = waveCols;
      tempCanvas.height = waveBuckets;
      const tempCtx = tempCanvas.getContext('2d');
      const tempImgData = tempCtx.createImageData(waveCols, waveBuckets);
      const data = tempImgData.data;
      
      let maxWaveVal = 1;
      const totalLen = waveCols * waveBuckets;
      for (let i = 0; i < totalLen; i++) {
        if (waveR[i] > maxWaveVal) maxWaveVal = waveR[i];
        if (waveG[i] > maxWaveVal) maxWaveVal = waveG[i];
        if (waveB[i] > maxWaveVal) maxWaveVal = waveB[i];
      }
      
      for (let i = 0; i < totalLen; i++) {
        const rCount = waveR[i];
        const gCount = waveG[i];
        const bCount = waveB[i];
        
        const valR = Math.sqrt(rCount / maxWaveVal);
        const valG = Math.sqrt(gCount / maxWaveVal);
        const valB = Math.sqrt(bCount / maxWaveVal);
        
        const idx = i * 4;
        data[idx] = Math.min(255, Math.floor(valR * 255 * 1.5));     // Red
        data[idx+1] = Math.min(255, Math.floor(valG * 255 * 1.5));   // Green
        data[idx+2] = Math.min(255, Math.floor(valB * 255 * 1.5));   // Blue
        const maxVal = Math.max(valR, valG, valB);
        data[idx+3] = Math.min(255, Math.floor(maxVal * 255 * 1.8)); // Alpha
      }
      
      tempCtx.putImageData(tempImgData, 0, 0);
      
      waveCtx.imageSmoothingEnabled = true;
      waveCtx.imageSmoothingQuality = 'high';
      waveCtx.drawImage(tempCanvas, 0, 0, wW, wH);
      
      waveCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      waveCtx.lineWidth = 1;
      waveCtx.setLineDash([4, 4]);
      const lines = [wH * 0.25, wH * 0.5, wH * 0.75];
      lines.forEach(y => {
        waveCtx.beginPath();
        waveCtx.moveTo(0, y);
        waveCtx.lineTo(wW, y);
        waveCtx.stroke();
      });
      waveCtx.setLineDash([]);
    }
  };

  analysisWorker.postMessage({ data: imgData.data }, [imgData.data.buffer]);
}

async function drawDominantColors(item) {
  const container = document.getElementById('paletteChips');
  if (!container) return;
  
  const chips = container.querySelectorAll('.palette-chip');
  chips.forEach(chip => {
    chip.style.display = 'none';
  });

  if (!item || !item.path) return;
  
  try {
    const colors = await invoke('get_dominant_colors', { path: item.path });
    colors.forEach((color, i) => {
      if (i >= chips.length) return;
      const chip = chips[i];
      chip.style.display = 'block';
      chip.style.background = color;
      chip.setAttribute('data-tooltip', `Copy: ${color}`);
      
      chip.onmouseenter = () => {
        chip.style.transform = 'scale(1.25)';
        chip.style.boxShadow = `0 0 6px ${color}`;
      };
      chip.onmouseleave = () => {
        chip.style.transform = 'scale(1)';
        chip.style.boxShadow = 'none';
      };
      
      chip.onclick = async (e) => {
        e.stopPropagation();
        if (activeColorFilter === color) {
          activeColorFilter = null;
          chip.style.transform = 'scale(1)';
          chip.style.borderColor = 'rgba(255,255,255,0.25)';
        } else {
          activeColorFilter = color;
          chips.forEach(c => c.style.borderColor = 'rgba(255,255,255,0.25)');
          chip.style.borderColor = '#fff';
          chip.style.transform = 'scale(1.25)';
          
          if (Object.keys(folderDominantColorsCache).length === 0) {
            folderDominantColorsCache = await invoke('get_folder_dominant_colors', { paths: items.map(it => it.path) });
          }
        }
        applyFilters();
      };
    });
  } catch (e) {
    console.error('Failed to get dominant colors:', e);
  }
}

function extractDominantColor(imgEl) {
  try {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const ctx = c.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, 64, 64);
    const d = ctx.getImageData(0,0,64,64).data;
    let r=0,g=0,b=0;
    for (let i=0; i<d.length; i+=4) { r+=d[i]; g+=d[i+1]; b+=d[i+2]; }
    const count = d.length / 4;
    return `rgba(${Math.floor(r/count)}, ${Math.floor(g/count)}, ${Math.floor(b/count)}, 0.3)`;
  } catch (e) { return 'rgba(255,255,255,0.05)'; }
}

/* ── Init ── */
applyTheme(currentTheme);
initHomeScroll();
renderHomeHub();
renderEditPresets();
listen('menu-open-folder', openFolder);
listen('menu-open-in-finder', openCurrentFolderInFinder);
listen('menu-settings', openSettings);
listen('folio-open-path', async (event) => {
  const filePath = event?.payload;
  if (filePath) await openMediaFromPath(filePath);
});

document.addEventListener('folio-pref-change', (e) => {
  const { key, value } = e.detail || {};
  if (key === 'high_contrast') {
    highContrastEnabled = value;
    localStorage.setItem('folio_high_contrast', value);
    document.body.classList.toggle('high-contrast', value);
    if (highContrastCheck) highContrastCheck.checked = value;
  } else if (key === 'reduced_motion') {
    reducedMotionEnabled = value;
    localStorage.setItem('folio_reduced_motion', value);
    document.body.classList.toggle('prefers-reduced-motion', value);
    if (reducedMotionCheck) reducedMotionCheck.checked = value;
  } else if (key === 'cinematic') {
    cinematicEnabled = value;
    localStorage.setItem('folio_cinematic', value);
    if (cinematicCheck) cinematicCheck.checked = value;
  } else if (key === 'sort') {
    currentSort = value;
    localStorage.setItem('folio_sort', value);
    if (sortSelect) sortSelect.value = value;
    sortItems();
    if (items.length) buildFilmstrip();
  } else if (key === 'show_recents') {
    showRecentFolders = value;
    localStorage.setItem('folio_show_recents', value);
    if (recentFoldersCheck) recentFoldersCheck.checked = value;
    renderHomeHub();
  } else if (key === 'prefetch') {
    prefetchEnabled = value;
    localStorage.setItem('folio_prefetch_enabled', value);
    if (prefetchCheck) prefetchCheck.checked = value;
  } else if (key === 'strip_metadata') {
    stripMetadataEnabled = value;
    localStorage.setItem('folio_strip_metadata', value);
    if (stripMetadataCheck) stripMetadataCheck.checked = value;
  } else if (key === 'sound_volume') {
    soundVolume = value;
    localStorage.setItem('folio_sound_volume', value);
    if (soundVolumeSlider) soundVolumeSlider.value = value;
    if (soundVolumeVal) soundVolumeVal.textContent = `${value}%`;
  } else if (key === 'zoom_sens') {
    zoomSens = value;
    localStorage.setItem('folio_zoom_sens', value);
    if (zoomSensSlider) zoomSensSlider.value = value;
  }
});
if (cinematicCheck) cinematicCheck.checked = cinematicEnabled;
if (themeSelect) themeSelect.value = currentTheme;
if (sortSelect) sortSelect.value = currentSort;
if (zoomSensSlider) zoomSensSlider.value = zoomSens;
// Initialize grid thumbnail size CSS variable globally
document.documentElement.style.setProperty('--grid-thumb-size', `${gridThumbSize}px`);

// Initialize Phase 2 custom toggles
if (highContrastCheck) {
  highContrastCheck.checked = highContrastEnabled;
  document.body.classList.toggle('high-contrast', highContrastEnabled);
}
if (reducedMotionCheck) {
  reducedMotionCheck.checked = reducedMotionEnabled;
  document.body.classList.toggle('prefers-reduced-motion', reducedMotionEnabled);
}
if (performanceHudCheck) {
  performanceHudCheck.checked = performanceHudEnabled;
  performanceHud.style.display = performanceHudEnabled ? 'flex' : 'none';
  if (performanceHudEnabled) startDiagnosticsPolling();
}

// ── Mobile sidebar drawer click-away & Resize ──
window.addEventListener('resize', () => {
  const isMobile = window.innerWidth < 768;
  if (isMobile) {
    if (sidebar.style.display === 'flex') {
      sidebar.style.display = 'none';
    }
  } else {
    if (viewer.style.display === 'block' && !zenModeActive) {
      sidebar.style.display = 'flex';
    }
  }
});
document.addEventListener('click', (e) => {
  if (window.innerWidth < 768) {
    if (sidebar.style.display === 'flex' && !sidebar.contains(e.target) && e.target !== sidebarToggle) {
      sidebar.style.display = 'none';
    }
  }
});

// ── Adaptive Aspect-Ratio Grid Columns (FE-1) ──
// Removed manual calculation; CSS auto-fill and minmax handles this fluidly.

// ── Diagnostics HUD polling & physics constants ──
let lastFrameTime = performance.now();
let frameCount = 0;
let fps = 60;
let lastFpsUpdate = performance.now();
let refreshRateType = 60; // 60 or 120

function monitorPerformanceLoop() {
  const now = performance.now();
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  
  frameCount++;
  if (now - lastFpsUpdate >= 1000) {
    fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    frameCount = 0;
    lastFpsUpdate = now;
    
    if (fps > 90) {
      refreshRateType = 120;
    } else {
      refreshRateType = 60;
    }
    
    // Update performance HUD values
    const hudFpsVal = $('hudFpsVal');
    const hudHzVal = $('hudHzVal');
    if (hudFpsVal) hudFpsVal.textContent = fps;
    if (hudHzVal) hudHzVal.textContent = `${refreshRateType}Hz`;
  }
  
  requestAnimationFrame(monitorPerformanceLoop);
}
requestAnimationFrame(monitorPerformanceLoop);

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function loadStorageDiagnostics() {
  try {
    const data = await invoke('get_storage_diagnostics');
    if (dbSizeVal) dbSizeVal.textContent = formatBytes(data.db_size);
    if (cacheSizeVal) cacheSizeVal.textContent = formatBytes(data.cache_size);
    if (thumbCacheLimitInput && data.thumbnail_cache_limit_bytes) {
      thumbCacheLimitInput.value = (data.thumbnail_cache_limit_bytes / 1024 / 1024 / 1024).toFixed(2);
    }
    if (decodedCacheLimitInput && data.decoded_cache_limit_bytes) {
      decodedCacheLimitInput.value = (data.decoded_cache_limit_bytes / 1024 / 1024 / 1024).toFixed(1);
    }
    if (decodedSizeVal) decodedSizeVal.textContent = formatBytes(data.decoded_size);
    if (cpuLoadVal) cpuLoadVal.textContent = data.cpu_used_pct.toFixed(1) + '%';
    if (ramSizeVal) ramSizeVal.textContent = formatBytes(data.memory_used_kb * 1024);
    return data;
  } catch (err) {
    console.error('Failed to fetch storage diagnostics:', err);
    return null;
  }
}

let diagnosticsInterval = null;
function startDiagnosticsPolling() {
  if (diagnosticsInterval) return;
  diagnosticsInterval = setInterval(async () => {
    const isHudActive = localStorage.getItem('folio_performance_hud') === 'true';
    const activeTab = document.querySelector('.settings-nav-item.active')?.dataset?.tab;
    const isDiagnosticsTab = settingsPage?.style.display !== 'none'
      && (activeTab === 'cache' || activeTab === 'advanced');
    
    if (isHudActive || isDiagnosticsTab) {
      const data = await loadStorageDiagnostics();
      if (!data) return;
      const memStr = formatBytes(data.memory_used_kb * 1024);
      const cpuStr = data.cpu_used_pct.toFixed(1) + '%';
      if (isHudActive) {
        const hudCpuVal = $('hudCpuVal');
        const hudMemoryVal = $('hudMemoryVal');
        if (hudCpuVal) hudCpuVal.textContent = cpuStr;
        if (hudMemoryVal) hudMemoryVal.textContent = memStr;
      }
    }
  }, 1000);
}

/* ── Settings navigation ── */
document.querySelectorAll('.settings-nav-item').forEach(btn => {
  btn.addEventListener('click', async () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = $('tab-' + tab);
    if (pane) pane.classList.add('active');
    if (settingsPaneTitle && SETTINGS_PANE_TITLES[tab]) {
      settingsPaneTitle.textContent = SETTINGS_PANE_TITLES[tab];
    }
    if (tab === 'cache' || tab === 'advanced') await loadStorageDiagnostics();
  });
});

pruneThumbCacheBtn?.addEventListener('click', async () => {
  try {
    const removed = await invoke('prune_thumbnail_cache');
    showToast(`Pruned ${formatBytes(removed)} from thumbnail cache`);
  } catch (err) {
    showToast(`Thumbnail prune failed: ${err}`);
  }
});

/* ── Settings Controls Wiring ── */
if (sortSelect) {
  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value;
    localStorage.setItem('folio_sort', currentSort);
    if (items.length) { sortItems(); show(0); }
  });
}

if (themeSelect) {
  themeSelect.addEventListener('change', (e) => {
    currentTheme = e.target.value;
    localStorage.setItem('folio_theme', currentTheme);
    applyTheme(currentTheme);
  });
}

if (cinematicCheck) {
  cinematicCheck.addEventListener('change', (e) => {
    cinematicEnabled = e.target.checked;
    localStorage.setItem('folio_cinematic', cinematicEnabled);
  });
}

// Wire Phase 2 setting checkboxes
highContrastCheck?.addEventListener('change', (e) => {
  highContrastEnabled = e.target.checked;
  localStorage.setItem('folio_high_contrast', highContrastEnabled);
  document.body.classList.toggle('high-contrast', highContrastEnabled);
});

reducedMotionCheck?.addEventListener('change', (e) => {
  reducedMotionEnabled = e.target.checked;
  localStorage.setItem('folio_reduced_motion', reducedMotionEnabled);
  document.body.classList.toggle('prefers-reduced-motion', reducedMotionEnabled);
});

performanceHudCheck?.addEventListener('change', (e) => {
  performanceHudEnabled = e.target.checked;
  localStorage.setItem('folio_performance_hud', performanceHudEnabled);
  performanceHud.style.display = performanceHudEnabled ? 'flex' : 'none';
  if (performanceHudEnabled) {
    startDiagnosticsPolling();
  }
});

let mediaCacheEpoch = 0;

async function reloadLibraryAfterCacheClear(cacheResult) {
  const folderToReload = openedLibraryPath;
  selectedCatalogPaths.clear();
  updateTranscodeHud();
  mediaCacheEpoch += 1;
  preloadedThumbs.clear();
  preloadCache.clear();
  for (const path of [...videoPreloadCache.keys()]) evictVideoPreload(path);
  if (folderToReload) {
    try {
      if (cacheResult?.items_reindexed > 0) {
        items = processLoadedItems(await invoke('get_folder_items'));
        sortItems();
        idx = Math.min(idx, Math.max(0, items.length - 1));
        clearEmptyState(catalogStateHost);
        clearEmptyState(viewerStateHost);
        if (!isSettingsOpen()) {
          updateWorkspaceLayout();
          if (catalogModeActive) buildCatalogContent();
          else {
            buildFilmstrip();
            show(idx);
          }
        } else if (!catalogModeActive) {
          buildFilmstrip();
        }
        Promise.all([renderTagFilters(), loadMediaAttributes()]).catch((e) => console.error(e));
      } else {
        const refreshed = await invoke('refresh_active_library');
        if (refreshed?.items?.length) {
          items = processLoadedItems(refreshed.items);
          sortItems();
          idx = Math.min(idx, Math.max(0, items.length - 1));
          clearEmptyState(catalogStateHost);
          clearEmptyState(viewerStateHost);
          if (!isSettingsOpen()) {
            updateWorkspaceLayout();
            if (catalogModeActive) buildCatalogContent();
            else {
              buildFilmstrip();
              show(idx);
            }
          } else if (!catalogModeActive) {
            buildFilmstrip();
          }
          Promise.all([renderTagFilters(), loadMediaAttributes()]).catch((e) => console.error(e));
        } else {
          await loadFolderData(folderToReload);
        }
      }
      showToast('Library refreshed after cache clear.');
    } catch (e) {
      console.error('[Folio] refresh after cache clear:', e);
      await loadFolderData(folderToReload);
      showToast('Library reloaded after cache clear.');
    }
  } else if (items.length) {
    buildCatalogContent?.();
  }
  await loadStorageDiagnostics();
}

function cacheClearToast(label, result) {
  const freed = result?.bytes_freed ? ` Freed ${formatBytes(result.bytes_freed)}.` : '';
  const warn = result?.warnings?.length ? ` (${result.warnings.length} warnings)` : '';
  showToast(`${label} complete.${freed}${warn}`);
}

async function runCacheAction(btn, label, invokeName, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  const prev = btn?.textContent;
  try {
    setInlineStatus(cacheActionStatus, `${label}…`, 'loading');
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    const result = await invoke(invokeName);
    cacheClearToast(label, result);
    setInlineStatus(cacheActionStatus, `${label} complete.`, 'success');
    await reloadLibraryAfterCacheClear(result);
  } catch (err) {
    showToast(`${label} failed: ${err}`);
    setInlineStatus(cacheActionStatus, `${label} failed: ${err}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
  }
}

clearThumbsBtn?.addEventListener('click', () => runCacheAction(
  clearThumbsBtn, 'Thumbnails cleared', 'clear_thumbnail_cache',
  'Clear all thumbnail files? The library will rebuild previews on next browse.',
));
clearDecodedBtn?.addEventListener('click', () => runCacheAction(
  clearDecodedBtn, 'Decoded cache cleared', 'clear_decoded_cache',
  'Clear decoded full-size image cache?',
));
clearMetadataBtn?.addEventListener('click', () => runCacheAction(
  clearMetadataBtn, 'Metadata index cleared', 'clear_metadata_database',
  'Clear the metadata index (EXIF cache and histograms)? Tags and ratings are kept.',
));
purgeCacheBtn?.addEventListener('click', () => runCacheAction(
  purgeCacheBtn, 'All local cache cleared', 'purge_cache',
  'Clear thumbnails, decoded images, and metadata index? Tags, ratings, and albums are kept.',
));
resetLibraryMetadataBtn?.addEventListener('click', () => runCacheAction(
  resetLibraryMetadataBtn,
  'Library metadata reset',
  'reset_library_metadata',
  'Remove all tags, ratings, albums, and per-image metadata? This cannot be undone.',
));

function initHomeScroll() {
  const scrollEl = document.querySelector('.home-side-scroll');
  const hub = $('welcome');
  scrollEl?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  hub?.addEventListener('wheel', (e) => {
    if (e.target === hub || e.target.closest('.home-main')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { passive: false });
}

if (zoomSensSlider) {
  zoomSensSlider.addEventListener('input', (e) => {
    zoomSens = parseFloat(e.target.value);
    localStorage.setItem('folio_zoom_sens', zoomSens);
  });
}

/* ── Keybind Buttons ── */
function keybindLabel(key) {
  const labels = { ' ': 'Space', 'ArrowRight': '→', 'ArrowLeft': '←', 'ArrowUp': '↑', 'ArrowDown': '↓', 'Shift': '⇧ Shift', 'Control': '⌃ Ctrl', 'Alt': '⌥ Alt', 'Meta': '⌘ Cmd' };
  return labels[key] || key.toUpperCase();
}

function populateKeybindButtons() {
  document.querySelectorAll('.keybind-btn').forEach(btn => {
    const action = btn.dataset.action;
    if (action && keybinds[action] !== undefined) {
      btn.textContent = keybindLabel(keybinds[action]);
    }
  });
}
populateKeybindButtons();

$('resetKeybindsBtn')?.addEventListener('click', () => {
  keybinds = { ...defaultKeybinds };
  localStorage.setItem('folio_keybinds', JSON.stringify(keybinds));
  populateKeybindButtons();
  showToast('Keybinds reset to defaults');
});

/* ── Keybind Recording ── */
let activeKeybindBtn = null;
document.querySelectorAll('.keybind-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (activeKeybindBtn) activeKeybindBtn.classList.remove('recording');
    activeKeybindBtn = btn;
    btn.classList.add('recording');
    btn.textContent = 'Press key...';
  });
});

window.addEventListener('keydown', (e) => {
  if (!activeKeybindBtn) return;
  e.preventDefault(); e.stopPropagation();
  const action = activeKeybindBtn.dataset.action;
  const isModifierAction = action === 'modifierZoom' || action === 'modifierPan';
  const key = isModifierAction ? e.key : e.key;
  keybinds[action] = key;
  localStorage.setItem('folio_keybinds', JSON.stringify(keybinds));
  activeKeybindBtn.textContent = keybindLabel(key);
  activeKeybindBtn.classList.remove('recording');
  activeKeybindBtn = null;
}, true);

function collapseSidebar() {
  if (sidebar && sidebar.style.display !== 'none') {
    sidebar.style.display = 'none';
    if (sidebarToggle) {
      sidebarToggle.classList.remove('active');
      sidebarToggle.classList.add('sidebar-closed');
      sidebarToggle.textContent = 'Sidebar';
    }
  }
}

let zenModeActive = false;
function toggleZenMode() {
  zenModeActive = !zenModeActive;
  if (zenModeActive) {
    collapseSidebar();
  }
  document.body.classList.toggle('zen-mode', zenModeActive);
  sidebar.classList.toggle('zen-hide', zenModeActive);
  document.getElementById('zoomHud')?.classList.toggle('zen-hide', zenModeActive);
  document.getElementById('editToggleBtn')?.classList.toggle('zen-hide', zenModeActive);
  document.getElementById('sidebarToggle')?.classList.toggle('zen-hide', zenModeActive);
  closeCropMode();
  closeEditPanel();
  showToast(zenModeActive ? 'Zen Mode Activated' : 'Zen Mode Deactivated');
}

function showContextMenu(e, itemPath, itemIndex) {
  e.preventDefault();
  
  let menu = document.getElementById('customContextMenu');
  if (menu) menu.remove();
  
  menu = document.createElement('div');
  menu.id = 'customContextMenu';
  menu.className = 'glassmorphic-menu';
  menu.style.position = 'fixed';
  menu.style.top = `${e.clientY}px`;
  menu.style.left = `${e.clientX}px`;
  menu.style.zIndex = '99999';
  menu.style.padding = '6px';
  menu.style.borderRadius = '12px';
  menu.style.background = 'rgba(20, 20, 20, 0.85)';
  menu.style.backdropFilter = 'blur(20px) saturate(180%)';
  menu.style.border = '1px solid rgba(255, 255, 255, 0.08)';
  menu.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02)';
  menu.style.display = 'flex';
  menu.style.flexDirection = 'column';
  menu.style.gap = '2px';
  menu.style.minWidth = '140px';

  const finderBtn = document.createElement('div');
  finderBtn.className = 'context-menu-item finder-item';
  finderBtn.style.padding = '8px 12px';
  finderBtn.style.borderRadius = '8px';
  finderBtn.style.cursor = 'pointer';
  finderBtn.style.color = 'var(--text-primary)';
  finderBtn.style.fontSize = '13px';
  finderBtn.style.display = 'flex';
  finderBtn.style.alignItems = 'center';
  finderBtn.style.gap = '8px';
  finderBtn.style.transition = 'background 0.2s';
  finderBtn.textContent = 'Show in Finder';
  finderBtn.addEventListener('mouseenter', () => {
    finderBtn.style.background = 'rgba(255,255,255,0.08)';
  });
  finderBtn.addEventListener('mouseleave', () => {
    finderBtn.style.background = 'none';
  });
  finderBtn.addEventListener('click', () => {
    menu.remove();
    openPathInFinder(itemPath, true);
  });
  
  const deleteBtn = document.createElement('div');
  deleteBtn.className = 'context-menu-item delete-item';
  deleteBtn.style.padding = '8px 12px';
  deleteBtn.style.borderRadius = '8px';
  deleteBtn.style.cursor = 'pointer';
  deleteBtn.style.color = '#ff6b6b';
  deleteBtn.style.fontSize = '13px';
  deleteBtn.style.display = 'flex';
  deleteBtn.style.alignItems = 'center';
  deleteBtn.style.gap = '8px';
  deleteBtn.style.transition = 'background 0.2s';
  deleteBtn.textContent = 'Move to Trash';
  
  deleteBtn.addEventListener('mouseenter', () => {
    deleteBtn.style.background = 'rgba(255, 107, 107, 0.15)';
  });
  deleteBtn.addEventListener('mouseleave', () => {
    deleteBtn.style.background = 'none';
  });
  
  deleteBtn.addEventListener('click', () => {
    menu.remove();
    showDeleteConfirmation(itemPath, itemIndex);
  });
  
  menu.appendChild(finderBtn);
  menu.appendChild(deleteBtn);
  document.body.appendChild(menu);
  
  const closeMenu = (evt) => {
    if (!menu.contains(evt.target)) {
      menu.remove();
      document.removeEventListener('mousedown', closeMenu);
    }
  };
  document.addEventListener('mousedown', closeMenu);
}

function showDeleteConfirmation(itemPath, itemIndex) {
  let modal = document.createElement('div');
  modal.className = 'glassmorphic-modal-overlay';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.background = 'rgba(0,0,0,0.5)';
  modal.style.backdropFilter = 'blur(10px)';
  modal.style.zIndex = '999999';
  modal.style.display = 'flex';
  modal.style.alignItems = 'center';
  modal.style.justifyContent = 'center';
  modal.style.opacity = '0';
  modal.style.transition = 'opacity 0.3s ease';
  
  const dialog = document.createElement('div');
  dialog.className = 'glassmorphic-dialog';
  dialog.style.background = 'rgba(24, 24, 28, 0.85)';
  dialog.style.border = '1px solid rgba(255,255,255,0.08)';
  dialog.style.padding = '24px';
  dialog.style.borderRadius = '16px';
  dialog.style.boxShadow = '0 30px 60px rgba(0,0,0,0.7)';
  dialog.style.maxWidth = '360px';
  dialog.style.width = '90%';
  dialog.style.overflow = 'hidden';
  dialog.style.textAlign = 'center';
  dialog.style.transform = 'scale(0.9)';
  dialog.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
  
  const title = document.createElement('h3');
  title.textContent = 'Move File to Trash?';
  title.style.color = '#fff';
  title.style.fontSize = '17px';
  title.style.margin = '0 0 10px 0';
  
  const fullName = basename(itemPath);
  const shownName = formatFilenameForDialog(itemPath, 48);
  const desc = document.createElement('p');
  desc.className = 'dialog-body-text';
  desc.textContent = `This will move “${shownName}” to the system Trash.`;
  if (fullName !== shownName) desc.title = fullName;
  desc.style.color = 'rgba(255,255,255,0.6)';
  desc.style.fontSize = '13px';
  desc.style.lineHeight = '1.5';
  desc.style.margin = '0 0 20px 0';
  desc.style.overflowWrap = 'anywhere';
  desc.style.wordBreak = 'break-word';
  
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '12px';
  actions.style.justifyContent = 'center';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.padding = '8px 16px';
  cancelBtn.style.borderRadius = '8px';
  cancelBtn.style.border = '1px solid rgba(255,255,255,0.08)';
  cancelBtn.style.background = 'rgba(255,255,255,0.05)';
  cancelBtn.style.color = '#fff';
  cancelBtn.style.cursor = 'pointer';
  cancelBtn.style.fontSize = '13px';
  cancelBtn.style.transition = 'background 0.2s';
  cancelBtn.addEventListener('mouseenter', () => cancelBtn.style.background = 'rgba(255,255,255,0.1)');
  cancelBtn.addEventListener('mouseleave', () => cancelBtn.style.background = 'rgba(255,255,255,0.05)');
  
  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Move to Trash';
  deleteBtn.style.padding = '8px 16px';
  deleteBtn.style.borderRadius = '8px';
  deleteBtn.style.border = 'none';
  deleteBtn.style.background = '#ff6b6b';
  deleteBtn.style.color = '#fff';
  deleteBtn.style.cursor = 'pointer';
  deleteBtn.style.fontSize = '13px';
  deleteBtn.style.transition = 'background 0.2s';
  deleteBtn.addEventListener('mouseenter', () => deleteBtn.style.background = '#ff5252');
  deleteBtn.addEventListener('mouseleave', () => deleteBtn.style.background = '#ff6b6b');
  
  const closeModal = () => {
    modal.style.opacity = '0';
    dialog.style.transform = 'scale(0.9)';
    setTimeout(() => modal.remove(), 300);
  };
  
  cancelBtn.addEventListener('click', closeModal);
  deleteBtn.addEventListener('click', async () => {
    try {
      await invoke('delete_physical_file', { path: itemPath });
      showToast('File moved to Trash');
      
      items = items.filter(it => it.path !== itemPath);
      
      if (items.length === 0) {
        showHomeHub();
        sidebar.style.display = viewer.style.display = catalogGrid.style.display = 'none';
      } else {
        if (idx >= items.length) idx = items.length - 1;
        buildFilmstrip();
        if (catalogModeActive) {
          buildCatalogContent();
        } else {
          show(idx);
        }
      }
    } catch (e) {
      showToast('Failed to move file to Trash');
    }
    closeModal();
  });
  
  actions.appendChild(cancelBtn);
  actions.appendChild(deleteBtn);
  dialog.appendChild(title);
  dialog.appendChild(desc);
  dialog.appendChild(actions);
  modal.appendChild(dialog);
  document.body.appendChild(modal);
  
  requestAnimationFrame(() => {
    modal.style.opacity = '1';
    dialog.style.transform = 'scale(1)';
  });
}

function toggleCatalogView(active) {
  catalogModeActive = active;
  if (active) {
    welcome.classList.add('hidden');
    buildCatalogContent();
    showToast('Catalog Grid Mode');
  } else {
    buildFilmstrip();
    show(idx);
  }
  updateWorkspaceLayout();
}

function renderCatalogChunk(startIndex, count) {
  const endIndex = Math.min(startIndex + count, items.length);
  const fragment = document.createDocumentFragment();
  
  for (let i = startIndex; i < endIndex; i++) {
    const it = items[i];
    const card = document.createElement('div');
    card.className = 'catalog-card';
    card.dataset.path = it.path;
    
    if (selectedCatalogPaths.has(it.path)) {
      card.classList.add('selected');
    }
    
    if (duplicateGroupsCache && duplicateGroupsCache.has(it.path)) {
      const color = duplicateGroupsCache.get(it.path);
      card.style.borderColor = color;
      card.style.boxShadow = `0 0 0 3px ${color}`;
      card.classList.add('is-duplicate');
      if (duplicateKeeperPaths.has(it.path)) {
        card.classList.add('is-dup-keeper');
        card.dataset.dupRole = 'keeper';
      } else {
        card.dataset.dupRole = 'alt';
      }
    }

    const attr = mediaAttributesCache.get(it.path);
    if (attr?.favorite) card.classList.add('is-favorite');
    if ((attr?.rating || 0) > 0) card.classList.add('is-rated');
    if (i === idx) card.classList.add('is-focused');
    
    if (activeTagFilter !== null) {
      const tags = folderTagsCache.get(it.path) || [];
      const matches = tags.some(t => t.name === activeTagFilter);
      card.classList.toggle('hidden-by-filter', !matches);
    }
    if (!matchesSmartFilter(it)) {
      card.classList.add('hidden-by-filter');
    }
    
    const checkOverlay = document.createElement('div');
    checkOverlay.className = 'card-select-checkbox';
    checkOverlay.innerHTML = '✓';
    checkOverlay.onclick = (e) => {
      e.stopPropagation();
      if (selectedCatalogPaths.has(it.path)) {
        selectedCatalogPaths.delete(it.path);
        card.classList.remove('selected');
      } else {
        selectedCatalogPaths.add(it.path);
        card.classList.add('selected');
      }
      updateTranscodeHud();
    };
    card.appendChild(checkOverlay);
    
    card.onclick = (e) => {
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        checkOverlay.click();
        return;
      }
      idx = i;
      toggleCatalogView(false);
    };
    
    card.oncontextmenu = (e) => {
      showContextMenu(e, it.path, i);
    };
    
    if (it.is_video) {
      const v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      card.appendChild(v);
      
      invoke('get_thumbnail', { path: it.path, maxSide: 320 })
        .then(tp => {
          v.poster = `folio://localhost/${encodeURIComponent(tp)}`;
        })
        .catch(() => {});
        
      card.addEventListener('mouseenter', () => {
        if (!v.src) v.src = `folio://localhost/${encodeURIComponent(it.path)}`;
        v.play().catch(()=>{});
      });
      card.addEventListener('mouseleave', () => {
        v.pause();
      });
    } else {
      const img = document.createElement('img');
      img.crossOrigin = "anonymous";
      card.classList.add('is-loading');
      img.onload = () => {
        img.classList.add('loaded');
        card.classList.remove('is-loading');
      };
      img.onerror = () => {
        card.classList.remove('is-loading');
        card.classList.add('is-failed');
      };
      card.appendChild(img);
      
      invoke('get_thumbnail', { path: it.path, maxSide: 320 })
        .then(tp => {
          img.src = `folio://localhost/${encodeURIComponent(tp)}`;
        })
        .catch(() => {
          img.src = `folio://localhost/${encodeURIComponent(it.path)}`;
        });
    }
    
    if (it.focus_score !== null && it.focus_score !== undefined && it.focus_score < 100.0) {
      const blurryBadge = document.createElement('div');
      blurryBadge.className = 'blurry-badge';
      blurryBadge.textContent = 'Blurry';
      card.appendChild(blurryBadge);
    }
    
    const info = document.createElement('div');
    info.className = 'catalog-card-info';
    
    const title = document.createElement('div');
    title.className = 'catalog-card-title';
    title.textContent = it.path.split('/').pop();
    
    info.appendChild(title);
    const ratingRow = document.createElement('div');
    ratingRow.className = 'catalog-card-rating';
    const r = attr?.rating || 0;
    if (r > 0) ratingRow.textContent = '★'.repeat(r);
    info.appendChild(ratingRow);
    card.appendChild(info);
    fragment.appendChild(card);
  }
  
  catalogContent.appendChild(fragment);
  
  if (endIndex < items.length) {
    let sentinel = catalogContent.querySelector('.catalog-sentinel');
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.className = 'catalog-sentinel';
      sentinel.style.height = '1px';
      sentinel.style.gridColumn = '1 / -1';
    }
    catalogContent.appendChild(sentinel);
    
    if (!catalogObserver) {
      catalogObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          const currentCount = catalogContent.querySelectorAll('.catalog-card').length;
          if (currentCount < items.length) {
            renderCatalogChunk(currentCount, 100);
          } else {
            catalogObserver.disconnect();
            catalogObserver = null;
            const s = catalogContent.querySelector('.catalog-sentinel');
            if (s) s.remove();
          }
        }
      }, { root: catalogContent, rootMargin: '200px' });
    }
    catalogObserver.observe(sentinel);
  } else {
    const sentinel = catalogContent.querySelector('.catalog-sentinel');
    if (sentinel) sentinel.remove();
    if (catalogObserver) {
      catalogObserver.disconnect();
      catalogObserver = null;
    }
  }
}

async function buildCatalogContent() {
  if (catalogObserver) {
    catalogObserver.disconnect();
    catalogObserver = null;
  }
  catalogContent.innerHTML = '';
  if (!items || items.length === 0) {
    renderEmptyState(catalogStateHost, {
      preset: 'catalog-empty',
      actions: openedLibraryPath
        ? [{ label: 'Open another folder', primary: true, onClick: () => openFolder() }]
        : [{ label: 'Go home', primary: true, onClick: () => goHome() }],
    });
    return;
  }
  clearEmptyState(catalogStateHost);
  await loadMediaAttributes();
  catalogTitle.textContent = '';
  renderCatalogChunk(0, 100);
}

function showNewFolderModal() {
  if (!items || items.length === 0) {
    showToast('Open a folder first');
    return;
  }
  
  const activeImagePath = items[0].path;
  const parentPath = activeImagePath.substring(0, activeImagePath.lastIndexOf('/'));
  
  let modal = document.createElement('div');
  modal.className = 'glassmorphic-modal-overlay';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.background = 'rgba(0,0,0,0.5)';
  modal.style.backdropFilter = 'blur(10px)';
  modal.style.zIndex = '999999';
  modal.style.display = 'flex';
  modal.style.alignItems = 'center';
  modal.style.justifyContent = 'center';
  modal.style.opacity = '0';
  modal.style.transition = 'opacity 0.3s ease';
  
  const dialog = document.createElement('div');
  dialog.className = 'glassmorphic-dialog';
  dialog.style.background = 'rgba(24, 24, 28, 0.85)';
  dialog.style.border = '1px solid rgba(255,255,255,0.08)';
  dialog.style.padding = '24px';
  dialog.style.borderRadius = '16px';
  dialog.style.boxShadow = '0 30px 60px rgba(0,0,0,0.7)';
  dialog.style.maxWidth = '360px';
  dialog.style.width = '90%';
  dialog.style.textAlign = 'center';
  dialog.style.transform = 'scale(0.9)';
  dialog.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
  
  const title = document.createElement('h3');
  title.textContent = 'Create New Folder';
  title.style.color = '#fff';
  title.style.fontSize = '17px';
  title.style.margin = '0 0 10px 0';
  
  const desc = document.createElement('p');
  desc.textContent = `Create a new directory inside "${parentPath.split('/').pop()}":`;
  desc.style.color = 'rgba(255,255,255,0.6)';
  desc.style.fontSize = '12px';
  desc.style.lineHeight = '1.5';
  desc.style.margin = '0 0 16px 0';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Folder Name';
  input.className = 'ed-inline-input';
  input.style.width = '100%';
  input.style.padding = '10px 14px';
  input.style.border = '1px solid rgba(255,255,255,0.1)';
  input.style.borderRadius = '8px';
  input.style.background = 'rgba(255,255,255,0.05)';
  input.style.color = '#fff';
  input.style.fontSize = '13px';
  input.style.outline = 'none';
  input.style.margin = '0 0 20px 0';
  
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '12px';
  actions.style.justifyContent = 'center';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.padding = '8px 16px';
  cancelBtn.style.borderRadius = '8px';
  cancelBtn.style.border = '1px solid rgba(255,255,255,0.08)';
  cancelBtn.style.background = 'rgba(255,255,255,0.05)';
  cancelBtn.style.color = '#fff';
  cancelBtn.style.cursor = 'pointer';
  cancelBtn.style.fontSize = '13px';
  
  const createBtn = document.createElement('button');
  createBtn.textContent = 'Create';
  createBtn.style.padding = '8px 16px';
  createBtn.style.borderRadius = '8px';
  createBtn.style.border = 'none';
  createBtn.style.background = 'var(--accent-gold, #d4a72c)';
  createBtn.style.color = '#000';
  createBtn.style.fontWeight = '600';
  createBtn.style.cursor = 'pointer';
  createBtn.style.fontSize = '13px';
  
  const closeModal = () => {
    modal.style.opacity = '0';
    dialog.style.transform = 'scale(0.9)';
    setTimeout(() => modal.remove(), 300);
  };
  
  cancelBtn.addEventListener('click', closeModal);
  createBtn.addEventListener('click', async () => {
    const val = input.value.trim();
    if (!val) {
      showToast('Enter folder name');
      return;
    }
    try {
      await invoke('create_physical_folder', { parentPath, folderName: val });
      showToast(`Folder "${val}" created`);
      closeModal();
    } catch (e) {
      showToast('Failed to create folder');
    }
  });
  
  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);
  dialog.appendChild(title);
  dialog.appendChild(desc);
  dialog.appendChild(input);
  dialog.appendChild(actions);
  modal.appendChild(dialog);
  document.body.appendChild(modal);
  
  requestAnimationFrame(() => {
    modal.style.opacity = '1';
    dialog.style.transform = 'scale(1)';
    input.focus();
  });
}

let folderTagsCache = new Map();

async function loadMediaAttributes() {
  if (!items.length) return;
  try {
    const attrs = await invoke('get_media_attributes', { paths: items.map(it => it.path) });
    mediaAttributesCache.clear();
    attrs.forEach(attr => mediaAttributesCache.set(attr.path, attr));
  } catch (e) {
    console.error('Failed to load media attributes:', e);
  }
}

function matchesSmartFilter(item) {
  if (!activeSmartFilter) return true;
  const attr = mediaAttributesCache.get(item.path) || {};
  const format = (item.format || item.path.split('.').pop() || '').toLowerCase();
  if (activeSmartFilter === 'favorites') return !!attr.favorite;
  if (activeSmartFilter === 'rated') return (attr.rating || 0) >= 3;
  if (activeSmartFilter === 'gps') return !!(item.exif?.latitude && item.exif?.longitude);
  if (activeSmartFilter === 'raw') return ['raw', 'cr2', 'nef', 'arw', 'dng', 'heic', 'heif', 'tiff', 'tif'].some(ext => format.includes(ext));
  if (activeSmartFilter === 'videos') return !!item.is_video;
  return true;
}

function applyFilters() {
  applyTagFilter();
  document.querySelectorAll('.thumb').forEach(thumb => {
    const item = items.find(it => it.path === thumb.dataset.path);
    thumb.classList.toggle('hidden-by-filter', item ? !matchesSmartFilter(item) : false);
  });
  document.querySelectorAll('.catalog-card').forEach(card => {
    const item = items.find(it => it.path === card.dataset.path);
    if (item && !matchesSmartFilter(item)) card.classList.add('hidden-by-filter');
  });
}

async function renderTagFilters() {
  if (!items || items.length === 0) {
    tagFilterPanel.style.display = 'none';
    return;
  }
  
  try {
    const summary = await invoke('get_folder_tags_summary');
    folderTagsCache.clear();
    
    const tagCounts = {};
    const tagColors = {};
    
    summary.forEach(([imgPath, tagName, tagColor]) => {
      const exists = items.some(it => it.path === imgPath);
      if (exists) {
        tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
        tagColors[tagName] = tagColor;
        
        if (!folderTagsCache.has(imgPath)) {
          folderTagsCache.set(imgPath, []);
        }
        folderTagsCache.get(imgPath).push({ name: tagName, color: tagColor });
      }
    });
    
    const uniqueTags = Object.keys(tagCounts);
    if (uniqueTags.length === 0) {
      tagFilterPanel.style.display = 'none';
      return;
    }
    
    tagFilterPanel.style.display = 'block';
    tagFilterList.innerHTML = '';
    
    const allChip = document.createElement('div');
    allChip.className = `tag-filter-chip ${activeTagFilter === null ? 'active' : ''}`;
    
    const allDot = document.createElement('div');
    allDot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.5);';
    allChip.appendChild(allDot);
    
    const allLabel = document.createElement('span');
    allLabel.textContent = 'All';
    allChip.appendChild(allLabel);
    
    const allCount = document.createElement('span');
    allCount.className = 'tag-filter-count';
    allCount.textContent = items.length;
    allChip.appendChild(allCount);
    
    allChip.onclick = async () => {
      activeTagFilter = null;
      activeColorFilter = null;
      folderDominantColorsCache = {};
      await renderTagFilters();
      applyFilters();
    };
    tagFilterList.appendChild(allChip);
    
    uniqueTags.forEach(tagName => {
      const chip = document.createElement('div');
      chip.className = `tag-filter-chip ${activeTagFilter === tagName ? 'active' : ''}`;
      
      const dot = document.createElement('div');
      dot.style.width = '6px';
      dot.style.height = '6px';
      dot.style.borderRadius = '50%';
      dot.style.background = tagColors[tagName];
      
      const label = document.createElement('span');
      label.textContent = tagName;
      
      const count = document.createElement('span');
      count.className = 'tag-filter-count';
      count.textContent = tagCounts[tagName];
      
      chip.appendChild(dot);
      chip.appendChild(label);
      chip.appendChild(count);
      
      chip.onclick = () => {
        if (activeTagFilter === tagName) {
          activeTagFilter = null;
        } else {
          activeTagFilter = tagName;
        }
        applyFilters();
        renderTagFilters();
      };
      tagFilterList.appendChild(chip);
    });
  } catch (e) {
    console.error('Failed to render tag filters:', e);
  }
}

function applyTagFilter() {
  document.querySelectorAll('.thumb').forEach(thumb => {
    const path = thumb.dataset.path;
    if (activeTagFilter === null) {
      thumb.classList.remove('hidden-by-filter');
    } else {
      const tags = folderTagsCache.get(path) || [];
      const matches = tags.some(t => t.name === activeTagFilter);
      thumb.classList.toggle('hidden-by-filter', !matches);
    }
  });
  
  document.querySelectorAll('.catalog-card').forEach(card => {
    const path = card.dataset.path;
    if (activeTagFilter === null) {
      card.classList.remove('hidden-by-filter');
    } else {
      const tags = folderTagsCache.get(path) || [];
      const matches = tags.some(t => t.name === activeTagFilter);
      card.classList.toggle('hidden-by-filter', !matches);
    }
  });
  
  if (items && items.length > 0) {
    if (activeTagFilter !== null) {
      // Switching to a specific tag — jump to first matching image
      const currentPath = items[idx]?.path;
      const currentTags = folderTagsCache.get(currentPath) || [];
      const isCurrentMatches = currentTags.some(t => t.name === activeTagFilter);
      if (!isCurrentMatches) {
        let foundIdx = items.findIndex(it => {
          const tags = folderTagsCache.get(it.path) || [];
          return tags.some(t => t.name === activeTagFilter);
        });
        if (foundIdx !== -1) {
          idx = foundIdx;
          if (!catalogModeActive) {
            show(idx);
          }
        }
      }
    }
  }
}

function showTagPill() {
  let pill = document.getElementById('tagPill');
  if (pill) {
    pill.querySelector('input').focus();
    return;
  }
  
  pill = document.createElement('div');
  pill.id = 'tagPill';
  pill.className = 'glassmorphic-pill-overlay';
  pill.style.position = 'fixed';
  pill.style.top = '40%';
  pill.style.left = '50%';
  pill.style.transform = 'translate(-50%, -50%) scale(0.9)';
  pill.style.opacity = '0';
  pill.style.transition = 'all 0.3s var(--ease-spring)';
  pill.style.zIndex = '9999';
  pill.style.display = 'flex';
  pill.style.alignItems = 'center';
  pill.style.gap = '8px';
  pill.style.padding = '8px 16px';
  pill.style.borderRadius = '30px';
  pill.style.background = 'rgba(20, 20, 20, 0.65)';
  pill.style.backdropFilter = 'blur(20px) saturate(180%)';
  pill.style.border = '1px solid rgba(255,255,255,0.08)';
  pill.style.boxShadow = '0 20px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)';
  
  const icon = document.createElement('span');
  icon.textContent = '🏷️';
  icon.style.fontSize = '14px';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Add tag to current photo...';
  input.style.background = 'none';
  input.style.border = 'none';
  input.style.outline = 'none';
  input.style.color = '#fff';
  input.style.fontSize = '14px';
  input.style.width = '200px';
  input.style.fontFamily = 'inherit';
  
  pill.appendChild(icon);
  pill.appendChild(input);
  document.body.appendChild(pill);
  
  requestAnimationFrame(() => {
    pill.style.transform = 'translate(-50%, -50%) scale(1)';
    pill.style.opacity = '1';
  });
  
  input.focus();
  
  const closePill = () => {
    pill.style.transform = 'translate(-50%, -50%) scale(0.9)';
    pill.style.opacity = '0';
    setTimeout(() => pill.remove(), 250);
  };
  
  input.addEventListener('keydown', async (evt) => {
    if (evt.key === 'Escape') closePill();
    if (evt.key === 'Enter') {
      const tagName = input.value.trim();
      if (!tagName) return;
      
      const item = items[idx];
      if (item) {
        try {
          const colors = ['#D4A72C', '#E55E5E', '#4FA8EE', '#5BC2A8', '#AB6BFA'];
          let hash = 0;
          for (let i = 0; i < tagName.length; i++) hash = tagName.charCodeAt(i) + ((hash << 5) - hash);
          const chosenColor = colors[Math.abs(hash) % colors.length];
          
          await invoke('add_tag_to_image', { path: item.path, tagName, tagColor: chosenColor });
          showToast(`Tagged as "${tagName}"`);
          await renderTagFilters();
          applyTagFilter();
          
          const activeThumb = document.querySelector(`.thumb.active`);
          if (activeThumb) {
            let dotsContainer = activeThumb.querySelector('.thumb-tag-dots');
            if (!dotsContainer) {
              dotsContainer = document.createElement('div');
              dotsContainer.className = 'thumb-tag-dots';
              activeThumb.appendChild(dotsContainer);
            }
            const dot = document.createElement('div');
            dot.className = 'thumb-tag-dot';
            dot.style.background = chosenColor;
            dot.title = tagName;
            dotsContainer.appendChild(dot);
          }
        } catch (e) {
          showToast('Failed to save tag');
        }
      }
      closePill();
    }
  });
  
  const clickOutside = (evt) => {
    if (!pill.contains(evt.target)) {
      closePill();
      document.removeEventListener('mousedown', clickOutside);
    }
  };
  document.addEventListener('mousedown', clickOutside);
}

// Real-time filesystem hot-watching update listener
listen('fs-change', async () => {
  if (!items || items.length === 0) return;
  try {
    const oldPath = items[idx]?.path;
    items = processLoadedItems(await invoke('get_folder_items'));
    sortItems();
    
    if (items.length === 0) {
      if (!openedLibraryPath) updateWorkspaceLayout();
      return;
    }
    
    let oldPathStillExists = false;
    if (oldPath) {
      const newIdx = items.findIndex(it => it.path === oldPath);
      if (newIdx !== -1) {
        idx = newIdx;
        oldPathStillExists = true;
      } else {
        if (idx >= items.length) idx = Math.max(0, items.length - 1);
      }
    } else {
      if (idx >= items.length) idx = Math.max(0, items.length - 1);
    }
    
    await renderTagFilters();
    buildFilmstrip();
    applyTagFilter();
    if (catalogModeActive) {
      buildCatalogContent();
    } else {
      // If the current file still exists, do not call show(idx) to avoid resetting playback/zoom status.
      // Simply update the active state highlighted in the filmstrip.
      if (oldPathStillExists) {
        highlightThumb();
      } else {
        show(idx);
      }
    }
  } catch (e) {
    console.error('Failed to reload on filesystem watcher update:', e);
  }
});

function playFavoriteBurst(anchorEl) {
  if (!anchorEl || reducedMotionEnabled) return;
  const rect = anchorEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const layer = document.createElement('div');
  layer.className = 'heart-burst-layer';
  const count = 10;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'heart-particle';
    p.textContent = '♥';
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const dist = 28 + Math.random() * 22;
    p.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
    p.style.setProperty('--rot', `${(Math.random() - 0.5) * 40}deg`);
    p.style.animationDelay = `${i * 25}ms`;
    layer.appendChild(p);
  }
  const pulse = document.createElement('span');
  pulse.className = 'heart-pulse-ring';
  layer.appendChild(pulse);
  layer.style.left = `${cx}px`;
  layer.style.top = `${cy}px`;
  document.body.appendChild(layer);
  anchorEl.classList.add('favorite-pop');
  setTimeout(() => anchorEl.classList.remove('favorite-pop'), 420);
  setTimeout(() => layer.remove(), 900);
}

function buildMapSrcdoc(data) {
  const markersJson = JSON.stringify(data);
  const centerLat = data[0].lat;
  const centerLon = data[0].lon;
  const initialZoom = data.length > 1 ? 11 : 14;
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <style>
        html, body { margin: 0; padding: 0; height: 100%; background: #111113; }
        #map { width: 100%; height: 100%; }
        .leaflet-popup-content-wrapper.folio-map-popup,
        .leaflet-popup-content-wrapper { 
          background: #1b1b1f; 
          color: #f5f5f2; 
          border: 1px solid rgba(212,167,44,0.25); 
          border-radius: 10px; 
          box-shadow: 0 8px 24px rgba(0,0,0,0.45);
          max-width: 168px !important;
        }
        .leaflet-popup-tip { background: #1b1b1f; border: 1px solid rgba(212,167,44,0.2); }
        .leaflet-popup-content { margin: 8px; width: 148px !important; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
        .popup-img { width: 100%; height: 52px; object-fit: cover; border-radius: 6px; margin-bottom: 6px; cursor: pointer; display: block; }
        .popup-title { font-size: 11px; font-weight: 600; color: #f5f5f2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px; }
        .popup-address { font-size: 10px; color: #a8a8b0; line-height: 1.35; margin: 0 0 4px; display: block; }
        .popup-coords { font-size: 9px; color: rgba(212,167,44,0.85); font-family: ui-monospace, monospace; }
        .leaflet-control-attribution { font-size: 9px; background: rgba(17,17,19,0.85) !important; color: #888 !important; }
        .leaflet-control-attribution a { color: #aaa !important; }
      </style>
    </head>
    <body>
      <div id="map"></div>
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        const map = L.map('map', { zoomControl: false }).setView([${centerLat}, ${centerLon}], ${initialZoom});
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: 'abcd',
          maxZoom: 20
        }).addTo(map);

        const markers = ${markersJson};
        const bounds = L.latLngBounds();
        
        markers.forEach(m => {
          bounds.extend([m.lat, m.lon]);
          const popupContent = 
            \`<div class="folio-popup-inner">
              \${m.path ? \`<img src="folio://localhost/\${encodeURIComponent(m.path)}" class="popup-img" alt="" onclick="window.parent.openGeotaggedImage('\${m.path.replace(/'/g, "\\\\'")}')" />\` : ''}
              <div class="popup-title">\${m.name || 'Location'}</div>
              <div class="popup-address" id="addr-\${m.lat}-\${m.lon}">Loading address…</div>
              <div class="popup-coords">\${m.lat.toFixed(4)}, \${m.lon.toFixed(4)}</div>
            </div>\`;
            
          const marker = L.marker([m.lat, m.lon]).addTo(map);
          marker.bindPopup(popupContent, { maxWidth: 168, minWidth: 120, className: 'folio-map-popup' });
          if (markers.length === 1) {
            setTimeout(() => marker.openPopup(), 200);
          }
        });
        
        map.on('popupopen', async function(e) {
          const popup = e.popup;
          const container = popup.getElement();
          if (!container) return;
          const addressEl = container.querySelector('.popup-address');
          if (!addressEl) return;
          const latLng = popup.getLatLng();
          const pending = addressEl.textContent;
          if (pending === 'Loading address…' || pending === '…' || pending === 'Loading address...') {
            addressEl.textContent = 'Loading address…';
            try {
              const lookup = window.parent.reverseGeocodeForMap || window.parent.reverseGeocode;
              const address = await lookup(latLng.lat, latLng.lng);
              addressEl.textContent = address;
            } catch (err) {
              addressEl.textContent = 'Address unavailable';
            }
          }
        });

        if (markers.length > 1) {
          map.fitBounds(bounds, { padding: [50, 50] });
        }
      </script>
    </body>
    </html>
  `;
}

function positionGpsPopover(anchor, wide = false) {
  if (!gpsPopover || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const w = wide ? 380 : 320;
  const h = wide ? 300 : 280;
  let left = rect.left;
  let top = rect.bottom + 10;
  if (left + w > window.innerWidth - 16) left = window.innerWidth - w - 16;
  if (left < 12) left = 12;
  if (top + h > window.innerHeight - 16) top = Math.max(12, rect.top - h - 10);
  const originX = rect.left + rect.width / 2 - left;
  const originY = rect.top + rect.height / 2 - top;
  gpsPopover.style.width = `${w}px`;
  gpsPopover.style.height = `${h}px`;
  gpsPopover.style.left = `${left}px`;
  gpsPopover.style.top = `${top}px`;
  gpsPopover.style.transformOrigin = `${originX}px ${originY}px`;
}

function toggleGpsPopover(anchor, geodata) {
  if (!gpsPopover || !gpsPopoverIframe || !anchor) return;
  const data = Array.isArray(geodata) ? geodata : (geodata ? [geodata] : []);
  if (!data.length) return;

  if (gpsPopover.classList.contains('open') && gpsPopoverAnchor === anchor) {
    closeGpsPopover();
    return;
  }

  gpsPopoverAnchor = anchor;
  gpsPopoverIframe.srcdoc = buildMapSrcdoc(data);
  positionGpsPopover(anchor, data.length > 1);
  gpsPopover.classList.add('open');
  gpsPopover.setAttribute('aria-hidden', 'false');
}

function closeGpsPopover() {
  if (!gpsPopover) return;
  gpsPopover.classList.remove('open');
  gpsPopover.setAttribute('aria-hidden', 'true');
  gpsPopoverAnchor = null;
  if (gpsPopoverIframe) {
    gpsPopoverIframe.srcdoc = '';
    gpsPopoverIframe.src = '';
  }
}

function showMapPopup(geodata, anchor) {
  toggleGpsPopover(anchor || gpsChip, geodata);
}

document.addEventListener('click', (e) => {
  if (!gpsPopover?.classList.contains('open')) return;
  if (e.target.closest('#gpsPopover') || e.target.closest('.gps-chip') || e.target.closest('#catalogMapBtn')) return;
  closeGpsPopover();
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeGpsPopover();
});

// Before/After Compare Slider Functions
let compareBarCleanup = null;

function toggleCompareMode(active) {
  compareModeActive = active;
  if (compareBtn) compareBtn.classList.toggle('active', active);
  
  const layer = media.querySelector('.media-layer.media-active');
  if (!layer) return;
  
  const oldBar = layer.querySelector('.compare-slider-bar');
  if (oldBar) oldBar.remove();
  if (compareBarCleanup) {
    compareBarCleanup();
    compareBarCleanup = null;
  }
  
  if (active) {
    if (!editPreviewImg) {
      const currentEdit = getCurrentEdit();
      applyEditPreview(currentEdit);
    }
    
    const bar = document.createElement('div');
    bar.className = 'compare-slider-bar';
    bar.innerHTML = `<div class="compare-handle">↔</div>`;
    layer.appendChild(bar);
    
    updateCompareClip();
    
    let isDragging = false;
    
    const onStart = (e) => {
      isDragging = true;
      e.preventDefault();
    };
    
    const onMove = (e) => {
      if (!isDragging) return;
      const rect = layer.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const x = clientX - rect.left;
      compareClipPct = Math.max(0, Math.min(100, (x / rect.width) * 100));
      updateCompareClip();
    };
    
    const onEnd = () => {
      isDragging = false;
    };
    
    bar.addEventListener('mousedown', onStart);
    bar.addEventListener('touchstart', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
    
    compareBarCleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchend', onEnd);
    };
  } else {
    if (editPreviewImg) {
      editPreviewImg.style.clipPath = 'none';
      editPreviewImg.style.webkitClipPath = 'none';
    }
  }
}

function updateCompareClip() {
  const layer = media.querySelector('.media-layer.media-active');
  if (!layer) return;
  
  layer.style.setProperty('--clip-pct', `${compareClipPct}%`);
  
  if (editPreviewImg) {
    editPreviewImg.style.clipPath = `inset(0 0 0 ${compareClipPct}%)`;
    editPreviewImg.style.webkitClipPath = `inset(0 0 0 ${compareClipPct}%)`;
  }
}

compareBtn?.addEventListener('click', () => {
  toggleCompareMode(!compareModeActive);
});

// Format Transcoder HUD Functions
function updateTranscodeHud() {
  const count = selectedCatalogPaths.size;
  if (count > 0) {
    if (batchCount) batchCount.textContent = `${count} item${count !== 1 ? 's' : ''}`;
    batchBar?.classList.add('visible');
  } else {
    batchBar?.classList.remove('visible');
  }
}

batchClose?.addEventListener('click', () => {
  selectedCatalogPaths.clear();
  buildCatalogContent();
  updateTranscodeHud();
});

async function runTrackedBatch(operation, label) {
  const started = await invoke('start_batch_job', { operation });
  const jobId = started?.job_id || `job-${Date.now()}`;
  setInspectorTab('jobs');
  setInspectorVisible(true);
  upsertBatchJobRow(jobId, label, { state: 'running', completed: 0, total: started?.total || 0 });
  showToast(`${label} started...`);
  const finalStatus = await trackJob(invoke, started, status => {
    upsertBatchJobRow(jobId, label, status);
    if (status.completed === status.total || status.completed % 5 === 0) {
      FolioEvents.emit('job:update', status);
    }
  });
  const failed = finalStatus.failed ? ` (${finalStatus.failed} failed)` : '';
  showToast(`${label} ${finalStatus.state}: ${finalStatus.completed}/${finalStatus.total}${failed}`);
  return finalStatus;
}

document.querySelectorAll('.batch-chip[data-fmt]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const fmt = btn.dataset.fmt;
    const count = selectedCatalogPaths.size;
    if (count === 0) return;
    
    const paths = Array.from(selectedCatalogPaths);
    
    selectedCatalogPaths.clear();
    buildCatalogContent();
    updateTranscodeHud();
    
    showToast(`Started transcoding ${count} item(s) to ${fmt.toUpperCase()}...`);
    
    try {
      await runTrackedBatch({ type: 'transcode', paths, target_format: fmt }, `Transcode to ${fmt.toUpperCase()}`);
    } catch (e) {
      showToast(`Transcode failed: ${e}`);
    }
  });
});

batchTagInput?.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const tagName = e.target.value.trim();
    if (!tagName) return;
    
    if (selectedCatalogPaths.size > 0) {
      const paths = Array.from(selectedCatalogPaths);
      const result = await invoke('batch_add_tag', { paths, tagName, tagColor: '#D4A72C' });
      for (const path of paths) {
        const existing = folderTagsCache.get(path) || [];
        if (!existing.some(t => t.name === tagName)) {
          existing.push({ name: tagName, color: '#D4A72C' });
          folderTagsCache.set(path, existing);
        }
      }
      showToast(`Added tag "${tagName}" to ${result.success} items` + (result.failed > 0 ? ` (${result.failed} failed)` : ''));
      e.target.value = '';
      await renderTagFilters();
      applyFilters();
    }
  }
});

batchTrashBtn?.addEventListener('click', async () => {
  if (selectedCatalogPaths.size > 0) {
    if (confirm(`Move ${selectedCatalogPaths.size} selected items to Trash?`)) {
      playUISound('delete');
      const paths = Array.from(selectedCatalogPaths);
      const result = await invoke('batch_trash_files', { paths });
      const trashed = new Set(paths);
      items = items.filter(it => !trashed.has(it.path));
      showToast(`Moved ${result.success} items to Trash` + (result.failed > 0 ? ` (${result.failed} failed)` : ''));
      selectedCatalogPaths.clear();
      updateCatalogSelectionState();
      buildCatalogContent();
    }
  }
});

batchFavoriteBtn?.addEventListener('click', async () => {
  if (selectedCatalogPaths.size === 0) return;
  const paths = Array.from(selectedCatalogPaths);
  try {
    const result = await invoke('set_media_favorite', { paths, favorite: true });
    paths.forEach(path => {
      const attr = mediaAttributesCache.get(path) || { path };
      attr.favorite = true;
      mediaAttributesCache.set(path, attr);
    });
    showToast(`Favorited ${result.success} item(s)`);
    buildCatalogContent();
  } catch (e) { showToast(`Favorite failed: ${e}`); }
});

batchRateBtn?.addEventListener('click', async () => {
  if (selectedCatalogPaths.size === 0) return;
  const paths = Array.from(selectedCatalogPaths);
  try {
    const result = await invoke('set_media_rating', { paths, rating: 5 });
    paths.forEach(path => {
      const attr = mediaAttributesCache.get(path) || { path };
      attr.rating = 5;
      mediaAttributesCache.set(path, attr);
    });
    showToast(`Rated ${result.success} item(s)`);
    buildCatalogContent();
  } catch (e) { showToast(`Rating failed: ${e}`); }
});

batchVaultBtn?.addEventListener('click', async () => {
  if (selectedCatalogPaths.size === 0) return;
  const paths = Array.from(selectedCatalogPaths);
  try {
    await invoke('vault_unlock');
    const finalStatus = await runTrackedBatch({ type: 'vault_add', paths }, 'Vault import');
    refreshVaultStatus();
    if (finalStatus.failed === 0) selectedCatalogPaths.clear();
    updateTranscodeHud();
  } catch (e) { showToast(`Vault import failed: ${e}`); }
});

batchSidecarBtn?.addEventListener('click', async () => {
  const paths = selectedCatalogPaths.size ? Array.from(selectedCatalogPaths) : items.map(it => it.path);
  if (!paths.length) return;
  const destination = await save({ defaultPath: 'folio-sidecar.json', filters: [{ name: 'Folio Sidecar', extensions: ['json'] }] });
  if (!destination) return;
  try {
    const result = await invoke('export_sidecar', { paths, destination });
    showToast(`Exported sidecar metadata for ${result.success} item(s)`);
  } catch (e) { showToast(`Sidecar export failed: ${e}`); }
});

batchFinderBtn?.addEventListener('click', () => {
  const first = selectedCatalogPaths.values().next().value;
  if (first) openPathInFinder(first, true);
});

// Phase 4 Secure Platform APIs Event Handlers

// Cryptographic BLAKE3 Audits
auditImageBtn?.addEventListener('click', async () => {
  if (!items || idx < 0 || idx >= items.length) {
    showToast("No active image in viewport to audit!");
    return;
  }
  const item = items[idx];
  checksumResult.textContent = "Computing...";
  showToast("Auditing file integrity via BLAKE3...");
  try {
    const hash = await invoke('audit_file_checksum', { path: item.path });
    checksumResult.textContent = hash;
    showToast("BLAKE3 Integrity Audit Verified!");
  } catch (err) {
    checksumResult.textContent = "Error";
    showToast(`Audit failed: ${err}`);
  }
});

// Cocoa Native Share Sheet Picker
nativeShareBtn?.addEventListener('click', async () => {
  if (!items || idx < 0 || idx >= items.length) {
    showToast("No active image to share!");
    return;
  }
  const item = items[idx];
  showToast("Opening macOS Native Share Sheet...");
  try {
    await invoke('show_native_share_sheet', { filePath: item.path });
  } catch (err) {
    showToast(`Sharing failed: ${err}`);
  }
});

// Spotlight NSMetadataQuery search integration
spotlightSearchBtn?.addEventListener('click', async () => {
  if (!items || items.length === 0) {
    showToast("Open a folder first!");
    return;
  }
  
  const activeImagePath = items[0].path;
  const parentPath = activeImagePath.substring(0, activeImagePath.lastIndexOf('/'));
  
  const query = prompt("Enter query to search via macOS Spotlight (leave empty to reset view):");
  if (query === null) return;
  
  if (query.trim() === '') {
    showToast("Resetting folder view...");
    items = processLoadedItems(await invoke('get_folder_items'));
    idx = 0;
    sortItems();
    buildCatalogContent();
    return;
  }
  
  showToast(`Searching Spotlight for "${query}"...`);
  try {
    const results = await invoke('search_directory_spotlight', { dirPath: parentPath, query: query.trim() });
    const lowerPaths = new Set(results.map(p => p.toLowerCase()));
    
    const matched = items.filter(it => lowerPaths.has(it.path.toLowerCase()));
    if (matched.length === 0) {
      showToast(`No matches found in Spotlight for "${query}"`);
      return;
    }
    
    items = matched;
    idx = 0;
    buildCatalogContent();
    showToast(`Spotlight found ${matched.length} matches!`);
  } catch (err) {
    showToast(`Spotlight search failed: ${err}`);
  }
});

// Lossless EXIF Metadata batch/single scrubbing
batchScrubBtn?.addEventListener('click', async () => {
  const paths = selectedCatalogPaths.size > 0 
    ? Array.from(selectedCatalogPaths) 
    : (items && idx >= 0 && idx < items.length ? [items[idx].path] : []);

  if (paths.length === 0) {
    showToast("No images selected or active in viewport to scrub EXIF!");
    return;
  }

  if (!confirm(`Are you sure you want to losslessly strip all EXIF and GPS metadata from ${paths.length} image(s)?`)) {
    return;
  }

  showToast(`Scrubbing metadata for ${paths.length} files...`);
  let result;
  try {
    result = await invoke('batch_scrub_exif', { paths });
  } catch (err) {
    showToast(`EXIF scrub failed: ${err}`);
    return;
  }

  showToast(`EXIF Scrubber: ${result.success} stripped successfully` + (result.failed > 0 ? `, ${result.failed} failed` : ''));
  
  if (result.success > 0) {
    try {
      const oldPath = items[idx]?.path;
      items = processLoadedItems(await invoke('get_folder_items'));
      sortItems();
      if (oldPath) {
        const newIdx = items.findIndex(it => it.path === oldPath);
        if (newIdx !== -1) idx = newIdx;
      }
      selectedCatalogPaths.clear();
      updateCatalogSelectionState();
      if (catalogModeActive) {
        buildCatalogContent();
      } else {
        show(idx);
      }
    } catch (e) {
      console.error("Reload after scrub failed:", e);
    }
  }
});

// Global Auto-Crash Reporter Hooks
window.onerror = function(message, source, lineno, colno, error) {
  const diagnostics = `Message: ${message}\nSource: ${source}\nLine: ${lineno}:${colno}\nError object: ${JSON.stringify(error || {})}\nStack: ${error ? error.stack : 'N/A'}`;
  invoke('submit_crash_report', { diagnostics }).then(path => {
    console.warn("Crash report captured locally in sandbox cache:", path);
  }).catch(err => {
    console.error("Failed to submit crash report:", err);
  });
  return false;
};
