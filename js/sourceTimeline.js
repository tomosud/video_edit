// sourceTimeline.js - zoomable, multi-clip source timeline
import { store, uid } from './store.js?v=20260707-horizontal-crop';
import { generateWindow, spacing } from './thumbnails.js?v=20260707-horizontal-crop';
import { fmtTime, frameFromTime, frameStartTime, makeFrameScrubber, seekVideoFrame } from './util.js?v=20260707-horizontal-crop';

const FOCUS_MARGIN = 0.3;        // extra view beyond a selected clip (fraction of clip len)
const REGEN_DEBOUNCE = 140;

let els, video;
let curSourceId = null;
let duration = 0;
let fps = 30;
let regenTimer = 0;
let renderToken = { cancelled: false };
let overviewToken = { cancelled: false };
let renderedWin = null;          // window the current thumbnail DOM was built for
let scrub = () => {};            // fast scrubber bound to the preview video
let playRaf = 0;                 // rAF id for smooth playhead while playing

export function init(elements, videoEl) {
  els = elements;
  video = videoEl;
  scrub = makeFrameScrubber(video, () => fps, () => duration);

  els.scroll.addEventListener('wheel', onWheel, { passive: false });
  els.inner.addEventListener('pointerdown', onInnerDown);
  els.inner.addEventListener('dblclick', onInnerDblClick);
  els.inner.addEventListener('contextmenu', (e) => e.preventDefault()); // allow right-drag pan
  els.playhead.addEventListener('pointerdown', onPlayheadDown);
  els.playhead.addEventListener('dblclick', (e) => { e.stopPropagation(); onInnerDblClick(e); });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', () => { layout(); scheduleRegen(); scheduleOverviewRegen(); });

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
const frameOf = (t) => frameFromTime(t, fps, Math.max(0, Math.round(duration * fps) - 1));
const previewAt = (t) => scrub(frameOf(t));
const seekPreviewAt = (t) => seekVideoFrame(video, frameOf(t), fps, duration);
const materialLen = (m) => Math.max(0, m.out - m.in);

function editingIds() {
  const ids = Array.isArray(store.ui.editMaterialIds) ? store.ui.editMaterialIds : [];
  if (ids.length) return new Set(ids);
  return store.ui.editMaterialId ? new Set([store.ui.editMaterialId]) : new Set();
}

function setEditingMaterials(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  store.setUI({ editMaterialIds: unique, editMaterialId: unique[0] || null });
}

function materialsAtTime(t) {
  const eps = Math.max(1e-6, 1 / fps / 8);
  return store.get().materials
    .filter(m => m.sourceId === curSourceId && t >= m.in - eps && t < m.out + eps)
    .sort((a, b) => materialLen(a) - materialLen(b));
}

function shortestMaterial(items) {
  return [...items].sort((a, b) => materialLen(a) - materialLen(b))[0] || null;
}

// ---------- state sync ----------
function onState(project, ui) {
  const src = store.activeSource();
  if (!src) {
    curSourceId = null;
    els.thumbRow.innerHTML = '';
    if (els.ovThumbRow) els.ovThumbRow.innerHTML = '';
    els.bands.innerHTML = '';
    return;
  }

  if (src.id !== curSourceId) {
    curSourceId = src.id;
    duration = src.duration || 0;
    fps = src.fps || 30;
    store.ui.view = { start: 0, end: duration || 1 };
    regenNow();
    regenOverviewNow();
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

  const t = clampT(xToTime(e.clientX));
  const hits = materialsAtTime(t);
  if (hits.length) {
    const band = e.target.closest('.clip-band');
    const target = band ? store.getMaterial(band.dataset.id) : null;
    const editing = editingIds();
    const handleHit = target && editing.has(target.id) && e.target.classList.contains('h');
    const m = handleHit ? target : shortestMaterial(hits);
    if (!m) return;
    store.ui._fromTimeline = true;                // don't auto-focus the view
    store.select('material', m.id);               // left-click selects
    seekFromClientX(e.clientX);
    if (!editing.has(m.id)) {
      gesture = null;
      e.preventDefault();
      return;
    }
    if (handleHit) {
      const edge = e.target.classList.contains('l') ? 'in' : 'out';
      gesture = { type: 'resize', id: m.id, edge, started: false };
    } else {
      gesture = { type: 'move', id: m.id, grabDT: t - m.in, started: false };
    }
    e.preventDefault();
    return;
  }

  // left-click on empty area -> move preview/playhead without editing
  store.select(null, null);
  gesture = null;
  seekFromClientX(e.clientX);
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
    previewAt(nin);                   // follow the clip's IN edge while moving
    layout();
  } else if (gesture.type === 'resize') {
    const t = snapT(xToTime(e.clientX));
    store.updateLive(() => {
      if (gesture.edge === 'in') m.in = Math.min(t, m.out - 1 / fps);
      else m.out = Math.max(t, m.in + 1 / fps);
    });
    previewAt(gesture.edge === 'in' ? m.in : outPreviewT(m));   // OUT shows the last in-range frame
    layout();
  }
}

function onPointerUp(e) {
  if (playheadDrag) {
    playheadDrag = false;
    try { els.playhead.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const t = snapT(xToTime(e.clientX));
    if (video.readyState >= 1) seekPreviewAt(t);
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
      seekPreviewAt(gesture.edge === 'in' ? m.in : outPreviewT(m));
    }
  }
  gesture = null;
}

function seekFromClientX(clientX) {
  const t = snapT(xToTime(clientX));
  previewAt(t);
  positionPlayhead(frameStartTime(frameOf(t), fps));
}

// Double-click band -> enter edit mode.
// Double-click empty:
//   - while editing: leave edit mode
//   - otherwise: create a clip one displayed-frame (cell) wide and edit it.
// Does NOT change zoom/view.
function onInnerDblClick(e) {
  if (!duration) return;
  const t = clampT(xToTime(e.clientX));
  const hits = materialsAtTime(t);
  if (hits.length) {
    const priority = shortestMaterial(hits);
    store.ui._fromTimeline = true;
    store.select('material', priority.id);
    setEditingMaterials(hits.map(m => m.id));
    seekFromClientX(e.clientX);
    e.preventDefault();
    return;
  }
  if (editingIds().size) {
    setEditingMaterials([]);
    seekFromClientX(e.clientX);
    return;
  }
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
    crop: { ...(ui.crop || { panX: .5, panY: .5, zoom: 1, bgBlur: 1 }) },
    horizontalCrop: { ...(ui.horizontalCrop || { panX: .5, panY: .5, zoom: 1, bgBlur: 1 }) },
  }));
  store.ui._fromTimeline = true;                 // creating shouldn't move the view
  store.select('material', id);
  setEditingMaterials([id]);
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

