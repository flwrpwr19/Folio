import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { save, open } from '@tauri-apps/plugin-dialog';
import { createEventBus } from './modules/state.js';
import { trackJob } from './modules/jobs.js';
import { initOnboarding, isOnboardingComplete, resetOnboarding } from './modules/onboarding.js';
import {
  getPinnedFolders, togglePinnedFolder, isPinned, getHomeLayout, saveHomeLayout,
  formatHomePath, folderDisplayName, getLibrarySummary, getLibrarySummaries, saveLibrarySummary,
  patchLibrarySummary,
  mergeRecentLibraryPaths, pushRecentLibraryPath, clearStoredRecentLibraryPaths,
  clearLibrarySummaries, getStoredRecentLibraryPaths, ensureLibrarySummaryStub,
} from './modules/home.js';
import { analyzeDuplicateGroup } from './modules/duplicates.js';
import { renderEmptyState, clearEmptyState, setInlineStatus } from './modules/empty-states.js';
import { initToast, showToast } from './modules/toast.js';
import { initZoomController, queueWheelZoom } from './modules/zoom.js';
import { bindVideoToolbar, detachVideoToolbar, toggleVideoPlayback } from './modules/video-player.js';
import { formatFilenameForDialog, basename, truncateDisplayName } from './modules/format.js';
import { initA11y, trapFocus } from './modules/a11y.js';
import {
  catalogFilterLabel,
  createCatalogKeyboardNav,
  bindCatalogOverflowMenu,
  syncCatalogDensityUi,
} from './modules/catalog-workspace.js';
import {
  initViewerChrome,
  bindDockOverflowMenu,
  isFilmstripVisible,
  setFilmstripVisible,
  filmstripWindowRange,
  FILMSTRIP_WINDOW_RADIUS,
  FILMSTRIP_THUMB_STEP_PX,
} from './modules/viewer-workspace.js';
import {
  initInspectorCards,
  createEditHistory,
  saveInspectorCardOrder,
  saveInspectorCardCollapsed,
  DEFAULT_INSPECTOR_CARD_ORDER,
} from './modules/inspector-workspace.js';
import {
  filterMapItems,
  itemsToMapPoints,
  clusterMapPoints,
  buildMapFrameSrcdoc,
  renderMapTray,
  formatMapClusterMeta,
  hasItemGps,
  mergeMapGpsIntoItems,
  enrichClustersForMap,
  pathsMatch,
  renderMapLocationStack,
  formatMapPlaceLabel,
} from './modules/map-workspace.js';

const editHistory = createEditHistory();

function recordEditHistory(label, path) {
  editHistory.push(label, path);
  editHistory.render($('editHistoryList'));
}

/* ── State ── */
let items = [];
const metadataHydrationKeys = new Set();
let idx = 0;
let zoom = 1;
let panX = 0, panY = 0;
let isDragging = false, startX, startY;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
let overlayVisible = false;
let isFullscreen = false;
let viewerChromeCtl = null;

function hasTauriRuntime() {
  return isTauri();
}

function listen(eventName, handler) {
  if (!hasTauriRuntime()) return Promise.resolve(() => {});
  return tauriListen(eventName, handler);
}

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
          <input class="home-search" id="homeSearchInput" type="search" placeholder="Search locations" aria-label="Search pinned and recent locations" />
          <div class="home-actions">
            <button type="button" class="home-btn home-btn-primary" id="openBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg> Open Folder</button>
            <button type="button" class="home-btn" id="homeCatalogBtn" style="display:none">Media Catalog</button>
            <button type="button" class="home-btn" id="homeSettingsBtn">Settings</button>
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
            <button type="button" class="home-layout-menu-btn" id="homeCustomizeToggle" aria-expanded="false">Home layout <span>⌄</span></button>
          </div>
          <div class="home-customize home-layout-menu" id="homeCustomizeChips" hidden></div>
        </div>
        </div>
      </aside>
      <main class="home-main">
        <div class="home-editorial">
          <section class="home-editorial-copy">
            <span class="home-welcome-eyebrow">Local media workspace</span>
            <h2>Continue where you left off.</h2>
            <p>Your photos stay on this Mac. Reopen a recent library or choose another folder.</p>
            <div class="home-editorial-actions">
              <button type="button" class="home-btn home-btn-primary home-resume-btn" id="homeResumeBtn">Resume library</button>
              <button type="button" class="home-editorial-link" id="openBtnCanvas">Choose another folder</button>
            </div>
            <div class="home-privacy-line"><span></span> Local only · No cloud sync</div>
            <button type="button" class="home-quick-hint" id="homeQuickActionsBtn"><kbd>⌘K</kbd> Quick actions</button>
          </section>
          <section class="home-editorial-preview" id="homeEditorialPreview">
            <div class="home-editorial-empty">
              <strong>No recent library</strong>
              <span>Choose a folder to start browsing.</span>
            </div>
          </section>
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

    <div class="nav-section nav-section--filters" id="catalogFilterRail">
      <div class="nav-section-label">Smart Filters</div>
      <button type="button" class="nav-item active" data-nav="all"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> All Photos</button>
      <button type="button" class="nav-item" data-nav="favorites"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.18L12 21z"/></svg> Favorites</button>
      <button type="button" class="nav-item" data-nav="rated"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Rated 3+</button>
      <button type="button" class="nav-item" data-nav="gps"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg> GPS</button>
      <button type="button" class="nav-item" data-nav="map" title="Browse geotagged media on a map"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 20l-5.447-2.724A2 2 0 013 15.382V6.618a2 2 0 011.553-1.894L9 2m0 18l6-3m-6 3V2m6 15l5.447 2.724A2 2 0 0021 17.382V8.618a2 2 0 00-1.553-1.894L15 4m0 13V4M9 7l6 3"/></svg> Map View</button>
      <button type="button" class="nav-item" data-nav="raw"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg> RAW / HEIC</button>
      <button type="button" class="nav-item" data-nav="videos"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Videos</button>
      <button type="button" class="nav-item" data-nav="duplicates"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg> Duplicates</button>
    </div>
    <div class="sidebar-catalog-status" id="sidebarCatalogStatus" hidden>
      <span class="sidebar-catalog-status-dot" aria-hidden="true"></span>
      <span id="sidebarCatalogStatusText">Updated just now</span>
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
  <div class="catalog-grid-view" id="catalogGrid">
    <header class="catalog-command-bar" id="cDrag" data-tauri-drag-region>
      <div class="catalog-command-leading">
        <button type="button" class="catalog-command-icon" id="catalogBackBtn" aria-label="Back to viewer" title="Back to viewer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="catalog-command-title">
          <span class="catalog-command-kicker">Catalog</span>
          <strong id="catalogScopeLabel">All Photos</strong>
        </div>
        <nav class="catalog-command-segments" aria-label="Catalog tools">
          <button type="button" class="catalog-segment is-active" data-catalog-segment="browse">Browse</button>
          <button type="button" class="catalog-segment" id="catalogFilterFocusBtn" data-catalog-segment="filter">Filter</button>
          <button type="button" class="catalog-segment" id="catalogSortMenuBtn" data-catalog-segment="sort" aria-haspopup="menu" aria-expanded="false">Sort</button>
          <button type="button" class="catalog-segment" id="catalogSelectModeBtn" data-catalog-segment="select" aria-pressed="false">Select</button>
        </nav>
      </div>
      <div class="catalog-command-trailing">
        <span class="catalog-command-stat" id="catalogCountPill">0 items</span>
        <span class="catalog-command-stat catalog-command-stat--muted" id="catalogSortPill">Name</span>
        <div class="catalog-command-utilities" aria-label="Quick actions">
          <button type="button" class="catalog-command-icon" id="catalogFavoritesQuickBtn" aria-label="Show favorites" title="Favorites"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.18L12 21z"/></svg></button>
          <button type="button" class="catalog-command-icon" id="catalogFinderBtn" aria-label="Reveal in Finder" title="Finder"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>
          <button type="button" class="catalog-command-icon" id="catalogMapBtn" aria-label="Map view" title="Map view"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg></button>
        </div>
        <input class="catalog-search" id="catalogSearchInput" type="search" placeholder="Search filenames" aria-label="Search catalog filenames" />
        <button type="button" class="catalog-command-icon" id="catalogOverflowBtn" aria-label="More catalog actions" aria-haspopup="menu" aria-expanded="false" title="More">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></svg>
        </button>
      </div>
    </header>
    <menu class="catalog-overflow-menu" id="catalogOverflowMenu" hidden>
      <button type="button" role="menuitem" data-catalog-action="map">Map view</button>
      <button type="button" role="menuitem" data-catalog-action="duplicates">Find duplicates</button>
      <button type="button" role="menuitem" data-catalog-action="save-smart">Save smart album</button>
      <button type="button" role="menuitem" data-catalog-action="finder">Reveal in Finder</button>
      <button type="button" role="menuitem" data-catalog-action="new-folder">New folder</button>
      <button type="button" role="menuitem" data-catalog-action="close">Close catalog</button>
    </menu>
    <menu class="catalog-sort-menu" id="catalogSortMenu" hidden>
      <button type="button" role="menuitemradio" data-sort="name" aria-checked="true">Name</button>
      <button type="button" role="menuitemradio" data-sort="date">Date</button>
      <button type="button" role="menuitemradio" data-sort="dimensions">Dimensions</button>
      <button type="button" role="menuitemradio" data-sort="size">Size</button>
      <button type="button" role="menuitemradio" data-sort="rating">Rating</button>
    </menu>
    <select class="visually-hidden" id="catalogSortSelect" aria-hidden="true" tabindex="-1"><option value="name">Name</option><option value="date">Date</option><option value="dimensions">Dimensions</option><option value="size">Size</option><option value="rating">Rating</option></select>
    <select class="visually-hidden" id="smartFilterSelect" aria-hidden="true" tabindex="-1"><option value="">All Photos</option><option value="favorites">Favorites</option><option value="rated">Rated 3+</option><option value="gps">GPS</option><option value="raw">RAW/HEIC</option><option value="videos">Videos</option><option value="duplicates">Duplicates</option></select>
    <button type="button" id="catalogDuplicatesBtn" class="visually-hidden" tabindex="-1" aria-hidden="true">Find duplicates</button>
    <button type="button" id="saveSmartAlbumBtn" class="visually-hidden" tabindex="-1" aria-hidden="true">Save smart</button>
    <button type="button" id="catalogNewFolderBtn" class="visually-hidden" tabindex="-1" aria-hidden="true">New folder</button>
    <button type="button" id="catalogCloseBtn" class="visually-hidden" tabindex="-1" aria-hidden="true">Close</button>
    <div class="catalog-workspace-body">
      <div class="catalog-grid-toolbar">
        <div class="catalog-grid-heading">
          <h2 id="catalogTitle">All Photos</h2>
          <p class="catalog-grid-subtitle" id="catalogSubtitle">0 items</p>
        </div>
        <div class="catalog-view-controls">
          <span class="catalog-view-label">View</span>
          <div class="catalog-density" role="group" aria-label="Catalog thumbnail size">
            <button type="button" class="catalog-density-btn" data-density="112" aria-label="Compact thumbnails">S</button>
            <button type="button" class="catalog-density-btn active" data-density="160" aria-label="Medium thumbnails">M</button>
            <button type="button" class="catalog-density-btn" data-density="240" aria-label="Large thumbnails">L</button>
          </div>
          <input type="range" class="catalog-density-slider" id="catalogDensitySlider" min="96" max="280" step="8" value="160" aria-label="Thumbnail size" />
        </div>
      </div>
      <div class="catalog-filter-bar" id="catalogFilterBar" hidden></div>
      <div class="folio-state-host" id="catalogStateHost" aria-hidden="true"></div>
      <div class="catalog-content" id="catalogContent" tabindex="0" role="grid" aria-label="Media catalog"></div>
    </div>
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

  <div class="map-workspace" id="mapWorkspace" hidden>
    <header class="map-command-bar" id="mapDrag" data-tauri-drag-region>
      <div class="map-command-leading">
        <button type="button" class="map-back-btn" id="mapBackBtn" aria-label="Leave map view">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="map-command-heading">
          <h2 class="map-title" id="mapTitle">Map View</h2>
          <p class="map-subtitle" id="mapSubtitle">GPS-tagged media</p>
        </div>
      </div>
      <div class="map-command-tools" aria-label="Map display controls">
        <select class="map-style-select" id="mapStyleSelect" aria-label="Map style">
          <option value="dark">Carto Dark</option>
          <option value="atlas">Folio Atlas</option>
          <option value="light">Carto Light</option>
          <option value="voyager">Voyager</option>
        </select>
        <button type="button" class="map-tool-btn" id="mapReverseToggle" aria-pressed="false">Reverse lookup</button>
        <button type="button" class="map-tool-btn" id="mapFitBtn">Fit</button>
      </div>
      <div class="map-filter-rail" role="group" aria-label="Map filters">
        <button type="button" class="map-filter-btn active" data-map-filter="all">All GPS</button>
        <button type="button" class="map-filter-btn" data-map-filter="favorites">Favorites</button>
        <button type="button" class="map-filter-btn" data-map-filter="rated">Rated 3+</button>
      </div>
    </header>
    <div class="map-body">
      <iframe class="map-frame" id="mapWorkspaceFrame" title="Map explorer" tabindex="-1" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
      <aside class="map-location-card" id="mapLocationCard" hidden>
        <div class="map-location-card-stack" id="mapLocationThumb" aria-hidden="true"></div>
        <div class="map-location-card-copy">
          <h3 id="mapLocationName">Location</h3>
          <p id="mapLocationMeta"></p>
          <button type="button" class="map-open-viewer-btn" id="mapOpenViewerBtn">Open in viewer</button>
        </div>
      </aside>
      <div class="map-empty-state" id="mapEmptyState" hidden>
        <p class="map-empty-title">No GPS media here</p>
        <p class="map-empty-copy">Import or filter a folder with location metadata to explore it on the map.</p>
      </div>
      <p class="map-privacy-note">Coordinates stay on this device. Map tiles may load from the network; your library does not.</p>
    </div>
    <footer class="map-tray" id="mapTray">
      <div class="map-tray-head">
        <div class="map-tray-head-text">
          <span class="map-tray-title" id="mapTrayTitle">Select a location</span>
          <span class="map-tray-count" id="mapTrayCount"></span>
        </div>
      </div>
      <div class="map-tray-scroll" id="mapTrayScroll" role="list" aria-label="Photos at this location"></div>
    </footer>
  </div>

  <div class="viewer" id="viewer">
    <div class="folio-state-host folio-state-host--viewer" id="viewerStateHost" aria-hidden="true"></div>
    <div class="viewer-bg-base"></div>
    <div class="backdrop-glow" id="backdropGlow"></div>
    <div class="viewer-dragbar" id="vDrag" data-tauri-drag-region></div>
    <div class="viewer-topbar" id="viewerTopbar">
      <div class="viewer-topbar-copy">
        <span class="viewer-topbar-path" id="viewerTopPath">Library</span>
        <strong class="viewer-topbar-name" id="viewerTopName">No media selected</strong>
      </div>
      <div class="viewer-topbar-meta">
        <span class="viewer-topbar-count" id="viewerTopCount"></span>
        <button type="button" class="viewer-topbar-icon" id="viewerTopFavoriteBtn" aria-label="Toggle favorite" title="Favorite">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.18L12 21z"/></svg>
        </button>
        <button type="button" class="viewer-topbar-icon" id="viewerShareBtn" aria-label="Share" title="Share">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13"/></svg>
        </button>
        <button type="button" class="viewer-topbar-icon" id="viewerFullscreenTopBtn" aria-label="Fullscreen" title="Fullscreen">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
        </button>
      </div>
    </div>
    <button class="sidebar-toggle" id="sidebarToggle" data-tooltip="Toggle Sidebar (B)" aria-label="Collapse sidebar" aria-expanded="true"><svg class="sidebar-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></button>
    <div class="media-wrap" id="media">
      <div class="media-loader" id="mediaLoader" aria-hidden="true">
        <svg class="loader-ring" viewBox="0 0 44 44">
          <circle class="loader-track" cx="22" cy="22" r="18"></circle>
          <circle class="loader-indicator" cx="22" cy="22" r="18"></circle>
        </svg>
      </div>
    </div>
    <div class="editorial-overlay" id="editorialOverlay" aria-hidden="true" style="display:none !important;"></div>
    <button class="nav-arrow prev" id="prev" aria-label="Previous media">‹</button>
    <button class="nav-arrow next" id="next" aria-label="Next media">›</button>
    <div class="viewer-chrome" id="viewerChrome">
      <div class="viewer-dock-panel" id="viewerDockPanel">
        <div class="viewer-dock-filmstrip" id="viewerFilmstripRow">
          <button type="button" class="filmstrip-nav-btn" id="filmstripPrevBtn" aria-label="Previous photo">‹</button>
          <div class="viewer-filmstrip-wrap">
            <div class="filmstrip viewer-filmstrip" id="filmstrip" role="listbox" aria-label="Filmstrip"></div>
          </div>
          <button type="button" class="filmstrip-nav-btn" id="filmstripNextBtn" aria-label="Next photo">›</button>
        </div>
        <div class="viewer-toolbar viewer-dock" id="viewerToolbar">
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
          <button type="button" class="vt-btn viewer-text-tool" id="viewerCompareBtn" data-tooltip="Compare with original" aria-label="Compare with original">Compare</button>
          <div class="v-volume-container toolbar-video-only" id="viewerVideoVolWrap" hidden>
            <button type="button" class="vt-btn vt-btn-icon v-volume-btn" id="viewerVideoVolBtn" aria-label="Mute or unmute">
              <svg class="v-icon-volume-high" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              <svg class="v-icon-volume-muted" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
            </button>
            <input type="range" class="v-volume-slider" id="viewerVideoVolSlider" min="0" max="100" value="100" aria-label="Volume">
          </div>
        </div>
        <span class="viewer-toolbar-divider" aria-hidden="true"></span>
        <button type="button" class="vt-btn vt-btn-icon" id="viewerInspectorBtn" data-tooltip="Inspector (I)" aria-label="Toggle inspector">
          <svg class="vt-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        </button>
        <span class="viewer-toolbar-divider viewer-dock-divider-zoom" aria-hidden="true"></span>
        <div class="zoom-hud-inline">
          <button type="button" class="vt-btn vt-btn-icon zoom-step-btn" id="zoomOutBtn" aria-label="Zoom out">−</button>
          <input type="range" id="zoomSlider" min="100" max="800" value="100" step="10" aria-label="Zoom level" />
          <span class="zoom-label" id="zoomLabel">100%</span>
          <button type="button" class="vt-btn vt-btn-icon zoom-step-btn" id="zoomInBtn" aria-label="Zoom in">+</button>
          <button type="button" class="zoom-reset" id="zoomReset" data-tooltip="Fit to Screen (0)">Fit</button>
          <button type="button" class="zoom-action fullscreen-toggle" id="fullscreenBtn" data-tooltip="Fullscreen (F)" aria-label="Fullscreen">⛶</button>
        </div>
        <button type="button" class="vt-btn vt-btn-icon" id="editToggleBtn" data-tooltip="Edit Photo (E)" aria-label="Edit">
          <svg class="vt-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button type="button" class="vt-btn viewer-text-tool" id="viewerRotateQuickBtn" data-tooltip="Rotate 90°" aria-label="Rotate 90 degrees">Rotate</button>
        <button type="button" class="vt-btn vt-btn-icon" id="viewerDockOverflowBtn" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" title="More">
          <svg class="vt-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
        </button>
        </div>
      </div>
    </div>
    <menu class="viewer-dock-menu" id="viewerDockMenu" hidden>
      <button type="button" role="menuitem" data-viewer-action="reveal">Reveal in Finder</button>
      <button type="button" role="menuitem" data-viewer-action="share">Share</button>
      <button type="button" role="menuitem" data-viewer-action="tag">Add tag</button>
      <button type="button" role="menuitem" data-viewer-action="command">Quick actions ⌘K</button>
      <button type="button" role="menuitem" data-viewer-action="filmstrip">Toggle filmstrip</button>
    </menu>
  </div>
  </div>

  <aside class="inspector-pane visible" id="inspectorPane">
    <button type="button" class="inspector-edge-btn" id="inspectorCollapseBtn" aria-label="Collapse inspector" aria-expanded="true">
      <svg class="inspector-edge-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>
    </button>
    <div class="inspector-inner">
    <div class="inspector-header">
      <div class="inspector-tabs" role="tablist" aria-label="Inspector">
        <button type="button" class="inspector-tab active" id="inspectorTabInfo" data-inspector="info" role="tab" aria-controls="inspectorInfo" aria-selected="true" tabindex="0">Info</button>
        <button type="button" class="inspector-tab" id="inspectorTabAdjust" data-inspector="adjust" role="tab" aria-controls="inspectorAdjust" aria-selected="false" tabindex="-1">Adjust</button>
        <button type="button" class="inspector-tab" id="inspectorTabPresets" data-inspector="presets" role="tab" aria-controls="inspectorPresets" aria-selected="false" tabindex="-1">Presets</button>
        <button type="button" class="inspector-tab" id="inspectorTabJobs" data-inspector="jobs" role="tab" aria-controls="inspectorJobs" aria-selected="false" tabindex="-1">Jobs</button>
      </div>
    </div>
    <div class="inspector-body">
      <div class="inspector-panel active" id="inspectorInfo" data-panel="info" role="tabpanel" aria-labelledby="inspectorTabInfo">
        <div class="inspector-cards-host" id="inspectorCardsHost">
        <div class="inspector-card inspector-meta" data-inspector-card="file">
          <div class="inspector-card-title">File</div>
          <div class="counter" id="counter"></div>
          <div class="filename" id="fname"></div>
          <div class="dimensions" id="dims"></div>
          <span class="format-badge" id="badge" style="display:none"></span>
          <div class="inspector-copy-row">
            <button type="button" class="inspector-copy-btn" id="inspectorCopyNameBtn">Copy name</button>
            <button type="button" class="inspector-copy-btn" id="inspectorCopyPathBtn">Copy path</button>
            <button type="button" class="inspector-copy-btn" id="inspectorCopyGpsBtn">Copy GPS</button>
            <button type="button" class="inspector-copy-btn" id="inspectorCopyCameraBtn">Copy camera</button>
          </div>
        </div>
        <div class="inspector-card" data-inspector-card="camera">
          <div class="inspector-card-title">Camera</div>
          <div class="editorial-camera" id="edCamera"></div>
          <div class="inspector-exif-grid">
            <div class="inspector-exif-item"><span>Aperture</span><span id="edAperture">—</span></div>
            <div class="inspector-exif-item"><span>Shutter</span><span id="edShutter">—</span></div>
            <div class="inspector-exif-item"><span>ISO</span><span id="edIso">—</span></div>
            <div class="inspector-exif-item"><span>Focal</span><span id="edFocal">—</span></div>
          </div>
          <div class="editorial-tech-data" id="edTechData"></div>
        </div>
        <div class="inspector-card inspector-location-card editorial-gps" id="edGps" data-inspector-card="location" style="display:none">
          <div class="inspector-card-title">Location</div>
          <div id="edAddress" class="gps-address"></div>
          <button type="button" class="gps-chip" id="gpsChip"></button>
          <div class="inspector-location-actions">
            <button type="button" class="inspector-copy-btn" id="inspectorShowMapBtn">Show in Map</button>
            <button type="button" class="inspector-copy-btn" id="inspectorCopyGpsBtn2">Copy GPS</button>
          </div>
        </div>
        <div class="inspector-card" data-inspector-card="date" id="edDateCard" style="display:none">
          <div class="inspector-card-title">Date &amp; Time</div>
          <div class="inspector-date-value" id="edDateTime">—</div>
        </div>
        <div class="inspector-card inspector-tags-card" data-inspector-card="tags">
          <div class="inspector-card-title">Tags</div>
          <div class="inspector-tag-list" id="inspectorTagList"></div>
          <div class="inspector-tag-entry">
            <input type="text" id="inspectorTagInput" placeholder="Add tags…" aria-label="Add tag to current media" />
            <button type="button" id="inspectorTagAddBtn">Add</button>
          </div>
        </div>
        <div class="inspector-card" data-inspector-card="analysis">
          <div class="inspector-card-title">Analysis</div>
          <div class="inspector-analysis-head">
            <button type="button" class="settings-update-btn inspector-suggest-btn" id="classifySuggestBtn">Suggest tags</button>
          </div>
          <div id="classifyResults" class="classify-results" hidden></div>
          <canvas class="editorial-histogram" id="histogramCanvas" width="260" height="48" aria-hidden="true"></canvas>
          <canvas class="editorial-waveform" id="waveformCanvas" width="260" height="48" aria-hidden="true"></canvas>
          <div class="editorial-palette" id="editorialPalette">
            <span class="inspector-palette-label">Dominant palette</span>
            <div id="paletteChips" class="inspector-palette-chips">
              <div class="palette-chip"></div>
              <div class="palette-chip"></div>
              <div class="palette-chip"></div>
              <div class="palette-chip"></div>
              <div class="palette-chip"></div>
            </div>
          </div>
        </div>
        </div>
        <button type="button" class="inspector-customize-btn" id="inspectorCustomizeBtn">Customize inspector</button>
        <div class="editorial-resizer" id="editorialResizer" style="display:none;"></div>
      </div>
      <div class="inspector-panel" id="inspectorAdjust" data-panel="adjust" role="tabpanel" aria-labelledby="inspectorTabAdjust" hidden>
        <div class="edit-panel" id="editPanel" aria-hidden="false">
          <div class="edit-panel-header">
            <div class="edit-panel-header-row">
              <span class="edit-panel-title">Adjust</span>
              <div class="edit-panel-actions">
                <button type="button" class="edit-action-btn" id="editResetBtn">Reset</button>
                <button type="button" class="edit-action-btn edit-export-btn" id="editExportBtn">Export</button>
              </div>
            </div>
          </div>
          <canvas class="editorial-histogram edit-adjust-histogram" id="adjustHistogramCanvas" width="260" height="44" aria-hidden="true"></canvas>
          <div class="edit-preset-strip" id="adjustPresetStrip" aria-label="Quick presets"></div>
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
          <div class="edit-history-block">
            <div class="edit-section-label">History</div>
            <div class="edit-history-list" id="editHistoryList"></div>
          </div>
          <div class="edit-footer">
            <div class="edit-footer-transforms">
              <button type="button" class="edit-flip-btn" id="rotateBtn">Rotate 90°</button>
              <button type="button" class="edit-flip-btn" id="flipHBtn">Flip H</button>
              <button type="button" class="edit-flip-btn" id="flipVBtn">Flip V</button>
            </div>
            <button type="button" class="edit-flip-btn edit-crop-btn" id="cropBtn">Crop</button>
          </div>
        </div>
      </div>
      <div class="inspector-panel" id="inspectorPresets" data-panel="presets" role="tabpanel" aria-labelledby="inspectorTabPresets" hidden>
        <div class="inspector-card">
          <div class="inspector-card-title">Presets</div>
          <p class="inspector-presets-hint">Apply a look in one tap. Save your current sliders as a custom preset.</p>
          <div class="edit-preset-grid" id="editPresetGrid"></div>
          <button type="button" class="edit-preset-save-btn" id="saveEditPresetBtn">Save current adjustments</button>
        </div>
      </div>
      <div class="inspector-panel" id="inspectorJobs" data-panel="jobs" role="tabpanel" aria-labelledby="inspectorTabJobs" hidden>
        <div class="batch-jobs-list" id="batchJobsList"></div>
      </div>
    </div>
    </div>
  </aside>
  </div>

  <div class="gps-popover" id="gpsPopover" aria-hidden="true">
    <iframe class="gps-popover-map" id="gpsPopoverIframe" title="Location map" tabindex="-1" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
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
          <nav class="settings-categories" role="tablist" aria-label="Settings sections">
            <button type="button" class="settings-nav-item active" id="settingsTabGeneral" role="tab" aria-controls="tab-general" aria-selected="true" tabindex="0" data-tab="general">General</button>
            <button type="button" class="settings-nav-item" id="settingsTabAppearance" role="tab" aria-controls="tab-appearance" aria-selected="false" tabindex="-1" data-tab="appearance">Appearance</button>
            <button type="button" class="settings-nav-item" id="settingsTabCatalog" role="tab" aria-controls="tab-catalog" aria-selected="false" tabindex="-1" data-tab="catalog">Catalog</button>
            <button type="button" class="settings-nav-item" id="settingsTabCache" role="tab" aria-controls="tab-cache" aria-selected="false" tabindex="-1" data-tab="cache">Cache</button>
            <button type="button" class="settings-nav-item" id="settingsTabExport" role="tab" aria-controls="tab-export" aria-selected="false" tabindex="-1" data-tab="export">Export</button>
            <button type="button" class="settings-nav-item" id="settingsTabShortcuts" role="tab" aria-controls="tab-shortcuts" aria-selected="false" tabindex="-1" data-tab="shortcuts">Shortcuts</button>
            <button type="button" class="settings-nav-item" id="settingsTabSecurity" role="tab" aria-controls="tab-security" aria-selected="false" tabindex="-1" data-tab="security">Security</button>
            <button type="button" class="settings-nav-item" id="settingsTabAdvanced" role="tab" aria-controls="tab-advanced" aria-selected="false" tabindex="-1" data-tab="advanced">Advanced</button>
          </nav>
        </div>
      </aside>
      <main class="settings-main">
        <header class="settings-main-head" data-tauri-drag-region>
          <h2 class="settings-pane-title" id="settingsPaneTitle">General</h2>
        </header>
        <div class="settings-main-body">

        <div class="tab-pane active" id="tab-general" role="tabpanel" aria-labelledby="settingsTabGeneral">
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
        <div class="tab-pane" id="tab-appearance" role="tabpanel" aria-labelledby="settingsTabAppearance" hidden>
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

        <div class="tab-pane" id="tab-catalog" role="tabpanel" aria-labelledby="settingsTabCatalog" hidden>
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
          <div class="settings-section-label" style="margin-top: 12px;">Viewer</div>
          <div class="setting-row">
            <label for="filmstripVisibleCheck">Show filmstrip in viewer</label>
            <input type="checkbox" id="filmstripVisibleCheck" checked />
          </div>
        </div>

        <div class="tab-pane" id="tab-cache" role="tabpanel" aria-labelledby="settingsTabCache" hidden>
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

        <div class="tab-pane" id="tab-export" role="tabpanel" aria-labelledby="settingsTabExport" hidden>
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
            <input type="text" id="watermarkInput" aria-label="Watermark text" placeholder="Watermark text…" style="flex: 1;" />
            <select id="watermarkAnchorSelect" aria-label="Watermark position" style="width: 120px;">
              <option value="bottom-right">Bottom Right</option>
              <option value="bottom-left">Bottom Left</option>
              <option value="top-right">Top Right</option>
              <option value="top-left">Top Left</option>
              <option value="center">Center</option>
            </select>
          </div>
          <div class="watermark-input-row" id="watermarkAdvancedRow" style="display: flex; gap: 8px; margin-top: 8px;">
            <input type="range" id="watermarkOpacitySlider" min="10" max="100" value="70" title="Opacity" aria-label="Watermark opacity" />
            <input type="range" id="watermarkScaleSlider" min="50" max="200" value="100" title="Scale" aria-label="Watermark scale" />
            <input type="range" id="watermarkFontSlider" min="12" max="72" value="32" title="Font size" aria-label="Watermark font size" />
          </div>
        </div>

        <div class="tab-pane" id="tab-shortcuts" role="tabpanel" aria-labelledby="settingsTabShortcuts" hidden>
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

        <div class="tab-pane" id="tab-advanced" role="tabpanel" aria-labelledby="settingsTabAdvanced" hidden>
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

        <div class="tab-pane" id="tab-security" role="tabpanel" aria-labelledby="settingsTabSecurity" hidden>
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
  <div id="toastContainer" class="toast-container" role="status" aria-live="polite" aria-atomic="true"></div>
  <div class="command-palette-overlay" id="commandPalette" hidden>
    <div class="command-palette" role="dialog" aria-modal="true" aria-labelledby="commandPaletteTitle">
      <div class="command-palette-head">
        <span id="commandPaletteTitle">Quick actions</span>
        <kbd>ESC</kbd>
      </div>
      <input id="commandPaletteInput" type="search" placeholder="Search actions" aria-label="Search quick actions" />
      <div class="command-palette-list" id="commandPaletteList"></div>
    </div>
  </div>
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
const welcome = $('welcome'), sidebar = $('sidebar'), sidebarResizer = $('sidebarResizer'), sidebarToggle = $('sidebarToggle'), viewer = $('viewer'), media = $('media'), mediaLoader = $('mediaLoader'), filmstrip = $('filmstrip'), breadcrumbs = $('breadcrumbs'), gridToggleBtn = $('gridToggleBtn'), counter = $('counter'), fname = $('fname'), dims = $('dims'), badge = $('badge'), edOverlay = $('editorialOverlay'), edCamera = $('edCamera'), edAperture = $('edAperture'), edShutter = $('edShutter'), edIso = $('edIso'), edFocal = $('edFocal'), edTechData = $('edTechData'), backdropGlow = $('backdropGlow'), editPanel = $('editPanel'), editToggleBtn = $('editToggleBtn'), editCloseBtn = $('editCloseBtn'), editResetBtn = $('editResetBtn'), editExportBtn = $('editExportBtn'), rotateBtn = $('rotateBtn'), flipHBtn = $('flipHBtn'), flipVBtn = $('flipVBtn'), cropBtn = $('cropBtn'), dropzoneGlow = $('dropzoneGlow'), zoomSlider = $('zoomSlider'), zoomLabel = $('zoomLabel'), zoomReset = $('zoomReset'), fullscreenBtn = $('fullscreenBtn'), imageFsExit = $('imageFsExit'), sortSelect = $('sortSelect'), zoomSensSlider = $('zoomSensSlider'), themeSelect = $('themeSelect'), cinematicCheck = $('cinematicCheck'), recentFoldersCheck = $('recentFoldersCheck'), stripMetadataCheck = $('stripMetadataCheck'), vibrancyCheck = $('vibrancyCheck'), reverseGeocodeCheck = $('reverseGeocodeCheck'), soundVolumeSlider = $('soundVolumeSlider'), soundVolumeVal = $('soundVolumeVal'), catalogGrid = $('catalogGrid'), catalogContent = $('catalogContent'), catalogStateHost = $('catalogStateHost'), viewerStateHost = $('viewerStateHost'), catalogTitle = $('catalogTitle'), catalogNewFolderBtn = $('catalogNewFolderBtn'), catalogFinderBtn = $('catalogFinderBtn'), catalogMapBtn = $('catalogMapBtn'), catalogDuplicatesBtn = $('catalogDuplicatesBtn'), catalogCloseBtn = $('catalogCloseBtn'), smartFilterSelect = $('smartFilterSelect'), saveSmartAlbumBtn = $('saveSmartAlbumBtn'), tagFilterPanel = $('tagFilterPanel'), tagFilterList = $('tagFilterList'), sidebarCatalogBtn = $('sidebarCatalogBtn'), edGps = $('edGps'), gpsChip = $('gpsChip'), edAddress = $('edAddress'), batchBar = $('batchBar'), batchCount = $('batchCount'), batchClose = $('batchClose'), colorBlindSelect = $('colorBlindSelect'), watermarkInput = $('watermarkInput'), watermarkAnchorSelect = $('watermarkAnchorSelect'), watermarkOpacitySlider = $('watermarkOpacitySlider'), watermarkScaleSlider = $('watermarkScaleSlider'), watermarkFontSlider = $('watermarkFontSlider'), batchTagInput = $('batchTagInput'), batchTrashBtn = $('batchTrashBtn'), batchFavoriteBtn = $('batchFavoriteBtn'), batchRateBtn = $('batchRateBtn'), batchVaultBtn = $('batchVaultBtn'), batchSidecarBtn = $('batchSidecarBtn'), batchFinderBtn = $('batchFinderBtn');
const catalogSearchInput = $('catalogSearchInput'), catalogFilterBar = $('catalogFilterBar'), catalogSortSelect = $('catalogSortSelect'), catalogSelectModeBtn = $('catalogSelectModeBtn'), catalogSubtitle = $('catalogSubtitle'), catalogBackBtn = $('catalogBackBtn'), catalogOverflowBtn = $('catalogOverflowBtn'), catalogOverflowMenu = $('catalogOverflowMenu'), catalogSortMenu = $('catalogSortMenu'), catalogSortMenuBtn = $('catalogSortMenuBtn'), catalogDensitySlider = $('catalogDensitySlider'), catalogFilterFocusBtn = $('catalogFilterFocusBtn'), catalogFavoritesQuickBtn = $('catalogFavoritesQuickBtn'), catalogFilterRail = $('catalogFilterRail'), catalogScopeLabel = $('catalogScopeLabel'), catalogCountPill = $('catalogCountPill'), catalogSortPill = $('catalogSortPill'), sidebarCatalogStatus = $('sidebarCatalogStatus'), sidebarCatalogStatusText = $('sidebarCatalogStatusText'), viewerTopPath = $('viewerTopPath'), viewerTopName = $('viewerTopName'), viewerTopCount = $('viewerTopCount'), viewerMediaKind = $('viewerMediaKind'), viewerCompareBtn = $('viewerCompareBtn'), viewerRotateQuickBtn = $('viewerRotateQuickBtn'), inspectorTagList = $('inspectorTagList'), inspectorTagInput = $('inspectorTagInput'), commandPalette = $('commandPalette'), commandPaletteInput = $('commandPaletteInput'), commandPaletteList = $('commandPaletteList');

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
let mapModeActive = false;
let mapReturnCatalog = false;
let mapClusters = [];
let mapSelectedClusterId = null;
let mapFilterMode = 'all';
let mapSelectedTrayPath = null;
let mapGpsSyncGeneration = 0;
let inspectorPaneVisible = true;
let zenModeActive = false;
let zenSidebarWasVisible = true;
let zenInspectorWasVisible = false;
let openedLibraryPath = null;
const batchJobRows = new Map();

