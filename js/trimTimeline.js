// trimTimeline.js - source strip: IN/OUT handles, playhead, zoom, click-to-seek
import { store } from './store.js?v=20260627-nativepreview3';
import { generateStrip } from './thumbnails.js?v=20260627-nativepreview3';

let els, video;
let duration = 0;
let dragging = null; // 'in' | 'out' | null
let curSourceId = null;

export function init(elements, videoEl) {
  els = elements;
  video = videoEl;

  els.stripZoom.addEventListener('input', () => { applyZoom(); layout(); });
  els.scroll.addEventListener('scroll', () => positionElements());

  els.trimIn.addEventListener('pointerdown', startDrag('in'));
  els.trimOut.addEventListener('pointerdown', startDrag('out'));
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag);

  // click on strip to seek
  els.inner.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.trim-handle')) return;
    const t = xToTime(e.clientX);
    if (video) video.currentTime = t;
  });

  video.addEventListener('timeupdate', positionPlayhead);
  video.addEventListener('seeked', positionPlayhead);

  store.subscribe(onState);
}

function onState(project, ui) {
  const src = store.activeSource();
  if (!src) { clear(); return; }
  if (src.id !== curSourceId) {
    curSourceId = src.id;
    duration = src.duration || 0;
    // init trim draft for this source
    if (ui.trimIn == null || ui._trimFor !== src.id) {
      store.setUI({ trimIn: 0, trimOut: Math.min(duration, 15), _trimFor: src.id });
    }
    buildThumbs(src);
  }
  layout();
}

async function buildThumbs(src) {
  applyZoom();
  await generateStrip(src, els.thumbRow);
  layout();
}

function clear() {
  curSourceId = null;
  els.thumbRow.innerHTML = '';
}

// ---- zoom / sizing ----
function applyZoom() {
  const z = parseFloat(els.stripZoom.value) || 1;
  els.inner.style.width = (els.scroll.clientWidth * z) + 'px';
}

function innerWidth() { return els.inner.clientWidth || els.scroll.clientWidth; }

function timeToX(t) { return duration ? (t / duration) * innerWidth() : 0; }
function xToTime(clientX) {
  const rect = els.inner.getBoundingClientRect();
  const x = clientX - rect.left;
  return duration ? Math.max(0, Math.min(duration, (x / innerWidth()) * duration)) : 0;
}

// ---- layout (handles + range) ----
function layout() {
  const { trimIn = 0, trimOut = 0 } = store.ui;
  const xIn = timeToX(trimIn);
  const xOut = timeToX(trimOut);
  els.trimIn.style.left = (xIn - 12) + 'px';
  els.trimOut.style.left = xOut + 'px';
  els.trimRange.style.left = xIn + 'px';
  els.trimRange.style.width = Math.max(0, xOut - xIn) + 'px';
  positionPlayhead();
}

function positionElements() { layout(); }

function positionPlayhead() {
  if (!video) return;
  els.playhead.style.left = timeToX(video.currentTime) + 'px';
}

// ---- dragging trim handles ----
function startDrag(which) {
  return (e) => { dragging = which; e.preventDefault(); };
}
function onDrag(e) {
  if (!dragging) return;
  const t = xToTime(e.clientX);
  const { trimIn = 0, trimOut = 0 } = store.ui;
  if (dragging === 'in') {
    store.setUI({ trimIn: Math.min(t, trimOut - 0.1) });
  } else {
    store.setUI({ trimOut: Math.max(t, trimIn + 0.1) });
  }
  layout();
}
function endDrag() {
  if (dragging) {
    dragging = null;
    // commit a history entry on drop (snapshot of project is unchanged here;
    // Trim draft lives in UI, so no project mutation and nothing to undo yet.
  }
}

// ---- public API ----
export function getTrim() {
  return { in: store.ui.trimIn || 0, out: store.ui.trimOut || 0 };
}
export function setIn() {
  if (!video) return;
  store.setUI({ trimIn: Math.min(video.currentTime, (store.ui.trimOut || duration) - 0.1) });
  layout();
}
export function setOut() {
  if (!video) return;
  store.setUI({ trimOut: Math.max(video.currentTime, (store.ui.trimIn || 0) + 0.1) });
  layout();
}
