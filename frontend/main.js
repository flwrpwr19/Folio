import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { save, open } from '@tauri-apps/plugin-dialog';
import { createEventBus } from './modules/state.js';
import { trackJob } from './modules/jobs.js';

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
  <div class="welcome" id="welcome">
    <div class="welcome-dragbar" id="wDrag" data-tauri-drag-region></div>
    <div class="welcome-bg" id="welcomeBg">
      <div class="welcome-bg-inner"></div>
    </div>
    <div class="welcome-content">
      <h1>Folio</h1>
      <p class="tagline">Your photography, undistracted.</p>
      <div class="welcome-dropzone" id="welcomeDropzone">
        <span class="drop-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg></span>
        <span class="drop-text">Drop folder here</span>
      </div>
      <button class="welcome-btn" id="openBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg><span>Open Folder</span></button>
      <div class="recent-folders" id="recentFolders"></div>
      <div class="welcome-shortcuts">
        <span><kbd>⇧</kbd> + Scroll to Zoom</span>
        <span><kbd>⇧</kbd> + Mid Click to Pan</span>
        <span>Drag to Move Window</span>
      </div>
    </div>
  </div>

  <div class="sidebar" id="sidebar" style="display:none">
    <div class="sidebar-dragbar" id="sDrag" data-tauri-drag-region>
        <div class="breadcrumbs" id="breadcrumbs"></div>
        <button class="grid-toggle-btn" id="gridToggleBtn" data-tooltip="Toggle Grid View">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
        </button>
    </div>

    <div class="sidebar-controls">
      <button class="sidebar-btn" id="openBtn2"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg> Open Folder</button>
      <button class="sidebar-btn" id="sidebarCatalogBtn" style="margin-top: 6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> Media Catalog</button>
    </div>
    <div class="sidebar-divider"></div>
    <div class="sidebar-info">
      <div class="counter" id="counter"></div>
      <div class="filename" id="fname"></div>
      <div class="dimensions" id="dims"></div>
      <span class="format-badge" id="badge" style="display:none"></span>
    </div>
    <div class="sidebar-divider"></div>
    <div class="tag-filter-panel" id="tagFilterPanel">
      <span class="tag-filter-header">Filter by Tag</span>
      <div class="tag-filter-list" id="tagFilterList"></div>
    </div>
    <div class="sidebar-divider"></div>
    <div class="filmstrip" id="filmstrip"></div>
    <div class="sidebar-resizer" id="sidebarResizer"></div>
  </div>

  <div class="catalog-grid-view" id="catalogGrid" style="display:none">
    <div class="catalog-header" id="cDrag" data-tauri-drag-region>
      <h2 id="catalogTitle">Catalog Grid</h2>
      <div class="catalog-header-actions">
        <button class="catalog-btn" id="catalogMapBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg> Map View</button>
        <select class="catalog-btn" id="smartFilterSelect" style="height: 30px; max-width: 132px;"><option value="">All Media</option><option value="favorites">Favorites</option><option value="rated">Rated 3+</option><option value="gps">GPS</option><option value="raw">RAW/HEIC/TIFF</option></select>
        <button class="catalog-btn" id="saveSmartAlbumBtn">Save Smart</button>
        <button class="catalog-btn" id="catalogDuplicatesBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg> Find Duplicates</button>
        <button class="catalog-btn" id="catalogFinderBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/></svg> Finder</button>
        <button class="catalog-btn" id="catalogNewFolderBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg> New Folder</button>
        <button class="catalog-btn" data-tooltip="⇧/⌘ + Click to select multiple" style="opacity: 0.5; padding: 6px 8px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></button>
        <button class="catalog-btn" id="catalogCloseBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close Grid</button>
      </div>
    </div>
    <div class="catalog-content" id="catalogContent"></div>
    <div class="transcode-hud" id="transcodeHud">
      <span class="transcode-hud-title" id="transcodeCount">0 items selected</span>
      <div style="width: 1px; height: 16px; background: rgba(255,255,255,0.1); margin: 0 8px;"></div>
      <button class="transcode-btn" data-fmt="webp">WebP</button>
      <button class="transcode-btn" data-fmt="png">PNG</button>
      <button class="transcode-btn" data-fmt="jpeg">JPEG</button>
      <button class="transcode-btn" data-fmt="avif">AVIF</button>
      <button class="transcode-btn" data-fmt="tiff">TIFF</button>
      <div style="width: 1px; height: 16px; background: rgba(255,255,255,0.1); margin: 0 8px;"></div>
      <input type="text" id="batchTagInput" class="batch-tag-input" placeholder="Add tag (Enter)..." style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 11px; outline: none; width: 120px;" />
      <button class="transcode-btn" id="batchFavoriteBtn">Favorite</button>
      <button class="transcode-btn" id="batchRateBtn">Rate 5</button>
      <button class="transcode-btn" id="batchVaultBtn">Vault</button>
      <button class="transcode-btn" id="batchSidecarBtn">Sidecar</button>
      <button class="transcode-btn" id="batchFinderBtn">Finder</button>
      <button class="transcode-btn" id="batchTrashBtn" style="color: #ff6b6b; border-color: rgba(255, 107, 107, 0.3);">Trash</button>
      <button class="transcode-btn" id="batchScrubBtn" style="color: #ffb86c; border-color: rgba(255, 184, 108, 0.3); margin-left: 6px;">Scrub EXIF</button>
      <button class="transcode-btn" id="transcodeClose" style="background:transparent; border-color:transparent; margin-left: 8px; display:flex; align-items:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
  </div>

  <div class="map-modal" id="mapModal" style="display:none">
    <div class="map-container">
      <div class="map-header">
        <span class="map-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -2px; margin-right: 6px;"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/></svg>Image Location</span>
        <button class="map-close-btn" id="mapCloseBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <iframe class="map-iframe" id="mapIframe" frameborder="0" src=""></iframe>
    </div>
  </div>

  <div class="viewer" id="viewer" style="display:none">
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
    
    <div class="editorial-overlay" id="editorialOverlay">
      <div class="editorial-resizer" id="editorialResizer"></div>
      <div class="editorial-camera" id="edCamera"></div>
      <div class="editorial-stats">
        <div class="editorial-stat-group"><span class="editorial-stat-label">Aperture</span><span class="editorial-stat-value" id="edAperture">—</span></div>
        <div class="editorial-stat-group"><span class="editorial-stat-label">Shutter</span><span class="editorial-stat-value" id="edShutter">—</span></div>
        <div class="editorial-stat-group"><span class="editorial-stat-label">ISO</span><span class="editorial-stat-value" id="edIso">—</span></div>
        <div class="editorial-stat-group"><span class="editorial-stat-label">Focal</span><span class="editorial-stat-value" id="edFocal">—</span></div>
      </div>
      <div class="editorial-tech-data" id="edTechData"></div>
      <canvas class="editorial-histogram" id="histogramCanvas" width="220" height="56" aria-hidden="true"></canvas>
      <canvas class="editorial-waveform" id="waveformCanvas" width="220" height="80" aria-hidden="true" style="margin-top: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); display: block;"></canvas>
      <div class="editorial-palette" id="editorialPalette" style="margin-top: 16px; display: flex; flex-direction: column; gap: 6px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
        <span class="editorial-stat-label">Dominant Palette</span>
        <div id="paletteChips" style="display: flex; gap: 8px; margin-top: 4px;">
          <div class="palette-chip" style="display: none; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; border: 1px solid rgba(255,255,255,0.25); transition: transform var(--transition-dur-fast) var(--ease-spring), box-shadow var(--transition-dur-fast) var(--ease-spring);"></div>
          <div class="palette-chip" style="display: none; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; border: 1px solid rgba(255,255,255,0.25); transition: transform var(--transition-dur-fast) var(--ease-spring), box-shadow var(--transition-dur-fast) var(--ease-spring);"></div>
          <div class="palette-chip" style="display: none; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; border: 1px solid rgba(255,255,255,0.25); transition: transform var(--transition-dur-fast) var(--ease-spring), box-shadow var(--transition-dur-fast) var(--ease-spring);"></div>
          <div class="palette-chip" style="display: none; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; border: 1px solid rgba(255,255,255,0.25); transition: transform var(--transition-dur-fast) var(--ease-spring), box-shadow var(--transition-dur-fast) var(--ease-spring);"></div>
          <div class="palette-chip" style="display: none; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; border: 1px solid rgba(255,255,255,0.25); transition: transform var(--transition-dur-fast) var(--ease-spring), box-shadow var(--transition-dur-fast) var(--ease-spring);"></div>
        </div>
      </div>
      <div class="editorial-gps" id="edGps" style="margin-top: 12px; display: none; flex-direction: column; gap: 6px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
        <span class="editorial-stat-label">Location</span>
        <button class="gps-chip" id="gpsChip" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); color: var(--accent-gold); padding: 6px 10px; border-radius: 8px; font-size: 0.72rem; cursor: pointer; display: flex; align-items: center; gap: 6px; width: fit-content; transition: all 0.25s var(--ease-spring); font-family: var(--font-body); font-weight: 500;"></button>
        <div id="edAddress" style="font-size: 0.72rem; color: #b0b0b8; margin-top: 2px; line-height: 1.3;"></div>
      </div>
    </div>
    <button class="nav-arrow prev" id="prev">‹</button>
    <button class="nav-arrow next" id="next">›</button>
    <div class="zoom-hud" id="zoomHud">
      <input type="range" id="zoomSlider" min="100" max="800" value="100" step="10" />
      <span class="zoom-label" id="zoomLabel">100%</span>
      <button class="zoom-reset" id="zoomReset" data-tooltip="Fit to Screen (0)">FIT</button>
      <button class="zoom-action compare-toggle-btn" id="compareBtn" data-tooltip="Compare Before/After (C)" style="display:none">COMPARE</button>
      <button class="zoom-action fullscreen-toggle" id="fullscreenBtn" data-tooltip="Enter Fullscreen (F)">FULL</button>
    </div>

    <div class="edit-panel" id="editPanel" aria-hidden="true">
      <div class="edit-panel-header">
        <span class="edit-panel-title">Edit Photo</span>
        <div class="edit-panel-actions">
          <button class="edit-action-btn" id="editResetBtn">Reset</button>
          <button class="edit-action-btn edit-export-btn" id="editExportBtn">Export</button>
          <button class="edit-close-btn" id="editCloseBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div class="edit-sliders">
        <div class="edit-row"><label>Brightness</label><input type="range" class="edit-slider" data-param="brightness" min="-100" max="100" step="1" value="0"><span class="edit-val">0</span></div>
        <div class="edit-row"><label>Vibrance</label><input type="range" class="edit-slider" data-param="vibrance" min="-100" max="100" step="1" value="0"><span class="edit-val">0</span></div>
      </div>
      <div class="edit-footer" style="flex-direction: column; gap: 8px;">
        <div style="display: flex; gap: 8px; width: 100%;">
          <button class="edit-flip-btn" id="rotateBtn" style="flex: 1;">Rotate 90°</button>
          <button class="edit-flip-btn" id="flipHBtn" style="flex: 1;">Flip H</button>
          <button class="edit-flip-btn" id="flipVBtn" style="flex: 1;">Flip V</button>
        </div>
        <button class="edit-flip-btn" id="cropBtn" style="width: 100%; border-color: rgba(212,167,44,0.35); color: var(--accent-gold);">Crop Photo</button>
      </div>
    </div>
    <button class="edit-toggle-btn" id="editToggleBtn" data-tooltip="Edit Photo (E)">Edit</button>
  </div>

  <div class="image-fullscreen" id="imageFullscreen" aria-hidden="true" style="display:none">
    <div class="image-fullscreen-bg"></div>
    <div class="image-fullscreen-ui">
      <button class="image-fullscreen-exit" id="imageFsExit">Exit</button>
      <div class="image-fullscreen-hint" id="imageFsHint">Shift + F to exit</div>
    </div>
  </div>

  <div class="settings-modal" id="settingsModal" style="display:none">
    <div class="settings-bg" id="settingsBg"></div>
    <div class="settings-content">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="settings-close" id="settingsClose"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="settings-body">
        <div class="settings-tabs">
          <button class="tab-btn active" data-tab="general">General</button>
          <button class="tab-btn" data-tab="appearance">Appearance</button>
          <button class="tab-btn" data-tab="storage">Storage</button>
          <button class="tab-btn" data-tab="keybinds">Keybinds</button>
          <button class="tab-btn" data-tab="security">Security</button>
        </div>

        <div class="tab-pane active" id="tab-general">
          <div class="settings-section-label">Interface</div>
          <div class="setting-row">
            <label for="sortSelect">Sort By</label>
            <select id="sortSelect">
              <option value="name">Name</option>
              <option value="date">Date</option>
              <option value="size">Size</option>
            </select>
          </div>
          <div class="setting-row">
           <label for="zoomSensSlider">Zoom Sensitivity</label>
           <input type="range" id="zoomSensSlider" min="1" max="10" value="5" style="width: 120px;" />
          </div>
          <div class="setting-row">
            <label for="recentFoldersCheck">Show Recent Folders</label>
            <input type="checkbox" id="recentFoldersCheck" checked />
          </div>
          <div class="setting-row">
            <label for="soundVolumeSlider">UI Sound Volume</label>
            <div style="display: flex; align-items: center; gap: 8px;">
              <input type="range" id="soundVolumeSlider" min="0" max="100" value="40" style="width: 100px;" />
              <span class="setting-val" id="soundVolumeVal" style="font-size: 0.7rem; color: var(--text-tertiary); min-width: 32px; text-align: right; font-variant-numeric: tabular-nums;">40%</span>
            </div>
          </div>
          <div class="settings-section-label">Export</div>
          <div class="setting-row">
            <label for="stripMetadataCheck">Scrub EXIF Metadata</label>
            <input type="checkbox" id="stripMetadataCheck" />
          </div>
          <div>
            <div class="watermark-toggle-row">
              <label for="watermarkToggle">Export Watermark</label>
              <input type="checkbox" id="watermarkToggle" />
            </div>
            <div class="watermark-input-row" id="watermarkInputRow" style="display: flex; gap: 8px;">
              <input type="text" id="watermarkInput" placeholder="Enter watermark text…" style="flex: 1;" />
              <select id="watermarkAnchorSelect" style="width: 120px;">
                 <option value="bottom-right">Bottom Right</option>
                 <option value="bottom-left">Bottom Left</option>
                 <option value="top-right">Top Right</option>
                 <option value="top-left">Top Left</option>
                 <option value="center">Center</option>
              </select>
            </div>
            <div class="watermark-input-row" id="watermarkAdvancedRow" style="display: flex; gap: 8px; margin-top: 8px;">
              <input type="range" id="watermarkOpacitySlider" min="10" max="100" value="70" />
              <input type="range" id="watermarkScaleSlider" min="50" max="200" value="100" />
              <input type="range" id="watermarkFontSlider" min="12" max="72" value="32" />
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
            <label for="reverseGeocodeCheck">Look up addresses from GPS coordinates</label>
            <input type="checkbox" id="reverseGeocodeCheck" />
          </div>
          <div class="setting-row">
            <label for="vibrancyCheck">Enable Window Vibrancy</label>
            <input type="checkbox" id="vibrancyCheck" />
          </div>
          <div class="setting-row">
            <label for="customCursorCheck">Use Custom Cursor</label>
            <input type="checkbox" id="customCursorCheck" checked />
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
          <div class="setting-row">
            <label for="performanceHudCheck">Show Performance HUD</label>
            <input type="checkbox" id="performanceHudCheck" />
          </div>
        </div>

        <div class="tab-pane" id="tab-storage">
          <div class="settings-section-label">Database & Cache Diagnostics</div>
          <div class="setting-row">
            <span class="setting-label">SQLite Database Size</span>
            <span class="setting-val" id="dbSizeVal">—</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">Thumbnail Cache Size</span>
            <span class="setting-val" id="cacheSizeVal">—</span>
          </div>
          <div class="setting-row">
            <label for="thumbCacheLimitInput">Thumbnail Cache Limit (GB)</label>
            <input id="thumbCacheLimitInput" type="number" min="0.25" max="100" step="0.25" value="2" style="width: 90px;" />
          </div>
          <div class="setting-row">
            <label for="prefetchCheck">Navigation Prefetch</label>
            <input type="checkbox" id="prefetchCheck" checked />
          </div>
          <div class="setting-row">
            <span class="setting-label">Decoded Image Cache Size</span>
            <span class="setting-val" id="decodedSizeVal">—</span>
          </div>
          <div class="settings-section-label">Runtime Engine Statistics</div>
          <div class="setting-row">
            <span class="setting-label">CPU Engine Load</span>
            <span class="setting-val" id="cpuLoadVal">—</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">RAM Memory Usage</span>
            <span class="setting-val" id="ramSizeVal">—</span>
          </div>
          <div class="setting-row" style="margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 16px; justify-content: flex-start;">
            <button class="settings-update-btn" id="purgeCacheBtn" style="background: #e03131 !important; color: #fff !important; font-weight: bold; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; transition: all 0.25s ease;">Purge All Local Cache</button>
            <button class="settings-update-btn" id="pruneThumbCacheBtn" style="margin-left: 8px;">Prune Thumbnails</button>
          </div>
        </div>

        <div class="tab-pane" id="tab-keybinds">
          <div class="setting-row">
            <label style="font-size: 0.85rem; color: var(--text-primary); font-weight: 500;">Keybindings</label>
            <button class="settings-update-btn" id="resetKeybindsBtn">Reset Defaults</button>
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
        </div>

        <div class="tab-pane" id="tab-security">
          <div class="setting-row">
            <span style="font-size: 0.85rem; color: var(--text-primary); font-weight: 500;">Secure Album Vault & Platform Settings</span>
          </div>
          <div class="setting-row">
            <label for="biometricVaultCheck">Enable Biometric Album Lock</label>
            <input type="checkbox" id="biometricVaultCheck" />
          </div>
          <div class="setting-row">
            <label for="vaultAutoLockInput">Vault Auto-Lock Minutes</label>
            <input id="vaultAutoLockInput" type="number" min="1" max="120" value="5" style="width: 90px;" />
          </div>
          <div class="setting-row" style="gap: 8px; justify-content: flex-start;">
            <button class="settings-update-btn" id="vaultCreateBtn">Create Vault</button>
            <button class="settings-update-btn" id="vaultUnlockBtn">Unlock</button>
            <button class="settings-update-btn" id="vaultLockBtn">Lock</button>
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
  <div class="custom-cursor" id="customCursor"></div>
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
const welcome = $('welcome'), welcomeBg = $('welcomeBg'), sidebar = $('sidebar'), sidebarResizer = $('sidebarResizer'), sidebarToggle = $('sidebarToggle'), viewer = $('viewer'), media = $('media'), mediaLoader = $('mediaLoader'), filmstrip = $('filmstrip'), breadcrumbs = $('breadcrumbs'), gridToggleBtn = $('gridToggleBtn'), counter = $('counter'), fname = $('fname'), dims = $('dims'), badge = $('badge'), edOverlay = $('editorialOverlay'), edCamera = $('edCamera'), edAperture = $('edAperture'), edShutter = $('edShutter'), edIso = $('edIso'), edFocal = $('edFocal'), edTechData = $('edTechData'), backdropGlow = $('backdropGlow'), editPanel = $('editPanel'), editToggleBtn = $('editToggleBtn'), editCloseBtn = $('editCloseBtn'), editResetBtn = $('editResetBtn'), editExportBtn = $('editExportBtn'), rotateBtn = $('rotateBtn'), flipHBtn = $('flipHBtn'), flipVBtn = $('flipVBtn'), cropBtn = $('cropBtn'), customCursor = $('customCursor'), customCursorCheck = $('customCursorCheck'), dropzoneGlow = $('dropzoneGlow'), zoomSlider = $('zoomSlider'), zoomLabel = $('zoomLabel'), zoomReset = $('zoomReset'), fullscreenBtn = $('fullscreenBtn'), imageFsExit = $('imageFsExit'), sortSelect = $('sortSelect'), zoomSensSlider = $('zoomSensSlider'), themeSelect = $('themeSelect'), cinematicCheck = $('cinematicCheck'), recentFoldersCheck = $('recentFoldersCheck'), stripMetadataCheck = $('stripMetadataCheck'), vibrancyCheck = $('vibrancyCheck'), reverseGeocodeCheck = $('reverseGeocodeCheck'), soundVolumeSlider = $('soundVolumeSlider'), soundVolumeVal = $('soundVolumeVal'), catalogGrid = $('catalogGrid'), catalogContent = $('catalogContent'), catalogTitle = $('catalogTitle'), catalogNewFolderBtn = $('catalogNewFolderBtn'), catalogFinderBtn = $('catalogFinderBtn'), catalogMapBtn = $('catalogMapBtn'), catalogDuplicatesBtn = $('catalogDuplicatesBtn'), catalogCloseBtn = $('catalogCloseBtn'), smartFilterSelect = $('smartFilterSelect'), saveSmartAlbumBtn = $('saveSmartAlbumBtn'), tagFilterPanel = $('tagFilterPanel'), tagFilterList = $('tagFilterList'), sidebarCatalogBtn = $('sidebarCatalogBtn'), edGps = $('edGps'), gpsChip = $('gpsChip'), edAddress = $('edAddress'), mapModal = $('mapModal'), mapCloseBtn = $('mapCloseBtn'), mapIframe = $('mapIframe'), compareBtn = $('compareBtn'), transcodeHud = $('transcodeHud'), transcodeCount = $('transcodeCount'), transcodeClose = $('transcodeClose'), colorBlindSelect = $('colorBlindSelect'), watermarkInput = $('watermarkInput'), watermarkAnchorSelect = $('watermarkAnchorSelect'), watermarkOpacitySlider = $('watermarkOpacitySlider'), watermarkScaleSlider = $('watermarkScaleSlider'), watermarkFontSlider = $('watermarkFontSlider'), batchTagInput = $('batchTagInput'), batchTrashBtn = $('batchTrashBtn'), batchFavoriteBtn = $('batchFavoriteBtn'), batchRateBtn = $('batchRateBtn'), batchVaultBtn = $('batchVaultBtn'), batchSidecarBtn = $('batchSidecarBtn'), batchFinderBtn = $('batchFinderBtn');

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
      pruneThumbCacheBtn = $('pruneThumbCacheBtn'),
      thumbCacheLimitInput = $('thumbCacheLimitInput'),
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
      vaultAutoLockInput = $('vaultAutoLockInput');

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

  settings: {
    get currentSort() { return currentSort; },
    set currentSort(v) { currentSort = v; localStorage.setItem('folio_sort', v); },
    get zoomSens() { return zoomSens; },
    set zoomSens(v) { zoomSens = v; localStorage.setItem('folio_zoom_sens', v); },
    get currentTheme() { return currentTheme; },
    set currentTheme(v) { currentTheme = v; localStorage.setItem('folio_theme', v); },
    get cinematicEnabled() { return cinematicEnabled; },
    set cinematicEnabled(v) { cinematicEnabled = v; localStorage.setItem('folio_cinematic', v); },
    get useCustomCursor() { return useCustomCursor; },
    set useCustomCursor(v) { useCustomCursor = v; localStorage.setItem('folio_custom_cursor', v); },
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
};