const appShell = $('appShell');
const inspectorPane = $('inspectorPane');
const inspectorCollapseBtn = $('inspectorCollapseBtn');
const gpsPopover = $('gpsPopover');
const gpsPopoverIframe = $('gpsPopoverIframe');
const mapStyleSelect = $('mapStyleSelect');
const mapReverseToggle = $('mapReverseToggle');
const mapFitBtn = $('mapFitBtn');
const batchJobsList = $('batchJobsList');
const resetOnboardingBtn = $('resetOnboardingBtn');
const batchJobHistory = [];
const undoStack = [];

function setAppShellVisible(visible) {
  if (appShell) appShell.style.display = visible ? 'flex' : 'none';
}

function isSettingsOpen() {
  return settingsPage && settingsPage.style.display !== 'none';
}

function enhanceSettingsPanelStructure() {
  if (!settingsPage || settingsPage.dataset.enhanced === '1') return;
  settingsPage.dataset.enhanced = '1';
  const paneSummaries = {
    general: 'Startup, recents, default app behavior, and feedback volume.',
    appearance: 'Theme, accessibility, contrast, and motion preferences.',
    catalog: 'Grid defaults, prefetch behavior, and viewer filmstrip preferences.',
    cache: 'Storage use, cache limits, pruning, and destructive cache actions.',
    export: 'Export privacy, watermark defaults, and output treatment.',
    shortcuts: 'Keyboard assignments for navigation, viewing, editing, and workspace toggles.',
    security: 'Vault state, platform actions, and integrity checks.',
    advanced: 'Diagnostics, performance HUD, zoom tuning, and location lookup.',
  };

  settingsPage.querySelectorAll('.settings-nav-item').forEach((btn) => {
    const summary = paneSummaries[btn.dataset.tab];
    if (!summary || btn.querySelector('.settings-nav-item-sub')) return;
    const label = btn.textContent.trim();
    btn.replaceChildren();
    const title = document.createElement('span');
    title.className = 'settings-nav-item-title';
    title.textContent = label;
    const sub = document.createElement('span');
    sub.className = 'settings-nav-item-sub';
    sub.textContent = summary.split(',')[0];
    btn.append(title, sub);
  });

  settingsPage.querySelectorAll('.tab-pane').forEach((pane) => {
    if (pane.dataset.enhanced === '1') return;
    pane.dataset.enhanced = '1';
    const tab = pane.id.replace('tab-', '');
    const intro = document.createElement('p');
    intro.className = 'settings-pane-summary';
    intro.textContent = paneSummaries[tab] || 'Preferences for this workspace area.';
    pane.prepend(intro);

    const nodes = [...pane.children].filter((node) => !node.classList?.contains('settings-pane-summary'));
    let currentGroup = null;
    const createGroup = (titleText = '') => {
      const group = document.createElement('section');
      group.className = 'settings-card';
      if (titleText) {
        const heading = document.createElement('h3');
        heading.className = 'settings-card-title';
        heading.textContent = titleText;
        group.appendChild(heading);
      }
      pane.appendChild(group);
      return group;
    };

    nodes.forEach((node) => {
      if (node.classList?.contains('settings-section-label')) {
        currentGroup = createGroup(node.textContent.trim());
        node.remove();
        return;
      }
      if (!currentGroup) currentGroup = createGroup();
      currentGroup.appendChild(node);
    });
  });
}

enhanceSettingsPanelStructure();

function showHomeHub(animate = false) {
  welcome?.classList.remove('hidden');
  if (welcome) welcome.style.display = '';
  setAppShellVisible(false);
  homeSearchTerm = '';
  const homeSearch = $('homeSearchInput');
  if (homeSearch) homeSearch.value = '';
  scheduleHomeHubRefresh();
  if (animate && welcome && !reducedMotionEnabled) {
    welcome.classList.add('home-entering');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => welcome.classList.remove('home-entering'));
    });
  }
}

function isLibraryShellVisible() {
  return appShell && appShell.style.display !== 'none';
}

