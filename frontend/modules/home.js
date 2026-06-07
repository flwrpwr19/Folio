const PINNED_KEY = 'folio_pinned_folders';
const LAYOUT_KEY = 'folio_home_layout';
const SUMMARY_KEY = 'folio_library_summaries';
const RECENT_PATHS_KEY = 'folio_recent_library_paths';

const DEFAULT_LAYOUT = {
  showLibrary: true,
  showPinned: true,
  showRecents: true,
  showShortcuts: true,
  compact: false,
};

export function getPinnedFolders() {
  try {
    return JSON.parse(localStorage.getItem(PINNED_KEY) || '[]');
  } catch {
    return [];
  }
}

export function setPinnedFolders(list) {
  localStorage.setItem(PINNED_KEY, JSON.stringify(list));
}

export function togglePinnedFolder(path) {
  const list = getPinnedFolders();
  const i = list.indexOf(path);
  if (i >= 0) list.splice(i, 1);
  else list.unshift(path);
  setPinnedFolders(list);
  return list.includes(path);
}

export function isPinned(path) {
  return getPinnedFolders().includes(path);
}

export function getHomeLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    return {
      ...DEFAULT_LAYOUT,
      ...saved,
      showRecents: saved.showRecents !== false,
      showLibrary: saved.showLibrary !== false,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function ensureLibrarySummaryStub(path, count = 0) {
  if (!path || getLibrarySummary(path)) return;
  saveLibrarySummary(path, { count, previews: [] });
}

export function saveHomeLayout(partial) {
  const next = { ...getHomeLayout(), ...partial };
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
  return next;
}

export function getLibrarySummary(path) {
  try {
    return JSON.parse(localStorage.getItem(SUMMARY_KEY) || '{}')[path] || null;
  } catch {
    return null;
  }
}

export function getLibrarySummaries() {
  try {
    return Object.entries(JSON.parse(localStorage.getItem(SUMMARY_KEY) || '{}'))
      .map(([path, summary]) => ({ path, ...summary }))
      .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  } catch {
    return [];
  }
}

export function getStoredRecentLibraryPaths() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_PATHS_KEY) || '[]');
    return Array.isArray(list) ? list.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function pushRecentLibraryPath(path) {
  if (!path) return;
  const next = [path, ...getStoredRecentLibraryPaths().filter((p) => p !== path)].slice(0, 12);
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(next));
}

export function clearStoredRecentLibraryPaths() {
  localStorage.removeItem(RECENT_PATHS_KEY);
}

export function clearLibrarySummaries() {
  localStorage.removeItem(SUMMARY_KEY);
}

/** Merge Tauri recents, local path history, and summaries (newest summary first). */
export function mergeRecentLibraryPaths(backendPaths = []) {
  const summaries = getLibrarySummaries();
  const openedAt = new Map(summaries.map((s) => [s.path, s.openedAt || 0]));
  const seen = new Set();
  const merged = [];
  const add = (path) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    merged.push(path);
  };
  for (const path of backendPaths) add(path);
  for (const path of getStoredRecentLibraryPaths()) add(path);
  for (const { path } of summaries) add(path);
  return merged.sort((a, b) => (openedAt.get(b) || 0) - (openedAt.get(a) || 0));
}

export function saveLibrarySummary(path, summary) {
  if (!path) return;
  let summaries = {};
  try {
    summaries = JSON.parse(localStorage.getItem(SUMMARY_KEY) || '{}');
  } catch {}
  summaries[path] = { ...summary, openedAt: Date.now() };
  localStorage.setItem(SUMMARY_KEY, JSON.stringify(summaries));
  pushRecentLibraryPath(path);
}

export function patchLibrarySummary(path, patch) {
  if (!path) return null;
  let summaries = {};
  try {
    summaries = JSON.parse(localStorage.getItem(SUMMARY_KEY) || '{}');
  } catch {}
  const previous = summaries[path] || {};
  const next = {
    ...previous,
    ...patch,
    openedAt: previous.openedAt || Date.now(),
  };
  summaries[path] = next;
  localStorage.setItem(SUMMARY_KEY, JSON.stringify(summaries));
  return next;
}

export function formatHomePath(path) {
  if (!path) return '';
  return path.replace(/^\/Users\/[^/]+/, '~');
}

export function folderDisplayName(path) {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}
