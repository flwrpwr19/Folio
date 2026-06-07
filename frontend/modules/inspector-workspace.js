/** Inspector cards and adjust history helpers. */

export const DEFAULT_INSPECTOR_CARD_ORDER = ['file', 'camera', 'location', 'date', 'tags', 'analysis'];

const ORDER_KEY = 'folio_inspector_card_order';
const COLLAPSED_KEY = 'folio_inspector_card_collapsed';
const FLIP_MS = 320;

export function loadInspectorCardOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [...DEFAULT_INSPECTOR_CARD_ORDER];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_INSPECTOR_CARD_ORDER];
    const known = new Set(DEFAULT_INSPECTOR_CARD_ORDER);
    const ordered = parsed.filter((id) => known.has(id));
    DEFAULT_INSPECTOR_CARD_ORDER.forEach((id) => {
      if (!ordered.includes(id)) ordered.push(id);
    });
    return ordered;
  } catch {
    return [...DEFAULT_INSPECTOR_CARD_ORDER];
  }
}

export function saveInspectorCardOrder(order) {
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
}

export function loadInspectorCardCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveInspectorCardCollapsed(map) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(map));
}

export function applyInspectorCardOrder(host, order) {
  if (!host) return;
  const map = new Map();
  host.querySelectorAll('[data-inspector-card]').forEach((el) => {
    map.set(el.dataset.inspectorCard, el);
  });
  order.forEach((id) => {
    const el = map.get(id);
    if (el) host.appendChild(el);
  });
}