function goHome() {
  closeGpsPopover();
  if (isSettingsOpen()) {
    closeSettings();
    return;
  }
  if (!items.length && !openedLibraryPath && !isLibraryShellVisible()) {
    showHomeHub(false);
    return;
  }
  const finish = () => {
    catalogModeActive = false;
    mapModeActive = false;
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
    setMainWorkspace('');
    document.body.classList.remove('map-workspace-active', 'catalog-workspace-active');
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
  $('viewerInspectorBtn')?.classList.toggle('active', visible);
  appShell?.classList.toggle('inspector-collapsed', !visible);
  viewerChromeCtl?.wake();
  requestAnimationFrame(() => {
    if (zoom > 1) scheduleUpdate();
    else resetZoom();
  });
}

function setSidebarVisible(visible) {
  if (!sidebar) return;
  sidebar.style.display = 'flex';
  sidebar.classList.toggle('collapsed', !visible);
  sidebarToggle?.classList.toggle('sidebar-closed', !visible);
  sidebarToggle?.setAttribute('aria-expanded', visible ? 'true' : 'false');
  sidebarToggle?.setAttribute('aria-label', visible ? 'Collapse sidebar' : 'Expand sidebar');
  appShell?.classList.toggle('sidebar-collapsed', !visible);
  requestAnimationFrame(() => {
    if (zoom > 1) scheduleUpdate();
    else resetZoom();
  });
}

function setInspectorTab(tabId) {
  document.querySelectorAll('.inspector-tab').forEach((btn) => {
    const active = btn.dataset.inspector === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.inspector-panel').forEach((panel) => {
    const active = panel.dataset.panel === tabId;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

function updateWorkspaceGuidance() {
  document.body.dataset.workspaceSurface = catalogModeActive ? 'catalog' : items.length ? 'viewer' : 'home';
}

function pushUndo(label, action) {
  undoStack.push({ label, action });
  if (undoStack.length > 12) undoStack.shift();
  showToast(`${label} · Press ⌘Z to undo`);
}

async function runUndo() {
  const entry = undoStack.pop();
  if (!entry) return;
  await entry.action();
  showToast(`Undid ${entry.label.toLowerCase()}`);
}

function maybeShowFirstLibraryTour() {
  if (localStorage.getItem('folio_first_library_tour') === 'done' || !items.length) return;
  localStorage.setItem('folio_first_library_tour', 'done');
  const overlay = document.createElement('div');
  overlay.className = 'guided-tour';
  overlay.innerHTML = `<div class="guided-tour-card"><span class="guided-tour-eyebrow">First library</span><h2>Your workspace at a glance</h2><p><b>Sidebar</b> filters the library. <b>Filmstrip</b> moves through files. <b>Inspector</b> holds metadata and edits. Press <kbd>G</kbd> for the catalog or <kbd>⌘K</kbd> for quick actions.</p><button type="button">Got it</button></div>`;
  overlay.querySelector('button').addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

const mapWorkspaceEl = $('mapWorkspace');

function setMainWorkspace(mode) {
  const catalog = catalogGrid;
  const map = mapWorkspaceEl;
  const view = viewer;

  catalog?.classList.toggle('is-active', mode === 'catalog');
  map?.classList.toggle('is-active', mode === 'map');
  if (map) map.hidden = mode !== 'map';
  view?.classList.toggle('is-active', mode === 'viewer');
}

function updateWorkspaceLayout() {
  if (isSettingsOpen()) return;
  if (!items.length) {
    if (openedLibraryPath) {
      welcome?.classList.add('hidden');
      setAppShellVisible(true);
      setMainWorkspace(catalogModeActive ? 'catalog' : 'viewer');
      if (sidebar) sidebar.style.display = catalogModeActive ? 'none' : 'flex';
    } else {
      showHomeHub();
    }
    return;
  }
  welcome?.classList.add('hidden');
  setAppShellVisible(true);

  if (mapModeActive) {
    setMainWorkspace('map');
    if (sidebar) setSidebarVisible(!sidebar.classList.contains('collapsed'));
    setInspectorVisible(false);
    if (sidebarCatalogStatus) sidebarCatalogStatus.hidden = false;
    document.body.classList.add('map-workspace-active');
    document.body.classList.remove('catalog-workspace-active');
  } else if (catalogModeActive) {
    setMainWorkspace('catalog');
    if (sidebar) setSidebarVisible(!sidebar.classList.contains('collapsed'));
    setInspectorVisible(false);
    if (sidebarCatalogStatus) sidebarCatalogStatus.hidden = false;
    document.body.classList.remove('map-workspace-active');
    document.body.classList.add('catalog-workspace-active');
  } else {
    setMainWorkspace('viewer');
    if (sidebar) setSidebarVisible(!sidebar.classList.contains('collapsed'));
    setInspectorVisible(inspectorPaneVisible);
    if (sidebarCatalogStatus) sidebarCatalogStatus.hidden = true;
    document.body.classList.remove('map-workspace-active', 'catalog-workspace-active');
  }
  updateWorkspaceGuidance();
}

function syncSidebarNavActive(overrideNavKey = null) {
  let navKey = overrideNavKey;
  if (navKey == null) {
    if (mapModeActive) navKey = 'map';
    else if (activeSmartFilter) navKey = activeSmartFilter;
    else navKey = 'all';
  }
  document.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === navKey);
  });
}

function applyNavFilter(navKey) {
  if (navKey === 'map') {
    toggleMapView(true);
    return;
  }
  if (mapModeActive) {
    toggleMapView(false, { preferViewer: true });
  }

  const map = { all: '', favorites: 'favorites', rated: 'rated', videos: 'videos', gps: 'gps', raw: 'raw', duplicates: 'duplicates' };
  activeSmartFilter = map[navKey] ?? '';
  if (smartFilterSelect) smartFilterSelect.value = activeSmartFilter;
  syncSidebarNavActive(navKey);
  applyFilters();
  if (catalogModeActive) buildCatalogContent();
}

function updateCatalogGridHeading() {
  if (!catalogTitle) return;
  const title = catalogFilterLabel(activeSmartFilter);
  catalogTitle.textContent = title;
  if (catalogScopeLabel) catalogScopeLabel.textContent = title;
  const count = catalogVisibleItems?.length ?? items.length;
  if (catalogSubtitle) catalogSubtitle.textContent = `${count} item${count === 1 ? '' : 's'}`;
  if (catalogCountPill) catalogCountPill.textContent = `${count} item${count === 1 ? '' : 's'}`;
  if (catalogSortPill) {
    const sortLabel = currentSort.charAt(0).toUpperCase() + currentSort.slice(1);
    catalogSortPill.textContent = `Sort: ${sortLabel}`;
  }
  if (sidebarCatalogStatusText) {
    sidebarCatalogStatusText.textContent = `${items.length} items · Updated just now`;
  }
}

let catalogDensityRebuildTimer = null;

function queueCatalogDensityRebuild() {
  if (!catalogModeActive) return;
  clearTimeout(catalogDensityRebuildTimer);
  catalogDensityRebuildTimer = setTimeout(() => {
    catalogDensityRebuildTimer = null;
    if (catalogModeActive) buildCatalogContent();
  }, 140);
}

function setCatalogDensity(size, { immediate = false } = {}) {
  gridThumbSize = Math.min(280, Math.max(96, size));
  localStorage.setItem('folio_grid_thumb_size', gridThumbSize);
  document.documentElement.style.setProperty('--grid-thumb-size', `${gridThumbSize}px`);
  syncCatalogDensityUi(gridThumbSize);
  if (catalogModeActive) {
    if (immediate) buildCatalogContent();
    else queueCatalogDensityRebuild();
  }
}

function renderBatchJobs() {
  if (!batchJobsList) return;
  batchJobsList.replaceChildren();
  if (!batchJobHistory.length) {
    const empty = document.createElement('p');
    empty.className = 'batch-jobs-empty';
    empty.textContent = 'No jobs yet. Batch conversions and exports will appear here.';
    batchJobsList.appendChild(empty);
    return;
  }
  [['running', 'Active'], ['completed', 'Completed'], ['failed', 'Failed']].forEach(([groupState, title]) => {
    const jobs = batchJobHistory.filter((job) => job.state === groupState || (groupState === 'failed' && job.state === 'cancelled'));
    if (!jobs.length) return;
    const group = document.createElement('section');
    group.className = 'batch-job-group';
    group.innerHTML = `<h3>${title}</h3>`;
    jobs.forEach((job) => {
      const row = document.createElement('div');
      row.className = `batch-job-row batch-job-row--${job.state}`;
      row.innerHTML = `<div class="batch-job-name"></div><div class="batch-job-bar"><div class="batch-job-fill"></div></div><div class="batch-job-status"></div><div class="batch-job-actions"></div>`;
      row.querySelector('.batch-job-name').textContent = job.label;
      row.querySelector('.batch-job-fill').style.width = `${job.pct}%`;
      row.querySelector('.batch-job-status').textContent = job.statusText;
      const reveal = document.createElement('button');
      reveal.type = 'button'; reveal.className = 'batch-job-action'; reveal.textContent = 'Reveal';
      reveal.addEventListener('click', openCurrentFolderInFinder);
      row.querySelector('.batch-job-actions').appendChild(reveal);
      if (job.state === 'failed' && job.retry) {
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'batch-job-action'; retry.textContent = 'Retry';
        retry.addEventListener('click', job.retry);
        row.querySelector('.batch-job-actions').appendChild(retry);
      }
      group.appendChild(row);
    });
    batchJobsList.appendChild(group);
  });
}

function upsertBatchJobRow(jobId, label, status, retry = null) {
  if (!batchJobsList) return;
  let job = batchJobRows.get(jobId);
  if (!job) {
    job = { jobId, label, retry, state: 'running', pct: 0, statusText: '' };
    batchJobRows.set(jobId, job);
    batchJobHistory.unshift(job);
  }
  const pct = status?.total ? Math.round((status.completed / status.total) * 100) : 0;
  const state = status?.state || 'running';
  job.label = label; job.pct = pct; job.state = state; job.retry = retry || job.retry;
  job.statusText =
    state === 'completed' ? `Completed · ${status.completed}/${status.total}` :
    state === 'failed' ? `Failed · ${status.failed || 0} errors` :
    state === 'cancelled' ? 'Cancelled' : `Running · ${status.completed || 0}/${status.total || '?'}`;
  renderBatchJobs();
}

renderBatchJobs();

let selectedCatalogPaths = new Set();
let gridThumbSize = parseInt(localStorage.getItem('folio_grid_thumb_size')) || 160;
let activeTagFilter = null;
let activeColorFilter = null;
let activeSmartFilter = '';
let homeSearchTerm = '';
let catalogSelectionModeActive = false;
let catalogSearchTerm = '';
let folderDominantColorsCache = {};
let folderDominantColorsLoading = null;
let folderDominantColorsGeneration = 0;
let catalogObserver = null;
let catalogKeyboardFocusIndex = -1;
const mediaAttributesCache = new Map();
const folderTagsCache = new Map();

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
let mapTileStyle = localStorage.getItem('folio_map_tile_style') || 'dark';
if (mapTileStyle === 'atlas' && localStorage.getItem('folio_map_tile_style_migrated') === 'atlas') {
  mapTileStyle = 'dark';
  localStorage.setItem('folio_map_tile_style', mapTileStyle);
  localStorage.removeItem('folio_map_tile_style_migrated');
}

// Load settings for Phase 2 features
let highContrastEnabled = localStorage.getItem('folio_high_contrast') === 'true';
let reducedMotionEnabled = localStorage.getItem('folio_reduced_motion') === 'true';
let performanceHudEnabled = localStorage.getItem('folio_performance_hud') === 'true';

let pendingRafUpdate = false;
let editPanelOpen = false;
let adjustPreviewActive = false;
let editSessionPath = null;
let gpsPopoverAnchor = null;
let gpsPopoverData = [];
let editDebounceTimer = null;
let editPreviewRequestId = 0;
let editPreviewInFlight = false;
let pendingEditFlush = null;
let editPreviewImg = null;
const editMap = new Map();
const preloadedThumbs = new Map();
const preloadedThumbSides = new Map();
const preloadCache = new Map();
const videoPreloadCache = new Map();
const VIEWER_TRANSITION_MS = 120;
const VIEWER_PRELOAD_CACHE_MAX = 32;
let viewerDeferredWorkToken = 0;

function scheduleViewerIdleWork(callback, timeout = 280) {
  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(callback, { timeout });
  }
  return window.setTimeout(callback, Math.min(timeout, 120));
}

function videoMimeType(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mkv') return 'video/x-matroska';
  if (ext === 'avi') return 'video/x-msvideo';
  return 'video/mp4';
}

function folioMediaUrl(path) {
  return `folio://localhost/${encodeURIComponent(path)}`;
}

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function rememberLibraryFolder(path) {
  if (!path) return;
  pushRecentLibraryPath(path);
  if (!hasTauriRuntime()) return;
  try {
    await invoke('add_recent_folder', { path });
  } catch (e) {
    console.warn('[Folio] rememberLibraryFolder:', e);
  }
}

async function fetchBackendRecentFolders() {
  if (!hasTauriRuntime()) {
    window.__folioRecentProbe = { ok: false, skipped: true, reason: 'no-tauri-runtime', time: Date.now() };
    return [];
  }
  try {
    const list = await withTimeout(invoke('get_recent_folders'), 3000, 'get_recent_folders');
    window.__folioRecentProbe = { ok: true, count: Array.isArray(list) ? list.length : 0, time: Date.now() };
    return Array.isArray(list) ? list : [];
  } catch (e) {
    window.__folioRecentProbe = { ok: false, error: String(e), time: Date.now() };
    if (hasTauriRuntime()) console.warn('[Folio] get_recent_folders:', e);
    throw e;
  }
}

async function fetchBackendRecentFoldersSafe() {
  try {
    return await fetchBackendRecentFolders();
  } catch (e) {
    return [];
  }
}

async function seedHomeRecentsFromBackend() {
  const paths = await fetchBackendRecentFolders();
  for (const path of paths) {
    pushRecentLibraryPath(path);
    ensureLibrarySummaryStub(path, 0);
  }
  return paths;
}

function getLocalRecentLibraryPaths() {
  const seen = new Set();
  const paths = [];
  const add = (path) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const { path } of getLibrarySummaries()) add(path);
  for (const path of getStoredRecentLibraryPaths()) add(path);
  return paths;
}

async function syncRecentsFromSummaries() {
  const summaries = getLibrarySummaries();
  const stored = getStoredRecentLibraryPaths();
  if (!summaries.length && !stored.length) return;
  const backend = await fetchBackendRecentFoldersSafe();
  const known = new Set(backend);
  const missing = [...stored, ...summaries.map((s) => s.path)]
    .filter((path) => path && !known.has(path));
  for (const path of missing) {
    await rememberLibraryFolder(path);
  }
}

const HOME_PREVIEW_CONCURRENCY = 8;
let homePreviewQueue = [];
let homePreviewActive = 0;
const homeSummaryRequests = new Set();

function drainHomePreviewQueue() {
  while (homePreviewActive < HOME_PREVIEW_CONCURRENCY && homePreviewQueue.length > 0) {
    const job = homePreviewQueue.shift();
    homePreviewActive += 1;
    invoke('get_thumbnail', { path: job.path, maxSide: job.maxSide })
      .then((thumbPath) => {
        if (job.img.isConnected) job.img.src = folioMediaUrl(thumbPath);
      })
      .catch(() => {
        if (job.img.isConnected && !job.img.dataset.homePreviewFallback) {
          job.img.dataset.homePreviewFallback = '1';
          job.img.src = folioMediaUrl(job.path);
        }
      })
      .finally(() => {
        homePreviewActive -= 1;
        drainHomePreviewQueue();
      });
  }
}

function hydrateHomePreviewImage(img, path, thumbPath = '') {
  if (!path) return;
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.onerror = () => {
    if (img.dataset.homePreviewFallback === '1') {
      img.removeAttribute('src');
      img.hidden = true;
      return;
    }
    img.dataset.homePreviewFallback = '1';
    img.src = folioMediaUrl(path);
  };
  if (thumbPath) {
    img.src = folioMediaUrl(thumbPath);
    return;
  }
  if (!hasTauriRuntime()) {
    img.src = folioMediaUrl(path);
    return;
  }
  homePreviewQueue.push({ img, path, maxSide: 200 });
  drainHomePreviewQueue();
}

async function ensureHomePreviewSummary(path, { repaint = true } = {}) {
  if (!path || !hasTauriRuntime() || homeSummaryRequests.has(path)) return null;
  const current = getLibrarySummary(path);
  const currentThumbs = current?.previewThumbnails || current?.preview_thumbnails || [];
  if (current?.previews?.length && currentThumbs.length >= Math.min(current.previews.length, 4)) return current;
  homeSummaryRequests.add(path);
  try {
    const summary = await invoke('get_folder_preview_summary', { path, limit: 5 });
    if (!summary?.previews?.length && !Number.isFinite(summary?.count)) return null;
    const next = patchLibrarySummary(path, {
      count: Number.isFinite(summary.count) ? summary.count : current?.count || 0,
      previews: Array.isArray(summary.previews) ? summary.previews : [],
      previewThumbnails: Array.isArray(summary.preview_thumbnails)
        ? summary.preview_thumbnails
        : Array.isArray(summary.previewThumbnails)
          ? summary.previewThumbnails
          : [],
    });
    if (repaint) {
      renderEditorialHome();
      await renderPinnedFoldersList();
      await renderRecentFolders({ source: 'local-only' });
    }
    return next;
  } catch (e) {
    console.warn('[Folio] home preview summary:', e);
    return null;
  } finally {
    homeSummaryRequests.delete(path);
  }
}

/** WebKit needs an explicit MIME on <source>; .mov as quicktime often fails on custom schemes. */
function setVideoSource(video, path, query = '') {
  const src = folioMediaUrl(path) + query;
  video.innerHTML = '';
  const source = document.createElement('source');
  source.src = src;
  source.type = videoMimeType(path);
  video.appendChild(source);
  video.load();
}

