(function () {
  const SOURCE_PARENT = 'folio-map-parent';
  const SOURCE_FRAME = 'folio-map-frame';
  const mapEl = document.getElementById('map');
  const offlineBanner = document.getElementById('offlineBanner');
  let map = null;
  let markersLayer = null;
  let activeClusters = [];
  let activeMarkers = [];
  let activeMode = null;
  let activeTileStyle = 'dark';
  const reverseGeocodeRequests = new Map();
  const tileStyles = {
    atlas: null,
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    voyager: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  };

  function send(type, payload = {}) {
    window.parent.postMessage({ source: SOURCE_FRAME, type, ...payload }, '*');
  }

  function clearMap() {
    if (map) {
      map.remove();
      map = null;
    }
    markersLayer = null;
    activeClusters = [];
    activeMarkers = [];
    activeMode = null;
    if (mapEl) {
      mapEl.classList.remove('folio-map-atlas');
      mapEl.replaceChildren();
    }
    offlineBanner?.classList.remove('visible');
  }

  function showEmpty(message) {
    clearMap();
    if (!mapEl) return;
    const empty = document.createElement('div');
    empty.className = 'folio-frame-empty';
    empty.textContent = message;
    mapEl.appendChild(empty);
  }

  function ensureLeaflet() {
    if (window.L) return true;
    showEmpty('Map assets could not be loaded. Coordinates are still available in the inspector.');
    return false;
  }

  function createMap(center, zoom) {
    if (!ensureLeaflet() || !mapEl) return null;
    clearMap();
    mapEl.classList.toggle('folio-map-atlas', activeTileStyle === 'atlas');
    map = L.map('map', {
      attributionControl: activeTileStyle !== 'atlas',
      zoomControl: false,
      worldCopyJump: true,
    }).setView(center, zoom);
    markersLayer = L.layerGroup().addTo(map);
    if (activeTileStyle === 'atlas') {
      const atlasLayer = L.DomUtil.create('div', 'folio-atlas-layer');
      atlasLayer.innerHTML = '<span style="--x:18%;--y:24%">NORTH</span><span style="--x:72%;--y:18%">EAST</span><span style="--x:38%;--y:68%">LOCAL COORDINATES</span><span style="--x:78%;--y:76%">FOLIO ATLAS</span>';
      map.getPanes().tilePane.appendChild(atlasLayer);
    } else {
      const tile = L.tileLayer(tileStyles[activeTileStyle] || tileStyles.dark, {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20,
      });
      tile.on('tileerror', () => offlineBanner?.classList.add('visible'));
      tile.addTo(map);
    }
    return map;
  }

  function renderClusters(clusters = [], tileStyle = activeTileStyle) {
    activeTileStyle = tileStyle || activeTileStyle;
    if (!clusters.length) {
      showEmpty('No GPS locations to display.');
      return;
    }
    const center = [Number(clusters[0].lat), Number(clusters[0].lon)];
    const initialZoom = clusters.length > 1 ? 9 : 13;
    const currentMap = createMap(center, initialZoom);
    if (!currentMap) return;
    activeMode = 'clusters';
    activeClusters = clusters;
    const bounds = L.latLngBounds();

    clusters.forEach((cluster) => {
      bounds.extend([cluster.lat, cluster.lon]);
      const icon = L.divIcon({
        className: 'folio-leaflet-pin',
        html: cluster.markerHtml,
        iconSize: [76, 92],
        iconAnchor: [38, 86],
      });
      const marker = L.marker([cluster.lat, cluster.lon], { icon }).addTo(markersLayer);
      marker.on('click', () => send('selectCluster', { clusterId: cluster.id }));
    });

    if (clusters.length > 1) currentMap.fitBounds(bounds.pad(0.22));
  }

  function requestReverseGeocode(lat, lon, addressEl) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    reverseGeocodeRequests.set(requestId, addressEl);
    send('reverseGeocode', { requestId, lat, lon });
  }

  function renderPopover(markers = [], tileStyle = activeTileStyle) {
    activeTileStyle = tileStyle || activeTileStyle;
    if (!markers.length) {
      showEmpty('No GPS coordinates available.');
      return;
    }
    const center = [Number(markers[0].lat), Number(markers[0].lon)];
    const initialZoom = markers.length > 1 ? 11 : 14;
    const currentMap = createMap(center, initialZoom);
    if (!currentMap) return;
    activeMode = 'popover';
    activeMarkers = markers;
    const bounds = L.latLngBounds();

    markers.forEach((markerData) => {
      bounds.extend([markerData.lat, markerData.lon]);
      const popupContent = document.createElement('div');
      popupContent.className = 'folio-popup-inner';

      if (markerData.path) {
        const image = document.createElement('img');
        image.src = `folio://localhost/${encodeURIComponent(markerData.path)}`;
        image.className = 'popup-img';
        image.alt = '';
        image.addEventListener('click', () => send('openGeotaggedImage', { path: markerData.path }));
        popupContent.appendChild(image);
      }

      const title = document.createElement('div');
      title.className = 'popup-title';
      title.textContent = markerData.name || 'Location';
      popupContent.appendChild(title);

      const address = document.createElement('div');
      address.className = 'popup-address';
      address.textContent = 'Loading address...';
      popupContent.appendChild(address);

      const coords = document.createElement('div');
      coords.className = 'popup-coords';
      coords.textContent = `${Number(markerData.lat).toFixed(4)}, ${Number(markerData.lon).toFixed(4)}`;
      popupContent.appendChild(coords);

      const marker = L.marker([markerData.lat, markerData.lon]).addTo(markersLayer);
      marker.bindPopup(popupContent, { maxWidth: 168, minWidth: 120, className: 'folio-map-popup' });
      marker.on('popupopen', () => requestReverseGeocode(markerData.lat, markerData.lon, address));
      if (markers.length === 1) setTimeout(() => marker.openPopup(), 200);
    });

    if (markers.length > 1) {
      currentMap.fitBounds(bounds, { padding: [50, 50] });
    }
  }

  function flyToCluster(clusterId) {
    if (!map || activeMode !== 'clusters') return;
    const cluster = activeClusters.find((entry) => entry.id === clusterId);
    if (!cluster) return;
    map.setView([cluster.lat, cluster.lon], cluster.count > 1 ? 12 : 15, { animate: true });
  }

  function flyToPoint(lat, lon) {
    if (!map) return;
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) return;
    map.setView([latN, lonN], Math.max(map.getZoom(), 14), { animate: true });
  }

  function fitAll() {
    if (!map) return;
    const bounds = L.latLngBounds();
    if (activeMode === 'clusters') {
      activeClusters.forEach((cluster) => bounds.extend([cluster.lat, cluster.lon]));
    } else if (activeMode === 'popover') {
      activeMarkers.forEach((marker) => bounds.extend([marker.lat, marker.lon]));
    }
    if (!bounds.isValid()) return;
    map.fitBounds(bounds.pad(0.22), { animate: true });
  }

  function setTileStyle(tileStyle) {
    const next = Object.prototype.hasOwnProperty.call(tileStyles, tileStyle) ? tileStyle : 'dark';
    if (next === activeTileStyle) return;
    activeTileStyle = next;
    if (activeMode === 'clusters') renderClusters(activeClusters, activeTileStyle);
    else if (activeMode === 'popover') renderPopover(activeMarkers, activeTileStyle);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.source !== SOURCE_PARENT) return;

    switch (message.type) {
      case 'renderClusters':
        renderClusters(message.clusters || [], message.tileStyle);
        break;
      case 'renderPopover':
        renderPopover(message.markers || [], message.tileStyle);
        break;
      case 'flyToCluster':
        flyToCluster(message.clusterId);
        break;
      case 'flyToPoint':
        flyToPoint(message.lat, message.lon);
        break;
      case 'fitAll':
        fitAll();
        break;
      case 'setTileStyle':
        setTileStyle(message.tileStyle);
        break;
      case 'reverseGeocodeResult': {
        const el = reverseGeocodeRequests.get(message.requestId);
        if (el) {
          el.textContent = message.address || 'Address unavailable';
          reverseGeocodeRequests.delete(message.requestId);
        }
        break;
      }
      default:
        break;
    }
  });

  send('ready');
}());
