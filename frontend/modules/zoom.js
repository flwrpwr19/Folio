/**
 * Viewer wheel zoom — rAF-coalesced steps for mouse wheel, trackpad, and Shift+scroll.
 */

let wheelAccum = 0;
let wheelFocalX = 0;
let wheelFocalY = 0;
let wheelRaf = 0;
let getZoom = () => 1;
let setZoom = () => {};
let getZoomSens = () => 5;

export function initZoomController(config) {
  getZoom = config.getZoom;
  setZoom = config.setZoom;
  getZoomSens = config.getZoomSens;
}

function flushWheelZoom() {
  wheelRaf = 0;
  const delta = wheelAccum;
  wheelAccum = 0;
  if (!delta) return;

  const sens = 0.4 + (getZoomSens() / 10) * 1.1;
  const magnitude = Math.min(Math.abs(delta), 320);
  const factor = Math.pow(1.22, (-Math.sign(delta) * magnitude / 70) * sens);
  setZoom(getZoom() * factor, wheelFocalX, wheelFocalY, { snapToFit: false, fromWheel: true });
}

/** Coalesce rapid wheel events into one smooth zoom step per frame. */
export function queueWheelZoom(delta, focalX, focalY) {
  wheelAccum += delta;
  wheelFocalX = focalX;
  wheelFocalY = focalY;
  if (!wheelRaf) wheelRaf = requestAnimationFrame(flushWheelZoom);
}