let catalogModeActive = false;
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
let useCustomCursor = localStorage.getItem('folio_custom_cursor') !== 'false';
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
let activeWatermarkOpacity = parseInt(localStorage.getItem('folio_watermark_opacity') || '70', 10);
let activeWatermarkScale = parseInt(localStorage.getItem('folio_watermark_scale') || '100', 10);
let activeWatermarkFont = parseInt(localStorage.getItem('folio_watermark_font') || '32', 10);

// Load settings for Phase 2 features
let highContrastEnabled = localStorage.getItem('folio_high_contrast') === 'true';
let reducedMotionEnabled = localStorage.getItem('folio_reduced_motion') === 'true';
let performanceHudEnabled = localStorage.getItem('folio_performance_hud') === 'true';

let trafficLightHover = false;
let pendingRafUpdate = false;
let editPanelOpen = false;
let editDebounceTimer = null;
let editPreviewImg = null;
const editMap = new Map();
const preloadedThumbs = new Map();
const preloadCache = new Map();

// Geocoding Cache & Service
const geocodeCache = new Map();
async function reverseGeocode(lat, lon) {
  if (lat === undefined || lat === null || lon === undefined || lon === null) return 'No coordinates';
  if (!reverseGeocodeEnabled) return 'Address lookup disabled';
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
window.reverseGeocode = reverseGeocode;

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
  trafficLightHover: { get() { return trafficLightHover; }, set(val) { trafficLightHover = val; } },
  editPanelOpen: { get() { return editPanelOpen; }, set(val) { editPanelOpen = val; } }
});