// Geocoding Cache & Service
const geocodeCache = new Map();
async function fetchReverseGeocode(lat, lon) {
  if (lat === undefined || lat === null || lon === undefined || lon === null) return 'No coordinates';
  if (!navigator.onLine) return 'Offline - address lookup unavailable';
  const key = `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' }, signal: controller.signal });
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
    return err?.name === 'AbortError' ? 'Address lookup timed out' : 'Address unavailable';
  } finally {
    clearTimeout(timeout);
  }
}

async function reverseGeocode(lat, lon) {
  if (!reverseGeocodeEnabled) return 'Address lookup disabled';
  return fetchReverseGeocode(lat, lon);
}

async function reverseGeocodeForMap(lat, lon) {
  return reverseGeocode(lat, lon);
}

window.reverseGeocode = reverseGeocode;
window.reverseGeocodeForMap = reverseGeocodeForMap;

// Bind existing sessions properties to FolioState dynamically
Object.defineProperties(FolioState, {
  idx: { get() { return idx; }, set(val) { idx = val; } },
  items: { get() { return items; }, set(val) { items = val; } },
  catalogModeActive: { get() { return catalogModeActive; }, set(val) { catalogModeActive = val; } },
  selectedCatalogPaths: { get() { return selectedCatalogPaths; }, set(val) { selectedCatalogPaths = val; } },
  gridThumbSize: { get() { return gridThumbSize; }, set(val) { gridThumbSize = val; } },
  activeTagFilter: { get() { return activeTagFilter; }, set(val) { activeTagFilter = val; } },
  editPanelOpen: { get() { return editPanelOpen; }, set(val) { editPanelOpen = val; } }
});

const defaultKeybinds = { nextImage: 'ArrowRight', prevImage: 'ArrowLeft', resetZoom: '0', toggleMetadata: 'i', playVideo: ' ', modifierZoom: 'Shift', modifierPan: 'Shift', toggleZen: 'z', toggleSidebar: 'b', toggleFullscreen: 'f', editMode: 'e', addTag: 't', toggleCatalog: 'g', goHome: 'h' };
function loadStoredObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizeKeybinds(stored = {}) {
  const next = { ...defaultKeybinds };
  let changed = false;
  for (const action of Object.keys(defaultKeybinds)) {
    const value = stored[action];
    if (typeof value === 'string' && value.length > 0) {
      next[action] = value;
    } else if (value !== undefined) {
      changed = true;
    }
  }
  if (changed) {
    localStorage.setItem('folio_keybinds', JSON.stringify(next));
  }
  return next;
}

let keybinds = normalizeKeybinds(loadStoredObject('folio_keybinds'));
let activeKeybindBtn = null;

function shouldIgnoreGlobalShortcut(e) {
  if (e.repeat) return true;
  const tag = (e.target?.tagName || '').toLowerCase();
  return ['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable;
}

function hasBlockingDialogOpen() {
  return !!document.querySelector(
    '.folio-dialog-overlay, .glassmorphic-modal-overlay, .guided-tour, #tagPill, #duplicateResolverModal.is-open'
  );
}

function shortcutMatches(e, bindVal) {
  if (!bindVal) return false;
  const key = e.key || '';
  return key.toLowerCase() === String(bindVal).toLowerCase() || key === bindVal;
}

function actionMatches(e, action) {
  return shortcutMatches(e, keybinds[action]);
}

function handleGlobalShortcut(e) {
  if (e.__folioShortcutHandled) return;
  if (activeKeybindBtn) return;
  window.__folioShortcutProbe = {
    key: e.key,
    code: e.code,
    target: e.target?.tagName || '',
    time: Date.now(),
  };

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    commandPalette?.hidden ? openCommandPalette() : closeCommandPalette();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    runUndo().catch((err) => showToast(`Undo failed: ${err}`));
    return;
  }

  if (e.key === 'Escape' && commandPalette && !commandPalette.hidden) {
    e.__folioShortcutHandled = true;
    closeCommandPalette();
    return;
  }

  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (shouldIgnoreGlobalShortcut(e)) return;
  if (hasBlockingDialogOpen()) return;

  const key = e.key;
  if (key === 'Escape' && settingsPage?.style.display !== 'none') {
    e.__folioShortcutHandled = true;
    closeSettings();
    return;
  }

  if (actionMatches(e, 'goHome')) {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    goHome();
    return;
  }

  if (mapModeActive && key === 'Escape') {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    toggleMapView(false);
    return;
  }

  if (catalogModeActive) {
    if (catalogKeyboardNav?.handleKeydown?.(e)) {
      e.__folioShortcutHandled = true;
      return;
    }
    if (key === 'Escape') {
      e.__folioShortcutHandled = true;
      if (catalogSelectionModeActive) {
        setCatalogSelectionMode(false);
      } else {
        toggleCatalogView(false);
      }
      return;
    }
  }

  if (actionMatches(e, 'nextImage') && items.length) {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    nav(1);
  } else if (actionMatches(e, 'prevImage') && items.length) {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    nav(-1);
  } else if (actionMatches(e, 'playVideo')) {
    if (toggleVideoPlayback()) {
      e.__folioShortcutHandled = true;
      e.preventDefault();
    }
  } else if (actionMatches(e, 'editMode')) {
    e.__folioShortcutHandled = true;
    editToggleBtn?.click();
  } else if (actionMatches(e, 'addTag')) {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    showTagPill();
  } else if (actionMatches(e, 'toggleMetadata')) {
    e.__folioShortcutHandled = true;
    if (!items.length) {
      showToast('Open a library before toggling metadata');
      return;
    }
    overlayVisible = !overlayVisible;
    if (overlayVisible) {
      setInspectorVisible(true);
      setInspectorTab('info');
      drawHistogram(getActiveImage());
      drawDominantColors(items[idx]);
    }
  } else if (actionMatches(e, 'toggleFullscreen')) {
    e.__folioShortcutHandled = true;
    toggleFullscreen();
  } else if (actionMatches(e, 'toggleSidebar')) {
    e.__folioShortcutHandled = true;
    sidebarToggle?.click();
  } else if (actionMatches(e, 'toggleZen')) {
    e.__folioShortcutHandled = true;
    if (!items.length) {
      showToast('Open a library before using Zen Mode');
      return;
    }
    toggleZenMode();
  } else if (actionMatches(e, 'toggleCatalog')) {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    toggleCatalogView(!catalogModeActive);
  } else if (actionMatches(e, 'resetZoom')) {
    e.__folioShortcutHandled = true;
    resetZoom();
  } else if ((key === 'Backspace' || key === 'Delete') && items.length) {
    e.__folioShortcutHandled = true;
    e.preventDefault();
    showDeleteConfirmation(items[idx].path, idx);
  }
}

window.__folioShortcutProbe = { attached: true, time: Date.now() };
window.addEventListener('keydown', handleGlobalShortcut, true);

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
  host.hidden = false;
  host.replaceChildren();
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
    if (hasTauriRuntime()) invoke('set_window_vibrancy', { enabled: vibrancyEnabled }).catch(() => {});
  });
}
// Apply initial vibrancy if enabled
if (vibrancyEnabled && hasTauriRuntime()) invoke('set_window_vibrancy', { enabled: true }).catch(() => {});

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
    mapReverseToggle?.setAttribute('aria-pressed', String(reverseGeocodeEnabled));
    mapReverseToggle?.classList.toggle('active', reverseGeocodeEnabled);
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
  invoke('set_thumbnail_cache_limit', { limitGb: thumbnailCacheLimitGb }).catch(() => {});
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
  try { populateKeybindButtons(); } catch (e) {}
  const activeTab = document.querySelector('.settings-nav-item.active')?.dataset?.tab || 'general';
  if (activeTab === 'cache' || activeTab === 'advanced') loadStorageDiagnostics();
  syncDiagnosticsPolling();
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
  syncDiagnosticsPolling();
}

let settingsNavigationBound = false;
function bindSettingsNavigation() {
  if (settingsNavigationBound) return;
  settingsNavigationBound = true;
  const nav = document.querySelector('.settings-categories');
  nav?.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-item');
    if (!btn || !nav.contains(btn)) return;
    activateSettingsTab(btn);
  });
  nav?.addEventListener('keydown', (e) => {
    const btn = e.target.closest('.settings-nav-item');
    if (!btn || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const tabs = Array.from(nav.querySelectorAll('.settings-nav-item'));
    const current = tabs.indexOf(btn);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
      : (current + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[next]?.focus();
    if (tabs[next]) activateSettingsTab(tabs[next]);
  });
}
bindSettingsNavigation();

function currentTauriWindow() {
  try { return getCurrentWindow(); } catch { return null; }
}

function currentTauriWebview() {
  try { return getCurrentWebview(); } catch { return null; }
}

currentTauriWindow()?.setCursorVisible(true).catch(() => {});

async function syncFullscreenState() {
  try { isFullscreen = await currentTauriWindow()?.isFullscreen() || false; } catch { isFullscreen = false; }
  if (fullscreenBtn) {
    fullscreenBtn.classList.toggle('active', isFullscreen);
    fullscreenBtn.textContent = isFullscreen ? 'EXIT' : 'FULL';
  }
}

async function toggleFullscreen() {
  try {
    const appWindow = currentTauriWindow();
    if (!appWindow) return;
    await appWindow.setFullscreen(!isFullscreen);
    await syncFullscreenState();
  } catch (err) { console.error(err); }
}

/* ── Viewport & Zoom/Pan ── */
function getActiveImage() {
  return media.querySelector('.media-layer.media-active img.media-content:not(.edit-preview)');
}

function scheduleUpdate() {
  if (pendingRafUpdate) return; pendingRafUpdate = true;
  requestAnimationFrame(() => {
    pendingRafUpdate = false;
    const img = getActiveImage();
    if (img) {
      const t = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
      img.style.transform = t;
      if (editPreviewImg && editPreviewImg.parentElement === img.parentElement) {
        editPreviewImg.style.transform = t;
        syncEditPreviewLayout();
      }
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
      if (editPreviewImg) {
        editPreviewImg.style.transform = '';
        syncEditPreviewLayout();
      }
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

async function openHomeLibraryPath(path) {
  try {
    const p = await invoke('open_specific_folder', { path });
    await loadFolderData(p);
  } catch (e) {
    console.error(e);
    showToast(`Could not open folder: ${e}`);
  }
}

function createHomeFolderRow(path) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'home-list-item';
  const summary = getLibrarySummary(path);
  const preview = document.createElement('div');
  preview.className = 'home-library-preview';
  const previewPaths = summary?.previews || [];
  const previewThumbs = summary?.previewThumbnails || summary?.preview_thumbnails || [];
  if (!previewPaths.length) {
    preview.classList.add('is-loading');
    ensureHomePreviewSummary(path).catch(() => {});
  }
  for (let i = 0; i < 4; i++) {
    const tile = document.createElement('span');
    tile.className = 'home-library-preview-tile';
    if (previewPaths[i]) {
      const image = document.createElement('img');
      hydrateHomePreviewImage(image, previewPaths[i], previewThumbs[i]);
      tile.appendChild(image);
    }
    preview.appendChild(tile);
  }
  const meta = document.createElement('div');
  meta.className = 'home-item-meta';
  const nameEl = document.createElement('span');
  nameEl.className = 'home-item-name';
  nameEl.textContent = folderDisplayName(path);
  const pathEl = document.createElement('span');
  pathEl.className = 'home-item-path';
  pathEl.textContent = formatHomePath(path);
  const detailEl = document.createElement('span');
  detailEl.className = 'home-item-detail';
  const opened = summary?.openedAt ? new Date(summary.openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Not opened yet';
  detailEl.textContent = summary ? `${summary.count} items · Opened ${opened}` : opened;
  meta.append(nameEl, pathEl, detailEl);
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
  row.append(preview, meta, pinBtn);
  row.addEventListener('click', () => openHomeLibraryPath(path));
  row.addEventListener('contextmenu', (e) => showAppContextMenu(e, {
    label: folderDisplayName(path),
    actions: [
      { label: 'Open library', run: () => row.click() },
      { label: isPinned(path) ? 'Unpin library' : 'Pin library', run: () => { togglePinnedFolder(path); renderHomeHub(); } },
      { label: 'Reveal in Finder', run: () => openPathInFinder(path, false) },
      { separator: true },
      { label: 'Open another folder…', run: openFolder },
      { label: 'Settings', run: openSettings },
    ],
  }));
  return row;
}

function createHomePreviewImage(path, className = '', thumbPath = '') {
  const image = document.createElement('img');
  image.className = className;
  hydrateHomePreviewImage(image, path, thumbPath);
  return image;
}

function renderEditorialHome() {
  const preview = $('homeEditorialPreview');
  const resumeBtn = $('homeResumeBtn');
  if (!preview || !resumeBtn) return;
  const summaries = getLibrarySummaries();
  const latest = summaries[0];
  preview.replaceChildren();
  resumeBtn.disabled = !latest;
  resumeBtn.textContent = latest ? `Resume ${folderDisplayName(latest.path)}` : 'Choose a library';
  resumeBtn.onclick = latest ? () => openHomeLibraryPath(latest.path) : openFolder;
  if (!latest) {
    const empty = document.createElement('div');
    empty.className = 'home-editorial-empty';
    empty.innerHTML = '<strong>No recent library</strong><span>Choose a folder to start browsing.</span>';
    preview.appendChild(empty);
    return;
  }
  const mosaic = document.createElement('button');
  mosaic.type = 'button';
  mosaic.className = 'home-editorial-mosaic';
  mosaic.addEventListener('click', () => openHomeLibraryPath(latest.path));
  const previewPaths = latest.previews || [];
  const previewThumbs = latest.previewThumbnails || latest.preview_thumbnails || [];
  if (!previewPaths.length) {
    mosaic.classList.add('is-loading');
    ensureHomePreviewSummary(latest.path).catch(() => {});
  }
  previewPaths.slice(0, 5).forEach((path, index) => mosaic.appendChild(createHomePreviewImage(path, `home-editorial-image home-editorial-image-${index + 1}`, previewThumbs[index])));
  const caption = document.createElement('div');
  caption.className = 'home-editorial-caption';
  caption.innerHTML = `<strong>${folderDisplayName(latest.path)}</strong><span>${latest.count || 0} items · Last opened ${new Date(latest.openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`;
  preview.append(mosaic, caption);
}

async function renderPinnedFoldersList() {
  const container = $('pinnedFolders');
  if (!container) return;
  const layout = getHomeLayout();
  const section = $('homePinnedSection');
  if (section) section.style.display = layout.showPinned ? '' : 'none';
  container.replaceChildren();
  const pinned = getPinnedFolders().filter((path) => path.toLowerCase().includes(homeSearchTerm));
  if (!pinned.length) {
    const empty = document.createElement('p');
    empty.className = 'onboarding-hint';
    empty.style.margin = '0';
    empty.textContent = homeSearchTerm ? 'No pinned locations match your search' : 'No pinned locations yet. Pin a recent library with ★.';
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

$('homeCustomizeToggle')?.addEventListener('click', () => {
  const wrap = $('homeCustomizeChips');
  if (!wrap) return;
  if (!wrap.children.length) renderHomeCustomizeChips();
  wrap.hidden = !wrap.hidden;
  $('homeCustomizeToggle')?.setAttribute('aria-expanded', String(!wrap.hidden));
});

$('homeSearchInput')?.addEventListener('input', debounce((e) => {
  homeSearchTerm = e.target.value.trim().toLowerCase();
  renderHomeHub();
}, 120));

async function clearAllRecents() {
  try {
    if (hasTauriRuntime()) await invoke('clear_recent_folders');
    clearStoredRecentLibraryPaths();
    clearLibrarySummaries();
    homeRecentsBootComplete = true;
    await renderHomeHub({ syncFromSummaries: false, recentsSource: 'backend-only' });
    showToast('Recent folders cleared');
  } catch (e) {
    showToast(`Could not clear recents: ${e}`);
  }
}

let homeRecentsBootComplete = false;
function scheduleHomeHubRefresh(options) {
  const run = async () => {
    if (homeRecentsBootComplete && !options?.force) return;
    try {
      await seedHomeRecentsFromBackend();
      homeRecentsBootComplete = true;
    } catch (e) {
      console.warn('[Folio] seedHomeRecentsFromBackend:', e);
    }
    try {
      await syncRecentsFromSummaries();
    } catch (e) {
      console.warn('[Folio] syncRecentsFromSummaries:', e);
    }
    await renderHomeHub(options).catch((e) => console.error('[Folio] renderHomeHub:', e));
  };
  run();
  [250, 750, 1500, 3000, 6000].forEach((delay) => setTimeout(run, delay));
  if (hasTauriRuntime()) return;
  let attempts = 0;
  const id = setInterval(() => {
    attempts += 1;
    if (hasTauriRuntime()) {
      clearInterval(id);
      run();
    } else if (attempts >= 120) {
      clearInterval(id);
    }
  }, 50);
}

$('clearRecentsHomeBtn')?.addEventListener('click', clearAllRecents);
$('clearRecentsSettingsBtn')?.addEventListener('click', clearAllRecents);

async function renderHomeHub(options = {}) {
  const { syncFromSummaries = true, recentsSource = 'merged' } = options;
  const scrollEl = document.querySelector('.home-side-scroll');
  const savedScrollTop = scrollEl?.scrollTop ?? 0;
  try {
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
  } catch (e) {
    console.warn('[Folio] home layout render failed:', e);
  }
  try {
    renderHomeCustomizeChips();
  } catch (e) {
    console.warn('[Folio] home customize render failed:', e);
  }
  try {
    renderEditorialHome();
  } catch (e) {
    console.warn('[Folio] editorial home render failed:', e);
  }
  try {
    await renderPinnedFoldersList();
  } catch (e) {
    console.warn('[Folio] pinned folders render failed:', e);
  }
  try {
    await renderRecentFolders({ source: recentsSource });
  } catch (e) {
    console.warn('[Folio] recent folders render failed:', e);
  }
  if (scrollEl) scrollEl.scrollTop = savedScrollTop;
  if (syncFromSummaries) {
    syncRecentsFromSummaries()
      .then(() => renderRecentFolders({ source: recentsSource }))
      .catch((e) => console.warn('[Folio] syncRecentsFromSummaries:', e));
  }
}

async function renderRecentFolders({ source = 'merged' } = {}) {
  const container = $('recentFolders');
  if (!container) return;
  const layout = getHomeLayout();
  const section = $('homeRecentsSection');
  if (section) section.style.display = layout.showRecents && showRecentFolders ? '' : 'none';
  if (!showRecentFolders) {
    container.innerHTML = '';
    return;
  }

  const paintList = (fullList) => {
    container.replaceChildren();
    if (!fullList.length) {
      const empty = document.createElement('p');
      empty.className = 'onboarding-hint';
      empty.style.margin = '0';
      empty.textContent = 'No recent libraries yet. Open a folder to start your history.';
      container.appendChild(empty);
      return;
    }
    const matches = fullList.filter((path) => path.toLowerCase().includes(homeSearchTerm)).slice(0, 8);
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'onboarding-hint';
      empty.textContent = 'No recent locations match your search';
      container.appendChild(empty);
      return;
    }
    matches.forEach((path) => container.appendChild(createHomeFolderRow(path)));
  };
  const paintError = (error) => {
    container.replaceChildren();
    const row = document.createElement('p');
    row.className = 'onboarding-hint';
    row.style.margin = '0';
    row.textContent = `Recent folders could not load: ${String(error)}`;
    container.appendChild(row);
  };

  if (source === 'backend-only') {
    try {
      const paths = await fetchBackendRecentFolders();
      paintList(paths);
    } catch (e) {
      paintError(e);
    }
    return;
  }

  const localPaths = getLocalRecentLibraryPaths();
  if (localPaths.length) {
    paintList(localPaths);
  } else if (source === 'local-only') {
    return;
  }

  let backendList = [];
  try {
    backendList = await fetchBackendRecentFolders();
  } catch (e) {
    if (!localPaths.length) paintError(e);
    return;
  }
  for (const path of backendList) {
    pushRecentLibraryPath(path);
    ensureLibrarySummaryStub(path, 0);
  }
  if (backendList.length) {
    try {
      renderEditorialHome();
    } catch (e) {
      console.warn('[Folio] editorial home render after recents:', e);
    }
  }
  const paths = [...getLocalRecentLibraryPaths()];
  for (const path of backendList) {
    if (!paths.includes(path)) paths.push(path);
  }

  if (paths.length && !layout.showRecents) {
    saveHomeLayout({ showRecents: true });
    if (section) section.style.display = showRecentFolders ? '' : 'none';
  }

  paintList(paths);
}

scheduleHomeHubRefresh();

function updateViewerToolbar() {
  const starsEl = $('viewerStars');
  const favBtn = $('viewerFavoriteBtn');
  const pickBtn = $('viewerPickBtn');
  const item = items[idx];
  const topFavBtn = $('viewerTopFavoriteBtn');
  if (!starsEl || !item || item.is_video) {
    if (starsEl) starsEl.innerHTML = '';
    if (topFavBtn) topFavBtn.hidden = !item || !!item.is_video;
    return;
  }
  if (topFavBtn) topFavBtn.hidden = false;
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
        pushUndo(`Rated ${next || 0} stars`, async () => {
          await invoke('set_media_rating', { paths: [item.path], rating });
          a.rating = rating; updateViewerToolbar(); buildFilmstrip();
        });
      } catch (err) {
        showToast(`Rating failed: ${err}`);
      }
    });
    starsEl.appendChild(btn);
  }
  if (topFavBtn) topFavBtn.classList.toggle('is-active', !!attr.favorite);

  if (favBtn) {
    favBtn.classList.toggle('active', !!attr.favorite);
    const toggleFavorite = async () => {
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
        pushUndo(next ? 'Favorited media' : 'Removed favorite', async () => {
          await invoke('set_media_favorite', { paths: [item.path], favorite: !next });
          a.favorite = !next; updateViewerToolbar(); buildFilmstrip();
        });
      } catch (err) {
        showToast(`Favorite failed: ${err}`);
      }
    };
    favBtn.onclick = toggleFavorite;
    if (topFavBtn) topFavBtn.onclick = toggleFavorite;
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
  resetFilmstripWarmState();
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
  thumbQueue = [];
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
    mapGpsSyncGeneration += 1;
    saveLibrarySummary(p, {
      count: items.length,
      previews: items.filter((item) => !item.is_video).slice(0, 4).map((item) => item.path),
    });
    await rememberLibraryFolder(p);
    mediaAttributesCache.clear();
    idx = 0;
    sortItems({ rebuildFilmstrip: false });
    if (selectPath) {
      const normalized = selectPath.toLowerCase();
      const found = items.findIndex((it) => it.path.toLowerCase() === normalized);
      if (found >= 0) idx = found;
    }
    renderBreadcrumbs(p);
    activeTagFilter = null;
    activeColorFilter = null;
    folderDominantColorsCache = {};
    folderDominantColorsLoading = null;
    folderDominantColorsGeneration += 1;

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
    if (mapModeActive) {
      refreshMapWorkspace();
    } else if (catalogModeActive) {
      buildCatalogContent();
    } else {
      show(idx);
    }
    requestAnimationFrame(() => {
      buildFilmstrip();
      highlightThumb();
    });
    Promise.all([renderTagFilters(), loadMediaAttributes(), syncMapGpsFromBackend()]).catch((e) => console.error(e));
    maybeShowFirstLibraryTour();
    updateWorkspaceGuidance();
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

async function ensureLibraryItemsForCatalog() {
  if (items.length) return true;

  if (openedLibraryPath) {
    try {
      items = processLoadedItems(await invoke('get_folder_items'));
      if (items.length) {
        saveLibrarySummary(openedLibraryPath, {
          count: items.length,
          previews: items.filter((item) => !item.is_video).slice(0, 4).map((item) => item.path),
        });
        sortItems({ rebuildFilmstrip: false });
        renderBreadcrumbs(openedLibraryPath);
        clearEmptyState(catalogStateHost);
        clearEmptyState(viewerStateHost);
        return true;
      }
    } catch (e) {
      console.warn('[Folio] hydrate active catalog library:', e);
    }
  }

  const [recentPath] = await fetchBackendRecentFoldersSafe();
  if (!recentPath) return false;
  try {
    const p = await invoke('open_specific_folder', { path: recentPath });
    await loadFolderData(p);
    return items.length > 0;
  } catch (e) {
    console.warn('[Folio] open recent catalog library:', e);
    return false;
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
    if (!hasTauriRuntime()) {
        showToast('Open Folio in the desktop app to choose a folder.');
        return;
    }
    try {
        const p = await invoke('open_folder_picker');
        if (!p) return;
        await rememberLibraryFolder(p);
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


function nav(dir) {
  viewerChromeCtl?.wake();
  if (items.length) show((idx + dir + items.length) % items.length, dir);
}

function navTo(nextIdx) {
  if (!items.length) return;
  const bounded = Math.max(0, Math.min(items.length - 1, nextIdx));
  const dir = bounded === idx ? 0 : bounded > idx ? 1 : -1;
  show(bounded, dir);
}

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
    { opacity: 0, transform: `translate3d(${dir * -24}px, 0, 0) scale(0.99)` }
  ], { duration: VIEWER_TRANSITION_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }).finished.then(() => node.remove());
}

const VIEWER_DIRECT_IMAGE_MAX_PIXELS = 48_000_000;
const VIEWER_DIRECT_IMAGE_MAX_BYTES = 80 * 1024 * 1024;
const BROWSER_NATIVE_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

function isBrowserNativeImage(item) {
  const ext = (item?.path?.split('.').pop() || '').toLowerCase();
  return BROWSER_NATIVE_IMAGE_EXTS.has(ext);
}

function shouldUseDecodedViewerImage(item) {
  if (!item || item.is_video) return false;
  if (!isBrowserNativeImage(item)) return true;
  const pixels = Number(item.width || 0) * Number(item.height || 0);
  return pixels > VIEWER_DIRECT_IMAGE_MAX_PIXELS || Number(item.size || 0) > VIEWER_DIRECT_IMAGE_MAX_BYTES;
}

function resolveViewerImageUrl(item, { force = false, cacheBust = '' } = {}) {
  if (!shouldUseDecodedViewerImage(item)) {
    return Promise.resolve(`${folioMediaUrl(item.path)}${cacheBust}`);
  }
  return invoke('get_full_image', { path: item.path, force })
    .then(p => `folio://localhost/${encodeURIComponent(p)}${cacheBust}`);
}

function preloadImage(item) {
  if (!item || item.is_video) return;
  if (preloadCache.has(item.path)) return;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.loading = 'eager';
  preloadCache.set(item.path, img);

  resolveViewerImageUrl(item)
    .then(url => { img.src = url; })
    .catch(() => { preloadCache.delete(item.path); });
}

function preloadVideo(item) {
  if (!item?.is_video || videoPreloadCache.has(item.path)) return;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;left:-9999px';
  setVideoSource(v, item.path);
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
    for (let o = 1; o <= 10; o++) offsets.push(o * direction);
  } else {
    offsets.push(-5, -4, -3, -2, -1, 1, 2, 3, 4, 5);
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
      if (Math.abs(offset) <= 2 && shouldUseDecodedViewerImage(item)) {
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
  if (preloadCache.size > VIEWER_PRELOAD_CACHE_MAX) {
    for (const path of preloadCache.keys()) {
      if (!keepSet.has(path)) {
        preloadCache.delete(path);
        if (preloadCache.size <= VIEWER_PRELOAD_CACHE_MAX) break;
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
  const previousItem = items[prevIdx];
  idx = i; zoom = 1; panX = 0; panY = 0;
  zoomSlider.value = 100; zoomLabel.textContent = '100%';
  
  const item = items[i];
  if (!item?.is_video) detachVideoToolbar();
  if (editSessionPath && editSessionPath !== item.path) {
    editSessionPath = null;
    removeEditPreview();
  }
  const src = folioMediaUrl(item.path);
  const outgoing = media.querySelector('.media-layer.media-active');
  if (outgoing) {
    if (rapidNav) {
      outgoing.remove();
    } else if (cinematicEnabled && direction !== 0) {
      applyPhysicalExit(outgoing, direction);
    } else {
      outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: VIEWER_TRANSITION_MS, easing: 'ease-out' }).finished.then(() => outgoing.remove());
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
        { opacity: 0, transform: `translate3d(${direction * 24}px, 0, 0) scale(1.01)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1) rotate(0deg)' }
    ], { duration: VIEWER_TRANSITION_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }));
  } else {
    requestAnimationFrame(() => layer.animate([
        { opacity: 0 },
        { opacity: 1 }
    ], { duration: VIEWER_TRANSITION_MS, easing: 'ease-out', fill: 'forwards' }));
    layer.style.transform = 'none';
  }
  
  if (item.is_video) {
    viewer.classList.remove('loading');
    const v = document.createElement('video');
    v.className = 'media-content';
    v.autoplay = true; v.loop = true; v.playsInline = true;
    const warmed = videoPreloadCache.get(item.path);
    if (warmed && warmed.readyState >= 2) {
      const warmedSrc = warmed.currentSrc || warmed.querySelector('source')?.src || warmed.src;
      if (warmedSrc) {
        v.innerHTML = '';
        const source = document.createElement('source');
        source.src = warmedSrc;
        source.type = videoMimeType(item.path);
        v.appendChild(source);
        v.load();
      } else {
        setVideoSource(v, item.path);
      }
    } else {
      setVideoSource(v, item.path);
    }

    v.onerror = () => {
      viewer.classList.remove('loading');
      renderMediaError(layer, item, () => {
        setVideoSource(v, item.path, `?retry=${Date.now()}`);
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
      const ts = getCachedThumb(item.path);
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
      const workToken = ++viewerDeferredWorkToken;
      img.classList.add('loaded');
      img.style.opacity = '1';
      viewer.classList.remove('loading');
      const ph = layer.querySelector('.placeholder-thumb');
      if (ph) {
        ph.classList.remove('loaded');
        ph.classList.add('fade-out');
        setTimeout(() => ph.remove(), 120);
      }
      scheduleViewerIdleWork(() => {
        if (workToken !== viewerDeferredWorkToken || items[idx]?.path !== item.path) return;
        try { updateAdaptiveGlow(img); } catch (e) { console.error('Adaptive glow error:', e); }
        if (isEditPreviewEnabled()) {
          invoke('prepare_edit_preview', { path: item.path }).then(() => {
            if (workToken !== viewerDeferredWorkToken || items[idx]?.path !== item.path) return;
            editSessionPath = item.path;
            loadEditForCurrent();
          }).catch(e => console.error(e));
        }
        try { drawHistogram(img); } catch (e) { console.error('Histogram error:', e); }
        try { drawDominantColors(item); } catch (e) { console.error('Dominant colors error:', e); }
      });
    };

    let img;
    let revealToken = 0;

    if (preloadReady) {
      preloadCache.delete(item.path);
      img = cached;
      img.className = 'media-content';
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = 'high';
      img.style.opacity = '1';
      layer.appendChild(img);
      runViewerChrome(img);
    } else {
      img = document.createElement('img');
      img.crossOrigin = 'anonymous';
      img.alt = '';
      img.className = 'media-content';
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = 'high';

      const revealViewerImage = () => {
        const token = ++revealToken;
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
          invoke('clear_decode_failures', { path: item.path }).catch(() => {});
          resolveViewerImageUrl(item, { force: true, cacheBust: `?retry=${Date.now()}` })
            .then(url => { img.src = url; })
            .catch(() => {
              if (isBrowserNativeImage(item) && !shouldUseDecodedViewerImage(item)) {
                img.src = `${src}?retry=${Date.now()}`;
              }
            });
        });
      };

      resolveViewerImageUrl(item)
        .then(url => {
          if (items[idx]?.path !== item.path) return;
          img.src = url;
          if (img.complete && img.naturalWidth > 0) revealViewerImage();
        })
        .catch(() => { img.onerror(); });
      layer.appendChild(img);
    }

    if (item.isLivePhoto && item.livePhotoVideoPath) {
      const v = document.createElement('video');
      v.className = 'live-video-player';
      v.muted = true; v.loop = true; v.playsInline = true;
      setVideoSource(v, item.livePhotoVideoPath);
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
  if (viewerTopPath) viewerTopPath.textContent = currentFolderPath() || 'Library';
  if (viewerTopName) viewerTopName.textContent = basename(item.path);
  if (viewerTopCount) viewerTopCount.textContent = `${i + 1} / ${items.length}`;
  dims.textContent = `${item.width} × ${item.height}`;
  badge.style.display = 'inline-block';
  badge.textContent = (item.path.split('.').pop() || '').toUpperCase();
  badge.className = `format-badge fmt-${badge.textContent.toLowerCase()}`;
  
  renderInspectorMetadata(item);
  renderInspectorTags(item);

  highlightThumb();
  updateViewerToolbar();
  viewerChromeCtl?.wake();
  if (catalogContent) {
    for (const path of [previousItem?.path, item.path]) {
      if (!path) continue;
      catalogContent
        .querySelector(`.catalog-card[data-path="${CSS.escape(path)}"]`)
        ?.classList.toggle('is-focused', path === item.path);
    }
  }
  closeCropMode();
  removeEditPreview();
}

function formatCaptureDate(item) {
  if (!item?.modified) return null;
  const d = new Date(item.modified * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatShutterDisplay(raw) {
  if (!raw || raw === '—') return '—';
  const text = String(raw).trim();
  const frac = text.match(/1\s*\/\s*([\d.]+)/);
  if (frac) {
    const denom = parseFloat(frac[1]);
    if (Number.isFinite(denom) && denom > 0) {
      return denom >= 10 ? `1/${Math.round(denom)} s` : `1/${denom.toFixed(1)} s`;
    }
  }
  const sec = parseFloat(text);
  if (Number.isFinite(sec) && sec > 0 && sec < 1) return `${sec.toFixed(3).replace(/\.?0+$/, '')} s`;
  return text;
}

function renderInspectorMetadata(item) {
  const edDateCard = $('edDateCard');
  const edDateTime = $('edDateTime');
  const captureLabel = formatCaptureDate(item);
  if (edDateCard && edDateTime) {
    if (captureLabel) {
      edDateCard.style.display = '';
      edDateTime.textContent = captureLabel;
    } else {
      edDateCard.style.display = 'none';
    }
  }

  if (item.exif) {
    if (edCamera) edCamera.textContent = item.exif.camera || 'Unknown Camera';
    edAperture.textContent = item.exif.aperture || '—';
    edShutter.textContent = formatShutterDisplay(item.exif.shutter_speed);
    edIso.textContent = item.exif.iso || '—';
    edFocal.textContent = item.exif.focal_length || '—';
    if (item.exif.latitude !== undefined && item.exif.latitude !== null && item.exif.longitude !== undefined && item.exif.longitude !== null) {
      const lat = item.exif.latitude;
      const lon = item.exif.longitude;
      if (edGps) edGps.style.display = '';
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
    } else if (edGps) {
      edGps.style.display = 'none';
    }
    const isRaw = !['jpg','jpeg','png','webp'].includes(item.path.split('.').pop().toLowerCase());
    if (isRaw && edTechData) {
      edTechData.style.display = 'block';
      edTechData.innerHTML = `<span>Format: ${badge.textContent}</span><span>Bit Depth: 14-bit</span>`;
    } else if (edTechData) edTechData.style.display = 'none';
  } else {
    if (edCamera) edCamera.textContent = 'No Metadata';
    edAperture.textContent = edShutter.textContent = edIso.textContent = edFocal.textContent = '—';
    if (edGps) edGps.style.display = 'none';
    if (edTechData) edTechData.style.display = 'none';
  }
  hydrateInspectorMetadata(item);
}

function renderInspectorTags(item = items[idx]) {
  if (!inspectorTagList) return;
  inspectorTagList.replaceChildren();
  const tags = item ? (folderTagsCache.get(item.path) || []) : [];
  if (!tags.length) {
    const empty = document.createElement('span');
    empty.className = 'inspector-tags-empty';
    empty.textContent = 'No tags yet';
    inspectorTagList.appendChild(empty);
    return;
  }
  tags.forEach((tag) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'inspector-tag-chip';
    chip.textContent = `${tag.name} ×`;
    chip.title = `Remove ${tag.name}`;
    chip.addEventListener('click', async () => {
      await invoke('remove_tag_from_image', { path: item.path, tagName: tag.name });
      folderTagsCache.set(item.path, tags.filter((row) => row.name !== tag.name));
      renderInspectorTags(item);
      renderTagFilters();
      pushUndo(`Removed tag "${tag.name}"`, async () => {
        await invoke('add_tag_to_image', { path: item.path, tagName: tag.name, tagColor: tag.color || '#D4A72C' });
        folderTagsCache.set(item.path, [...(folderTagsCache.get(item.path) || []), tag]);
        renderInspectorTags(item); renderTagFilters();
      });
    });
    inspectorTagList.appendChild(chip);
  });
}

async function addInspectorTag() {
  const item = items[idx];
  const tagName = inspectorTagInput?.value.trim();
  if (!item || !tagName) return;
  await invoke('add_tag_to_image', { path: item.path, tagName, tagColor: '#D4A72C' });
  const tags = folderTagsCache.get(item.path) || [];
  if (!tags.some((tag) => tag.name === tagName)) tags.push({ name: tagName, color: '#D4A72C' });
  folderTagsCache.set(item.path, tags);
  inspectorTagInput.value = '';
  renderInspectorTags(item);
  renderTagFilters();
  pushUndo(`Tagged "${tagName}"`, async () => {
    await invoke('remove_tag_from_image', { path: item.path, tagName });
    folderTagsCache.set(item.path, (folderTagsCache.get(item.path) || []).filter((tag) => tag.name !== tagName));
    renderInspectorTags(item); renderTagFilters();
  });
}

function hydrateInspectorMetadata(item) {
  if (!item || item.exif || item.is_video) return;
  const key = `${item.path}:${item.modified}`;
  if (metadataHydrationKeys.has(key)) return;
  metadataHydrationKeys.add(key);
  invoke('get_media_metadata', { path: item.path })
    .then((exif) => {
      item.exif = exif;
      if (exif && items[idx]?.path === item.path) renderInspectorMetadata(item);
      if (mapModeActive && hasItemGps(item)) {
        refreshMapWorkspace();
      }
      renderSidebarFilterCounts();
    })
    .catch((e) => {
      metadataHydrationKeys.delete(key);
      console.error('Failed to hydrate media metadata:', e);
    });
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
const THUMB_CONCURRENCY = Math.min(16, Math.max(8, navigator.hardwareConcurrency || 8));
let thumbQueue = [];
let thumbActive = 0;
const THUMB_DEFAULT_MAX_SIDE = 192;
const CATALOG_THUMB_MIN_SIDE = 256;
const CATALOG_THUMB_MAX_SIDE = 640;
const FILMSTRIP_INITIAL_WARM_COUNT = 360;
const FILMSTRIP_NAV_WARM_AHEAD = 240;
const thumbInflight = new Map();
let filmstripThumbGeneration = 0;
let filmstripWarmTimer = null;
let filmstripWarmGeneration = 0;
let filmstripWarmKeys = new Set();

function resetFilmstripWarmState() {
  clearTimeout(filmstripWarmTimer);
  filmstripWarmTimer = null;
  filmstripWarmGeneration += 1;
  filmstripWarmKeys = new Set();
}

function markThumbFailed(el) {
  if (!el) return;
  el.classList.remove('is-loading');
  el.classList.add('is-failed');
}

function thumbnailPixelRatio() {
  return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
}

function thumbSideForElement(el) {
  if (!el?.classList?.contains('catalog-card')) return THUMB_DEFAULT_MAX_SIDE;
  const cssSize = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--grid-thumb-size'), 10)
    || gridThumbSize
    || 160;
  return Math.max(
    CATALOG_THUMB_MIN_SIDE,
    Math.min(CATALOG_THUMB_MAX_SIDE, Math.ceil(cssSize * thumbnailPixelRatio())),
  );
}

function getCachedThumb(path, minSide = 0) {
  const url = preloadedThumbs.get(path);
  if (!url) return null;
  const cachedSide = preloadedThumbSides.get(path) || 0;
  if (minSide > 0 && cachedSide > 0 && cachedSide < minSide) return null;
  return url;
}

function rememberThumb(path, url, maxSide = 0) {
  if (!path || !url) return;
  const currentSide = preloadedThumbSides.get(path) || 0;
  if (!preloadedThumbs.has(path) || maxSide >= currentSide) {
    preloadedThumbs.set(path, url);
    preloadedThumbSides.set(path, maxSide);
  }
}

function applyThumbToElement(el, path, url, maxSide = 0) {
  if (!el || !url) return;
  const img = el.querySelector('img');
  if (img) {
    img.decoding = 'async';
    img.loading = el.classList.contains('thumb') ? 'eager' : 'lazy';
    img.onload = () => {
      img.dataset.thumbFallback = '';
      img.classList.add('loaded');
      el.classList.add('loaded');
      el.classList.remove('is-loading', 'is-failed');
    };
    img.onerror = () => {
      if (img.dataset.thumbFallback !== '1') {
        img.dataset.thumbFallback = '1';
        img.src = folioMediaUrl(path);
        return;
      }
      markThumbFailed(el);
    };
    if (img.src !== url) img.src = url;
    if (img.complete && img.naturalWidth) {
      img.classList.add('loaded');
      el.classList.add('loaded');
      el.classList.remove('is-loading', 'is-failed');
    }
  }
  const v = el.querySelector('video');
  if (v) {
    v.poster = url;
    el.classList.add('loaded');
    el.classList.remove('is-loading', 'is-failed');
  }
  rememberThumb(path, url, maxSide);
}

function enqueueThumb(el, p, { priority = false, maxSide = null } = {}) {
  if (!el || !p) return;
  const requestedSide = maxSide || thumbSideForElement(el);
  const cached = getCachedThumb(p, requestedSide);
  if (cached) {
    applyThumbToElement(el, p, cached, preloadedThumbSides.get(p) || requestedSide);
    return;
  }
  const placeholder = getCachedThumb(p);
  if (placeholder) applyThumbToElement(el, p, placeholder, preloadedThumbSides.get(p) || 0);
  el.classList.add('is-loading');
  const requestKey = `${p}:${requestedSide}:${filmstripThumbGeneration}`;
  if (el.dataset.thumbRequestKey === requestKey) return;
  el.dataset.thumbRequestKey = requestKey;
  const generation = el.classList.contains('thumb') ? filmstripThumbGeneration : null;
  const job = { el, path: p, retries: 0, priority, maxSide: requestedSide, generation };
  if (priority) thumbQueue.unshift(job);
  else thumbQueue.push(job);
  processThumbQueue();
}
async function processThumbQueue() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length > 0) {
    const j = thumbQueue.shift();
    thumbActive++;
    loadThumb(j).finally(() => {
      thumbActive--;
      processThumbQueue();
    });
  }
}
async function loadThumb({ el, path, retries, priority, maxSide, generation }) {
  if (!el || !path || !el.isConnected) return;
  if (generation != null && generation !== filmstripThumbGeneration) return;
  const fallback = () => {
    if (el.classList.contains('catalog-card')) {
      if (el.classList.contains('loaded')) return;
      markThumbFailed(el);
      return;
    }
    const img = el.querySelector('img');
    if (img) {
      img.onload = () => {
        img.classList.add('loaded');
        el.classList.add('loaded');
        el.classList.remove('is-loading', 'is-failed');
      };
      img.onerror = () => markThumbFailed(el);
      img.src = folioMediaUrl(path);
    } else {
      markThumbFailed(el);
    }
  };

  try {
    const key = `${path}:${maxSide}`;
    let request = thumbInflight.get(key);
    if (!request) {
      request = invoke('get_thumbnail', { path, maxSide, force: retries > 0 }).finally(() => {
        thumbInflight.delete(key);
      });
      thumbInflight.set(key, request);
    }
    const tp = await request;
    if (!el.isConnected) return;
    if (generation != null && generation !== filmstripThumbGeneration) return;
    const u = `folio://localhost/${encodeURIComponent(tp)}?v=${mediaCacheEpoch}`;
    applyThumbToElement(el, path, u, maxSide);
  } catch (err) {
    if (retries < 2) {
      await new Promise(r => setTimeout(r, 220 * (retries + 1)));
      const retryJob = { el, path, retries: retries + 1, priority, maxSide, generation };
      if (priority) thumbQueue.unshift(retryJob);
      else thumbQueue.push(retryJob);
    } else {
      fallback();
    }
  }
}
function filmstripObserverRootMargin() {
  if (filmstrip?.classList.contains('viewer-filmstrip')) return '0px 240px 0px 240px';
  return '240px 0px';
}

let filmstripObs = null;

function resetFilmstripObserver() {
  filmstripObs?.disconnect();
  filmstripObs = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting && !en.target.dataset.loaded) {
        en.target.dataset.loaded = '1';
        enqueueThumb(en.target, en.target.dataset.path);
        filmstripObs?.unobserve(en.target);
      }
    }
  }, { root: filmstrip, rootMargin: filmstripObserverRootMargin() });
}

function warmFilmstripThumbnails(start, end, { delay = 20 } = {}) {
  if (!prefetchEnabled || !items.length || !hasTauriRuntime()) return;
  const paths = [];
  const generation = filmstripWarmGeneration;
  for (let i = Math.max(0, start); i < Math.min(items.length, end); i++) {
    const path = items[i]?.path;
    const key = `${path}:${THUMB_DEFAULT_MAX_SIDE}`;
    if (!path || filmstripWarmKeys.has(key)) continue;
    filmstripWarmKeys.add(key);
    paths.push(path);
  }
  if (!paths.length) return;
  clearTimeout(filmstripWarmTimer);
  filmstripWarmTimer = setTimeout(() => {
    if (generation !== filmstripWarmGeneration) return;
    invoke('prefetch_media', { paths, maxSide: THUMB_DEFAULT_MAX_SIDE }).catch(() => {});
  }, delay);
}

function appendFilmstripThumb(it, i, { eager = false } = {}) {
    const d = document.createElement('div');
    d.className = i === idx ? 'thumb active' : 'thumb';
    d.dataset.path = it.path;
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.setAttribute('aria-label', `Open ${basename(it.path)}`);
    if (i === idx) {
      FolioState.activeThumbEl = d;
    }
    d.onclick = () => show(i, i === idx ? 0 : (i > idx ? 1 : -1));
    d.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      d.click();
    });
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
    if (eager || Math.abs(i - idx) <= 1) {
      d.dataset.loaded = '1';
      enqueueThumb(d, it.path, { priority: true });
    } else {
      filmstripObs?.observe(d);
    }
}

