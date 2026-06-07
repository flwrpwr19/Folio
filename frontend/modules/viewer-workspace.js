/** Immersive viewer chrome: floating dock idle state and filmstrip windowing. */

export const FILMSTRIP_WINDOW_RADIUS = 18;
export const FILMSTRIP_THUMB_STEP_PX = 40;

export function isFilmstripVisible() {
  return localStorage.getItem('folio_filmstrip_visible') !== 'false';
}

export function setFilmstripVisible(visible) {
  localStorage.setItem('folio_filmstrip_visible', visible ? 'true' : 'false');
}

export function filmstripWindowRange(index, total, radius = FILMSTRIP_WINDOW_RADIUS) {
  if (total <= radius * 2 + 1) {
    return { start: 0, end: total, virtualized: false };
  }
  return {
    start: Math.max(0, index - radius),
    end: Math.min(total, index + radius + 1),
    virtualized: true,
  };
}

/**
 * @param {object} opts
 * @param {HTMLElement | null} opts.viewer
 * @param {HTMLElement | null} opts.topbar
 * @param {HTMLElement | null} opts.chromeRoot
 * @param {() => boolean} opts.getReducedMotion
 * @param {() => boolean} opts.isScrubbing
 * @param {() => boolean} opts.isEditOpen
 * @param {() => boolean} [opts.isZenMode]
 * @param {number} [opts.idleMs]
 */
export function initViewerChrome({
  viewer,
  topbar,
  chromeRoot,
  getReducedMotion,
  isScrubbing,
  isEditOpen,
  isZenMode = () => false,
  idleMs = 2800,
}) {
  if (!viewer) return { wake: () => {}, destroy: () => {} };

  let idleTimer = null;
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const shouldAnimate = () => !getReducedMotion() && !motionQuery.matches;

  const applyIdle = (idle) => {
    viewer.classList.toggle('viewer-chrome-idle', idle);
    if (topbar) topbar.classList.toggle('is-dimmed', idle && !isZenMode());
  };

  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (isZenMode()) {
      applyIdle(true);
      return;
    }
    if (!shouldAnimate()) {
      applyIdle(false);
      return;
    }
    idleTimer = setTimeout(() => {
      if (isZenMode() || isScrubbing() || isEditOpen()) {
        scheduleIdle();
        return;
      }
      applyIdle(true);
    }, idleMs);
  };

  const wake = () => {
    if (isZenMode()) {
      applyIdle(true);
      return;
    }
    applyIdle(false);
    scheduleIdle();
  };

  const onActivity = () => wake();

  const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'focusin'];
  events.forEach((name) => viewer.addEventListener(name, onActivity, { passive: true }));
  topbar?.addEventListener('pointerenter', onActivity);
  chromeRoot?.addEventListener('pointerenter', onActivity);

  const onMotionChange = () => {
    if (!shouldAnimate()) applyIdle(false);
    else scheduleIdle();
  };
  motionQuery.addEventListener('change', onMotionChange);

  wake();

  return {
    wake,
    destroy: () => {
      clearTimeout(idleTimer);
      events.forEach((name) => viewer.removeEventListener(name, onActivity));
      motionQuery.removeEventListener('change', onMotionChange);
      applyIdle(false);
    },
  };
}

export function bindDockOverflowMenu({ menu, trigger, onAction }) {
  if (!menu || !trigger) return;

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const positionMenu = () => {
    const rect = trigger.getBoundingClientRect();
    menu.style.top = `${rect.top - menu.offsetHeight - 8}px`;
    menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    close();
    if (!open) {
      positionMenu();
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    }
  });

  menu.querySelectorAll('[data-viewer-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onAction(btn.dataset.viewerAction);
      close();
    });
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== trigger) close();
  });
}
