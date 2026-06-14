// sourceTimeline.js — zoomable, multi-clip source timeline
import { store, uid } from './store.js';
import { generateWindow, spacing } from './thumbnails.js';
import { fmtTime } from './util.js';

const FOCUS_MARGIN = 0.3;        // extra view beyond a selected clip (fraction of clip len)
const REGEN_DEBOUNCE = 140;

let els, video;
let curSourceId = null;
let duration = 0;
let fps = 30;
let regenTimer = 0;
let renderToken = { cancelled: false };

export function init(elements, videoEl) {
  els = elements;
  video = videoEl;

  els.scroll.addEventListener('wheel', onWheel, { passive: false });
  els.inner.addEventListener('pointerdown', onInnerDown);
  els.inner.addEventListener('dblclick', onInnerDblClick);
  els.inner.addEventListener('contextmenu', (e) => e.preventDefault()); // allow right-drag pan
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', () => { layout(); scheduleRegen(); });

  video.addEventListener('timeupdate', positionPlayhead);
  video.addEventListener('seeked', positionPlayhead);

  store.subscribe(onState);
}

function view() { return store.ui.view; }
function span() { return Math.max(1e-4, view().end - view().start); }
function innerW() { return els.inner.clientWidth || 1; }
function timeToX(t) { return (t - view().start) / span() * innerW(); }
function xToTime(clientX) {
  const rect = els.inner.getBoundingClientRect();
  return view().start + ((clientX - rect.left) / innerW()) * span();
}
const clampT = (t) => Math.max(0, Math.min(duration, t));

// ---------- state sync ----------
function onState(project, ui) {
  const src = store.activeSource();
  if (!src) { curSourceId = null; els.thumbRow.innerHTML = ''; els.bands.innerHTML = ''; return; }

  if (src.id !== curSourceId) {
    curSourceId = src.id;
    duration = src.duration || 0;
    fps = src.fps || 30;
    store.ui.view = { start: 0, end: duration || 1 };
    regenNow();
  }
  layout();
}

// ---------- zoom (wheel) ----------
function onWheel(e) {
  if (!duration) return;
  e.preventDefault();
  const tc = clampT(xToTime(e.clientX));
  const factor = Math.exp(e.deltaY * 0.0015);
  const minSpan = Math.max(2 / fps, 0.04);          // down to ~2 frames
  let newSpan = Math.min(duration, Math.max(minSpan, span() * factor));
  let start = tc - (tc - view().start) * (newSpan / span());
  let end = start + newSpan;
  if (start < 0) { start = 0; end = newSpan; }
  if (end > duration) { end = duration; start = end - newSpan; }
  store.ui.view = { start: Math.max(0, start), end: Math.min(duration, end) };
  layout();
  scheduleRegen();
}

// ---------- pointer gestures ----------
// left button : click band = select; drag selected band = move; drag handle = resize
// right button: drag anywhere = pan the view window
// (clip creation is on double-click of empty area; see onInnerDblClick)
let gesture = null;

function onInnerDown(e) {
  if (!duration) return;

  // right button anywhere -> pan
  if (e.button === 2) {
    e.preventDefault();
    gesture = { type: 'pan', startX: e.clientX, startView: { ...view() } };
    return;
  }
  if (e.button !== 0) return;

  const band = e.target.closest('.clip-band');
  if (band) {
    const id = band.dataset.id;
    store.ui._fromTimeline = true;                // don't auto-focus the view
    store.select('material', id);                 // left-click selects
    const m = store.getMaterial(id);
    if (e.target.classList.contains('h')) {
      const edge = e.target.classList.contains('l') ? 'in' : 'out';
      gesture = { type: 'resize', id, edge, started: false };
    } else {
      gesture = { type: 'move', id, grabDT: xToTime(e.clientX) - m.in, started: false };
    }
    e.preventDefault();
    return;
  }

  // left-click on empty area -> just deselect (no creation, no pan)
  store.select(null, null);
  gesture = null;
}