let filmstripVirtualized = false;

function applyFilmstripVisibility() {
  const visible = isFilmstripVisible();
  $('viewerFilmstripRow')?.classList.toggle('is-hidden', !visible);
  const filmstripCheck = $('filmstripVisibleCheck');
  if (filmstripCheck) filmstripCheck.checked = visible;
}

function buildFilmstrip() {
  filmstripThumbGeneration += 1;
  thumbQueue = thumbQueue.filter((job) => job.generation == null);
  resetFilmstripObserver();
  filmstrip.innerHTML = '';
  filmstrip.classList.toggle('grid-view', gridView);
  gridToggleBtn?.classList.toggle('active', gridView);
  if (!items.length) return;
  applyFilmstripVisibility();

  const isViewerStrip = filmstrip.classList.contains('viewer-filmstrip');
  const range = isViewerStrip ? filmstripWindowRange(idx, items.length) : { start: 0, end: items.length, virtualized: false };
  filmstripVirtualized = range.virtualized;

  if (range.virtualized) {
    if (range.start > 0) {
      const lead = document.createElement('div');
      lead.className = 'filmstrip-spacer';
      lead.style.width = `${range.start * FILMSTRIP_THUMB_STEP_PX}px`;
      lead.setAttribute('aria-hidden', 'true');
      filmstrip.appendChild(lead);
    }
    for (let i = range.start; i < range.end; i++) appendFilmstripThumb(items[i], i, { eager: true });
    if (range.end < items.length) {
      const trail = document.createElement('div');
      trail.className = 'filmstrip-spacer';
      trail.style.width = `${(items.length - range.end) * FILMSTRIP_THUMB_STEP_PX}px`;
      trail.setAttribute('aria-hidden', 'true');
      filmstrip.appendChild(trail);
    }
    warmFilmstripThumbnails(0, Math.min(items.length, FILMSTRIP_INITIAL_WARM_COUNT), { delay: 10 });
    warmFilmstripThumbnails(range.start - FILMSTRIP_WINDOW_RADIUS, range.end + FILMSTRIP_NAV_WARM_AHEAD, { delay: 10 });
    requestAnimationFrame(() => highlightThumb());
    return;
  }

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
  const path = items[idx]?.path;
  let targetThumb = path
    ? filmstrip.querySelector(`.thumb[data-path="${CSS.escape(path)}"]`)
    : null;
  if (!targetThumb && filmstripVirtualized) {
    buildFilmstrip();
    targetThumb = path
      ? filmstrip.querySelector(`.thumb[data-path="${CSS.escape(path)}"]`)
      : null;
  }
  if (targetThumb) {
    targetThumb.classList.add('active');
    FolioState.activeThumbEl = targetThumb;
    if (!targetThumb.classList.contains('loaded')) {
      targetThumb.dataset.loaded = '1';
      enqueueThumb(targetThumb, path, { priority: true });
    }
    warmFilmstripThumbnails(idx - FILMSTRIP_WINDOW_RADIUS, idx + FILMSTRIP_NAV_WARM_AHEAD, { delay: 10 });
    const scrollBehavior = reducedMotionEnabled ? 'auto' : 'smooth';
    if (filmstrip.classList.contains('viewer-filmstrip')) {
      filmstrip.scrollTo({
        left: targetThumb.offsetLeft - filmstrip.clientWidth / 2 + targetThumb.clientWidth / 2,
        behavior: scrollBehavior,
      });
    } else {
      filmstrip.scrollTo({
        top: targetThumb.offsetTop - filmstrip.clientHeight / 2 + targetThumb.clientHeight / 2,
        behavior: scrollBehavior,
      });
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

function setLocalEdit(edit) {
  const path = items[idx]?.path;
  if (path) editMap.set(path, edit);
}

function persistCurrentEdit() {
  const path = items[idx]?.path;
  const edit = path ? editMap.get(path) : null;
  if (path && edit) invoke('set_edit', { path, edit }).catch(() => {});
}

function setCurrentEdit(edit) {
  setLocalEdit(edit);
  persistCurrentEdit();
}

function isEditIdentity(edit) {
  if (!edit) return true;
  return (
    !edit.flip_h
    && !edit.flip_v
    && !edit.rotate
    && (edit.crop_x ?? 0) === 0
    && (edit.crop_y ?? 0) === 0
    && (edit.crop_w ?? 1) === 1
    && (edit.crop_h ?? 1) === 1
    && (edit.brightness ?? 0) === 0
    && (edit.vibrance ?? 0) === 0
    && (edit.contrast ?? 0) === 0
    && (edit.saturation ?? 0) === 0
    && (edit.exposure ?? 0) === 0
    && (edit.warmth ?? 0) === 0
  );
}

function hasGeometryEdit(edit) {
  if (!edit) return false;
  return (
    !!edit.flip_h
    || !!edit.flip_v
    || !!edit.rotate
    || (edit.crop_x ?? 0) !== 0
    || (edit.crop_y ?? 0) !== 0
    || (edit.crop_w ?? 1) !== 1
    || (edit.crop_h ?? 1) !== 1
  );
}

function setBasePreviewSuppressed(suppressed) {
  const base = getActiveMediaImg();
  if (base) base.classList.toggle('is-edit-preview-suppressed', !!suppressed);
}

function cssFilterForEdit(edit) {
  const exposure = (edit.exposure ?? 0) / 100;
  const brightness = (edit.brightness ?? 0) / 100;
  const contrast = 1 + (edit.contrast ?? 0) / 100;
  const saturation = 1 + (edit.saturation ?? 0) / 100 + (edit.vibrance ?? 0) / 200;
  const warmth = (edit.warmth ?? 0) / 100;
  const bright = Math.max(0.25, Math.min(2.5, 1 + brightness + exposure * 0.35));
  const sepia = warmth > 0 ? warmth * 0.35 : 0;
  const hue = warmth * 12;
  return `brightness(${bright}) contrast(${contrast}) saturate(${Math.max(0, saturation)}) sepia(${sepia}) hue-rotate(${hue}deg)`;
}

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
  renderAdjustPresetStrip();
  editHistory.render($('editHistoryList'));
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
  return layer?.querySelector('.media-content:not(.edit-preview)') || null;
}

let editPreviewResizeObserver = null;

function syncEditPreviewLayout() {
  const base = getActiveMediaImg();
  if (!base || !editPreviewImg || editPreviewImg.parentElement !== base.parentElement) return;

  if (editPreviewImg.classList.contains('is-geometry-preview')) {
    editPreviewImg.style.position = 'static';
    editPreviewImg.style.left = '';
    editPreviewImg.style.top = '';
    editPreviewImg.style.width = '';
    editPreviewImg.style.height = '';
    editPreviewImg.style.maxWidth = '';
    editPreviewImg.style.maxHeight = '';
    editPreviewImg.style.margin = '';
    editPreviewImg.style.objectFit = 'contain';
    editPreviewImg.style.transform = base.style.transform || '';
    editPreviewImg.style.transformOrigin = base.style.transformOrigin || 'center center';
    editPreviewImg.classList.toggle('zoomed', base.classList.contains('zoomed'));
    setBasePreviewSuppressed(true);
    return;
  }

  const layer = base.parentElement;
  const layerRect = layer.getBoundingClientRect();
  const rect = base.getBoundingClientRect();

  editPreviewImg.style.position = 'absolute';
  editPreviewImg.style.left = `${rect.left - layerRect.left}px`;
  editPreviewImg.style.top = `${rect.top - layerRect.top}px`;
  editPreviewImg.style.width = `${rect.width}px`;
  editPreviewImg.style.height = `${rect.height}px`;
  editPreviewImg.style.maxWidth = 'none';
  editPreviewImg.style.maxHeight = 'none';
  editPreviewImg.style.margin = '0';
  editPreviewImg.style.objectFit = 'contain';
  editPreviewImg.style.transform = base.style.transform || '';
  editPreviewImg.style.transformOrigin = base.style.transformOrigin || 'center center';
  editPreviewImg.classList.toggle('zoomed', base.classList.contains('zoomed'));
  setBasePreviewSuppressed(false);
}

function bindEditPreviewResizeObserver() {
  unbindEditPreviewResizeObserver();
  const layer = media.querySelector('.media-layer.media-active');
  if (!layer) return;
  editPreviewResizeObserver = new ResizeObserver(() => syncEditPreviewLayout());
  editPreviewResizeObserver.observe(layer);
  const base = getActiveMediaImg();
  if (base) editPreviewResizeObserver.observe(base);
}

function unbindEditPreviewResizeObserver() {
  editPreviewResizeObserver?.disconnect();
  editPreviewResizeObserver = null;
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
  applyEditPreview(e, { immediate: !FolioState.isSliderActive });
}

function removeEditPreview() {
  clearTimeout(editDebounceTimer);
  editDebounceTimer = null;
  editPreviewRequestId += 1;
  editPreviewInFlight = false;
  pendingEditFlush = null;
  unbindEditPreviewResizeObserver();
  setBasePreviewSuppressed(false);
  if (editPreviewImg) {
    editPreviewImg.remove();
    editPreviewImg = null;
  }
}

function ensureEditPreviewElement() {
  const layer = media.querySelector('.media-layer.media-active');
  if (!layer) return null;
  if (editPreviewImg?.parentElement === layer) return editPreviewImg;

  const base = getActiveMediaImg();
  if (!base?.src) return null;

  editPreviewImg = document.createElement('img');
  editPreviewImg.crossOrigin = 'anonymous';
  editPreviewImg.className = 'media-content edit-preview loaded';
  editPreviewImg.style.pointerEvents = 'none';
  editPreviewImg.style.zIndex = '2';
  editPreviewImg.src = base.src;
  layer.appendChild(editPreviewImg);
  bindEditPreviewResizeObserver();
  syncEditPreviewLayout();
  return editPreviewImg;
}

function applyCssEditPreview(edit) {
  if (isEditIdentity(edit)) {
    removeEditPreview();
    return;
  }
  if (hasGeometryEdit(edit)) {
    if (editPreviewImg?.classList.contains('is-css-preview')) removeEditPreview();
    return;
  }
  const img = ensureEditPreviewElement();
  if (!img) return;
  img.style.filter = cssFilterForEdit(edit);
  img.classList.add('is-css-preview');
  syncEditPreviewLayout();
}

async function flushEditPreview(edit, { path: pathOverride } = {}) {
  const path = pathOverride || items[idx]?.path;
  if (!path || !isEditPreviewEnabled()) return;

  if (isEditIdentity(edit)) {
    removeEditPreview();
    return;
  }

  const layer = media.querySelector('.media-layer.media-active');
  if (!layer) return;

  const reqId = ++editPreviewRequestId;
  editPreviewInFlight = true;
  const geometryPreview = hasGeometryEdit(edit);

  try {
    const previewPath = await invoke('edit_image', { path, edit });
    if (reqId !== editPreviewRequestId) return;

    if (!editPreviewImg || editPreviewImg.parentElement !== layer) {
      editPreviewImg = document.createElement('img');
      editPreviewImg.crossOrigin = 'anonymous';
      editPreviewImg.className = 'media-content edit-preview loaded';
      editPreviewImg.style.pointerEvents = 'none';
      editPreviewImg.style.zIndex = '2';
      layer.appendChild(editPreviewImg);
      bindEditPreviewResizeObserver();
    }

    const url = `folio://localhost/${encodeURIComponent(previewPath)}`;
    const onReady = () => {
      if (reqId !== editPreviewRequestId) return;
      editPreviewImg.style.filter = 'none';
      editPreviewImg.classList.remove('is-css-preview');
      editPreviewImg.classList.toggle('is-geometry-preview', geometryPreview);
      syncEditPreviewLayout();
      editPreviewInFlight = false;
      if (pendingEditFlush) {
        const next = pendingEditFlush;
        pendingEditFlush = null;
        flushEditPreview(next.edit, { path: next.path });
      }
    };

    if (editPreviewImg.src !== url) {
      editPreviewImg.addEventListener('load', onReady, { once: true });
      editPreviewImg.src = url;
    } else {
      editPreviewImg.addEventListener('load', onReady, { once: true });
      editPreviewImg.src = `${url}?r=${reqId}`;
    }
  } catch (e) {
    if (reqId === editPreviewRequestId) {
      editPreviewInFlight = false;
      console.error(e);
    }
  }
}

function applyEditPreview(edit, { immediate = false } = {}) {
  const path = items[idx]?.path;
  if (!path || !isEditPreviewEnabled()) return;

  applyCssEditPreview(edit);

  if (FolioState.isSliderActive && !immediate) return;

  clearTimeout(editDebounceTimer);
  const delay = immediate ? 0 : 100;
  editDebounceTimer = setTimeout(() => {
    if (editPreviewInFlight) {
      pendingEditFlush = { edit: { ...edit }, path };
      return;
    }
    flushEditPreview(edit);
  }, delay);
}

async function rotateCurrentEdit90() {
  const path = items[idx]?.path;
  if (!path || items[idx]?.is_video) return;
  adjustPreviewActive = true;
  if (editSessionPath !== path) {
    try {
      await invoke('prepare_edit_preview', { path });
      editSessionPath = path;
    } catch (e) {
      console.error(e);
      showToast('Could not prepare rotate preview');
      return;
    }
  }
  const e = { ...getCurrentEdit() };
  e.rotate = (e.rotate + 90) % 360;
  setCurrentEdit(e);
  loadEditForCurrent();
  applyEditPreview(e, { immediate: true });
}

/* ── Interactive Listeners ── */
$('openBtn').addEventListener('click', openFolder);
$('openBtn2').addEventListener('click', openFolder);
$('openBtnCanvas')?.addEventListener('click', openFolder);
$('homeSettingsBtn')?.addEventListener('click', openSettings);
$('homeQuickActionsBtn')?.addEventListener('click', openCommandPalette);
$('prev').addEventListener('click', () => nav(-1));
$('next').addEventListener('click', () => nav(1));
$('settingsBack')?.addEventListener('click', closeSettings);
zoomSlider?.addEventListener('input', (e) => setZoom(parseInt(e.target.value) / 100, 0, 0));
zoomReset?.addEventListener('click', resetZoom);
fullscreenBtn?.addEventListener('click', toggleFullscreen);
$('viewerFullscreenTopBtn')?.addEventListener('click', () => fullscreenBtn?.click());
$('viewerShareBtn')?.addEventListener('click', () => {
  const filePath = items[idx]?.path;
  if (filePath) invoke('show_native_share_sheet', { filePath }).catch((err) => showToast(`Sharing failed: ${err}`));
});
$('viewerInspectorBtn')?.addEventListener('click', () => setInspectorVisible(!inspectorPaneVisible));
$('filmstripPrevBtn')?.addEventListener('click', () => nav(-1));
$('filmstripNextBtn')?.addEventListener('click', () => nav(1));
$('zoomInBtn')?.addEventListener('click', () => {
  setZoom(Math.min(MAX_ZOOM, zoom + 0.35), 0, 0);
  if (zoomSlider) zoomSlider.value = String(Math.round(zoom * 100));
});
$('zoomOutBtn')?.addEventListener('click', () => {
  setZoom(Math.max(MIN_ZOOM, zoom - 0.35), 0, 0);
  if (zoomSlider) zoomSlider.value = String(Math.round(zoom * 100));
});
viewerRotateQuickBtn?.addEventListener('click', rotateCurrentEdit90);
if (viewerCompareBtn) {
  const releaseCompare = () => {
    viewer?.classList.remove('viewer-compare-active');
    if (!items[idx]?.is_video) applyCssEditPreview(getCurrentEdit());
  };
  viewerCompareBtn.addEventListener('pointerdown', (e) => {
    if (!items[idx] || items[idx]?.is_video) return;
    e.preventDefault();
    viewer.classList.add('viewer-compare-active');
    applyCssEditPreview(defaultEdit());
  });
  viewerCompareBtn.addEventListener('pointerup', releaseCompare);
  viewerCompareBtn.addEventListener('pointercancel', releaseCompare);
  viewerCompareBtn.addEventListener('pointerleave', releaseCompare);
  viewerCompareBtn.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    viewer.classList.add('viewer-compare-active');
    applyCssEditPreview(defaultEdit());
  });
  viewerCompareBtn.addEventListener('keyup', releaseCompare);
}

