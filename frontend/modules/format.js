/** @param {string} path */
export function basename(path) {
  if (!path) return '';
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * Shorten a filename for dialogs and UI chips (middle ellipsis).
 * @param {string} name
 * @param {number} maxLen
 */
export function truncateDisplayName(name, maxLen = 48) {
  if (!name || name.length <= maxLen) return name;
  const head = Math.ceil((maxLen - 1) / 2);
  const tail = Math.floor((maxLen - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(-tail)}`;
}

/** @param {string} path @param {number} maxLen */
export function formatFilenameForDialog(path, maxLen = 48) {
  return truncateDisplayName(basename(path), maxLen);
}
