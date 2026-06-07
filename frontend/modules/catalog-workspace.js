/** Catalog workspace helpers (command bar, filters, keyboard grid). */

export const CATALOG_FILTER_LABELS = {
  '': 'All Photos',
  favorites: 'Favorites',
  rated: 'Rated 3+',
  videos: 'Videos',
  gps: 'GPS',
  raw: 'RAW / HEIC',
  duplicates: 'Duplicates',
};

export function catalogFilterLabel(filterKey) {
  return CATALOG_FILTER_LABELS[filterKey] ?? 'All Photos';
}

export function createCatalogKeyboardNav({
  getVisibleItems,
  getFocusIndex,
  setFocusIndex,
  getSelection,
  setSelection,
  isSelectionMode,
  onOpenItem,
  onRebuild,
  scrollCardIntoView,
}) {
  function moveFocus(delta, extendRange = false) {
    const visible = getVisibleItems();
    if (!visible.length) return;
    let next = getFocusIndex();
    if (next < 0) next = 0;
    else next = Math.max(0, Math.min(visible.length - 1, next + delta));
    setFocusIndex(next);
    const { item } = visible[next];
    if (extendRange || isSelectionMode()) {
      setSelection((sel) => {
        const nextSel = new Set(sel);
        nextSel.add(item.path);
        return nextSel;
      });
    }
    scrollCardIntoView(item.path);
    onRebuild();
  }

  function handleKeydown(e) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(e.key)
      && !(e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey))) {
      return false;
    }
    const visible = getVisibleItems();
    if (!visible.length) return false;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelection(new Set(visible.map(({ item }) => item.path)));
      onRebuild();
      return true;
    }

    const cols = Math.max(1, estimateCatalogColumns());
    if (e.key === 'ArrowRight') { e.preventDefault(); moveFocus(1, e.shiftKey); return true; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveFocus(-1, e.shiftKey); return true; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(cols, e.shiftKey); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-cols, e.shiftKey); return true; }
    if (e.key === 'Home') { e.preventDefault(); setFocusIndex(0); scrollCardIntoView(visible[0].item.path); onRebuild(); return true; }
    if (e.key === 'End') {
      e.preventDefault();
      const last = visible.length - 1;
      setFocusIndex(last);
      scrollCardIntoView(visible[last].item.path);
      onRebuild();
      return true;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const idx = getFocusIndex();
      if (idx < 0 || idx >= visible.length) return false;
      e.preventDefault();
      const { itemIndex } = visible[idx];
      if (isSelectionMode() || e.shiftKey || e.metaKey || e.ctrlKey) {
        setSelection((sel) => {
          const nextSel = new Set(sel);
          const path = visible[idx].item.path;
          if (nextSel.has(path)) nextSel.delete(path);
          else nextSel.add(path);
          return nextSel;
        });
        onRebuild();
      } else {
        onOpenItem(itemIndex);
      }
      return true;
    }
    return false;
  }

  function estimateCatalogColumns() {
    const grid = document.getElementById('catalogContent');
    if (!grid) return 4;
    const card = grid.querySelector('.catalog-card:not(.hidden-by-filter)');
    if (!card) return 4;
    const gridRect = grid.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(grid).columnGap || getComputedStyle(grid).gap) || 8;
    return Math.max(1, Math.floor((gridRect.width + gap) / (cardRect.width + gap)));
  }

  return { handleKeydown, moveFocus };
}

export function bindCatalogOverflowMenu({ menu, trigger, onAction }) {
  if (!menu || !trigger) return () => {};

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const positionMenu = () => {
    const rect = trigger.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
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

  menu.querySelectorAll('[data-catalog-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.catalogAction;
      close();
      onAction(action);
    });
  });

  const onDoc = (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== trigger) close();
  };
  document.addEventListener('click', onDoc);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      e.stopPropagation();
      close();
    }
  });

  return close;
}

export function syncCatalogDensityUi(size) {
  document.querySelectorAll('.catalog-density-btn').forEach((btn) => {
    btn.classList.toggle('active', parseInt(btn.dataset.density, 10) === size);
  });
  const slider = document.getElementById('catalogDensitySlider');
  if (slider) slider.value = String(size);
}