const filmstripVisibleCheck = $('filmstripVisibleCheck');
if (filmstripVisibleCheck) {
  filmstripVisibleCheck.checked = isFilmstripVisible();
  filmstripVisibleCheck.addEventListener('change', () => {
    setFilmstripVisible(filmstripVisibleCheck.checked);
    applyFilmstripVisibility();
  });
}

viewerChromeCtl = initViewerChrome({
  viewer,
  topbar: $('viewerTopbar'),
  chromeRoot: $('viewerChrome'),
  getReducedMotion: () => reducedMotionEnabled,
  isScrubbing: () => FolioState.isScrubbingActive,
  isEditOpen: () => editPanelOpen,
  isZenMode: () => zenModeActive,
});

bindDockOverflowMenu({
  menu: $('viewerDockMenu'),
  trigger: $('viewerDockOverflowBtn'),
  onAction: (action) => {
    if (action === 'reveal') openPathInFinder(items[idx]?.path, true);
    else if (action === 'share') $('viewerShareBtn')?.click();
    else if (action === 'tag') showTagPill();
    else if (action === 'command') openCommandPalette();
    else if (action === 'filmstrip') {
      setFilmstripVisible(!isFilmstripVisible());
      applyFilmstripVisibility();
      showToast(isFilmstripVisible() ? 'Filmstrip shown' : 'Filmstrip hidden');
    }
  },
});

applyFilmstripVisibility();

initInspectorCards({ host: $('inspectorCardsHost') });

$('inspectorCustomizeBtn')?.addEventListener('click', () => {
  saveInspectorCardOrder([...DEFAULT_INSPECTOR_CARD_ORDER]);
  saveInspectorCardCollapsed({});
  const host = $('inspectorCardsHost');
  if (host) {
    delete host.dataset.dragBound;
    host.querySelectorAll('[data-inspector-card]').forEach((el) => {
      delete el.dataset.inspectorReady;
    });
    initInspectorCards({ host });
  }
  showToast('Inspector layout reset');
});

$('inspectorShowMapBtn')?.addEventListener('click', async () => {
  const item = items[idx];
  if (!item) return;
  if (!hasItemGps(item)) {
    await syncMapGpsFromBackend();
  }
  if (!hasItemGps(item)) {
    showToast('No GPS data for this file');
    return;
  }
  toggleMapView(true, { focusPath: item.path });
});

$('mapBackBtn')?.addEventListener('click', () => toggleMapView(false));
if (mapStyleSelect) {
  mapStyleSelect.value = mapTileStyle;
  mapStyleSelect.addEventListener('change', () => {
    mapTileStyle = mapStyleSelect.value || 'dark';
    localStorage.removeItem('folio_map_tile_style_migrated');
    localStorage.setItem('folio_map_tile_style', mapTileStyle);
    postMapFrameMessage($('mapWorkspaceFrame'), { type: 'setTileStyle', tileStyle: mapTileStyle });
  });
}
if (mapReverseToggle) {
  mapReverseToggle.setAttribute('aria-pressed', String(reverseGeocodeEnabled));
  mapReverseToggle.classList.toggle('active', reverseGeocodeEnabled);
  mapReverseToggle.addEventListener('click', () => {
    reverseGeocodeEnabled = !reverseGeocodeEnabled;
    localStorage.setItem('folio_reverse_geocode_enabled', String(reverseGeocodeEnabled));
    if (reverseGeocodeCheck) reverseGeocodeCheck.checked = reverseGeocodeEnabled;
    mapReverseToggle.setAttribute('aria-pressed', String(reverseGeocodeEnabled));
    mapReverseToggle.classList.toggle('active', reverseGeocodeEnabled);
    showToast(reverseGeocodeEnabled ? 'Reverse lookup enabled' : 'Reverse lookup disabled');
  });
}
mapFitBtn?.addEventListener('click', () => {
  postMapFrameMessage($('mapWorkspaceFrame'), { type: 'fitAll' });
});

document.querySelectorAll('.map-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    mapFilterMode = btn.dataset.mapFilter || 'all';
    document.querySelectorAll('.map-filter-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    refreshMapWorkspace();
  });
});

$('mapOpenViewerBtn')?.addEventListener('click', () => {
  if (mapSelectedTrayPath) window.openMapItem(mapSelectedTrayPath);
});

$('inspectorCopyGpsBtn2')?.addEventListener('click', () => copyInspectorValue('gps').catch(() => showToast('Copy failed')));

$('inspectorTagAddBtn')?.addEventListener('click', () => addInspectorTag().catch((err) => showToast(`Tag failed: ${err}`)));
inspectorTagInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addInspectorTag().catch((err) => showToast(`Tag failed: ${err}`));
});

async function copyInspectorValue(kind) {
  const item = items[idx];
  if (!item) return;
  const values = {
    name: basename(item.path),
    path: item.path,
    gps: item.exif?.latitude != null && item.exif?.longitude != null ? `${item.exif.latitude}, ${item.exif.longitude}` : '',
    camera: [item.exif?.camera, item.exif?.lens, item.exif?.aperture, item.exif?.shutter_speed, item.exif?.iso ? `ISO ${item.exif.iso}` : ''].filter(Boolean).join(' · '),
  };
  if (!values[kind]) {
    showToast(`No ${kind} metadata available`);
    return;
  }
  await navigator.clipboard.writeText(values[kind]);
  showToast(`Copied ${kind}`);
}

$('inspectorCopyNameBtn')?.addEventListener('click', () => copyInspectorValue('name').catch(() => showToast('Copy failed')));
$('inspectorCopyPathBtn')?.addEventListener('click', () => copyInspectorValue('path').catch(() => showToast('Copy failed')));
$('inspectorCopyGpsBtn')?.addEventListener('click', () => copyInspectorValue('gps').catch(() => showToast('Copy failed')));
$('inspectorCopyCameraBtn')?.addEventListener('click', () => copyInspectorValue('camera').catch(() => showToast('Copy failed')));

sidebarToggle.addEventListener('click', () => {
  setSidebarVisible(sidebar.classList.contains('collapsed'));
});

inspectorCollapseBtn?.addEventListener('click', () => {
  setInspectorVisible(!inspectorPaneVisible);
});

$('saveEditPresetBtn')?.addEventListener('click', async () => {
  const name = await requestTextInput({
    title: 'Save adjustment preset',
    message: 'Name this preset so it can be reused from the Inspector.',
    label: 'Preset name',
    confirmLabel: 'Save preset',
  });
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
  btn.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = Array.from(document.querySelectorAll('.inspector-tab'));
    const current = tabs.indexOf(btn);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
      : (current + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  });
});

document.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => applyNavFilter(btn.dataset.nav));
});

document.querySelectorAll('.nav-section').forEach((section, index) => {
  const label = section.querySelector('.nav-section-label');
  if (!label) return;
  label.classList.add('nav-section-toggle');
  label.tabIndex = 0;
  label.setAttribute('role', 'button');
  label.setAttribute('aria-expanded', 'true');
  label.addEventListener('click', () => {
    const collapsed = section.classList.toggle('collapsed');
    label.setAttribute('aria-expanded', String(!collapsed));
  });
  section.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
    const count = document.createElement('span');
    count.className = 'nav-count';
    count.dataset.navCount = btn.dataset.nav;
    count.textContent = '0';
    btn.appendChild(count);
  });
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
  if (!hasTauriRuntime()) return;
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
    if (activeSmartFilter === 'duplicates') applyNavFilter('all');
    renderSidebarFilterCounts();
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
      renderSidebarFilterCounts();
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

catalogMapBtn?.addEventListener('click', async () => {
  await syncMapGpsFromBackend();
  const geotagged = items.filter(hasItemGps);
  if (geotagged.length === 0) {
    showToast('No GPS media in this library. Add location metadata to use Map View.');
    return;
  }
  if (!catalogModeActive) toggleCatalogView(true);
  toggleMapView(true);
});

// Duplicates Resolver (UX-6)
let currentDupGroupIndex = 0;
let dupGroupsData = [];
let duplicateResolverFocusCleanup = null;
let duplicateResolverReturnFocus = null;

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
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDuplicateResolver();
    });
    document.body.appendChild(modal);
  }
  modal.classList.add('is-open');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'duplicateResolverTitle');
  duplicateResolverReturnFocus = document.activeElement;
  renderDuplicateGroup();
};

window.closeDuplicateResolver = () => {
  const modal = document.getElementById('duplicateResolverModal');
  if (modal) modal.classList.remove('is-open');
  duplicateResolverFocusCleanup?.();
  duplicateResolverFocusCleanup = null;
  duplicateResolverReturnFocus?.focus?.();
  duplicateResolverReturnFocus = null;
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
      <h2 class="dup-resolver-title" id="duplicateResolverTitle">Resolve duplicates</h2>
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
    const nameEl = document.createElement('div');
    nameEl.className = 'dup-resolver-card-name';
    nameEl.title = name;
    nameEl.textContent = name;
    const metaEl = document.createElement('div');
    metaEl.className = 'dup-resolver-card-meta';
    metaEl.textContent = `${sz}${dims ? ` · ${dims}` : ''}`;
    info.append(nameEl, metaEl);

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
  duplicateResolverFocusCleanup?.();
  duplicateResolverFocusCleanup = trapFocus(dialog);
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

if (catalogSortSelect) catalogSortSelect.value = currentSort;
catalogSortSelect?.addEventListener('change', () => {
  currentSort = catalogSortSelect.value;
  localStorage.setItem('folio_sort', currentSort);
  sortItems();
  buildCatalogContent();
});

function setCatalogSelectionMode(active) {
  catalogSelectionModeActive = active;
  catalogSelectModeBtn?.classList.toggle('active', active);
  catalogSelectModeBtn?.setAttribute('aria-pressed', String(active));
  if (catalogSelectModeBtn) catalogSelectModeBtn.textContent = active ? 'Selecting' : 'Select';
  catalogGrid?.classList.toggle('selection-mode', active);
}

function updateCatalogSelectionState() {
  document.querySelectorAll('.catalog-card').forEach((card) => {
    const selected = selectedCatalogPaths.has(card.dataset.path);
    card.classList.toggle('selected', selected);
    card.querySelector('.card-select-checkbox')?.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  updateTranscodeHud();
  if (selectedCatalogPaths.size > 0 && !catalogSelectionModeActive) {
    setCatalogSelectionMode(true);
  } else if (selectedCatalogPaths.size === 0 && catalogSelectionModeActive) {
    setCatalogSelectionMode(false);
  }
}

catalogSelectModeBtn?.addEventListener('click', () => {
  setCatalogSelectionMode(!catalogSelectionModeActive);
});

catalogBackBtn?.addEventListener('click', () => toggleCatalogView(false));

catalogFilterFocusBtn?.addEventListener('click', () => {
  catalogFilterRail?.scrollIntoView({ behavior: reducedMotionEnabled ? 'auto' : 'smooth', block: 'nearest' });
  catalogFilterRail?.querySelector('.nav-item.active, .nav-item')?.focus();
});

catalogFavoritesQuickBtn?.addEventListener('click', () => {
  applyNavFilter(activeSmartFilter === 'favorites' ? 'all' : 'favorites');
});

if (catalogSortMenu && catalogSortMenuBtn) {
  const closeSortMenu = () => {
    catalogSortMenu.hidden = true;
    catalogSortMenuBtn.setAttribute('aria-expanded', 'false');
  };
  catalogSortMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = catalogSortMenu.hidden;
    closeSortMenu();
    if (!open) {
      const rect = catalogSortMenuBtn.getBoundingClientRect();
      catalogSortMenu.style.top = `${rect.bottom + 6}px`;
      catalogSortMenu.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
      catalogSortMenu.hidden = false;
      catalogSortMenuBtn.setAttribute('aria-expanded', 'true');
    }
  });
  catalogSortMenu.querySelectorAll('[data-sort]').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.sort === currentSort));
  });
  catalogSortMenu.querySelectorAll('[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentSort = btn.dataset.sort;
      if (catalogSortSelect) catalogSortSelect.value = currentSort;
      localStorage.setItem('folio_sort', currentSort);
      catalogSortMenu.querySelectorAll('[data-sort]').forEach((candidate) => {
        candidate.setAttribute('aria-checked', String(candidate.dataset.sort === currentSort));
      });
      sortItems();
      buildCatalogContent();
      closeSortMenu();
    });
  });
  document.addEventListener('click', (e) => {
    if (!catalogSortMenu.hidden && !catalogSortMenu.contains(e.target) && e.target !== catalogSortMenuBtn) {
      closeSortMenu();
    }
  });
}

bindCatalogOverflowMenu({
  menu: catalogOverflowMenu,
  trigger: catalogOverflowBtn,
  onAction: (action) => {
    if (action === 'map') {
      catalogMapBtn?.click();
      return;
    }
    else if (action === 'duplicates') catalogDuplicatesBtn?.click();
    else if (action === 'save-smart') saveSmartAlbumBtn?.click();
    else if (action === 'finder') catalogFinderBtn?.click();
    else if (action === 'new-folder') catalogNewFolderBtn?.click();
    else if (action === 'close') toggleCatalogView(false);
  },
});

document.querySelectorAll('.catalog-density-btn').forEach((btn) => {
  const value = parseInt(btn.dataset.density, 10);
  btn.classList.toggle('active', value === gridThumbSize);
  btn.addEventListener('click', () => setCatalogDensity(value));
});

if (catalogDensitySlider) {
  catalogDensitySlider.value = String(gridThumbSize);
  catalogDensitySlider.addEventListener('input', () => {
    setCatalogDensity(parseInt(catalogDensitySlider.value, 10));
  });
}
syncCatalogDensityUi(gridThumbSize);
document.documentElement.style.setProperty('--grid-thumb-size', `${gridThumbSize}px`);

catalogSearchInput?.addEventListener('input', debounce(() => {
  catalogSearchTerm = catalogSearchInput.value.trim().toLowerCase();
  applyFilters();
}, 120));

saveSmartAlbumBtn?.addEventListener('click', async () => {
  const name = await requestTextInput({
    title: 'Save smart album',
    message: 'Name this reusable catalog filter.',
    label: 'Smart album name',
    value: activeSmartFilter ? `Smart ${activeSmartFilter}` : 'Current Smart Filter',
    confirmLabel: 'Save album',
  });
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
editResetBtn.addEventListener('click', () => {
  const p = items[idx]?.path;
  if (!p) return;
  setCurrentEdit(defaultEdit());
  loadEditForCurrent();
  showToast('Edit reset');
});

flipHBtn.addEventListener('click', () => { const e = getCurrentEdit(); e.flip_h = !e.flip_h; setCurrentEdit(e); loadEditForCurrent(); });
rotateBtn.addEventListener('click', rotateCurrentEdit90);
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
    const suggestedName = basename(p).replace(/(\.[^.]+)$/, '_edited$1');
    const watermarkPayload = generateWatermarkPayload();
    const dest = await invoke('export_edited_with_picker', {
      path: p,
      suggestedName,
      stripMetadata: stripMetadataEnabled,
      watermark: watermarkPayload,
      watermarkAnchor: activeWatermarkAnchor,
    });
    if (dest) {
      showToast('Exported successfully'); 
    }
  } catch (e) { showToast('Export failed'); }
});

function bindEditSliders() {
  document.querySelectorAll('.edit-slider').forEach((s) => {
    if (s.dataset.bound === '1') return;
    s.dataset.bound = '1';
    s.setAttribute('aria-label', s.closest('.edit-row')?.querySelector('label')?.textContent || s.dataset.param);
    let lastHistoryLabel = '';

    const finishSliderDrag = () => {
      if (!FolioState.isSliderActive) return;
      FolioState.isSliderActive = false;
      const edit = getCurrentEdit();
      persistCurrentEdit();
      applyEditPreview(edit, { immediate: true });
      if (lastHistoryLabel) {
        recordEditHistory(lastHistoryLabel, items[idx]?.path);
        lastHistoryLabel = '';
      }
    };

    s.addEventListener('pointerdown', () => {
      FolioState.isSliderActive = true;
      ensureEditSession();
    });
    s.addEventListener('pointerup', finishSliderDrag);
    s.addEventListener('pointercancel', finishSliderDrag);
    s.addEventListener('input', () => {
      const val = parseFloat(s.value);
      const valEl = s.closest('.edit-row')?.querySelector('.edit-val');
      if (valEl) valEl.textContent = Math.round(val);
      const edit = getCurrentEdit();
      edit[s.dataset.param] = val;
      setLocalEdit(edit);
      applyCssEditPreview(edit);
      const label = s.closest('.edit-row')?.querySelector('label')?.textContent;
      if (label) lastHistoryLabel = `${label} ${Math.round(val)}`;
    });
  });
}
bindEditSliders();

function renderAdjustPresetStrip() {
  const strip = $('adjustPresetStrip');
  if (!strip) return;
  strip.replaceChildren();
  BUILTIN_EDIT_PRESETS.slice(0, 6).forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'edit-preset-chip';
    btn.textContent = preset.name;
    btn.addEventListener('click', async () => {
      const path = items[idx]?.path;
      if (!path) return;
      editMap.set(path, { ...preset.edit });
      await invoke('set_edit', { path, edit: preset.edit });
      loadEditForCurrent();
      recordEditHistory(`Preset: ${preset.name}`, path);
      showToast(`Applied “${preset.name}”`);
    });
    strip.appendChild(btn);
  });
}

/* ── Global Handlers ── */
function modifierActive(e, mod) {
  if (mod === 'Shift') return e.shiftKey || e.getModifierState?.('Shift') === true;
  if (mod === 'Control' || mod === 'Ctrl') return e.ctrlKey || e.getModifierState?.('Control') === true;
  if (mod === 'Alt' || mod === 'Option') return e.altKey || e.getModifierState?.('Alt') === true;
  if (mod === 'Meta' || mod === 'Cmd' || mod === 'Command') return e.metaKey || e.getModifierState?.('Meta') === true;
  const prop = mod.toLowerCase() + 'Key';
  return !!e[prop];
}

function commandPaletteActions() {
  return [
    { label: 'Open folder', hint: 'Library', run: openFolder },
    { label: 'Open catalog grid', hint: 'G', run: () => toggleCatalogView(true) },
    { label: 'Open map explorer', hint: 'GPS', run: () => toggleMapView(true) },
    { label: 'Return to viewer', hint: 'Esc', run: () => { toggleMapView(false); toggleCatalogView(false); } },
    { label: 'Show settings', hint: 'Preferences', run: openSettings },
    { label: 'Toggle sidebar', hint: 'B', run: () => sidebarToggle.click() },
    { label: 'Toggle inspector', hint: 'I', run: () => setInspectorVisible(!inspectorPaneVisible) },
    { label: 'Reveal current file in Finder', hint: 'Finder', run: () => openPathInFinder(items[idx]?.path, true) },
    { label: 'Go home', hint: 'H', run: goHome },
  ];
}

function renderCommandPalette() {
  if (!commandPaletteList) return;
  const query = commandPaletteInput?.value.trim().toLowerCase() || '';
  commandPaletteList.replaceChildren();
  commandPaletteActions()
    .filter((action) => action.label.toLowerCase().includes(query))
    .forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'command-palette-item';
      btn.innerHTML = `<span>${action.label}</span><kbd>${action.hint}</kbd>`;
      btn.addEventListener('click', () => {
        closeCommandPalette();
        action.run();
      });
      commandPaletteList.appendChild(btn);
    });
}

