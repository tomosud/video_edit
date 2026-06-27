// sourceTimeline.js — zoomable, multi-clip source timeline
import { store, uid } from './store.js?v=20260627-nativepreview3';
import { generateWindow, spacing } from './thumbnails.js?v=20260627-nativepreview3';
import { fmtTime, makeScrubber } from './util.js?v=20260627-nativepreview3';

const FOCUS_MARGIN = 0.3;        // extra view beyond a selected clip (fraction of clip len)
const REGEN_DEBOUNCE = 140;

let els, video;
let curSourceId = null;
let duration = 0;
let fps = 30;
let regenTimer = 0;
let renderToken = { cancelled: false };
let renderedWin = null;          // window the current thumbnail DOM was built for
let scrub = () => {};            // fast scrubber bound to the preview video
let playRaf = 0;                 // rAF id for smooth playhead while playing

export function init(elements, videoEl) {
  els = elements;
  video = videoEl;
  scrub = makeScrubber(video);

  els.scroll.addEventListener('wheel', onWheel, { passive: false });
  els.inner.addEventListener('pointerdown', onInnerDown);
  els.inner.addEventListener('dblclick', onInnerDblClick);
  els.inner.addEventListener('contextmenu', (e) => e.preventDefault()); // allow right-drag pan
  els.playhead.addEventListener('pointerdown', onPlayheadDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', () => { layout(); scheduleRegen(); });

  if (els.overview) els.overview.addEventListener('pointerdown', onOverviewDown);

  video.addEventListener('timeupdate', positionPlayhead);
  video.addEventListener('seeked', positionPlayhead);
  video.addEventListener('play', startPlayhead);
  video.addEventListener('pause', stopPlayhead);
  video.addEventListener('ended', stopPlayhead);

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
// snap a time to the nearest exact frame boundary (precise, reproducible clips)
const snapT = (t) => clampT(Math.round(t * fps) / fps);
const frameDur = () => 1 / fps;
const outPreviewT = (m) => clampT(Math.max(m.in, m.out - frameDur()));

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
let playheadDrag = false;

function onPlayheadDown(e) {
  if (!duration || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  playheadDrag = true;
  try { els.playhead.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  store.setUI({ playRange: null });
  seekFromClientX(e.clientX);
}

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
  if (playheadDrag) { seekFromClientX(e.clientX); return; }
  if (ovDrag) { overviewSeek(e); return; }
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
    let nin = snapT(xToTime(e.clientX) - gesture.grabDT);
    let nout = nin + len;
    if (nout > duration) { nout = duration; nin = duration - len; }
    store.updateLive(() => { m.in = nin; m.out = nout; });
    scrub(nin);                       // follow the clip's IN edge while moving
    layout();
  } else if (gesture.type === 'resize') {
    const t = snapT(xToTime(e.clientX));
    store.updateLive(() => {
      if (gesture.edge === 'in') m.in = Math.min(t, m.out - 1 / fps);
      else m.out = Math.max(t, m.in + 1 / fps);
    });
    scrub(gesture.edge === 'in' ? m.in : outPreviewT(m));   // OUT shows the last in-range frame
    layout();
  }
}

function onPointerUp(e) {
  if (playheadDrag) {
    playheadDrag = false;
    try { els.playhead.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const t = snapT(xToTime(e.clientX));
    if (video.readyState >= 1) { try { video.currentTime = t; } catch { /* ignore */ } }
    return;
  }
  if (ovDrag) {
    ovDrag = false;
    try { els.overview.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    scheduleRegen();
    return;
  }
  // settle preview exactly on the dragged edge after an edge trim
  if (gesture && gesture.type === 'resize' && gesture.started) {
    const m = store.getMaterial(gesture.id);
    if (m && video.readyState >= 1) {
      try { video.currentTime = gesture.edge === 'in' ? m.in : outPreviewT(m); } catch { /* ignore */ }
    }
  }
  gesture = null;
}

function seekFromClientX(clientX) {
  const t = snapT(xToTime(clientX));
  scrub(t);
  positionPlayhead(t);
}

// double-click on empty area -> create a clip one displayed-frame (cell) wide.
// Does NOT change zoom/view.
function onInnerDblClick(e) {
  if (!duration) return;
  if (e.target.closest('.clip-band')) return; // band dbl-click = play (handled per band)
  const t = clampT(xToTime(e.clientX));
  const count = Math.max(6, Math.round(innerW() / spacing()));
  const cellDur = Math.max(1 / fps, span() / count);
  let nin = snapT(t - cellDur / 2);
  let nout = snapT(nin + cellDur);
  if (nout <= nin) { nout = snapT(nin + Math.max(1 / fps, cellDur)); }
  const id = uid('mat');
  store.update((p, ui) => p.materials.push({
    id,
    sourceId: curSourceId,
    in: nin,
    out: nout,
    crop: { ...(ui.crop || { panX: .5, panY: .5, zoom: 1 }) },
  }));
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
  // skeleton is rebuilt for the current view synchronously inside generateWindow,
  // so snap the thumb layer back to identity and remember the rendered window.
  renderedWin = { ...view() };
  els.thumbRow.style.transform = '';
  await generateWindow(src, view(), els.thumbRow, { fps, token: renderToken });
}

// While zooming/panning, instantly track the gesture by transforming the
// already-rendered thumbnails until the real regen settles (no blank flash).
function applyThumbTransform() {
  if (!renderedWin) { els.thumbRow.style.transform = ''; return; }
  const v = view();
  const curSpan = Math.max(1e-4, v.end - v.start);
  const renSpan = Math.max(1e-4, renderedWin.end - renderedWin.start);
  const scale = renSpan / curSpan;
  const tx = (renderedWin.start - v.start) / curSpan * innerW();
  els.thumbRow.style.transform =
    (Math.abs(scale - 1) < 1e-4 && Math.abs(tx) < 0.5) ? '' : `translateX(${tx}px) scaleX(${scale})`;
}

// ---------- layout (bands + playhead + range label) ----------
function layout() {
  applyThumbTransform();
  renderBands();
  renderOverview();
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

function positionPlayhead(t) {
  if (!video) return;
  const cur = t ?? video.currentTime;
  const x = timeToX(cur);
  els.playhead.style.left = x + 'px';
  els.playhead.style.display = (x < 0 || x > innerW()) ? 'none' : 'block';
  if (els.ovPlayhead && duration) els.ovPlayhead.style.left = (cur / duration * 100) + '%';
}

// smooth playhead during playback (timeupdate alone fires ~4x/sec)
function startPlayhead() { if (!playRaf) playheadLoop(); }
function stopPlayhead() { cancelAnimationFrame(playRaf); playRaf = 0; positionPlayhead(); }
function playheadLoop() { positionPlayhead(); playRaf = requestAnimationFrame(playheadLoop); }

// ---------- overview minimap (full source) ----------
function renderOverview() {
  if (!els.overview) return;
  if (!duration) { els.ovClips.innerHTML = ''; els.ovWindow.style.width = '0'; return; }
  const selMat = selectedMaterialId();
  const mats = store.get().materials.filter(m => m.sourceId === curSourceId);
  els.ovClips.innerHTML = mats.map(m => {
    const l = m.in / duration * 100;
    const w = Math.max(0.4, (m.out - m.in) / duration * 100);
    return `<div class="ov-clip${m.id === selMat ? ' selected' : ''}" style="left:${l}%;width:${w}%"></div>`;
  }).join('');
  const v = view();
  els.ovWindow.style.left = (v.start / duration * 100) + '%';
  els.ovWindow.style.width = Math.max(0.5, (v.end - v.start) / duration * 100) + '%';
}

let ovDrag = false;
function onOverviewDown(e) {
  if (!duration) return;
  e.preventDefault();
  ovDrag = true;
  try { els.overview.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  overviewSeek(e);
}
function overviewSeek(e) {
  const rect = els.overview.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / (rect.width || 1)));
  const tc = f * duration;
  const sp = span();
  let start = tc - sp / 2, end = tc + sp / 2;
  if (start < 0) { start = 0; end = sp; }
  if (end > duration) { end = duration; start = end - sp; }
  store.ui.view = { start: Math.max(0, start), end: Math.min(duration, end) };
  layout();
  scheduleRegen();
}

// ---------- ranged playback hook (set by app) ----------
let _playRange = () => {};
export function onPlayRange(fn) { _playRange = fn; }
function playRange(a, b) { _playRange(a, b); }