function onPointerMove(e) {
  if (!gesture) return;

  if (gesture.type === 'pan') {
    const dt = ((e.clientX - gesture.startX) / innerW()) * (gesture.startView.end - gesture.startView.start);
    let start = gesture.startView.start - dt;
    let end = gesture.startView.end - dt;
    const s = end - start;
    if (start < 0) { start = 0; end = s; }
    if (end > duration) { end = duration; start = end - s; }
    store.ui.view = { start, end };
    layout();
    scheduleRegen();
    return;
  }

  // move / resize operate only on the selected clip; commit one undo on first move
  if (!gesture.started) { store.beginAction(); gesture.started = true; }
  const m = store.getMaterial(gesture.id);
  if (!m) { gesture = null; return; }

  if (gesture.type === 'move') {
    const len = m.out - m.in;
    let nin = clampT(xToTime(e.clientX) - gesture.grabDT);
    let nout = nin + len;
    if (nout > duration) { nout = duration; nin = duration - len; }
    store.updateLive(() => { m.in = nin; m.out = nout; });
    layout();
  } else if (gesture.type === 'resize') {
    const t = clampT(xToTime(e.clientX));
    store.updateLive(() => {
      if (gesture.edge === 'in') m.in = Math.min(t, m.out - 1 / fps);
      else m.out = Math.max(t, m.in + 1 / fps);
    });
    layout();
  }
}

function onPointerUp() { gesture = null; }

// double-click on empty area -> create a clip one displayed-frame (cell) wide.
// Does NOT change zoom/view.
function onInnerDblClick(e) {
  if (!duration) return;
  if (e.target.closest('.clip-band')) return; // band dbl-click = play (handled per band)
  const t = clampT(xToTime(e.clientX));
  const count = Math.max(6, Math.round(innerW() / spacing()));
  const cellDur = Math.max(1 / fps, span() / count);
  let nin = clampT(t - cellDur / 2);
  let nout = clampT(nin + cellDur);
  if (nout <= nin) nin = clampT(nout - cellDur);
  const id = uid('mat');
  store.update((p) => p.materials.push({ id, sourceId: curSourceId, in: nin, out: nout }));
  store.ui._fromTimeline = true;                 // creating shouldn't move the view
  store.select('material', id);
}

// ---------- focus to a selected material ----------
export function focusMaterial(m) {
  if (!m || m.sourceId !== curSourceId) return;
  const len = Math.max(0.1, m.out - m.in);
  const margin = len * FOCUS_MARGIN;
  store.ui.view = { start: clampT(m.in - margin), end: clampT(m.out + margin) };
  layout();
  scheduleRegen();
}

// ---------- thumbnails ----------
function scheduleRegen() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regenNow, REGEN_DEBOUNCE);
}
async function regenNow() {
  const src = store.activeSource();
  if (!src) return;
  renderToken.cancelled = true;
  renderToken = { cancelled: false };
  await generateWindow(src, view(), els.thumbRow, { fps, token: renderToken });
}

// ---------- layout (bands + playhead + range label) ----------
function layout() {
  renderBands();
  positionPlayhead();
  if (els.range) {
    els.range.textContent = duration ? `${fmtTime(view().start)} – ${fmtTime(view().end)}（全 ${fmtTime(duration)}）` : '—';
  }
}

function selectedMaterialId() {
  const sel = store.ui.selection;
  if (!sel.kind) return null;
  if (sel.kind === 'material') return sel.id;
  const o = store.getOutput(sel.id);
  return o ? o.materialId : null;
}

function renderBands() {
  const W = innerW();
  const selMat = selectedMaterialId();
  const mats = store.get().materials.filter(m => m.sourceId === curSourceId);
  els.bands.innerHTML = '';
  for (const m of mats) {
    const x1 = timeToX(m.in), x2 = timeToX(m.out);
    if (x2 < 0 || x1 > W) continue; // off-screen
    const el = document.createElement('div');
    el.className = 'clip-band' + (m.id === selMat ? ' selected' : '');
    el.dataset.id = m.id;
    el.style.left = x1 + 'px';
    el.style.width = Math.max(2, x2 - x1) + 'px';
    el.innerHTML =
      `<div class="h l"></div><div class="lbl">${fmtTime(m.out - m.in)}</div><div class="h r"></div>`;
    el.addEventListener('dblclick', () => playRange(m.in, m.out));
    els.bands.appendChild(el);
  }
}

function positionPlayhead() {
  if (!video) return;
  const x = timeToX(video.currentTime);
  els.playhead.style.left = x + 'px';
  els.playhead.style.display = (x < 0 || x > innerW()) ? 'none' : 'block';
}

// ---------- ranged playback hook (set by app) ----------
let _playRange = () => {};
export function onPlayRange(fn) { _playRange = fn; }
function playRange(a, b) { _playRange(a, b); }