const defaultKeybinds = { nextImage: 'ArrowRight', prevImage: 'ArrowLeft', resetZoom: '0', toggleMetadata: 'i', playVideo: ' ', modifierZoom: 'Shift', modifierPan: 'Shift', toggleZen: 'z', toggleSidebar: 'b', toggleFullscreen: 'f', editMode: 'e', addTag: 't', toggleCatalog: 'g' };
let keybinds = { ...defaultKeybinds, ...JSON.parse(localStorage.getItem('folio_keybinds') || '{}') };

/* ── Init ── */
applyTheme(currentTheme);
if (recentFoldersCheck) {
  recentFoldersCheck.checked = showRecentFolders;
  recentFoldersCheck.addEventListener('change', (e) => {
    showRecentFolders = e.target.checked;
    localStorage.setItem('folio_show_recents', showRecentFolders);
    renderRecentFolders();
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
  if (!vaultStatusVal) return;
  try {
    const status = await invoke('vault_status');
    vaultStatusVal.textContent = `${status.unlocked ? 'Unlocked' : 'Locked'} • ${status.item_count} item${status.item_count === 1 ? '' : 's'}`;
  } catch (e) {
    vaultStatusVal.textContent = 'Vault unavailable';
  }
}

vaultAutoLockInput && (vaultAutoLockInput.value = vaultAutoLockMinutes);
vaultAutoLockInput?.addEventListener('change', e => {
  vaultAutoLockMinutes = Math.max(1, Math.min(120, parseInt(e.target.value || '5', 10)));
  localStorage.setItem('folio_vault_auto_lock_minutes', vaultAutoLockMinutes);
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
    localStorage.setItem('folio_thumbnail_cache_limit_gb', thumbnailCacheLimitGb);
    await invoke('set_thumbnail_cache_limit', { limitGb: thumbnailCacheLimitGb }).catch(err => showToast(`Cache limit failed: ${err}`));
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
    root.setProperty('--bg-deep', '#f5f5f6');
    root.setProperty('--bg-sidebar', 'rgba(250, 250, 250, 0.94)');
    root.setProperty('--text-primary', '#1a1a1e');
    root.setProperty('--text-secondary', 'rgba(0, 0, 0, 0.55)');
    root.setProperty('--text-tertiary', 'rgba(0, 0, 0, 0.35)');
    root.setProperty('--border-subtle', 'rgba(0, 0, 0, 0.07)');
    root.setProperty('--modal-bg', 'rgba(255, 255, 255, 0.9)');
    root.setProperty('--input-bg', 'rgba(0, 0, 0, 0.05)');
    root.setProperty('--overlay-bg', 'rgba(0, 0, 0, 0.2)');
  } else {
    root.setProperty('--bg-deep', '#08080a');
    root.setProperty('--bg-sidebar', 'rgba(12, 12, 14, 0.94)');
    root.setProperty('--text-primary', '#f0f0f4');
    root.setProperty('--text-secondary', 'rgba(255, 255, 255, 0.48)');
    root.setProperty('--text-tertiary', 'rgba(255, 255, 255, 0.22)');
    root.setProperty('--border-subtle', 'rgba(255, 255, 255, 0.06)');
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
  
  const errCard = document.createElement('div');
  errCard.className = 'glassmorphic-error-card';
  errCard.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 32px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    max-width: 400px;
    text-align: center;
    color: var(--text-primary);
    margin: auto;
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    animation: fadeIn var(--transition-dur-normal) var(--ease-spring);
  `;
  
  const title = document.createElement('div');
  title.textContent = 'Failed to Load Media';
  title.style.cssText = 'font-weight: 600; font-size: 15px; margin-top: 8px;';
  const name = document.createElement('div');
  name.textContent = item.path.split('/').pop();
  name.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4; word-break: break-all; margin-top: 4px;';
  const retryBtn = document.createElement('button');
  retryBtn.className = 'catalog-btn retry-btn';
  retryBtn.textContent = 'Retry Loading';
  retryBtn.style.cssText = 'margin-top: 16px; border-color: rgba(255,75,75,0.25); background: rgba(255,75,75,0.05); color: #ff6b6b; cursor: pointer; outline: none;';
  errCard.append(title, name, retryBtn);
  
  retryBtn.onclick = (e) => {
    e.stopPropagation();
    onRetry();
  };
  
  layer.appendChild(errCard);
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

let activeToasts = [];
function showToast(message) {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '14');
  icon.setAttribute('height', '14');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '3');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M22 11.08V12a10 10 0 1 1-5.93-9.14');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', '22 4 12 14.01 9 11.01');
  icon.append(path, poly);
  const label = document.createElement('span');
  label.textContent = String(message);
  toast.append(icon, label);
  container.appendChild(toast);
  activeToasts.push(toast);
  
  const type = message.toLowerCase().includes('fail') || message.toLowerCase().includes('error') ? 'error' : 'success';
  playUISound(type);

  const updateStack = () => {
    activeToasts.forEach((t, i) => {
      const offset = (activeToasts.length - 1 - i) * 44;
      t.style.transform = `translateY(${-offset}px)`;
    });
  };
  updateStack();

  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => {
      activeToasts = activeToasts.filter(t => t !== toast);
      toast.remove();
      updateStack();
    }, 300);
  }, 3000);
}

function openSettings() { $('settingsModal').style.display = 'flex'; }
function closeSettings() { $('settingsModal').style.display = 'none'; }

function updateCursorVisibility() {
  const shouldShowNative = !useCustomCursor || trafficLightHover;
  document.body.classList.toggle('force-native-cursor', shouldShowNative);
  getCurrentWindow().setCursorVisible(shouldShowNative).catch(() => {});
  if (customCursor) customCursor.style.opacity = shouldShowNative ? 0 : 1;
}

function setTrafficLightHover(active) {
  if (trafficLightHover === active) return;
  trafficLightHover = active;
  updateCursorVisibility();
}
updateCursorVisibility();

async function syncFullscreenState() {
  try { isFullscreen = await getCurrentWindow().isFullscreen(); } catch { isFullscreen = false; }
  if (isFullscreen && trafficLightHover) { trafficLightHover = false; updateCursorVisibility(); }
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
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));
  
  if ((zoom === 1 && oldZ !== 1) || (Math.floor(oldZ) !== Math.floor(zoom))) {
    try { playUISound('tick'); } catch (e) {}
  }

  const img = getActiveImage();
  if (img) {
    if (zoom <= 1.01) {
      const snapped = (zoom !== oldZ);
      zoom = 1; panX = 0; panY = 0;
      img.classList.remove('zoomed'); img.style.transform = '';
      if (editPreviewImg) editPreviewImg.style.transform = '';
      if (snapped && !opts.skipBounce) {
        img.classList.add('zoom-snap-bounce');
        setTimeout(() => img.classList.remove('zoom-snap-bounce'), 250);
      }
    } else {
      img.classList.add('zoomed');
      if (cx !== undefined && cy !== undefined) {
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
async function renderRecentFolders() {
  const container = $('recentFolders');
  if (!container) return;
  if (!showRecentFolders) {
    container.innerHTML = '';
    return;
  }

  try {
    const fullList = await invoke('get_recent_folders');
    if (!fullList || fullList.length === 0) {
      container.innerHTML = '';
      return;
    }
    const list = fullList.slice(0, 4);

    container.replaceChildren();
    const title = document.createElement('div');
    title.className = 'recents-title';
    title.textContent = 'Recent Folders';
    container.appendChild(title);
    list.forEach(path => {
      const card = document.createElement('div');
      card.className = 'recent-card';
      const name = path.split('/').pop() || path;
      const nameEl = document.createElement('span');
      nameEl.className = 'recent-name';
      nameEl.textContent = name;
      const pathEl = document.createElement('span');
      pathEl.className = 'recent-path';
      pathEl.textContent = path.replace(/^\/Users\/[^\/]+/, '~');
      const finder = document.createElement('button');
      finder.className = 'catalog-btn';
      finder.style.cssText = 'margin-left:auto;padding:3px 6px;font-size:10px;';
      finder.textContent = 'Finder';
      finder.addEventListener('click', e => {
        e.stopPropagation();
        openPathInFinder(path, false);
      });
      card.append(nameEl, pathEl, finder);
      card.addEventListener('click', async () => {
        try {
          const p = await invoke('open_specific_folder', { path });
          loadFolderData(p);
        } catch (e) {
          showToast('Failed to open recent folder');
          console.error(e);
        }
      });
      container.appendChild(card);
    });
  } catch (e) {
    console.error('[Folio] Failed to fetch recents:', e);
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

async function loadFolderData(p) {
  if (localStorage.getItem('folio_biometric_lock') === 'true') {
    showToast("Authenticating Secure Vault...");
    try {
      const authenticated = await invoke('authenticate_vault');
      if (!authenticated) {
        showToast("Secure Vault access denied!");
        return;
      }
      showToast("Secure Vault unlocked!");
    } catch (e) {
      showToast(`Authentication failed: ${e}`);
      return;
    }
  }

  items = processLoadedItems(await invoke('get_folder_items'));
  idx = 0; sortItems();
  welcome.classList.add('hidden');
  renderBreadcrumbs(p);
  playUISound('load');
  activeTagFilter = null;
  activeColorFilter = null;
  folderDominantColorsCache = {};
  await renderTagFilters();
  filmstrip.scrollTop = 0;
  if (catalogModeActive) {
    catalogGrid.style.display = 'grid';
    sidebar.style.display = 'none';
    viewer.style.display = 'none';
    buildCatalogContent();
  } else {
    catalogGrid.style.display = 'none';
    sidebar.style.display = 'flex';
    viewer.style.display = 'flex';
    show(idx);
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
        renderRecentFolders();
        loadFolderData(p);
    } catch (e) { console.error(e); }
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
  preloadCache.set(item.path, img);

  if (isNative) {
    img.src = `folio://localhost/${encodeURIComponent(item.path)}`;
  } else {
    invoke('get_full_image', { path: item.path })
      .then(p => {
        img.src = `folio://localhost/${encodeURIComponent(p)}`;
      })
      .catch(e => {
        preloadCache.delete(item.path);
        console.error('RAW preload failed:', e);
      });
  }
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

  const isFast = speed > 0.003;
  if (isFast) {
    for (let o = 1; o <= 3; o++) {
      offsets.push(o * direction);
    }
  } else {
    offsets.push(-2, -1, 1, 2);
  }

  const currentItem = items[currentIdx];
  if (currentItem) {
    keepSet.add(currentItem.path);
  }

  for (const offset of offsets) {
    const targetIdx = (currentIdx + offset + items.length) % items.length;
    const item = items[targetIdx];
    if (item && !item.is_video) {
      keepSet.add(item.path);
      preloadImage(item);
    }
  }
  if (prefetchEnabled) {
    const paths = Array.from(keepSet).filter(Boolean);
    invoke('prefetch_media', { paths, maxSide: 320 }).catch(() => {});
  }

  for (const path of preloadCache.keys()) {
    if (!keepSet.has(path)) {
      preloadCache.delete(path);
    }
  }
}

function show(i, dir = null) {
  const prevIdx = idx, direction = dir !== null ? dir : (i > prevIdx ? 1 : i < prevIdx ? -1 : 0);
  idx = i; zoom = 1; panX = 0; panY = 0;
  zoomSlider.value = 100; zoomLabel.textContent = '100%';
  
  const item = items[i], src = `folio://localhost/${encodeURIComponent(item.path)}`, outgoing = media.querySelector('.media-layer.media-active');
  if (outgoing) {
    if (cinematicEnabled && direction !== 0) {
      applyPhysicalExit(outgoing, direction);
    } else {
      outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease-out' }).finished.then(() => outgoing.remove());
    }
  }
  clearMediaContent(outgoing);
  
  const layer = document.createElement('div'); layer.className = 'media-layer media-active';
  layer.style.zIndex = '2';
  
  if (cinematicEnabled && direction !== 0) {
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
    v.autoplay = true; v.loop = true; v.playsInline = true; v.src = src;

    v.onerror = () => {
      viewer.classList.remove('loading');
      renderMediaError(layer, item, () => {
        v.src = '';
        v.src = src + '?retry=' + Date.now();
      });
    };

    v.onloadeddata = () => {
      v.classList.add('loaded');
      const ctrl = document.createElement('div');
      ctrl.className = 'video-controls';
      ctrl.innerHTML = `
        <button class="v-play-btn" aria-label="Play/Pause">
          <svg class="v-icon-play" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="display:none;"><polygon points="6,3 20,12 6,21"/></svg>
          <svg class="v-icon-pause" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <input type="range" class="v-progress" value="0" min="0" max="100" step="0.1">
        <span class="v-time">0:00 / 0:00</span>
        <div class="v-volume-container">
          <button class="v-volume-btn" aria-label="Mute/Unmute">
            <svg class="v-icon-volume-high" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            <svg class="v-icon-volume-muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
          </button>
          <input type="range" class="v-volume-slider" min="0" max="100" value="100">
        </div>
        <button class="v-fullscreen-btn" aria-label="Fullscreen">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        </button>
      `;

      const playBtn = ctrl.querySelector('.v-play-btn');
      const progress = ctrl.querySelector('.v-progress');
      const time = ctrl.querySelector('.v-time');
      const volBtn = ctrl.querySelector('.v-volume-btn');
      const volSlider = ctrl.querySelector('.v-volume-slider');
      const fsBtn = ctrl.querySelector('.v-fullscreen-btn');

      const iconPlay = playBtn.querySelector('.v-icon-play');
      const iconPause = playBtn.querySelector('.v-icon-pause');
      const iconVolHigh = volBtn.querySelector('.v-icon-volume-high');
      const iconVolMuted = volBtn.querySelector('.v-icon-volume-muted');

      // State machine for seek scrubbing
      let isScrubbing = false;
      let wasPlayingBeforeScrub = false;

      const updatePlayButtonUI = () => {
        if (v.paused) {
          iconPlay.style.display = 'block';
          iconPause.style.display = 'none';
        } else {
          iconPlay.style.display = 'none';
          iconPause.style.display = 'block';
        }
      };

      playBtn.onclick = () => {
        if (v.paused) {
          v.play().catch(e => console.error(e));
        } else {
          v.pause();
        }
        updatePlayButtonUI();
      };

      v.onplay = updatePlayButtonUI;
      v.onpause = updatePlayButtonUI;

      const updateTimeText = () => {
        const curTime = v.currentTime || 0;
        const durTime = v.duration || 0;
        const curMins = Math.floor(curTime / 60), curSecs = Math.floor(curTime % 60);
        const durMins = Math.floor(durTime / 60), durSecs = Math.floor(durTime % 60);
        time.textContent = `${curMins}:${curSecs.toString().padStart(2, '0')} / ${durMins}:${durSecs.toString().padStart(2, '0')}`;
      };

      v.onloadedmetadata = updateTimeText;

      v.ontimeupdate = () => {
        if (!isScrubbing) {
          const p = v.duration ? (v.currentTime / v.duration) * 100 : 0;
          progress.value = p;
          updateTimeText();
        }
      };

      // Scrubbing event handlers
      const endScrub = (e) => {
        if (isScrubbing) {
          isScrubbing = false;
          ctrl.classList.remove('scrubbing-active');
          FolioState.isScrubbingActive = false;
          if (v.duration) {
            v.currentTime = (progress.value / 100) * v.duration;
          }
          if (wasPlayingBeforeScrub) {
            v.play().catch(e => console.error(e));
          }
        }
        window.removeEventListener('pointerup', endScrub);
        window.removeEventListener('pointercancel', endScrub);
        window.removeEventListener('mouseup', endScrub);
        window.removeEventListener('blur', endScrub);
      };

      progress.addEventListener('pointerdown', (e) => {
        isScrubbing = true;
        wasPlayingBeforeScrub = !v.paused;
        v.pause();
        ctrl.classList.add('scrubbing-active');
        FolioState.isScrubbingActive = true;

        window.addEventListener('pointerup', endScrub);
        window.addEventListener('pointercancel', endScrub);
        window.addEventListener('mouseup', endScrub);
        window.addEventListener('blur', endScrub);
      });

      progress.addEventListener('input', () => {
        if (v.duration) {
          const seekTime = (progress.value / 100) * v.duration;
          v.currentTime = seekTime;
          // Render immediate scrubbing time frame feedback
          const curMins = Math.floor(seekTime / 60), curSecs = Math.floor(seekTime % 60);
          const durMins = Math.floor(v.duration / 60), durSecs = Math.floor(v.duration % 60);
          time.textContent = `${curMins}:${curSecs.toString().padStart(2, '0')} / ${durMins}:${durSecs.toString().padStart(2, '0')}`;
        }
      });

      // Volume slider slide-out handler
      let savedVolume = localStorage.getItem('folio_video_volume');
      let savedMuted = localStorage.getItem('folio_video_muted');

      if (savedVolume !== null) {
        v.volume = parseFloat(savedVolume);
      } else {
        v.volume = 0.8;
      }

      if (savedMuted !== null) {
        v.muted = savedMuted === 'true';
      } else {
        v.muted = false;
      }

      let lastVolume = v.volume > 0 ? v.volume : 0.8;

      const updateVolumeUI = () => {
        volSlider.value = v.muted ? 0 : v.volume * 100;
        if (v.muted || v.volume === 0) {
          iconVolHigh.style.display = 'none';
          iconVolMuted.style.display = 'block';
        } else {
          iconVolHigh.style.display = 'block';
          iconVolMuted.style.display = 'none';
        }
      };

      const endVolDrag = (e) => {
        ctrl.classList.remove('volume-active');
        FolioState.isVolumeActive = false;

        window.removeEventListener('pointerup', endVolDrag);
        window.removeEventListener('pointercancel', endVolDrag);
        window.removeEventListener('mouseup', endVolDrag);
        window.removeEventListener('blur', endVolDrag);
      };

      volSlider.addEventListener('pointerdown', (e) => {
        ctrl.classList.add('volume-active');
        FolioState.isVolumeActive = true;

        window.addEventListener('pointerup', endVolDrag);
        window.addEventListener('pointercancel', endVolDrag);
        window.addEventListener('mouseup', endVolDrag);
        window.addEventListener('blur', endVolDrag);
      });

      volSlider.addEventListener('input', () => {
        v.volume = volSlider.value / 100;
        if (v.volume > 0) {
          v.muted = false;
        }
        saveVideoSettings(v.volume, v.muted);
        updateVolumeUI();
      });

      volBtn.onclick = () => {
        if (v.muted) {
          v.muted = false;
          v.volume = lastVolume > 0 ? lastVolume : 0.8;
        } else {
          lastVolume = v.volume > 0 ? v.volume : lastVolume;
          v.muted = true;
        }
        saveVideoSettings(v.volume, v.muted);
        updateVolumeUI();
      };

      v.onvolumechange = () => {
        if (!v.muted && v.volume > 0) {
          lastVolume = v.volume;
        }
        saveVideoSettings(v.volume, v.muted);
        updateVolumeUI();
      };
      updateVolumeUI(); // init volume UI state

      // Fullscreen compatibility handling (WebKit & Native container toggling)
      fsBtn.onclick = () => {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(err => console.error(err));
        } else {
          if (layer.requestFullscreen) {
            layer.requestFullscreen().catch(err => {
              if (v.requestFullscreen) {
                v.requestFullscreen().catch(e => console.error(e));
              } else if (v.webkitEnterFullscreen) {
                v.webkitEnterFullscreen();
              }
            });
          } else if (v.webkitEnterFullscreen) {
            v.webkitEnterFullscreen();
          }
        }
      };

      layer.appendChild(ctrl);
      
      // Defer adaptive glow off the critical entry transition frame
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
    viewer.classList.add('loading'); const ts = preloadedThumbs.get(item.path);
    if (ts) { const ph = document.createElement('img'); ph.crossOrigin = "anonymous"; ph.src = ts; ph.className = 'placeholder-thumb loaded'; layer.appendChild(ph); }
    const img = document.createElement('img'); img.crossOrigin = "anonymous"; img.alt = ''; img.className = 'media-content';
    const onImgReady = () => {
        img.classList.add('loaded');
        img.style.opacity = '1';
        viewer.classList.remove('loading');
        const ph = layer.querySelector('.placeholder-thumb');
        if (ph) {
          ph.classList.remove('loaded');
          ph.classList.add('fade-out');
          setTimeout(() => ph.remove(), 150);
        }
        
        // Defer CPU-heavy color analytics to unblock visual navigation animations
        setTimeout(() => {
          requestAnimationFrame(() => {
            if (items[idx]?.path !== item.path) return;
            try {
                updateAdaptiveGlow(img);
            } catch (e) {
                console.error("Adaptive glow error:", e);
            }
            if (editPanelOpen) invoke('prepare_edit_preview', { path: item.path }).then(() => loadEditForCurrent()).catch(e => console.error(e));
            if (overlayVisible) {
                try {
                    drawHistogram(img);
                } catch (e) {
                    console.error("Histogram error:", e);
                }
                try {
                    drawDominantColors(item);
                } catch (e) {
                    console.error("Dominant colors error:", e);
                }
            }
          });
        }, 50);
    };
    img.onload = onImgReady;
    img.onerror = () => {
        viewer.classList.remove('loading');
        const ph = layer.querySelector('.placeholder-thumb');
        if (ph) ph.remove();
        renderMediaError(layer, item, () => {
            img.src = '';
            if (isNative) {
                img.src = src + '?retry=' + Date.now();
            } else {
                invoke('get_full_image', { path: item.path })
                    .then(p => { img.src = `folio://localhost/${encodeURIComponent(p)}?retry=${Date.now()}`; })
                    .catch(() => { img.src = src + '?retry=' + Date.now(); });
            }
        });
    };

    const cached = preloadCache.get(item.path);
    if (cached && cached.complete && cached.naturalWidth > 0) {
        img.src = cached.src;
        onImgReady();
    } else {
        const isNative = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(item.path.split('.').pop().toLowerCase());
        if (isNative) {
            img.src = src;
        } else {
            invoke('get_full_image', { path: item.path })
                .then(p => { img.src = `folio://localhost/${encodeURIComponent(p)}`; })
                .catch(() => {
                    // Trigger grace fallback directly if full image retrieval fails
                    img.onerror();
                });
        }
    }
    layer.appendChild(img);

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

      layer.addEventListener('mouseenter', () => {
        v.play().then(() => {
          v.style.opacity = '1';
        }).catch(err => console.error("Live Photo playback error:", err));
      });

      layer.addEventListener('mouseleave', () => {
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
  fname.textContent = item.path.split('/').pop();
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
      gpsChip.onclick = () => {
        showMapPopup({
          lat: lat,
          lon: lon,
          path: item.path,
          name: item.path.split('/').pop()
        });
      };
      if (edAddress) {
        if (reverseGeocodeEnabled) {
          edAddress.textContent = 'Loading address...';
          reverseGeocode(lat, lon).then(addr => {
            if (items[idx]?.path === item.path) {
              edAddress.textContent = addr;
            }
          }).catch(() => {
            if (items[idx]?.path === item.path) {
              edAddress.textContent = 'Address unavailable';
            }
          });
        } else {
          edAddress.textContent = 'Enable address lookup in Settings to resolve this location.';
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
const THUMB_CONCURRENCY = 4; let thumbQueue = [], thumbActive = 0, thumbMaxSide = 320;
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
    const u = `folio://localhost/${encodeURIComponent(tp)}`;
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

function buildFilmstrip() {
  obs.disconnect(); filmstrip.innerHTML = '';
  filmstrip.classList.toggle('grid-view', gridView);
  gridToggleBtn?.classList.toggle('active', gridView);
  
  items.forEach((it, i) => {
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
    
    filmstrip.appendChild(d); obs.observe(d);
  });
}

function highlightThumb() {
  if (FolioState.activeThumbEl) {
    FolioState.activeThumbEl.classList.remove('active');
  }
  const targetThumb = filmstrip.children[idx];
  if (targetThumb) {
    targetThumb.classList.add('active');
    FolioState.activeThumbEl = targetThumb;
    filmstrip.scrollTo({ top: targetThumb.offsetTop - filmstrip.clientHeight / 2 + targetThumb.clientHeight / 2, behavior: 'smooth' });
  }
}

/* ── Simple Edit Engine ── */
const defaultEdit = () => ({ brightness: 0, vibrance: 0, flip_h: false, flip_v: false, rotate: 0 });
function getCurrentEdit() { return editMap.get(items[idx]?.path) || defaultEdit(); }
function setCurrentEdit(edit) { if (items[idx]?.path) { editMap.set(items[idx].path, edit); invoke('set_edit', { path: items[idx].path, edit }).catch(() => {}); } }

async function openEditPanel() {
  const path = items[idx]?.path; if (!path || items[idx]?.is_video) return;
  editPanelOpen = true; editPanel.classList.add('visible'); editPanel.setAttribute('aria-hidden', 'false'); editToggleBtn.classList.add('active');
  if (compareBtn) compareBtn.style.display = 'inline-block';
  requestAnimationFrame(() => { if (zoom <= 1) resetZoom(); else scheduleUpdate(); });
  try { await invoke('prepare_edit_preview', { path }); loadEditForCurrent(); } catch (e) { console.error(e); }
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
  editPanel.classList.remove('visible');
  editPanel.setAttribute('aria-hidden', 'true');
  editToggleBtn.classList.remove('active');
  if (compareBtn) {
    compareBtn.style.display = 'none';
    toggleCompareMode(false);
  }
  closeCropMode();
  removeEditPreview();
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
  const path = items[idx]?.path; if (!path || !editPanelOpen) return;
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
$('settingsClose').addEventListener('click', closeSettings);
$('settingsBg').addEventListener('click', closeSettings);
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

gridToggleBtn?.addEventListener('click', () => {
  toggleCatalogView(!catalogModeActive);
});

sidebarCatalogBtn?.addEventListener('click', () => {
  toggleCatalogView(!catalogModeActive);
});

let duplicateGroupsCache = null;

catalogDuplicatesBtn?.addEventListener('click', async () => {
  if (!items || items.length === 0) return;
  if (duplicateGroupsCache) {
    duplicateGroupsCache = null;
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
      
      groups.forEach((group, index) => {
        const color = colors[index % colors.length];
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
    mapCloseBtn.click();
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
  showMapPopup(geotagged);
});

// Duplicates Resolver Modal
let currentDupGroupIndex = 0;
let dupGroupsData = [];

window.openDuplicateResolver = (groups) => {
  dupGroupsData = groups;
  currentDupGroupIndex = 0;
  
  let modal = document.getElementById('duplicateResolverModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'duplicateResolverModal';
    Object.assign(modal.style, {
      position: 'fixed', inset: '0',
      background: 'rgba(0,0,0,0.6)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      zIndex: '900',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff', opacity: '0',
      transition: 'opacity 0.25s ease',
    });
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDuplicateResolver();
    });
  }
  modal.style.display = 'flex';
  requestAnimationFrame(() => { modal.style.opacity = '1'; });
  renderDuplicateGroup();
};

window.closeDuplicateResolver = () => {
  const modal = document.getElementById('duplicateResolverModal');
  if (modal) {
    modal.style.opacity = '0';
    setTimeout(() => { modal.style.display = 'none'; }, 250);
  }
};

window.renderDuplicateGroup = async () => {
  const modal = document.getElementById('duplicateResolverModal');
  if (!modal) return;
  if (currentDupGroupIndex >= dupGroupsData.length) {
    closeDuplicateResolver();
    showToast('Finished reviewing all duplicate groups.');
    return;
  }
  
  const groupPaths = dupGroupsData[currentDupGroupIndex];
  
  // Build the dialog container
  const dialog = document.createElement('div');
  Object.assign(dialog.style, {
    background: 'var(--modal-bg)',
    backdropFilter: 'saturate(180%) blur(40px)',
    WebkitBackdropFilter: 'saturate(180%) blur(40px)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '16px',
    boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
    maxWidth: '680px', width: '90vw', maxHeight: '80vh',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  });
  
  // Header
  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '16px 20px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: '0',
  });
  const headerLeft = document.createElement('div');
  const headerTitle = document.createElement('div');
  headerTitle.textContent = 'Resolve Duplicates';
  headerTitle.style.cssText = 'font-size: 13px; font-weight: 600; letter-spacing: 0.03em;';
  const headerMeta = document.createElement('div');
  headerMeta.textContent = `Group ${currentDupGroupIndex + 1} of ${dupGroupsData.length} · ${groupPaths.length} similar images`;
  headerMeta.style.cssText = 'font-size: 11px; color: var(--text-tertiary); margin-top: 2px;';
  headerLeft.append(headerTitle, headerMeta);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'catalog-btn';
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { fontSize: '11px', padding: '4px 12px' });
  closeBtn.addEventListener('click', closeDuplicateResolver);
  header.appendChild(headerLeft);
  header.appendChild(closeBtn);
  dialog.appendChild(header);
  
  // Cards container
  const cardsContainer = document.createElement('div');
  Object.assign(cardsContainer.style, {
    padding: '20px', overflowY: 'auto',
    display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap',
  });
  
  for (let i = 0; i < groupPaths.length; i++) {
    const path = groupPaths[i];
    const name = path.split(/[\/\\]/).pop();
    const item = items.find(it => it.path === path);
    const sizeBytes = item ? item.size : 0;
    const sz = sizeBytes > 0 ? (sizeBytes / 1024 / 1024).toFixed(2) + ' MB' : '—';
    const dims = item ? `${item.width || '?'}×${item.height || '?'}` : '';
    
    const card = document.createElement('div');
    Object.assign(card.style, {
      flex: '1', minWidth: '180px', maxWidth: '280px',
      display: 'flex', flexDirection: 'column', gap: '10px',
      padding: '14px', background: 'rgba(255,255,255,0.03)',
      borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)',
    });
    
    const img = document.createElement('img');
    img.src = `folio://localhost/${encodeURIComponent(path)}`;
    Object.assign(img.style, {
      width: '100%', aspectRatio: '4/3', objectFit: 'cover',
      borderRadius: '6px', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    });
    
    const info = document.createElement('div');
    info.style.textAlign = 'center';
    const infoName = document.createElement('div');
    infoName.textContent = name;
    infoName.title = name;
    infoName.style.cssText = 'font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    const infoMeta = document.createElement('div');
    infoMeta.textContent = `${sz}${dims ? ' · ' + dims : ''}`;
    infoMeta.style.cssText = 'font-size: 10px; color: var(--text-tertiary); margin-top: 2px;';
    info.append(infoName, infoMeta);
    
    const trashBtn = document.createElement('button');
    trashBtn.className = 'catalog-btn';
    Object.assign(trashBtn.style, {
      width: '100%', justifyContent: 'center',
      borderColor: 'rgba(255,100,100,0.3)', color: '#ff8a8a', fontSize: '11px',
    });
    trashBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> Trash`;
    
    // Use a closure to capture the path safely — no inline onclick
    trashBtn.addEventListener('click', () => trashDuplicate(path));
    const finderBtn = document.createElement('button');
    finderBtn.className = 'catalog-btn';
    Object.assign(finderBtn.style, {
      width: '100%', justifyContent: 'center', fontSize: '11px',
    });
    finderBtn.textContent = 'Show in Finder';
    finderBtn.addEventListener('click', () => openPathInFinder(path, true));
    
    card.appendChild(img);
    card.appendChild(info);
    card.appendChild(finderBtn);
    card.appendChild(trashBtn);
    cardsContainer.appendChild(card);
  }
  dialog.appendChild(cardsContainer);
  
  // Footer
  const footer = document.createElement('div');
  Object.assign(footer.style, {
    padding: '12px 20px',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: '0',
  });
  const hint = document.createElement('span');
  hint.style.cssText = 'font-size: 11px; color: var(--text-tertiary);';
  hint.textContent = 'Click Trash on items you don\'t need';
  const nextBtn = document.createElement('button');
  nextBtn.className = 'catalog-btn';
  Object.assign(nextBtn.style, { color: 'var(--accent-gold)', borderColor: 'rgba(212,167,44,0.3)', fontSize: '11px' });
  nextBtn.textContent = currentDupGroupIndex < dupGroupsData.length - 1 ? 'Next Group →' : 'Done';
  nextBtn.addEventListener('click', () => { currentDupGroupIndex++; renderDuplicateGroup(); });
  footer.appendChild(hint);
  footer.appendChild(nextBtn);
  dialog.appendChild(footer);
  
  // Replace modal content
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

document.querySelectorAll('.edit-slider').forEach(s => {
  s.addEventListener('input', () => {
    const val = parseFloat(s.value);
    const valEl = s.closest('.edit-row')?.querySelector('.edit-val');
    if (valEl) valEl.textContent = Math.round(val);
    const e = getCurrentEdit(); e[s.dataset.param] = val; setCurrentEdit(e); applyEditPreview(e);
  });
});

/* ── Global Handlers ── */
let cursorX = 0, cursorY = 0;
let targetX = 0, targetY = 0;
let isHoveringCursor = false;
let cursorActivated = false;
let cursorLoopRunning = false;

function wakeCursorLoop() {
  if (!cursorLoopRunning) {
    cursorLoopRunning = true;
    requestAnimationFrame(updateCursorLoop);
  }
}

// Track custom cursor variants globally
let isEwResizeCursor = false;
let isCrosshairCursor = false;
let activeMagneticElement = null;
let magneticCenter = null;

window.addEventListener('mousemove', (e) => {
  targetX = e.clientX;
  targetY = e.clientY;
  cursorActivated = true;
  
  const inTL = !isFullscreen && e.clientX <= 80 && e.clientY <= 40;
  if (useCustomCursor) setTrafficLightHover(inTL);
  
  const ewTarget = e.target.closest('#sidebarResizer, #editorialResizer, .sidebar-resizer, .editorial-resizer') || isResizingSidebar || isResizingExif;
  const crosshairTarget = e.target.closest('input[type="range"], .slider, .scrubber') || FolioState.isSliderActive || FolioState.isVolumeActive || FolioState.isScrubbingActive;
  
  isEwResizeCursor = !!ewTarget;
  isCrosshairCursor = !!crosshairTarget;
  
  isHoveringCursor = !!(
    e.target.closest('button, .thumb, input, select, .welcome-btn, .sidebar-dragbar, .sidebar-toggle, .grid-toggle-btn, .sidebar-resizer, .editorial-resizer') ||
    FolioState.isSliderActive ||
    FolioState.isVolumeActive ||
    FolioState.isScrubbingActive
  );
  
  // FE-9 Magnetic Interactive Hover Targets
  if (!reducedMotionEnabled) {
    const mag = e.target.closest('button, .palette-chip, .gps-chip, .tab-btn');
    if (mag) {
      if (activeMagneticElement && activeMagneticElement !== mag) {
        activeMagneticElement.style.transform = '';
        activeMagneticElement.style.transition = 'transform 0.25s ease';
        magneticCenter = null;
      }
      activeMagneticElement = mag;
      
      if (!magneticCenter || magneticCenter.element !== mag) {
        const prevTransform = mag.style.transform;
        mag.style.transform = '';
        const rect = mag.getBoundingClientRect();
        mag.style.transform = prevTransform;
        
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const threshold = Math.max(rect.width, rect.height) / 2 + 15;
        magneticCenter = { element: mag, cx, cy, threshold };
      }
      
      const dx = e.clientX - magneticCenter.cx;
      const dy = e.clientY - magneticCenter.cy;
      const dist = Math.hypot(dx, dy);
      
      if (dist < magneticCenter.threshold) {
        const pullX = (dx / dist) * 3;
        const pullY = (dy / dist) * 3;
        
        let transformStr = `translate(${pullX}px, ${pullY}px)`;
        mag.style.transform = transformStr;
        mag.style.transition = 'transform 0.15s cubic-bezier(0.25, 0.8, 0.25, 1.4)';
      } else {
        mag.style.transform = '';
        mag.style.transition = 'transform 0.25s ease';
        magneticCenter = null;
      }
    } else {
      if (activeMagneticElement) {
        activeMagneticElement.style.transform = '';
        activeMagneticElement.style.transition = 'transform 0.25s ease';
        activeMagneticElement = null;
        magneticCenter = null;
      }
    }
  } else if (activeMagneticElement) {
    activeMagneticElement.style.transform = '';
    activeMagneticElement = null;
    magneticCenter = null;
  }
  
  wakeCursorLoop();
});

document.addEventListener('mouseleave', () => {
  cursorActivated = false;
  if (customCursor) customCursor.style.opacity = 0;
  wakeCursorLoop();
});

document.addEventListener('mouseenter', () => {
  cursorActivated = true;
  wakeCursorLoop();
});

function updateCursorLoop() {
  if (!useCustomCursor) {
    if (customCursor) customCursor.style.opacity = 0;
    cursorLoopRunning = false;
    return;
  }
  
  if (!trafficLightHover && cursorActivated) {
    const dx = targetX - cursorX;
    const dy = targetY - cursorY;
    
    // ProMotion continuous lerp interpolation (calibrated based on screen refresh rate deltas)
    const factor = refreshRateType === 120 ? 0.15 : 0.28;
    cursorX += dx * factor;
    cursorY += dy * factor;
    
    if (customCursor) {
      customCursor.style.opacity = 1;
      customCursor.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
      customCursor.classList.toggle('hovering', isHoveringCursor);
      customCursor.classList.toggle('ew-resize', isEwResizeCursor);
      customCursor.classList.toggle('crosshair', isCrosshairCursor);
    }
    
    // Close enough to destination -> sleep the loop to save energy
    if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
      cursorX = targetX;
      cursorY = targetY;
      if (customCursor) {
        customCursor.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
      }
      cursorLoopRunning = false;
      return;
    }
  } else {
    if (customCursor) customCursor.style.opacity = 0;
    cursorLoopRunning = false;
    return;
  }
  
  requestAnimationFrame(updateCursorLoop);
}
wakeCursorLoop();

media.addEventListener('wheel', (e) => {
  const img = getActiveImage(); if (!img) return;
  
  if (e.ctrlKey) {
    // Native Trackpad Pinch-to-Zoom
    e.preventDefault();
    const scale = Math.exp(-e.deltaY * 0.01);
    const rect = media.getBoundingClientRect();
    setZoom(zoom * scale, e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
    return;
  }

  const mod = keybinds.modifierZoom.toLowerCase() + 'Key';
  if (e[mod]) {
    // Keyboard-modifier Scroll Zoom
    e.preventDefault();
    const scale = Math.exp(-(e.deltaY || e.deltaX) * 0.001 * (zoomSens / 5));
    const rect = media.getBoundingClientRect();
    setZoom(zoom * scale, e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
  } else if (zoom > 1) {
    // Fluid 2D Panning when zoomed in
    e.preventDefault();
    panX -= e.deltaX;
    panY -= e.deltaY;
    scheduleUpdate();
  }
}, { passive: false });

media.addEventListener('mousedown', async (e) => {
  if (zoom <= 1 && e.button === 0) {
    if (e.target.closest('video') || e.target.closest('.video-controls')) return;
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
      const activeVideo = media.querySelector('.media-layer.media-active video');
      if (activeVideo) {
        e.preventDefault();
        const playBtn = media.querySelector('.media-layer.media-active .v-play-btn');
        if (playBtn) playBtn.click();
      }
    }
    else if (matchesKey(keybinds.editMode)) editToggleBtn.click();
    else if (matchesKey(keybinds.addTag)) { e.preventDefault(); showTagPill(); }
    else if (matchesKey(keybinds.toggleMetadata)) {
        overlayVisible = !overlayVisible;
        edOverlay.classList.toggle('visible', overlayVisible);
        if (overlayVisible) {
            drawHistogram(getActiveImage());
            drawDominantColors(items[idx]);
        }
    }
    else if (matchesKey(keybinds.toggleFullscreen)) toggleFullscreen();
    else if (matchesKey(keybinds.toggleSidebar)) sidebarToggle.click();
    else if (matchesKey(keybinds.toggleZen)) toggleZenMode();
    else if (matchesKey(keybinds.toggleCatalog)) { e.preventDefault(); toggleCatalogView(!catalogModeActive); }
    else if (matchesKey(keybinds.resetZoom)) resetZoom();
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
      renderRecentFolders();
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
renderRecentFolders();
listen('menu-open-folder', openFolder);
listen('menu-open-in-finder', openCurrentFolderInFinder);
listen('menu-settings', openSettings);
if (cinematicCheck) cinematicCheck.checked = cinematicEnabled;
if (themeSelect) themeSelect.value = currentTheme;
if (sortSelect) sortSelect.value = currentSort;
if (zoomSensSlider) zoomSensSlider.value = zoomSens;
if (customCursorCheck) customCursorCheck.checked = useCustomCursor;

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

let diagnosticsInterval = null;
function startDiagnosticsPolling() {
  if (diagnosticsInterval) return;
  diagnosticsInterval = setInterval(async () => {
    const isHudActive = localStorage.getItem('folio_performance_hud') === 'true';
    const isStorageTabActive = settingsModal.style.display !== 'none' && document.querySelector('.tab-btn[data-tab="storage"]').classList.contains('active');
    
    if (isHudActive || isStorageTabActive) {
      try {
        const data = await invoke('get_storage_diagnostics');
        const dbSizeStr = formatBytes(data.db_size);
        const cacheSizeStr = formatBytes(data.cache_size);
        const decodedSizeStr = formatBytes(data.decoded_size);
        const memStr = formatBytes(data.memory_used_kb * 1024);
        const cpuStr = data.cpu_used_pct.toFixed(1) + '%';
        
        if (isStorageTabActive) {
        if (dbSizeVal) dbSizeVal.textContent = dbSizeStr;
        if (cacheSizeVal) cacheSizeVal.textContent = cacheSizeStr;
          if (decodedSizeVal) decodedSizeVal.textContent = decodedSizeStr;
          if (cpuLoadVal) cpuLoadVal.textContent = cpuStr;
          if (ramSizeVal) ramSizeVal.textContent = memStr;
        }
        
        if (isHudActive) {
          const hudCpuVal = $('hudCpuVal');
          const hudMemoryVal = $('hudMemoryVal');
          if (hudCpuVal) hudCpuVal.textContent = cpuStr;
          if (hudMemoryVal) hudMemoryVal.textContent = memStr;
        }
      } catch (err) {
        console.error("Failed to fetch storage diagnostics:", err);
      }
    }
  }, 1000);
}

/* ── Settings Tab Switching ── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = $('tab-' + btn.dataset.tab);
    if (pane) pane.classList.add('active');
    
    if (btn.dataset.tab === 'storage') {
      try {
        const data = await invoke('get_storage_diagnostics');
        if (dbSizeVal) dbSizeVal.textContent = formatBytes(data.db_size);
        if (cacheSizeVal) cacheSizeVal.textContent = formatBytes(data.cache_size);
        if (thumbCacheLimitInput && data.thumbnail_cache_limit_bytes) {
          thumbCacheLimitInput.value = (data.thumbnail_cache_limit_bytes / 1024 / 1024 / 1024).toFixed(2);
        }
        if (decodedSizeVal) decodedSizeVal.textContent = formatBytes(data.decoded_size);
        if (cpuLoadVal) cpuLoadVal.textContent = data.cpu_used_pct.toFixed(1) + '%';
        if (ramSizeVal) ramSizeVal.textContent = formatBytes(data.memory_used_kb * 1024);
      } catch (err) {
        console.error("Failed to query diagnostics:", err);
      }
    }
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

// Purge local cache button wiring
purgeCacheBtn?.addEventListener('click', async () => {
  if (confirm("Are you absolutely sure you want to purge all local cache, database indices, and thumbnails? This action is irreversible.")) {
    try {
      purgeCacheBtn.disabled = true;
      purgeCacheBtn.textContent = 'Purging...';
      await invoke('purge_cache');
      showToast("Cache purged successfully. Catalog database has been reset.");
      
      items = [];
      idx = -1;
      selectedCatalogPaths.clear();
      if (typeof buildCatalogContent === 'function') buildCatalogContent();
      if (typeof toggleCatalogView === 'function') toggleCatalogView(false);
      
      welcome.style.display = 'flex';
      welcomeBg.style.display = 'block';
      viewer.style.display = 'none';
      sidebar.style.display = 'none';
      
      const data = await invoke('get_storage_diagnostics');
      if (dbSizeVal) dbSizeVal.textContent = formatBytes(data.db_size);
      if (cacheSizeVal) cacheSizeVal.textContent = formatBytes(data.cache_size);
      if (decodedSizeVal) decodedSizeVal.textContent = formatBytes(data.decoded_size);
      if (cpuLoadVal) cpuLoadVal.textContent = data.cpu_used_pct.toFixed(1) + '%';
      if (ramSizeVal) ramSizeVal.textContent = formatBytes(data.memory_used_kb * 1024);
    } catch (err) {
      showToast(`Purge failed: ${err}`);
    } finally {
      purgeCacheBtn.disabled = false;
      purgeCacheBtn.textContent = 'Purge All Local Cache';
    }
  }
});

if (customCursorCheck) {
  customCursorCheck.addEventListener('change', (e) => {
    useCustomCursor = e.target.checked;
    localStorage.setItem('folio_custom_cursor', useCustomCursor);
    updateCursorVisibility();
    wakeCursorLoop();
  });
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

/* ── Welcome Parallax & Zen Mode ── */
welcome.addEventListener('mousemove', (e) => {
  const w = welcome.clientWidth;
  const h = welcome.clientHeight;
  const x = (e.clientX - w / 2) / (w / 2);
  const y = (e.clientY - h / 2) / (h / 2);
  welcomeBg.style.setProperty('--parallax-x', `${x * -20}px`);
  welcomeBg.style.setProperty('--parallax-y', `${y * -20}px`);
});

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
  dialog.style.textAlign = 'center';
  dialog.style.transform = 'scale(0.9)';
  dialog.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
  
  const title = document.createElement('h3');
  title.textContent = 'Move File to Trash?';
  title.style.color = '#fff';
  title.style.fontSize = '17px';
  title.style.margin = '0 0 10px 0';
  
  const desc = document.createElement('p');
  desc.textContent = `This will move "${itemPath.split('/').pop()}" to the system Trash.`;
  desc.style.color = 'rgba(255,255,255,0.6)';
  desc.style.fontSize = '13px';
  desc.style.lineHeight = '1.5';
  desc.style.margin = '0 0 20px 0';
  
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
        welcome.classList.remove('hidden');
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
    catalogGrid.style.display = 'grid';
    sidebar.style.display = 'none';
    viewer.style.display = 'none';
    welcome.classList.add('hidden');
    buildCatalogContent();
    showToast('Catalog Grid Mode');
  } else {
    catalogGrid.style.display = 'none';
    sidebar.style.display = 'flex';
    viewer.style.display = 'block';
    buildFilmstrip();
    show(idx);
  }
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
    }
    
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
      img.onload = () => img.classList.add('loaded');
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
    const attr = mediaAttributesCache.get(it.path);
    if (attr?.favorite || attr?.rating) {
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:10px;color:var(--accent-gold);margin-top:3px;';
      meta.textContent = `${attr.favorite ? '★ Favorite ' : ''}${attr.rating ? `Rating ${attr.rating}/5` : ''}`.trim();
      info.appendChild(meta);
    }
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
  if (!items || items.length === 0) return;
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
      welcome.classList.remove('hidden');
      sidebar.style.display = viewer.style.display = 'none';
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

// Frosted MapKit GPS Modal Functions
function showMapPopup(geodata) {
  // Can be called with either a single {lat, lon} object/args or an array of objects
  const data = Array.isArray(geodata) ? geodata : (typeof geodata === 'object' ? [geodata] : [{lat: arguments[0], lon: arguments[1]}]);
  if (!data || data.length === 0) return;

  const markersJson = JSON.stringify(data);
  const centerLat = data[0].lat;
  const centerLon = data[0].lon;
  
  const srcdoc = `
    <!DOCTYPE html>
    <html>
    <head>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <style>
        body { margin: 0; padding: 0; background: #0c0c0e; }
        #map { width: 100vw; height: 100vh; }
        .leaflet-popup-content-wrapper { 
          background: rgba(18, 18, 20, 0.85); 
          color: #fff; 
          backdrop-filter: blur(20px) saturate(180%); 
          -webkit-backdrop-filter: blur(20px) saturate(180%); 
          border: 1px solid rgba(255,255,255,0.08); 
          border-radius: 12px; 
          box-shadow: 0 8px 32px 0 rgba(0,0,0,0.3);
        }
        .leaflet-popup-tip { background: rgba(18, 18, 20, 0.85); border: 1px solid rgba(255,255,255,0.08); }
        .leaflet-popup-content { margin: 12px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .popup-img { width: 100%; height: 110px; object-fit: cover; border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: transform 0.2s ease; }
        .popup-img:hover { transform: scale(1.02); }
        .popup-title { font-size: 13px; font-weight: 600; color: #ffffff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px; }
        .popup-address { font-size: 11px; color: #b0b0b8; line-height: 1.4; margin-top: 4px; margin-bottom: 4px; display: flex; align-items: flex-start; gap: 4px; }
        .popup-coords { font-size: 9px; color: rgba(255,255,255,0.4); font-family: monospace; margin-top: 2px; }
      </style>
    </head>
    <body>
      <div id="map"></div>
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        const map = L.map('map', { zoomControl: false }).setView([${centerLat}, ${centerLon}], 13);
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
            \`<div style="width:180px;">
              \${m.path ? \`<img src="folio://localhost/\${encodeURIComponent(m.path)}" class="popup-img" onclick="window.parent.openGeotaggedImage('\${m.path.replace(/'/g, "\\\\'")}')" />\` : ''}
              <div class="popup-title">\${m.name || 'Location'}</div>
              <div class="popup-address" id="addr-\${m.lat}-\${m.lon}">Loading address...</div>
              <div class="popup-coords">\${m.lat.toFixed(5)}, \${m.lon.toFixed(5)}</div>
            </div>\`;
            
          L.marker([m.lat, m.lon]).addTo(map).bindPopup(popupContent);
        });
        
        map.on('popupopen', async function(e) {
          const popup = e.popup;
          const container = popup.getElement();
          if (!container) return;
          const addressEl = container.querySelector('.popup-address');
          if (addressEl && addressEl.textContent === 'Loading address...') {
            const latLng = popup.getLatLng();
            const address = await window.parent.reverseGeocode(latLng.lat, latLng.lng);
            addressEl.textContent = address;
          }
        });

        if (markers.length > 1) {
          map.fitBounds(bounds, { padding: [50, 50] });
        }
      </script>
    </body>
    </html>
  `;
  mapIframe.srcdoc = srcdoc;
  mapModal.style.display = 'flex';
}

mapCloseBtn.onclick = () => {
  mapModal.style.display = 'none';
  mapIframe.srcdoc = '';
  mapIframe.src = '';
};

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
    if (transcodeCount) transcodeCount.textContent = `${count} item${count !== 1 ? 's' : ''} selected`;
    if (transcodeHud) transcodeHud.classList.add('visible');
  } else {
    if (transcodeHud) transcodeHud.classList.remove('visible');
  }
}

transcodeClose?.addEventListener('click', () => {
  selectedCatalogPaths.clear();
  buildCatalogContent();
  updateTranscodeHud();
});

async function runTrackedBatch(operation, label) {
  const started = await invoke('start_batch_job', { operation });
  showToast(`${label} started...`);
  const finalStatus = await trackJob(invoke, started, status => {
    if (status.completed === status.total || status.completed % 5 === 0) {
      FolioEvents.emit('job:update', status);
    }
  });
  const failed = finalStatus.failed ? ` (${finalStatus.failed} failed)` : '';
  showToast(`${label} ${finalStatus.state}: ${finalStatus.completed}/${finalStatus.total}${failed}`);
  return finalStatus;
}

document.querySelectorAll('.transcode-btn[data-fmt]').forEach(btn => {
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