function openCommandPalette() {
  if (!commandPalette) return;
  commandPalette.hidden = false;
  commandPaletteInput.value = '';
  renderCommandPalette();
  commandPaletteInput.focus();
}

function closeCommandPalette() {
  if (commandPalette) commandPalette.hidden = true;
}

commandPaletteInput?.addEventListener('input', renderCommandPalette);
commandPalette?.addEventListener('click', (e) => {
  if (e.target === commandPalette) closeCommandPalette();
});

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

function isViewerWorkspaceActive() {
  return viewer?.classList.contains('is-active') ?? false;
}

function isViewerWheelTarget(e) {
  if (!isViewerWorkspaceActive()) return false;
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
    currentTauriWindow()?.startDragging().catch(() => {});
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
        setCatalogDensity(gridThumbSize + 16);
      }
    } else if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      e.stopPropagation();
      if (catalogModeActive) {
        setCatalogDensity(gridThumbSize - 16);
      }
    }
  }
}, true);

/* ── Drag & Drop ── */
window.addEventListener('dragenter', (e) => e.preventDefault());
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

currentTauriWebview()?.onDragDropEvent(async (event) => {
  const { type, paths } = event.payload;
  if (type === 'enter' || type === 'over') {
    dropzoneGlow?.classList.add('active');
  } else if (type === 'leave') {
    dropzoneGlow?.classList.remove('active');
  } else if (type === 'drop') {
    dropzoneGlow?.classList.remove('active');
    if (!paths?.length) return;
    try {
      const result = await invoke('open_dropped_media_at_path', { filePath: paths[0] });
      const p = result.folder || paths[0];
      await rememberLibraryFolder(p);
      renderHomeHub();
      await loadFolderData(p, result.file || null);
    } catch (err) {
      console.error(err);
      showToast(`Could not open dropped item: ${err}`);
    }
  }
});

/* ── Histogram & Utilities ── */
function sortItems({ rebuildFilmstrip = true } = {}) {
  const rects = new Map();
  document.querySelectorAll('.thumb').forEach(t => {
    const path = t.dataset.path;
    if (path) rects.set(path, t.getBoundingClientRect());
  });

  if (currentSort === 'date') {
    items.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  } else if (currentSort === 'size') {
    items.sort((a, b) => (b.size || 0) - (a.size || 0));
  } else if (currentSort === 'dimensions') {
    items.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
  } else if (currentSort === 'rating') {
    items.sort((a, b) => (mediaAttributesCache.get(b.path)?.rating || 0) - (mediaAttributesCache.get(a.path)?.rating || 0));
  } else {
    items.sort((a, b) => a.path.localeCompare(b.path));
  }
  
  if (rebuildFilmstrip) buildFilmstrip();

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
  const adjustCanvas = $('adjustHistogramCanvas');
  const adjustCtx = adjustCanvas?.getContext('2d');
  if (adjustCtx) adjustCtx.clearRect(0, 0, adjustCanvas.width, adjustCanvas.height);
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

    const adjustCanvas = $('adjustHistogramCanvas');
    const adjustCtx = adjustCanvas?.getContext('2d');
    if (adjustCtx && histogramCanvas) {
      adjustCtx.clearRect(0, 0, adjustCanvas.width, adjustCanvas.height);
      adjustCtx.drawImage(histogramCanvas, 0, 0, adjustCanvas.width, adjustCanvas.height);
    }

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
          
          await ensureFolderDominantColorsCache();
        }
        applyFilters();
      };
    });
  } catch (e) {
    console.error('Failed to get dominant colors:', e);
  }
}

