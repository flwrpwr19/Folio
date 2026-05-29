let activeToasts = [];
let playUISound = () => {};

export function initToast({ playSound } = {}) {
  if (playSound) playUISound = playSound;
}

export function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const isError = /fail|error|denied/i.test(String(message));
  const toast = document.createElement('div');
  toast.className = 'folio-toast' + (isError ? ' folio-toast-error' : '');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'folio-toast-icon');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  if (isError) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '10');
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', '12'); line1.setAttribute('y1', '8'); line1.setAttribute('x2', '12'); line1.setAttribute('y2', '12');
    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', '12'); line2.setAttribute('y1', '16'); line2.setAttribute('x2', '12.01'); line2.setAttribute('y2', '16');
    icon.append(circle, line1, line2);
  } else {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M22 11.08V12a10 10 0 1 1-5.93-9.14');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', '22 4 12 14.01 9 11.01');
    icon.append(path, poly);
  }
  const label = document.createElement('span');
  label.className = 'folio-toast-text';
  label.textContent = String(message);
  toast.append(icon, label);
  container.prepend(toast);
  activeToasts.unshift(toast);
  playUISound(isError ? 'error' : 'success');

  setTimeout(() => {
    toast.classList.add('folio-toast-out');
    setTimeout(() => {
      activeToasts = activeToasts.filter((t) => t !== toast);
      toast.remove();
    }, 320);
  }, 3200);
}
