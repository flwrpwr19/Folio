/** Map explorer workspace — clustering, map srcdoc, and tray UI. */

export function normalizeMediaPath(path) {
  return String(path || '').replace(/\\/g, '/').toLowerCase();
}

export function pathsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return normalizeMediaPath(a) === normalizeMediaPath(b);
}

export function hasItemGps(item) {
  const lat = item?.exif?.latitude;
  const lon = item?.exif?.longitude;
  return (
    lat != null
    && lon != null
    && Number.isFinite(Number(lat))
    && Number.isFinite(Number(lon))
  );
}

/** @param {object[]} libraryItems */
export function mergeMapGpsIntoItems(libraryItems, points) {
  if (!points?.length) return 0;
  const itemsByPath = new Map();
  for (const item of libraryItems) {
    itemsByPath.set(normalizeMediaPath(item.path), item);
  }
  let merged = 0;
  for (const pt of points) {
    const item = itemsByPath.get(normalizeMediaPath(pt.path));
    if (!item || item.is_video) continue;
    if (!item.exif) item.exif = {};
    item.exif.latitude = pt.latitude;
    item.exif.longitude = pt.longitude;
    merged++;
  }
  return merged;
}

export function formatMapPlaceLabel(lat, lon) {
  const latN = Number(lat);
  const lonN = Number(lon);
  if (!Number.isFinite(latN) || !Number.isFinite(lonN)) return 'Location';
  const latAbs = Math.abs(latN).toFixed(2);
  const lonAbs = Math.abs(lonN).toFixed(2);
  const latDir = latN >= 0 ? 'N' : 'S';
  const lonDir = lonN >= 0 ? 'E' : 'W';
  return `${latAbs}° ${latDir}, ${lonAbs}° ${lonDir}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;');
}

/** @param {object} cluster */
export function buildClusterMarkerHtml(cluster) {
  const previews = cluster.previewUrls || [];
  const count = cluster.count || 1;

  if (count <= 1 && previews[0]) {
    return `<div class="folio-pin folio-pin--single" role="img" aria-label="1 photo">
      <span class="folio-pin-photo"><img src="${escapeHtml(previews[0])}" alt="" /></span>
      <span class="folio-pin-foot" aria-hidden="true"></span>
    </div>`;
  }

  const stack = previews.slice(0, 3).map((url, index) => (
    `<span class="folio-pin-photo" style="--i:${index}"><img src="${escapeHtml(url)}" alt="" /></span>`
  )).join('');

  return `<div class="folio-pin folio-pin--cluster" role="img" aria-label="${count} photos">
    <div class="folio-pin-stack">${stack}</div>
    <span class="folio-pin-badge">${count}</span>
    <span class="folio-pin-foot" aria-hidden="true"></span>
  </div>`;
}

/**
 * @param {object[]} clusters
 * @param {(path: string) => string} thumbUrl
 */
export function enrichClustersForMap(clusters, thumbUrl) {
  return clusters.map((cluster) => {
    const previewUrls = cluster.members.slice(0, 3).map((m) => thumbUrl(m.path));
    const placeLabel = formatMapPlaceLabel(cluster.lat, cluster.lon);
    const enriched = {
      ...cluster,
      previewUrls,
      placeLabel,
      label: placeLabel,
      markerHtml: '',
    };
    enriched.markerHtml = buildClusterMarkerHtml(enriched);
    return enriched;
  });
}

/**
 * @param {object[]} items
 * @param {object} opts
 * @param {string} [opts.mapFilter]
 * @param {string} [opts.searchTerm]
 * @param {Map<string, { favorite?: boolean, rating?: number }>} [opts.attributes]
 */
export function filterMapItems(items, opts = {}) {
  const {
    mapFilter = 'all',
    searchTerm = '',
    attributes = new Map(),
  } = opts;

  return items.filter((item) => {
    if (item.is_video) return false;
    if (!hasItemGps(item)) return false;
    if (searchTerm && !String(item.path).toLowerCase().includes(searchTerm.toLowerCase())) return false;

    const attrs = attributes.get(item.path);
    if (mapFilter === 'favorites' && !attrs?.favorite) return false;
    if (mapFilter === 'rated' && (attrs?.rating ?? 0) < 3) return false;
    return true;
  });
}

/**
 * @param {object[]} items
 * @returns {object[]}
 */
export function itemsToMapPoints(items) {
  return items.filter(hasItemGps).map((item) => ({
    lat: Number(item.exif.latitude),
    lon: Number(item.exif.longitude),
    path: item.path,
    name: item.path.split(/[/\\]/).pop(),
    modified: item.modified ?? 0,
  }));
}

/**
 * Grid clustering for map markers.
 * @param {object[]} points
 * @param {number} [cellSize]
 */
export function clusterMapPoints(points, cellSize = 0.12) {
  const buckets = new Map();

  points.forEach((point) => {
    const key = `${Math.round(point.lat / cellSize)}:${Math.round(point.lon / cellSize)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(point);
  });

  return [...buckets.entries()].map(([key, members], index) => {
    const lat = members.reduce((sum, m) => sum + m.lat, 0) / members.length;
    const lon = members.reduce((sum, m) => sum + m.lon, 0) / members.length;
    const modified = members.reduce((max, m) => Math.max(max, m.modified || 0), 0);
    const placeLabel = formatMapPlaceLabel(lat, lon);
    return {
      id: `cluster-${index}-${key}`,
      lat,
      lon,
      count: members.length,
      label: placeLabel,
      modified,
      paths: members.map((m) => m.path),
      members,
    };
  });
}

