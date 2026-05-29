const PINNED_KEY = 'folio_pinned_folders';
const LAYOUT_KEY = 'folio_home_layout';

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
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveHomeLayout(partial) {
  const next = { ...getHomeLayout(), ...partial };
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
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
