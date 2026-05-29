/**
 * Shared empty / loading / error surfaces (UX-7).
 */

const ICONS = {
  folder: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  loading: '<svg class="folio-state-spinner" width="40" height="40" viewBox="0 0 44 44"><circle class="folio-state-spinner-track" cx="22" cy="22" r="18"/><circle class="folio-state-spinner-arc" cx="22" cy="22" r="18"/></svg>',
  error: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  media: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  map: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  vault: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>',
  cache: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
};

const PRESETS = {
  'folder-loading': {
    icon: 'loading',
    title: 'Loading library',
    message: 'Indexing files and preparing thumbnails…',
  },
  'folder-empty': {
    icon: 'folder',
    title: 'No supported media',
    message: 'This folder has no images or videos Folio can display. Try another folder or drop one on the home screen.',
  },
  'folder-error': {
    icon: 'error',
    title: 'Could not open folder',
    message: 'Check permissions or choose a different location.',
    variant: 'error',
  },
  'catalog-empty': {
    icon: 'folder',
    title: 'Catalog is empty',
    message: 'Open a folder from the home screen or sidebar to browse your library in the grid.',
  },
  'media-error': {
    icon: 'media',
    title: 'Could not display file',
    message: 'The file may be unsupported, still processing, or temporarily unavailable.',
    variant: 'error',
  },
  'media-unsupported': {
    icon: 'media',
    title: 'Unsupported format',
    message: 'Folio could not decode this file. Try exporting to JPEG or PNG from your editor.',
    variant: 'error',
  },
  'map-unavailable': {
    icon: 'map',
    title: 'Address unavailable',
    message: 'Could not resolve a place name. Check your connection or try again later.',
    variant: 'muted',
  },
  'map-loading': {
    icon: 'loading',
    title: 'Looking up address',
    message: 'Querying OpenStreetMap…',
  },
  'vault-locked': {
    icon: 'vault',
    title: 'Vault locked',
    message: 'Unlock with Touch ID or use the buttons below to manage secure albums.',
    variant: 'vault',
  },
  'cache-working': {
    icon: 'loading',
    title: 'Working…',
    message: 'This may take a moment for large libraries.',
  },
};

/**
 * @param {HTMLElement|null} host
 * @param {{ preset?: string, icon?: string, title?: string, message?: string, variant?: string, actions?: Array<{ label: string, primary?: boolean, onClick: () => void }> }} opts
 * @returns {HTMLElement|null}
 */
export function renderEmptyState(host, opts = {}) {
  if (!host) return null;
  const preset = opts.preset ? { ...PRESETS[opts.preset] } : {};
  const iconKey = opts.icon || preset.icon || 'folder';
  const title = opts.title ?? preset.title ?? '';
  const message = opts.message ?? preset.message ?? '';
  const variant = opts.variant || preset.variant || 'default';
  const actions = opts.actions || [];

  host.innerHTML = '';
  host.classList.add('folio-state-host', 'is-active');
  host.setAttribute('aria-hidden', 'false');

  const el = document.createElement('div');
  el.className = `folio-empty-state folio-empty-state--${variant}`;

  const iconWrap = document.createElement('div');
  iconWrap.className = 'folio-empty-state-icon';
  iconWrap.innerHTML = ICONS[iconKey] || ICONS.folder;

  const titleEl = document.createElement('h3');
  titleEl.className = 'folio-empty-state-title';
  titleEl.textContent = title;

  const msgEl = document.createElement('p');
  msgEl.className = 'folio-empty-state-message';
  msgEl.textContent = message;

  el.append(iconWrap, titleEl, msgEl);

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'folio-empty-state-actions';
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'folio-empty-state-btn' + (a.primary ? ' is-primary' : '');
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      row.appendChild(btn);
    });
    el.appendChild(row);
  }

  host.appendChild(el);
  return el;
}

export function clearEmptyState(host) {
  if (!host) return;
  host.innerHTML = '';
  host.classList.remove('is-active');
  host.setAttribute('aria-hidden', 'true');
}

export function setInlineStatus(el, text, variant = 'default') {
  if (!el) return;
  el.className = `folio-inline-status folio-inline-status--${variant}`;
  el.textContent = text;
}