function readOrderFromDom(host) {
  return [...host.querySelectorAll('[data-inspector-card]')].map((el) => el.dataset.inspectorCard);
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

function flipInspectorCards(host, mutate) {
  const cards = [...host.querySelectorAll('[data-inspector-card]')];
  if (!cards.length || prefersReducedMotion()) {
    mutate();
    return;
  }

  const firstRects = new Map(cards.map((el) => [el, el.getBoundingClientRect()]));
  mutate();

  requestAnimationFrame(() => {
    cards.forEach((el) => {
      const first = firstRects.get(el);
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

      el.style.transition = 'none';
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;

      requestAnimationFrame(() => {
        el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        el.style.transform = '';
        const clear = () => {
          el.style.transition = '';
          el.removeEventListener('transitionend', clear);
        };
        el.addEventListener('transitionend', clear);
      });
    });
  });
}

function createDragPlaceholder(height) {
  const el = document.createElement('div');
  el.className = 'inspector-card-placeholder';
  el.style.height = `${height}px`;
  return el;
}

function movePlaceholder(host, placeholder, insertBefore) {
  flipInspectorCards(host, () => {
    if (insertBefore) {
      host.insertBefore(placeholder, insertBefore);
    } else {
      host.appendChild(placeholder);
    }
  });
}

function bindInspectorCardDrag(host, onOrderChange) {
  if (!host || host.dataset.dragBound === '1') return;
  host.dataset.dragBound = '1';

  let dragCard = null;
  let placeholder = null;
  let pointerId = null;
  let ghost = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const finishDrag = () => {
    if (!dragCard) return;

    if (ghost) {
      ghost.remove();
      ghost = null;
    }

    dragCard.classList.remove('is-dragging', 'is-dragging-source');

    flipInspectorCards(host, () => {
      if (placeholder?.parentNode) {
        host.insertBefore(dragCard, placeholder);
        placeholder.remove();
      }
    });

    placeholder = null;
    const order = readOrderFromDom(host);
    saveInspectorCardOrder(order);
    onOrderChange?.(order);
    dragCard = null;
    pointerId = null;
    document.body.classList.remove('inspector-drag-active');
  };

  host.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.inspector-card-drag');
    if (!handle || !host.contains(handle)) return;
    const card = handle.closest('[data-inspector-card]');
    if (!card) return;

    e.preventDefault();
    pointerId = e.pointerId;
    handle.setPointerCapture(pointerId);

    dragCard = card;
    const rect = card.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    ghost = card.cloneNode(true);
    ghost.classList.add('inspector-card-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);

    const moveGhost = (clientX, clientY) => {
      if (!ghost) return;
      ghost.style.transform = `translate3d(${clientX - dragOffsetX}px, ${clientY - dragOffsetY}px, 0)`;
    };
    moveGhost(e.clientX, e.clientY);

    dragCard.classList.add('is-dragging', 'is-dragging-source');
    placeholder = createDragPlaceholder(rect.height);
    host.insertBefore(placeholder, dragCard);
    document.body.classList.add('inspector-drag-active');
  });

  host.addEventListener('pointermove', (e) => {
    if (!dragCard || e.pointerId !== pointerId) return;

    if (ghost) {
      ghost.style.transform = `translate3d(${e.clientX - dragOffsetX}px, ${e.clientY - dragOffsetY}px, 0)`;
    }

    const cards = [...host.querySelectorAll('[data-inspector-card]:not(.is-dragging)')];
    let insertBefore = null;
    for (const card of cards) {
      const cardRect = card.getBoundingClientRect();
      const mid = cardRect.top + cardRect.height / 2;
      if (e.clientY < mid) {
        insertBefore = card;
        break;
      }
    }

    const nextSibling = insertBefore || null;
    if (nextSibling === placeholder.nextElementSibling && insertBefore) return;
    if (!insertBefore && placeholder === host.lastElementChild) return;

    movePlaceholder(host, placeholder, insertBefore);
  });

  host.addEventListener('pointerup', (e) => {
    if (!dragCard || e.pointerId !== pointerId) return;
    e.preventDefault();
    finishDrag();
  });

  host.addEventListener('pointercancel', (e) => {
    if (!dragCard || e.pointerId !== pointerId) return;
    finishDrag();
  });
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {(order: string[]) => void} [opts.onOrderChange]
 */
export function initInspectorCards({ host, onOrderChange }) {
  if (!host) return;

  let order = loadInspectorCardOrder();
  let collapsed = loadInspectorCardCollapsed();

  applyInspectorCardOrder(host, order);

  host.querySelectorAll('[data-inspector-card]').forEach((card) => {
    if (card.dataset.inspectorReady === '1') return;
    card.dataset.inspectorReady = '1';
    card.classList.add('inspector-card--collapsible');

    const titleEl = card.querySelector('.inspector-card-title');
    const titleText = titleEl?.textContent?.trim() || 'Section';
    const bodyNodes = [...card.childNodes].filter(
      (n) => n !== titleEl && !(n.nodeType === 1 && n.classList?.contains('inspector-card-head')),
    );

    const head = document.createElement('div');
    head.className = 'inspector-card-head';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'inspector-card-toggle';
    toggle.setAttribute('aria-expanded', collapsed[card.dataset.inspectorCard] ? 'false' : 'true');

    const titleSpan = document.createElement('span');
    titleSpan.className = 'inspector-card-title';
    titleSpan.textContent = titleText;

    const chevron = document.createElement('span');
    chevron.className = 'inspector-card-chevron';
    chevron.setAttribute('aria-hidden', 'true');

    toggle.append(titleSpan, chevron);

    const dragHandle = document.createElement('button');
    dragHandle.type = 'button';
    dragHandle.className = 'inspector-card-drag';
    dragHandle.setAttribute('aria-label', `Drag to reorder ${titleText}`);
    dragHandle.innerHTML = '<span class="inspector-drag-grip" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>';

    head.append(toggle, dragHandle);

    const body = document.createElement('div');
    body.className = 'inspector-card-body';
    bodyNodes.forEach((node) => body.appendChild(node));
    if (titleEl) titleEl.remove();

    card.replaceChildren(head, body);

    const cardId = card.dataset.inspectorCard;
    const setCollapsed = (isCollapsed) => {
      collapsed[cardId] = isCollapsed;
      card.classList.toggle('is-collapsed', isCollapsed);
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      saveInspectorCardCollapsed(collapsed);
    };

    setCollapsed(!!collapsed[cardId]);

    toggle.addEventListener('click', () => setCollapsed(!collapsed[cardId]));
  });

  bindInspectorCardDrag(host, (newOrder) => {
    order = newOrder;
    onOrderChange?.(newOrder);
  });
}

export function createEditHistory(max = 8) {
  const entries = [];

  return {
    push(label, path) {
      if (!label) return;
      entries.unshift({ label, path, time: Date.now() });
      if (entries.length > max) entries.length = max;
    },
    render(container) {
      if (!container) return;
      container.replaceChildren();
      if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'edit-history-empty';
        empty.textContent = 'Slider changes will appear here during this session.';
        container.appendChild(empty);
        return;
      }
      entries.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'edit-history-row';
        const label = document.createElement('span');
        label.textContent = entry.label;
        const time = document.createElement('time');
        time.dateTime = new Date(entry.time).toISOString();
        time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        row.append(label, time);
        container.appendChild(row);
      });
    },
  };
}