async function ensureFolderDominantColorsCache() {
  if (Object.keys(folderDominantColorsCache).length >= items.length) return folderDominantColorsCache;
  if (folderDominantColorsLoading) return folderDominantColorsLoading;
  const generation = folderDominantColorsGeneration;
  folderDominantColorsLoading = (async () => {
    const pending = items.map((it) => it.path).filter((path) => !folderDominantColorsCache[path]);
    const chunkSize = 120;
    for (let i = 0; i < pending.length; i += chunkSize) {
      if (generation !== folderDominantColorsGeneration) return folderDominantColorsCache;
      const colors = await invoke('get_folder_dominant_colors', { paths: pending.slice(i, i + chunkSize) });
      if (generation !== folderDominantColorsGeneration) return folderDominantColorsCache;
      folderDominantColorsCache = { ...folderDominantColorsCache, ...colors };
      if (activeColorFilter && catalogModeActive) renderCatalogWindow(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return folderDominantColorsCache;
  })().finally(() => {
    folderDominantColorsLoading = null;
  });
  return folderDominantColorsLoading;
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
  queueMicrotask(() => {
    syncDiagnosticsPolling();
    syncPerformanceMonitor();
  });
}

// ── Mobile sidebar drawer click-away & Resize ──
window.addEventListener('resize', () => {
  const isMobile = window.innerWidth < 768;
  if (isMobile) {
    setSidebarVisible(false);
  } else {
    if (isViewerWorkspaceActive() && !zenModeActive) {
      setSidebarVisible(true);
    }
  }
});
document.addEventListener('click', (e) => {
  if (window.innerWidth < 768) {
    if (!sidebar.classList.contains('collapsed') && !sidebar.contains(e.target) && e.target !== sidebarToggle) {
      setSidebarVisible(false);
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
let performanceMonitorRaf = 0;

function monitorPerformanceLoop() {
  if (!performanceHudEnabled) {
    performanceMonitorRaf = 0;
    return;
  }
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
  
  performanceMonitorRaf = requestAnimationFrame(monitorPerformanceLoop);
}

function syncPerformanceMonitor() {
  if (performanceHudEnabled && !performanceMonitorRaf) {
    lastFrameTime = performance.now();
    lastFpsUpdate = lastFrameTime;
    frameCount = 0;
    performanceMonitorRaf = requestAnimationFrame(monitorPerformanceLoop);
  } else if (!performanceHudEnabled && performanceMonitorRaf) {
    cancelAnimationFrame(performanceMonitorRaf);
    performanceMonitorRaf = 0;
  }
}

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
function diagnosticsPollingNeeded() {
  const activeTab = document.querySelector('.settings-nav-item.active')?.dataset?.tab;
  return performanceHudEnabled || (isSettingsOpen() && (activeTab === 'cache' || activeTab === 'advanced'));
}

function startDiagnosticsPolling() {
  if (diagnosticsInterval) return;
  diagnosticsInterval = setInterval(async () => {
    const isHudActive = performanceHudEnabled;
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

function syncDiagnosticsPolling() {
  if (diagnosticsPollingNeeded()) {
    startDiagnosticsPolling();
  } else if (diagnosticsInterval) {
    clearInterval(diagnosticsInterval);
    diagnosticsInterval = null;
  }
}

/* ── Settings navigation ── */
async function activateSettingsTab(btn) {
  const tab = btn.dataset.tab;
  document.querySelectorAll('.settings-nav-item').forEach(b => {
    const active = b === btn;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
    b.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    const active = p.id === 'tab-' + tab;
    p.classList.toggle('active', active);
    p.hidden = !active;
  });
  if (settingsPaneTitle && SETTINGS_PANE_TITLES[tab]) {
    settingsPaneTitle.textContent = SETTINGS_PANE_TITLES[tab];
  }
  if (tab === 'cache' || tab === 'advanced') await loadStorageDiagnostics();
  syncDiagnosticsPolling();
}

bindSettingsNavigation();

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
  syncDiagnosticsPolling();
  syncPerformanceMonitor();
});

let mediaCacheEpoch = 0;

async function reloadLibraryAfterCacheClear(cacheResult) {
  const folderToReload = openedLibraryPath;
  selectedCatalogPaths.clear();
  updateTranscodeHud();
  mediaCacheEpoch += 1;
  preloadedThumbs.clear();
  preloadedThumbSides.clear();
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
  if (confirmMsg && !await requestConfirmation({
    title: label,
    message: confirmMsg,
    confirmLabel: label,
    destructive: invokeName === 'reset_library_metadata' || invokeName === 'purge_cache',
  })) return;
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
  return labels[key] || String(key || '').toUpperCase();
}

function populateKeybindButtons() {
  keybinds = normalizeKeybinds(keybinds);
  document.querySelectorAll('.keybind-btn').forEach(btn => {
    const action = btn.dataset.action;
    if (action && defaultKeybinds[action] !== undefined) {
      const value = keybinds[action] || defaultKeybinds[action];
      btn.textContent = keybindLabel(value);
      btn.setAttribute('aria-label', `Change shortcut for ${btn.closest('.setting-row')?.querySelector('label')?.textContent || action}`);
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
  if (!action || !key) return;
  keybinds[action] = key;
  keybinds = normalizeKeybinds(keybinds);
  localStorage.setItem('folio_keybinds', JSON.stringify(keybinds));
  activeKeybindBtn.textContent = keybindLabel(keybinds[action]);
  activeKeybindBtn.classList.remove('recording');
  activeKeybindBtn = null;
}, true);

function collapseSidebar() {
  if (sidebar && !sidebar.classList.contains('collapsed')) setSidebarVisible(false);
}

function toggleZenMode() {
  zenModeActive = !zenModeActive;
  if (zenModeActive) {
    zenSidebarWasVisible = sidebar && !sidebar.classList.contains('collapsed');
    zenInspectorWasVisible = inspectorPaneVisible;
    if (zenSidebarWasVisible) collapseSidebar();
    if (zenInspectorWasVisible) setInspectorVisible(false);
  } else {
    sidebar?.classList.remove('zen-hide');
    if (zenSidebarWasVisible) setSidebarVisible(true);
    if (zenInspectorWasVisible) setInspectorVisible(true);
  }
  document.body.classList.toggle('zen-mode', zenModeActive);
  sidebar?.classList.toggle('zen-hide', zenModeActive);
  inspectorPane?.classList.toggle('zen-hide', zenModeActive);
  document.getElementById('zoomHud')?.classList.toggle('zen-hide', zenModeActive);
  document.getElementById('editToggleBtn')?.classList.toggle('zen-hide', zenModeActive);
  $('viewerChrome')?.classList.toggle('zen-hide', zenModeActive);
  $('viewerTopbar')?.classList.toggle('zen-hide', zenModeActive);
  document.getElementById('sidebarToggle')?.classList.toggle('zen-hide', zenModeActive);
  $('viewerDockMenu')?.setAttribute('hidden', '');
  closeCropMode();
  closeEditPanel();
  if (zenModeActive) viewer.classList.add('viewer-chrome-idle');
  else viewerChromeCtl?.wake();
  showToast(zenModeActive ? 'Zen Mode Activated' : 'Zen Mode Deactivated');
}

function showAppContextMenu(e, { label = '', actions = [] } = {}) {
  e.preventDefault();
  document.getElementById('customContextMenu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'customContextMenu';
  menu.className = 'app-context-menu';
  menu.setAttribute('role', 'menu');
  if (label) {
    const title = document.createElement('div');
    title.className = 'app-context-menu-title';
    title.textContent = label;
    menu.appendChild(title);
  }
  actions.forEach((action) => {
    if (action.separator) {
      const divider = document.createElement('div');
      divider.className = 'app-context-menu-divider';
      menu.appendChild(divider);
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-context-menu-item' + (action.destructive ? ' is-destructive' : '');
    button.setAttribute('role', 'menuitem');
    button.textContent = action.label;
    button.disabled = action.disabled === true;
    button.addEventListener('click', () => {
      menu.remove();
      action.run?.();
    });
    menu.appendChild(button);
  });
  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - height - 8))}px`;
}

function showContextMenu(e, itemPath, itemIndex) {
  const item = items[itemIndex];
  const attr = mediaAttributesCache.get(itemPath) || {};
  showAppContextMenu(e, {
    label: basename(itemPath),
    actions: [
      { label: 'Open in viewer', run: () => { idx = itemIndex; toggleCatalogView(false); } },
      { label: 'Reveal in Finder', run: () => openPathInFinder(itemPath, true) },
      { label: 'Share…', run: () => invoke('show_native_share_sheet', { filePath: itemPath }).catch((err) => showToast(`Sharing failed: ${err}`)) },
      { separator: true },
      { label: attr.favorite ? 'Remove favorite' : 'Favorite', run: () => invoke('set_media_favorite', { paths: [itemPath], favorite: !attr.favorite }).then(() => { attr.favorite = !attr.favorite; mediaAttributesCache.set(itemPath, attr); buildFilmstrip(); if (catalogModeActive) buildCatalogContent(); }) },
      { label: isPicked(itemPath) ? 'Remove pick' : 'Mark as pick', run: () => { togglePick(itemPath); buildFilmstrip(); } },
      { label: 'Copy filename', run: () => navigator.clipboard.writeText(basename(itemPath)) },
      { label: 'Copy path', run: () => navigator.clipboard.writeText(itemPath) },
      { separator: true },
      { label: 'Move to Trash…', destructive: true, run: () => showDeleteConfirmation(itemPath, itemIndex) },
    ],
  });
}

document.addEventListener('mousedown', (e) => {
  const menu = document.getElementById('customContextMenu');
  if (menu && !menu.contains(e.target)) menu.remove();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('customContextMenu')?.remove();
});
document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return;
  if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
  const home = !items.length;
  showAppContextMenu(e, {
    label: home ? 'Folio' : catalogModeActive ? 'Catalog' : 'Viewer',
    actions: [
      { label: 'Open folder…', run: openFolder },
      { label: home ? 'Open recent library' : 'Go home', run: home ? () => $('homeResumeBtn')?.click() : goHome },
      { label: catalogModeActive ? 'Return to viewer' : 'Open catalog', disabled: !items.length, run: () => toggleCatalogView(!catalogModeActive) },
      { separator: true },
      { label: 'Quick actions…', run: openCommandPalette },
      { label: 'Settings', run: openSettings },
    ],
  });
});

let dialogIdSequence = 0;
function enhanceDialog(modal, dialog, title, initialFocus = null) {
  const returnFocus = document.activeElement;
  const titleId = `folioDialogTitle${++dialogIdSequence}`;
  title.id = titleId;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', titleId);
  const releaseTrap = trapFocus(dialog);
  initialFocus?.focus();
  const onKeydown = (e) => {
    if (e.key === 'Escape') modal.dispatchEvent(new CustomEvent('folio-dialog-close'));
  };
  modal.addEventListener('keydown', onKeydown);
  return () => {
    releaseTrap();
    modal.removeEventListener('keydown', onKeydown);
    returnFocus?.focus?.();
  };
}

function createAppDialog({ title, message, confirmLabel, cancelLabel = 'Cancel', destructive = false, input = null }) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'folio-dialog-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'folio-dialog';
    const titleEl = document.createElement('h3');
    titleEl.className = 'folio-dialog-title';
    titleEl.textContent = title;
    const messageEl = document.createElement('p');
    messageEl.className = 'folio-dialog-message';
    messageEl.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'folio-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'folio-dialog-btn';
    cancelBtn.textContent = cancelLabel;
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'folio-dialog-btn folio-dialog-btn--primary' + (destructive ? ' folio-dialog-btn--danger' : '');
    confirmBtn.textContent = confirmLabel;

    dialog.append(titleEl, messageEl);
    let inputEl = null;
    if (input) {
      const label = document.createElement('label');
      label.className = 'folio-dialog-label';
      label.textContent = input.label;
      inputEl = document.createElement('input');
      inputEl.className = 'folio-dialog-input';
      inputEl.type = 'text';
      inputEl.value = input.value || '';
      inputEl.placeholder = input.placeholder || '';
      inputEl.setAttribute('aria-label', input.label);
      label.appendChild(inputEl);
      dialog.appendChild(label);
    }
    actions.append(cancelBtn, confirmBtn);
    dialog.appendChild(actions);
    modal.appendChild(dialog);
    document.body.appendChild(modal);

    let releaseDialog = () => {};
    const finish = (value) => {
      releaseDialog();
      modal.remove();
      resolve(value);
    };
    cancelBtn.addEventListener('click', () => finish(null));
    confirmBtn.addEventListener('click', () => finish(inputEl ? inputEl.value : true));
    modal.addEventListener('folio-dialog-close', () => finish(null));
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmBtn.click();
      }
    });
    releaseDialog = enhanceDialog(modal, dialog, titleEl, inputEl || cancelBtn);
    inputEl?.select();
  });
}

function requestConfirmation({ title, message, confirmLabel = 'Continue', destructive = false }) {
  return createAppDialog({ title, message, confirmLabel, destructive }).then(Boolean);
}

async function requestTextInput({ title, message, label, value = '', confirmLabel = 'Save', allowEmpty = false }) {
  const result = await createAppDialog({ title, message, confirmLabel, input: { label, value } });
  if (result === null) return null;
  const normalized = result.trim();
  return normalized || (allowEmpty ? '' : null);
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
  
  let releaseDialog = () => {};
  const closeModal = () => {
    releaseDialog();
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
        sidebar.style.display = 'none';
        setMainWorkspace('');
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
  modal.addEventListener('folio-dialog-close', closeModal);
  releaseDialog = enhanceDialog(modal, dialog, title, cancelBtn);
  
  requestAnimationFrame(() => {
    modal.style.opacity = '1';
    dialog.style.transform = 'scale(1)';
  });
}

async function toggleCatalogView(active) {
  if (active) {
    const ready = await ensureLibraryItemsForCatalog();
    if (!ready) {
      catalogModeActive = false;
      updateWorkspaceLayout();
      showToast('Open a folder before using Catalog');
      return;
    }
    mapModeActive = false;
  }
  catalogModeActive = active;
  updateWorkspaceLayout();
  if (active) {
    welcome.classList.add('hidden');
    catalogKeyboardFocusIndex = -1;
    buildCatalogContent();
    requestAnimationFrame(() => catalogContent?.focus({ preventScroll: true }));
  } else {
    catalogKeyboardFocusIndex = -1;
    buildFilmstrip();
    show(idx);
  }
}

function mapThumbUrl(path) {
  return getCachedThumb(path) || folioMediaUrl(path);
}

const MAP_PARENT_MESSAGE_SOURCE = 'folio-map-parent';
const MAP_FRAME_MESSAGE_SOURCE = 'folio-map-frame';

function postMapFrameMessage(frame, message) {
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage({ source: MAP_PARENT_MESSAGE_SOURCE, ...message }, '*');
}

function loadSandboxedMapFrame(frame, message) {
  if (!frame) return;
  const send = () => postMapFrameMessage(frame, { tileStyle: mapTileStyle, ...message });
  frame.addEventListener('load', send, { once: true });
  frame.srcdoc = buildMapFrameSrcdoc();
}

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message || message.source !== MAP_FRAME_MESSAGE_SOURCE) return;

  const mapFrame = $('mapWorkspaceFrame');
  const isWorkspaceFrame = event.source === mapFrame?.contentWindow;
  const isGpsFrame = event.source === gpsPopoverIframe?.contentWindow;
  if (!isWorkspaceFrame && !isGpsFrame) return;

  if (message.type === 'ready') return;

  if (message.type === 'selectCluster' && isWorkspaceFrame) {
    selectMapCluster(message.clusterId);
    return;
  }

  if (message.type === 'openGeotaggedImage' && isGpsFrame) {
    window.openGeotaggedImage(message.path);
    return;
  }

  if (message.type === 'reverseGeocode' && isGpsFrame) {
    const address = await reverseGeocodeForMap(message.lat, message.lon);
    event.source?.postMessage({
      source: MAP_PARENT_MESSAGE_SOURCE,
      type: 'reverseGeocodeResult',
      requestId: message.requestId,
      address,
    }, '*');
  }
});

function selectMapTrayItem(path) {
  if (!mapModeActive) return;
  const cluster = mapClusters.find((c) => c.id === mapSelectedClusterId);
  const member = cluster?.members.find((m) => pathsMatch(m.path, path));
  if (!member) return;

  mapSelectedTrayPath = path;

  $('mapTrayScroll')?.querySelectorAll('.map-tray-thumb').forEach((btn) => {
    const selected = pathsMatch(btn.dataset.path, path);
    btn.classList.toggle('is-selected', selected);
    if (selected) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  const nameEl = $('mapLocationName');
  const metaEl = $('mapLocationMeta');
  const thumbHost = $('mapLocationThumb');
  const fileName = path.split(/[/\\]/).pop() || 'Photo';
  if (nameEl) nameEl.textContent = formatMapPlaceLabel(member.lat, member.lon);
  if (metaEl) {
    const date = member.modified
      ? new Date(member.modified * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    metaEl.textContent = date ? `${fileName} · ${date}` : fileName;
  }
  if (thumbHost) renderMapLocationStack(thumbHost, [member], mapThumbUrl);

  postMapFrameMessage($('mapWorkspaceFrame'), { type: 'flyToPoint', lat: member.lat, lon: member.lon });
}

function selectMapCluster(clusterId, focusPath = null) {
  mapSelectedClusterId = clusterId;
  const cluster = mapClusters.find((c) => c.id === clusterId);
  if (!cluster) return;

  postMapFrameMessage($('mapWorkspaceFrame'), { type: 'flyToCluster', clusterId });

  const trayTitle = $('mapTrayTitle');
  const trayCount = $('mapTrayCount');
  if (trayTitle) trayTitle.textContent = cluster.label || cluster.placeLabel || 'Location';
  if (trayCount) trayCount.textContent = formatMapClusterMeta(cluster);

  const card = $('mapLocationCard');
  if (card) card.hidden = false;

  mapSelectedTrayPath = focusPath || cluster.members[0]?.path || null;
  renderMapTray($('mapTrayScroll'), cluster.members, {
    selectedPath: mapSelectedTrayPath,
    thumbUrl: mapThumbUrl,
    onSelect: selectMapTrayItem,
    onOpen: (path) => window.openMapItem(path),
  });

  if (mapSelectedTrayPath) selectMapTrayItem(mapSelectedTrayPath);
}

window.selectMapCluster = selectMapCluster;

window.openMapItem = (path) => {
  const index = items.findIndex((it) => pathsMatch(it.path, path));
  if (index === -1) return;
  mapModeActive = false;
  catalogModeActive = false;
  idx = index;
  syncSidebarNavActive();
  updateWorkspaceLayout();
  show(idx);
};

async function hydrateMissingGpsForMap(limit = 24) {
  const missing = items.filter((it) => !it.is_video && !hasItemGps(it));
  if (!missing.length) return;
  const batch = missing.slice(0, limit);
  await Promise.all(batch.map(async (item) => {
    const key = `${item.path}:${item.modified}`;
    if (metadataHydrationKeys.has(key)) return;
    metadataHydrationKeys.add(key);
    try {
      const exif = await invoke('get_media_metadata', { path: item.path });
      if (exif) item.exif = exif;
    } catch (e) {
      metadataHydrationKeys.delete(key);
      console.error('Failed to hydrate GPS for map:', item.path, e);
    }
  }));
}

async function syncMapGpsFromBackend() {
  const generation = ++mapGpsSyncGeneration;
  try {
    const points = await invoke('get_map_media_points');
    if (generation !== mapGpsSyncGeneration) return;
    mergeMapGpsIntoItems(items, points);
    renderSidebarFilterCounts();
  } catch (e) {
    console.error('Failed to sync map GPS metadata:', e);
  }
  if (generation !== mapGpsSyncGeneration) return;
  await hydrateMissingGpsForMap();
  if (generation === mapGpsSyncGeneration) renderSidebarFilterCounts();
}

async function refreshMapWorkspace(opts = {}) {
  const frame = $('mapWorkspaceFrame');
  const empty = $('mapEmptyState');
  const tray = $('mapTray');

  await syncMapGpsFromBackend();

  const filtered = filterMapItems(items, {
    mapFilter: mapFilterMode,
    searchTerm: catalogSearchTerm,
    attributes: mediaAttributesCache,
  });
  const points = itemsToMapPoints(filtered);
  mapClusters = clusterMapPoints(points);

  const subtitle = $('mapSubtitle');
  if (subtitle) {
    subtitle.textContent = points.length
      ? `${points.length} geotagged · ${mapClusters.length} location${mapClusters.length === 1 ? '' : 's'}`
      : 'No GPS-tagged media in current scope';
  }

  if (!points.length) {
    if (frame) frame.srcdoc = '';
    if (empty) empty.hidden = false;
    if (tray) tray.hidden = true;
    if ($('mapLocationCard')) $('mapLocationCard').hidden = true;
    return;
  }

  if (empty) empty.hidden = true;
  if (tray) tray.hidden = false;
  const mapThumbUrl = (path) => getCachedThumb(path) || folioMediaUrl(path);
  if (frame) {
    loadSandboxedMapFrame(frame, {
      type: 'renderClusters',
      tileStyle: mapTileStyle,
      clusters: enrichClustersForMap(mapClusters, mapThumbUrl),
    });
  }

  let clusterId = mapSelectedClusterId;
  if (opts.focusPath) {
    const match = mapClusters.find((c) => c.paths.includes(opts.focusPath));
    if (match) clusterId = match.id;
  }
  if (!clusterId || !mapClusters.some((c) => c.id === clusterId)) {
    clusterId = mapClusters[0]?.id;
  }
  if (clusterId) selectMapCluster(clusterId, opts.focusPath);
}

async function toggleMapView(active, opts = {}) {
  if (active) {
    mapReturnCatalog = catalogModeActive;
    welcome?.classList.add('hidden');
    mapModeActive = true;
    if (opts.mapFilter) mapFilterMode = opts.mapFilter;
    document.querySelectorAll('.map-filter-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mapFilter === mapFilterMode);
    });
    syncSidebarNavActive('map');
    updateWorkspaceLayout();
    await refreshMapWorkspace(opts);
  } else {
    mapModeActive = false;
    mapSelectedClusterId = null;
    const openCatalog = mapReturnCatalog && !opts.preferViewer;
    if (openCatalog) {
      catalogModeActive = true;
      buildCatalogContent();
    } else {
      catalogModeActive = false;
      buildFilmstrip();
      show(idx);
    }
    syncSidebarNavActive();
  }
  updateWorkspaceLayout();
}

function scrollCatalogCardIntoView(path) {
  const card = catalogContent?.querySelector(`.catalog-card[data-path="${CSS.escape(path)}"]`);
  if (card) {
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  const index = catalogVisibleItems.findIndex(({ item }) => item.path === path);
  if (index < 0 || !catalogContent) return;
  const { columns, rowHeight } = catalogLayoutMetrics();
  catalogContent.scrollTop = Math.floor(index / columns) * rowHeight;
  renderCatalogWindow(true);
  catalogContent
    .querySelector(`.catalog-card[data-path="${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const catalogKeyboardNav = createCatalogKeyboardNav({
  getVisibleItems: () => catalogVisibleItems,
  getFocusIndex: () => catalogKeyboardFocusIndex,
  setFocusIndex: (i) => { catalogKeyboardFocusIndex = i; },
  getSelection: () => selectedCatalogPaths,
  setSelection: (next) => {
    selectedCatalogPaths = typeof next === 'function' ? next(selectedCatalogPaths) : next;
    updateTranscodeHud();
  },
  isSelectionMode: () => catalogSelectionModeActive,
  onOpenItem: (itemIndex) => {
    idx = itemIndex;
    toggleCatalogView(false);
  },
  onRebuild: () => {
    document.querySelectorAll('.catalog-card').forEach((card) => {
      const visIdx = catalogVisibleItems.findIndex(({ item }) => item.path === card.dataset.path);
      card.classList.toggle('is-focused', visIdx === catalogKeyboardFocusIndex);
      const selected = selectedCatalogPaths.has(card.dataset.path);
      card.classList.toggle('selected', selected);
      card.querySelector('.card-select-checkbox')?.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    updateTranscodeHud();
  },
  scrollCardIntoView: scrollCatalogCardIntoView,
});

let catalogVisibleItems = [];

function catalogItemIsVisible(item) {
  if (catalogSearchTerm && !basename(item.path).toLowerCase().includes(catalogSearchTerm)) return false;
  if (activeTagFilter !== null) {
    const tags = folderTagsCache.get(item.path) || [];
    if (!tags.some(t => t.name === activeTagFilter)) return false;
  }
  return matchesSmartFilter(item);
}

function renderCatalogFilterBar() {
  if (!catalogFilterBar) return;
  const filters = [];
  if (catalogSearchTerm) {
    filters.push({
      label: `Search: ${catalogSearchTerm}`,
      clear: () => { catalogSearchTerm = ''; if (catalogSearchInput) catalogSearchInput.value = ''; },
    });
  }
  if (activeSmartFilter) {
    filters.push({
      label: catalogFilterLabel(activeSmartFilter),
      clear: () => { applyNavFilter('all'); },
    });
  }
  if (activeTagFilter) {
    filters.push({
      label: `Tag: ${activeTagFilter}`,
      clear: () => { activeTagFilter = null; },
    });
  }
  catalogFilterBar.hidden = filters.length === 0;
  catalogFilterBar.replaceChildren();
  filters.forEach(({ label, clear }) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'catalog-active-filter';
    chip.textContent = `${label} ×`;
    chip.addEventListener('click', () => {
      clear();
      applyFilters();
      renderTagFilters();
      renderCatalogFilterBar();
      updateCatalogGridHeading();
    });
    catalogFilterBar.appendChild(chip);
  });
}

let catalogThumbObs = null;
const CATALOG_INITIAL_EAGER_THUMBS = 64;
const CATALOG_CHUNK_EAGER_THUMBS = 24;
const CATALOG_OVERSCAN_ROWS = 4;
let catalogScrollRaf = null;
let catalogVirtualState = { start: -1, end: -1, columns: 0, rowHeight: 0 };

function resetCatalogVirtualState() {
  catalogVirtualState = { start: -1, end: -1, columns: 0, rowHeight: 0 };
}

function catalogLayoutMetrics() {
  if (!catalogContent) return { columns: 1, rowHeight: gridThumbSize + 10 };
  const styles = getComputedStyle(catalogContent);
  const gap = parseFloat(styles.columnGap || styles.gap || '10') || 10;
  const paddingLeft = parseFloat(styles.paddingLeft || '0') || 0;
  const paddingRight = parseFloat(styles.paddingRight || '0') || 0;
  const contentWidth = Math.max(1, catalogContent.clientWidth - paddingLeft - paddingRight);
  const minCard = Math.max(96, gridThumbSize || 140);
  const columns = Math.max(1, Math.floor((contentWidth + gap) / (minCard + gap)));
  return { columns, rowHeight: minCard + gap };
}

function createCatalogVirtualSpacer(height) {
  const spacer = document.createElement('div');
  spacer.className = 'catalog-virtual-spacer';
  spacer.style.gridColumn = '1 / -1';
  spacer.style.height = `${Math.max(0, Math.round(height))}px`;
  spacer.setAttribute('aria-hidden', 'true');
  return spacer;
}

function queueCatalogWindowRender() {
  if (catalogScrollRaf || !catalogModeActive) return;
  catalogScrollRaf = requestAnimationFrame(() => {
    catalogScrollRaf = null;
    renderCatalogWindow();
  });
}

catalogContent?.addEventListener('scroll', queueCatalogWindowRender, { passive: true });
window.addEventListener('resize', () => {
  if (!catalogModeActive) return;
  resetCatalogVirtualState();
  queueCatalogWindowRender();
});

function ensureCatalogThumbObserver() {
  if (catalogThumbObs || !catalogContent) return;
  catalogThumbObs = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting || en.target.dataset.catalogThumbLoaded) continue;
      en.target.dataset.catalogThumbLoaded = '1';
      enqueueThumb(en.target, en.target.dataset.path, { maxSide: thumbSideForElement(en.target) });
      catalogThumbObs.unobserve(en.target);
    }
  }, { root: catalogContent, rootMargin: '640px 0px' });
}

function scheduleCatalogCardThumb(card, path, { eager = false, priority = false } = {}) {
  const maxSide = thumbSideForElement(card);
  if (eager || getCachedThumb(path, maxSide)) {
    card.dataset.catalogThumbLoaded = '1';
    enqueueThumb(card, path, { priority, maxSide });
    return;
  }
  ensureCatalogThumbObserver();
  if (!catalogThumbObs) {
    card.dataset.catalogThumbLoaded = '1';
    enqueueThumb(card, path, { priority, maxSide });
    return;
  }
  catalogThumbObs.observe(card);
}

function renderCatalogChunk(startIndex, count) {
  const endIndex = Math.min(startIndex + count, catalogVisibleItems.length);
  const fragment = document.createDocumentFragment();
  const thumbJobs = [];
  
  for (let i = startIndex; i < endIndex; i++) {
    const { item: it, itemIndex } = catalogVisibleItems[i];
    const eagerThumb = startIndex === 0
      ? i < CATALOG_INITIAL_EAGER_THUMBS
      : i < startIndex + CATALOG_CHUNK_EAGER_THUMBS;
    const priorityThumb = i < startIndex + CATALOG_CHUNK_EAGER_THUMBS;
    const card = document.createElement('div');
    card.className = 'catalog-card';
    card.dataset.path = it.path;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${basename(it.path)}`);
    
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
    const visIdx = i;
    if (visIdx === catalogKeyboardFocusIndex) card.classList.add('is-focused');
    if (!catalogSelectionModeActive && (attr?.favorite || (attr?.rating || 0) > 0)) {
      card.classList.add('has-metadata-overlay');
    }
    
    const checkOverlay = document.createElement('button');
    checkOverlay.type = 'button';
    checkOverlay.className = 'card-select-checkbox';
    checkOverlay.textContent = '✓';
    checkOverlay.tabIndex = 0;
    checkOverlay.setAttribute('aria-label', `Select ${basename(it.path)}`);
    checkOverlay.setAttribute('aria-pressed', selectedCatalogPaths.has(it.path) ? 'true' : 'false');
    checkOverlay.onclick = (e) => {
      e.stopPropagation();
      if (selectedCatalogPaths.has(it.path)) {
        selectedCatalogPaths.delete(it.path);
      } else {
        selectedCatalogPaths.add(it.path);
      }
      updateCatalogSelectionState();
    };
    checkOverlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      checkOverlay.click();
    });
    card.appendChild(checkOverlay);
    
    card.onclick = (e) => {
      catalogKeyboardFocusIndex = visIdx;
      if (catalogSelectionModeActive || e.shiftKey || e.metaKey || e.ctrlKey) {
        checkOverlay.click();
        document.querySelectorAll('.catalog-card').forEach((c) => c.classList.toggle('is-focused', c === card));
        return;
      }
      idx = itemIndex;
      toggleCatalogView(false);
    };
    card.addEventListener('keydown', (e) => {
      if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      card.click();
    });
    
    card.oncontextmenu = (e) => {
      showContextMenu(e, it.path, itemIndex);
    };
    
    if (it.is_video) {
      const v = document.createElement('video');
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      card.classList.add('is-loading');
      card.appendChild(v);
      
      thumbJobs.push({ card, path: it.path, eager: eagerThumb, priority: priorityThumb });
      card.addEventListener('mouseenter', () => {
        if (!v.querySelector('source')) setVideoSource(v, it.path);
        v.play().catch(()=>{});
      });
      card.addEventListener('mouseleave', () => {
        v.pause();
      });
    } else {
      const img = document.createElement('img');
      img.crossOrigin = "anonymous";
      img.decoding = 'async';
      img.loading = 'lazy';
      card.classList.add('is-loading');
      img.onload = () => {
        img.classList.add('loaded');
        card.classList.add('loaded');
        card.classList.remove('is-loading');
      };
      img.onerror = () => {
        card.classList.remove('is-loading');
        card.classList.add('is-failed');
      };
      card.appendChild(img);
      thumbJobs.push({ card, path: it.path, eager: eagerThumb, priority: priorityThumb });
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
  thumbJobs.forEach((job) => {
    scheduleCatalogCardThumb(job.card, job.path, { eager: job.eager, priority: job.priority });
  });
}

function renderCatalogWindow(force = false) {
  if (!catalogContent || !catalogVisibleItems.length) return;
  const { columns, rowHeight } = catalogLayoutMetrics();
  const totalRows = Math.ceil(catalogVisibleItems.length / columns);
  const viewportRows = Math.max(1, Math.ceil(catalogContent.clientHeight / rowHeight));
  const scrollRow = Math.max(0, Math.floor(catalogContent.scrollTop / rowHeight));
  const startRow = Math.max(0, scrollRow - CATALOG_OVERSCAN_ROWS);
  const endRow = Math.min(totalRows, scrollRow + viewportRows + CATALOG_OVERSCAN_ROWS);
  const startIndex = startRow * columns;
  const endIndex = Math.min(catalogVisibleItems.length, endRow * columns);

  if (
    !force
    && catalogVirtualState.start === startIndex
    && catalogVirtualState.end === endIndex
    && catalogVirtualState.columns === columns
    && catalogVirtualState.rowHeight === rowHeight
  ) {
    return;
  }

  catalogVirtualState = { start: startIndex, end: endIndex, columns, rowHeight };
  if (catalogObserver) {
    catalogObserver.disconnect();
    catalogObserver = null;
  }
  catalogThumbObs?.disconnect();
  catalogThumbObs = null;
  thumbQueue = thumbQueue.filter((job) => !job.el?.classList?.contains('catalog-card'));
  catalogContent.replaceChildren();
  if (startRow > 0) catalogContent.appendChild(createCatalogVirtualSpacer(startRow * rowHeight));
  renderCatalogChunk(startIndex, Math.max(0, endIndex - startIndex));
  if (endRow < totalRows) catalogContent.appendChild(createCatalogVirtualSpacer((totalRows - endRow) * rowHeight));
}

async function buildCatalogContent() {
  if (catalogDensityRebuildTimer) {
    clearTimeout(catalogDensityRebuildTimer);
    catalogDensityRebuildTimer = null;
  }
  if (catalogObserver) {
    catalogObserver.disconnect();
    catalogObserver = null;
  }
  catalogThumbObs?.disconnect();
  catalogThumbObs = null;
  thumbQueue = thumbQueue.filter((job) => !job.el?.classList?.contains('catalog-card'));
  catalogContent.innerHTML = '';
  resetCatalogVirtualState();
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
  renderCatalogFilterBar();
  catalogVisibleItems = items
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter(({ item }) => catalogItemIsVisible(item));
  updateCatalogGridHeading();
  if (catalogVisibleItems.length === 0) {
    const dupHint = activeSmartFilter === 'duplicates' && !duplicateGroupsCache
      ? 'Run Find duplicates from the catalog menu to analyze this library.'
      : 'No media matches the current filters.';
    renderEmptyState(catalogStateHost, {
      preset: 'catalog-empty',
      message: dupHint,
    });
    return;
  }
  if (catalogKeyboardFocusIndex >= catalogVisibleItems.length) {
    catalogKeyboardFocusIndex = catalogVisibleItems.length - 1;
  }
  if (catalogKeyboardFocusIndex < 0 && catalogVisibleItems.length) catalogKeyboardFocusIndex = 0;
  catalogContent.scrollTop = 0;
  renderCatalogWindow(true);
  loadMediaAttributes()
    .then(() => {
      renderCatalogFilterBar();
      renderCatalogWindow(true);
    })
    .catch((e) => console.error(e));
}

function showNewFolderModal() {
  if (!items || items.length === 0) {
    showToast('Open a folder first');
    return;
  }
  
  const parentPath = openedLibraryPath || currentFolderPath();
  if (!parentPath) {
    showToast('Open a folder first');
    return;
  }
  
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
  input.setAttribute('aria-label', 'Folder name');
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
  
  let releaseDialog = () => {};
  const closeModal = () => {
    releaseDialog();
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
  modal.addEventListener('folio-dialog-close', closeModal);
  releaseDialog = enhanceDialog(modal, dialog, title, input);
  
  requestAnimationFrame(() => {
    modal.style.opacity = '1';
    dialog.style.transform = 'scale(1)';
  });
}

async function loadMediaAttributes() {
  if (!items.length) return;
  const missingPaths = items.map((it) => it.path).filter((path) => !mediaAttributesCache.has(path));
  if (!missingPaths.length) {
    renderSidebarFilterCounts();
    return;
  }
  try {
    const chunkSize = 600;
    for (let i = 0; i < missingPaths.length; i += chunkSize) {
      const attrs = await invoke('get_media_attributes', { paths: missingPaths.slice(i, i + chunkSize) });
      attrs.forEach(attr => mediaAttributesCache.set(attr.path, attr));
      if (catalogModeActive) renderCatalogWindow(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    renderSidebarFilterCounts();
  } catch (e) {
    console.error('Failed to load media attributes:', e);
  }
}

function renderSidebarFilterCounts() {
  const counts = { all: items.length, favorites: 0, rated: 0, videos: 0, gps: 0, raw: 0, duplicates: 0 };
  items.forEach((item) => {
    const attr = mediaAttributesCache.get(item.path) || {};
    const format = item.path.toLowerCase();
    if (attr.favorite) counts.favorites++;
    if ((attr.rating || 0) >= 3) counts.rated++;
    if (item.is_video) counts.videos++;
    if (hasItemGps(item)) counts.gps++;
    if (['.raw', '.cr2', '.nef', '.arw', '.dng', '.heic', '.heif', '.tiff', '.tif'].some((ext) => format.endsWith(ext))) counts.raw++;
    if (duplicateGroupsCache?.has(item.path)) counts.duplicates++;
  });
  counts.map = counts.gps;
  document.querySelectorAll('[data-nav-count]').forEach((node) => {
    node.textContent = counts[node.dataset.navCount] ?? 0;
  });
  if (catalogModeActive) updateCatalogGridHeading();
}

function matchesSmartFilter(item) {
  if (activeColorFilter) {
    const colors = folderDominantColorsCache[item.path] || [];
    if (!colors.includes(activeColorFilter)) return false;
  }
  if (!activeSmartFilter) return true;
  const attr = mediaAttributesCache.get(item.path) || {};
  const format = (item.format || item.path.split('.').pop() || '').toLowerCase();
  if (activeSmartFilter === 'favorites') return !!attr.favorite;
  if (activeSmartFilter === 'rated') return (attr.rating || 0) >= 3;
  if (activeSmartFilter === 'gps') return hasItemGps(item);
  if (activeSmartFilter === 'raw') return ['raw', 'cr2', 'nef', 'arw', 'dng', 'heic', 'heif', 'tiff', 'tif'].some(ext => format.includes(ext));
  if (activeSmartFilter === 'videos') return !!item.is_video;
  if (activeSmartFilter === 'duplicates') return !!duplicateGroupsCache?.has(item.path);
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
  if (catalogModeActive) {
    renderCatalogFilterBar();
    buildCatalogContent();
  }
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
    if (mapModeActive) {
      refreshMapWorkspace();
    } else if (catalogModeActive) {
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

function buildMapSrcdoc() {
  return buildMapFrameSrcdoc();
}

function escapeMapHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildOfflineMapSrcdoc(data) {
  const rows = data.map((marker) => `
    <li>
      <strong>${escapeMapHtml(marker.name || 'Location')}</strong>
      <span>${Number(marker.lat).toFixed(4)}, ${Number(marker.lon).toFixed(4)}</span>
    </li>
  `).join('');
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        html, body { margin: 0; min-height: 100%; background: #111113; color: #f5f5f2; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
        body { padding: 18px; box-sizing: border-box; }
        h1 { margin: 0 0 6px; font-size: 15px; }
        p { margin: 0 0 14px; color: #a8a8b0; font-size: 11px; line-height: 1.45; }
        ul { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
        li { padding: 9px; border: 1px solid rgba(212,167,44,0.2); border-radius: 8px; background: #1b1b1f; }
        strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
        span { color: rgba(212,167,44,0.85); font: 10px ui-monospace, monospace; }
      </style>
    </head>
    <body>
      <h1>Map unavailable offline</h1>
      <p>Folio kept the embedded coordinates. Reconnect to load map tiles and place names.</p>
      <ul>${rows}</ul>
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
  gpsPopoverData = data;
  if (navigator.onLine) {
    loadSandboxedMapFrame(gpsPopoverIframe, { type: 'renderPopover', markers: data });
  } else {
    gpsPopoverIframe.srcdoc = buildOfflineMapSrcdoc(data);
  }
  positionGpsPopover(anchor, data.length > 1);
  gpsPopover.classList.add('open');
  gpsPopover.setAttribute('aria-hidden', 'false');
}

function closeGpsPopover() {
  if (!gpsPopover) return;
  gpsPopover.classList.remove('open');
  gpsPopover.setAttribute('aria-hidden', 'true');
  gpsPopoverAnchor = null;
  gpsPopoverData = [];
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

window.addEventListener('online', () => {
  updateWorkspaceGuidance();
  if (gpsPopover?.classList.contains('open') && gpsPopoverData.length) {
    loadSandboxedMapFrame(gpsPopoverIframe, { type: 'renderPopover', markers: gpsPopoverData });
  }
});

window.addEventListener('offline', () => {
  updateWorkspaceGuidance();
  if (gpsPopover?.classList.contains('open') && gpsPopoverData.length) {
    gpsPopoverIframe.srcdoc = buildOfflineMapSrcdoc(gpsPopoverData);
  }
});

// Format Transcoder HUD Functions
function updateTranscodeHud() {
  const count = selectedCatalogPaths.size;
  if (count > 0) {
    const bytes = items.reduce((total, item) => selectedCatalogPaths.has(item.path) ? total + (item.size || 0) : total, 0);
    if (batchCount) batchCount.textContent = `${count} item${count !== 1 ? 's' : ''} · ${formatBytes(bytes)}`;
    batchBar?.classList.add('visible');
  } else {
    batchBar?.classList.remove('visible');
  }
}

batchClose?.addEventListener('click', () => {
  const previous = new Set(selectedCatalogPaths);
  selectedCatalogPaths.clear();
  buildCatalogContent();
  updateTranscodeHud();
  pushUndo('Cleared selection', () => {
    selectedCatalogPaths = new Set(previous);
    buildCatalogContent();
    updateTranscodeHud();
  });
});

async function runTrackedBatch(operation, label) {
  const started = await invoke('start_batch_job', { operation });
  const jobId = started?.job_id || `job-${Date.now()}`;
  setInspectorTab('jobs');
  setInspectorVisible(true);
  const retry = () => runTrackedBatch(operation, label).catch((err) => showToast(`${label} failed: ${err}`));
  upsertBatchJobRow(jobId, label, { state: 'running', completed: 0, total: started?.total || 0 }, retry);
  showToast(`${label} started...`);
  const finalStatus = await trackJob(invoke, started, status => {
    upsertBatchJobRow(jobId, label, status, retry);
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
    if (await requestConfirmation({
      title: 'Move selected files to Trash?',
      message: `This will move ${selectedCatalogPaths.size} selected items to the system Trash.`,
      confirmLabel: 'Move to Trash',
      destructive: true,
    })) {
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
  
  const query = await requestTextInput({
    title: 'Search with Spotlight',
    message: 'Leave the search field empty to reset the folder view.',
    label: 'Search query',
    confirmLabel: 'Search',
    allowEmpty: true,
  });
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

  if (!await requestConfirmation({
    title: 'Strip EXIF and GPS metadata?',
    message: `This will losslessly strip all EXIF and GPS metadata from ${paths.length} image(s).`,
    confirmLabel: 'Strip metadata',
    destructive: true,
  })) {
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