export function buildMapFrameSrcdoc() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <link rel="stylesheet" href="/vendor/leaflet/leaflet.css">
  <link rel="stylesheet" href="/vendor/folio-map-frame.css">
</head>
<body>
  <div class="map-offline-banner" id="offlineBanner">Map tiles unavailable. Coordinates and clusters are still shown offline.</div>
  <div id="map"></div>
  <script src="/vendor/leaflet/leaflet.js"></script>
  <script src="/vendor/folio-map-frame.js"></script>
</body>
</html>`;
}

/**
 * Leaflet map document for the full map workspace.
 * @param {object[]} clusters — enriched via enrichClustersForMap
 */
export function buildMapExplorerSrcdoc(clusters) {
  if (!clusters.length) {
    return `<!DOCTYPE html><html><body style="margin:0;background:#111113;color:#a8a8b0;font:13px system-ui;display:flex;align-items:center;justify-content:center;height:100%">No GPS locations to display.</body></html>`;
  }

  return buildMapFrameSrcdoc();
}

/**
 * @param {HTMLElement} host
 * @param {object[]} members
 * @param {(path: string) => string} thumbUrl
 */
export function renderMapLocationStack(host, members, thumbUrl) {
  if (!host) return;
  host.replaceChildren();
  const previews = members.slice(0, 3);
  previews.forEach((member, index) => {
    const frame = document.createElement('span');
    frame.className = 'map-location-card-photo';
    frame.style.setProperty('--i', String(index));
    const img = document.createElement('img');
    img.src = thumbUrl(member.path);
    img.alt = member.name || '';
    frame.appendChild(img);
    host.appendChild(frame);
  });
}

/**
 * @param {HTMLElement} container
 * @param {object[]} members
 * @param {object} opts
 * @param {string} [opts.selectedPath]
 * @param {(path: string) => string} opts.thumbUrl
 * @param {(path: string) => void} opts.onSelect
 * @param {(path: string) => void} [opts.onOpen] — e.g. double-click to open viewer
 */
export function renderMapTray(container, members, { selectedPath, thumbUrl, onSelect, onOpen }) {
  if (!container) return;
  container.replaceChildren();

  members.forEach((member) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-tray-thumb';
    btn.dataset.path = member.path;
    btn.title = onOpen ? 'Select · Double-click to open in viewer' : 'Select';
    if (selectedPath && pathsMatch(member.path, selectedPath)) btn.classList.add('is-selected');

    const img = document.createElement('img');
    img.alt = member.name || '';
    img.loading = 'lazy';
    img.src = thumbUrl(member.path);
    img.draggable = false;
    img.addEventListener('error', () => { img.style.opacity = '0.35'; });

    btn.appendChild(img);
    btn.addEventListener('click', () => onSelect(member.path));
    if (onOpen) {
      btn.addEventListener('dblclick', (e) => {
        e.preventDefault();
        onOpen(member.path);
      });
    }
    container.appendChild(btn);
  });
}

export function formatMapClusterMeta(cluster) {
  if (!cluster?.members?.length) return '';
  const countLabel = `${cluster.count} item${cluster.count === 1 ? '' : 's'}`;
  const dates = cluster.members.map((m) => m.modified).filter(Boolean).sort((a, b) => a - b);
  if (!dates.length) return countLabel;
  const start = new Date(dates[0] * 1000);
  const end = new Date(dates[dates.length - 1] * 1000);
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (dates.length === 1) return `${countLabel} · ${fmt(start)}`;
  return `${countLabel} · ${fmt(start)} – ${fmt(end)}`;
}