function scheduleOverviewRegen() {
  clearTimeout(overviewTimer);
  overviewTimer = setTimeout(regenOverviewNow, REGEN_DEBOUNCE);
}

let overviewTimer = 0;
async function regenOverviewNow() {
  if (!els.ovThumbRow) return;
  const src = store.activeSource();
  if (!src || !duration) return;
  overviewToken.cancelled = true;
  overviewToken = { cancelled: false };
  await generateWindow(src, { start: 0, end: duration || 1 }, els.ovThumbRow, { fps, token: overviewToken });
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
    els.range.textContent = duration ? `${fmtTime(view().start)} - ${fmtTime(view().end)} (total ${fmtTime(duration)})` : '-';
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
  const editSet = editingIds();
  const mats = store.get().materials.filter(m => m.sourceId === curSourceId);
  els.bands.innerHTML = '';
  for (const m of mats) {
    const x1 = timeToX(m.in), x2 = timeToX(m.out);
    if (x2 < 0 || x1 > W) continue; // off-screen
    const el = document.createElement('div');
    el.className = 'clip-band' +
      (m.id === selMat ? ' selected' : '') +
      (editSet.has(m.id) ? ' editing' : '');
    el.dataset.id = m.id;
    el.style.left = x1 + 'px';
    el.style.width = Math.max(2, x2 - x1) + 'px';
    const visibleLeft = Math.max(0, x1);
    const visibleRight = Math.min(W, x2);
    const labelX = Math.max(0, Math.min(Math.max(2, x2 - x1), (visibleLeft + visibleRight) / 2 - x1));
    el.style.setProperty('--edit-label-x', labelX + 'px');
    el.innerHTML =
      `<div class="h l"></div><div class="lbl">${fmtTime(m.out - m.in)}</div><div class="h r"></div>`;
    els.bands.appendChild(el);
  }
}

function positionPlayhead(t) {
  if (!video) return;
  const cur = t ?? frameStartTime(frameFromTime(video.currentTime, fps), fps);
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

