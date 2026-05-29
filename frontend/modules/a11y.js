/** UX-9: focus rings and keyboard affordances */

export function initA11y() {
  document.body.classList.add('folio-a11y');
}

export function trapFocus(container) {
  if (!container) return () => {};
  const focusable = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const onKey = (e) => {
    if (e.key !== 'Tab' || focusable.length === 0) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  container.addEventListener('keydown', onKey);
  first?.focus();
  return () => container.removeEventListener('keydown', onKey);
}
