// app.js - entry: wire modules, selection side-effects, ranged playback, temporary export
import { store } from './store.js';
import * as fileOpen from './fileOpen.js';
import * as db from './db.js';
import * as cropPreview from './cropPreview.js';
import * as horizontalPreview from './horizontalPreview.js';
import * as srcTimeline from './sourceTimeline.js';
import * as frameStrip from './frameStrip.js';
import * as shelf from './materialShelf.js';
import * as outSeq from './outputSequenceTimeline.js';
import { cardThumb, cloneCanvas } from './thumbnails.js';
import { disposeMediaSessions } from './mediaSession.js';
import { exportProject, downloadBlob } from './export.js';
import { escapeAttr, escapeHtml, fmtTime, frameFromTime, frameProbeTime, makeScrubber, seekVideoFrame } from './util.js';

const $ = (id) => document.getElementById(id);
const el = {};
['btnNewProject','btnAddVideo','sourceSelect','btnUndo','btnRedo',
 'btnExport','status','playInfo','sourcePicker','srcVideo','srcEmpty','origPane','origTime','btnPlay','btnLoop','vertPane','vertCanvas','horizCanvas',
 'panX','panY','zoom','bgBlur','verticalCropReset',
 'sourcePanX','sourcePanY','sourceZoom','sourceBgBlur','sourceCropReset',
 'overlay','overlayMsg','overlayProg',
 'confirm','confirmTitle','confirmMsg','confirmOk','confirmCancel',
 'exportMode','exportModeTitle','exportModeCancel',
 'srcPane','tlScroll','tlInner','thumbRow','clipBands','tlPlayhead','frameStrip','srcRange',
 'tlOverview','ovThumbRow','ovClips','ovWindow','ovPlayhead',
 'seekBar','seekMarks','seekRange','seekFill','seekHead','frameInfo',
 'workPane','shelf','shelfCount','outList','captionEditor','totalDur','btnPlayOut','btnStopOut'].forEach(id => el[id] = $(id));

let activeUrl = null;
let pendingSeek = null;
let lastSelKey = '';
let loopEnabled = true;
let sequence = null;
let transportRaf = 0;
let sequenceAdvancing = false;
let activeArea = 'timeline';
let previewContext = 'source';
const SESSION_LIMIT = 15;
let sourcePickerOpen = false;
let workspaceLayoutManual = false;
const sourceThumbs = new Map();
const sourceThumbBusy = new Set();

function init() {
  // The COOP/COEP service worker was removed (nothing here needs
  // SharedArrayBuffer); unregister any worker left from older versions.
  navigator.serviceWorker?.getRegistrations?.()
    .then(rs => rs.forEach(r => r.unregister()))
    .catch(() => { /* ignore */ });

  cropPreview.init(el.vertCanvas, el.srcVideo, { previewMode: currentPreviewMode });
  horizontalPreview.init(el.horizCanvas, el.srcVideo, { previewMode: currentPreviewMode });
  srcTimeline.init({
    scroll: el.tlScroll, inner: el.tlInner, thumbRow: el.thumbRow,
    bands: el.clipBands, playhead: el.tlPlayhead, range: el.srcRange,
    overview: el.tlOverview, ovThumbRow: el.ovThumbRow, ovClips: el.ovClips, ovWindow: el.ovWindow, ovPlayhead: el.ovPlayhead,
  }, el.srcVideo);
  frameStrip.init(el.frameStrip, el.srcVideo, { sourcePreview: activateSourcePreview });
  shelf.init({ shelf: el.shelf, count: el.shelfCount }, { play: playRange });
  outSeq.init({ list: el.outList, captionEditor: el.captionEditor, total: el.totalDur, video: el.srcVideo }, { play: playOutputFrom, seek: seekOutputTime });
  srcTimeline.onPlayRange(playRange);
  srcTimeline.onSourcePreview(activateSourcePreview);
  store.setSessionMetaProvider(sessionMeta);
  // Autosave failures (quota, blocked storage) must be visible: the user
  // otherwise closes the tab believing the session can be restored.
  store.setPersistErrorHandler((err) => setStatus('Autosave failed: ' + (err?.message || err)));

  wireMenu(); wireSourcePicker(); wireTransport(); wireCrop(); wireShortcuts(); wireSeek(); wireConfirm(); wireAreas(); wireWorkspaceSplitters(); wireVideoDrop();
  store.subscribe(onState);

  bootstrap();
}

async function bootstrap() {
  // Never let a storage failure (blocked IndexedDB, corrupt session, ...)
  // leave the app dead on load; fall back to an empty in-memory edit.
  try {
    const requested = urlSessionId();
    let restored = false;
    if (requested) {
      store.setSessionId(requested);
      restored = await store.restore(requested);
    } else {
      const latest = await db.latestSession().catch(() => null);
      const sessionId = latest?.id || makeSessionId();
      setUrlSession(sessionId);
      store.setSessionId(sessionId);
      restored = latest ? await store.restore(sessionId) : await store.restoreLegacyAutosave();
    }

    if (restored) {
      const mediaRestored = await fileOpen.restoreSavedMedia();
      refreshStateViews();
      setStatus(mediaRestored.length ? 'Restored edit' : 'Restored edit; video files are missing');
    } else {
      await resetTemporaryEdit('Temporary edit ready');
    }
  } catch (err) {
    console.error('bootstrap failed', err);
    await resetTemporaryEdit('Storage unavailable; this edit will not be saved');
  }
  updateChrome();
  updatePlayInfo();
}

// ---------- menu ----------
function wireMenu() {
  el.btnNewProject.onclick = guard(async () => {
    await store.flushSave();
    await db.pruneSessions(SESSION_LIMIT).catch(() => {});
    const choice = await askSessionChoice(await db.listSessions().catch(() => []));
    if (!choice) return;
    if (choice === 'new') await openSession(makeSessionId(), { restore: false });
    else await openSession(choice, { restore: true });
  });
  el.btnAddVideo.onclick = guard(async () => {
    el.btnAddVideo.disabled = true;
    try {
      await fileOpen.addVideo();
    }
    finally { updateChrome(); }
  });
  el.btnUndo.onclick = () => store.undo();
  el.btnRedo.onclick = () => store.redo();
  el.btnExport.onclick = guard(doExport);
  el.sourceSelect.onchange = () => {
    setPreviewContext('source');
    store.setUI({ activeSourceId: el.sourceSelect.value });
  };
}

function wireSourcePicker() {
  document.addEventListener('pointerdown', (e) => {
    if (!sourcePickerOpen || el.sourcePicker.contains(e.target)) return;
    sourcePickerOpen = false;
    renderSourcePicker(store.get(), store.ui);
  });
}

async function resetTemporaryEdit(message) {
  stopSequence();
  try { el.srcVideo.pause(); } catch { /* ignore */ }
  activeUrl = null;
  pendingSeek = null;
  lastSelKey = '';
  fileOpen.clear();
  disposeMediaSessions();
  store.load({ name: defaultSessionName() });
  setStatus(message);
}

async function openSession(sessionId, { restore }) {
  stopSequence();
  try { el.srcVideo.pause(); } catch { /* ignore */ }
  activeUrl = null;
  pendingSeek = null;
  lastSelKey = '';
  fileOpen.clear();
  disposeMediaSessions();
  store.setSessionId(sessionId);
  setUrlSession(sessionId);
  const restored = restore && await store.restore(sessionId);
  if (restored) {
    const mediaRestored = await fileOpen.restoreSavedMedia();
    refreshStateViews();
    setStatus(mediaRestored.length ? 'Session opened' : 'Session opened; video files are missing');
  } else {
    store.load({ name: defaultSessionName() });
    setStatus('New session ready');
  }
  updateChrome();
  updatePlayInfo();
}

function urlSessionId() {
  return new URL(location.href).searchParams.get('session');
}

function setUrlSession(sessionId) {
  const url = new URL(location.href);
  url.searchParams.set('session', sessionId);
  history.replaceState(null, '', url);
}

function makeSessionId() {
  return 'ses_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9));
}

function defaultSessionName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sessionMeta() {
  if (!store.get().outputs.length || !el.horizCanvas?.width || !el.horizCanvas?.height) return {};
  try {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 135;
    const ctx = c.getContext('2d');
    if (!ctx) return {};
    ctx.drawImage(el.horizCanvas, 0, 0, c.width, c.height);
    return { thumbnail: c.toDataURL('image/jpeg', 0.54) };
  } catch {
    return {};
  }
}

function hasWork() {
  const p = store.get();
  return !!(p.sources.length || p.materials.length || p.outputs.length);
}

function wireVideoDrop() {
  const takeFiles = guard(async (files) => {
    const videos = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name || ''));
    if (!videos.length) {
      setStatus('Drop video files on Add Video');
      return;
    }
    await fileOpen.addVideoFiles(videos);
    setStatus(videos.length === 1 ? 'Video added: ' + videos[0].name : 'Videos added: ' + videos.length);
    updateChrome();
  });

  el.btnAddVideo.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.btnAddVideo.classList.add('drop-active');
  });
  el.btnAddVideo.addEventListener('dragleave', () => el.btnAddVideo.classList.remove('drop-active'));
  el.btnAddVideo.addEventListener('drop', (e) => {
    e.preventDefault();
    el.btnAddVideo.classList.remove('drop-active');
    takeFiles(e.dataTransfer.files);
  });
}

// ---------- transport / ranged playback ----------
function wireTransport() {
  el.btnPlay.onclick = () => {
    if (!store.ui.playRange) {
      setPreviewContext('source');
      exitCropEdit();
    }
    stopSequence();
    if (el.srcVideo.paused) el.srcVideo.play();
    else el.srcVideo.pause();
  };
  el.btnLoop.onclick = () => { loopEnabled = !loopEnabled; el.btnLoop.style.color = loopEnabled ? 'var(--accent)' : ''; };
  el.srcVideo.addEventListener('play', () => el.btnPlay.textContent = '⏸ Pause');
  el.srcVideo.addEventListener('pause', () => el.btnPlay.textContent = '▶ Play');
  el.srcVideo.addEventListener('play', startTransportMonitor);
  el.srcVideo.addEventListener('pause', stopTransportMonitor);
  el.srcVideo.addEventListener('ended', stopTransportMonitor);
  el.srcVideo.addEventListener('play', updateOutputTransport);
  el.srcVideo.addEventListener('pause', updateOutputTransport);
  el.srcVideo.addEventListener('play', updatePlayInfo);
  el.srcVideo.addEventListener('pause', updatePlayInfo);
  el.srcVideo.addEventListener('ended', updatePlayInfo);
  el.srcVideo.addEventListener('timeupdate', () => {
    el.origTime.textContent = fmtTime(el.srcVideo.currentTime) + ' / ' + fmtTime(el.srcVideo.duration);
    updatePlayInfo();
  });
  el.btnLoop.style.color = 'var(--accent)';

  el.btnPlayOut.onclick = playOutputs;
  el.btnStopOut.onclick = toggleOutputPause;
}

function playRange(a, b, mode = 'cut') {
  stopSequence();
  const previewMode = mode === 'source' ? 'source' : 'stock';
  setPreviewContext(previewMode);
  store.ui.playRange = { start: a, end: b, mode: previewMode };
  renderSeekDecor();
  updatePlayInfo();
  seekTo(a, () => el.srcVideo.play());
}

function frameDur() {
  const fps = store.activeSource()?.fps || 30;
  return 1 / fps;
}

function frameDurFor(sourceId) {
  const fps = store.getSource(sourceId)?.fps || store.activeSource()?.fps || 30;
  return 1 / fps;
}

function activeFps() {
  return store.activeSource()?.fps || 30;
}

function activeDuration() {
  return store.activeSource()?.duration || el.srcVideo.duration || 0;
}

function frameOfTime(t, fps = activeFps(), duration = activeDuration()) {
  const total = duration ? Math.max(0, Math.round(duration * fps) - 1) : Number.MAX_SAFE_INTEGER;
  return frameFromTime(t, fps, total);
}

function probeTimeOf(t) {
  const fps = activeFps();
  const duration = activeDuration();
  return frameProbeTime(frameOfTime(t, fps, duration), fps, duration);
}

function endGuard() {
  return Math.min(0.03, frameDur() * 0.75);
}

function sequenceEndGuard(item) {
  return Math.min(0.08, frameDurFor(item?.sourceId) * 1.15);
}

function startTransportMonitor() {
  if (!transportRaf) transportLoop();
}

function stopTransportMonitor() {
  cancelAnimationFrame(transportRaf);
  transportRaf = 0;
}

function transportLoop() {
  transportRaf = requestAnimationFrame(transportLoop);
  if (!el.srcVideo || el.srcVideo.paused) return;

  // Sequential output playback takes priority over a source loop range.
  if (sequence) {
    const it = sequence.items[sequence.i];
    if (it && !sequenceAdvancing) {
      const fps = store.getSource(it.sourceId)?.fps || activeFps();
      const outFrame = Math.round(it.out * fps);
      if (el.srcVideo.currentTime >= outFrame / fps - sequenceEndGuard(it)) advanceSequence();
    }
    return;
  }

  const r = store.ui.playRange;
  if (!r) return;
  const fps = activeFps();
  const outFrame = Math.round(r.end * fps);
  if (el.srcVideo.currentTime < outFrame / fps - endGuard()) return;

  if (loopEnabled) {
    seekVideoFrame(el.srcVideo, Math.round(r.start * fps), fps, activeDuration());
  } else {
    el.srcVideo.pause();
    seekVideoFrame(el.srcVideo, Math.max(Math.round(r.start * fps), outFrame - 1), fps, activeDuration());
  }
}

// ---- sequential playback of the output sequence ----
function playOutputs() {
  playOutputsFromIndex(0);
}

function playOutputFrom(outputId) {
  const p = store.get();
  const index = p.outputs.findIndex(o => o.id === outputId);
  playOutputsFromIndex(Math.max(0, index));
}

function outputPlaybackItems() {
  const p = store.get();
  return p.outputs.map(o => {
    const m = store.getMaterial(o.materialId);
    return m ? {
      outputId: o.id,
      materialId: m.id,
      sourceId: m.sourceId,
      in: m.in,
      out: m.out,
      duration: Math.max(0, m.out - m.in),
    } : null;
  }).filter(Boolean);
}

function playOutputsFromIndex(startIndex) {
  const items = outputPlaybackItems();
  if (!items.length) return;
  setPreviewContext('edit');
  exitCropEdit();
  store.ui.playRange = null;
  sequence = { items, i: Math.min(Math.max(0, startIndex || 0), items.length - 1), mode: 'native' };
  sequenceAdvancing = false;
  updateOutputTransport();
  updatePlayInfo();
  playSequenceItem();
}

function seekOutputTime(sequenceSeconds, { previewOnly = false } = {}) {
  const items = outputPlaybackItems();
  if (!items.length) return;
  setPreviewContext('edit');
  exitCropEdit();
  const target = Math.max(0, sequenceSeconds || 0);
  let cursor = 0;
  let index = items.length - 1;
  let local = 0;
  for (let i = 0; i < items.length; i++) {
    const d = Math.max(0, items[i].duration);
    if (target < cursor + d || i === items.length - 1) {
      index = i;
      local = Math.max(0, Math.min(d, target - cursor));
      break;
    }
    cursor += d;
  }
  const wasPlaying = !!sequence && !el.srcVideo.paused;
  sequence = { items, i: index, mode: 'native' };
  sequenceAdvancing = true;
  store.ui.playRange = null;
  updateOutputTransport();
  updatePlayInfo();
  const it = items[index];
  store.ui._fromSequence = true;
  if (!(previewOnly && store.ui.selectedCaptionId)) store.select('output', it.outputId);
  ensureSource(it.sourceId, () => {
    seekTo(it.in + local, () => {
      sequenceAdvancing = false;
      if (wasPlaying && !previewOnly) el.srcVideo.play();
      else {
        try { el.srcVideo.pause(); } catch { /* ignore */ }
        updateOutputTransport();
        updatePlayInfo();
      }
    });
  });
}

function playSequenceItem() {
  if (!sequence) return;
  setPreviewContext('edit');
  const it = sequence.items[sequence.i];
  store.ui._fromSequence = true;
  store.select('output', it.outputId);
  updatePlayInfo();
  ensureSource(it.sourceId, () => {
    seekTo(it.in, () => {
      sequenceAdvancing = false;
      el.srcVideo.play();
    });
  });
}

function advanceSequence() {
  if (!sequence) return;
  sequenceAdvancing = true;
  try { el.srcVideo.pause(); } catch { /* ignore */ }
  sequence.i++;
  if (sequence.i >= sequence.items.length) { stopSequence(); return; }
  playSequenceItem();
}

function toggleOutputPause() {
  if (!sequence) return;
  if (el.srcVideo.paused) el.srcVideo.play();
  else el.srcVideo.pause();
  updateOutputTransport();
  updatePlayInfo();
}

function stopSequence() {
  const hadSequence = !!sequence;
  if (hadSequence) {
    try { el.srcVideo.pause(); } catch { /* ignore */ }
  }
  sequence = null;
  sequenceAdvancing = false;
  updateOutputTransport();
  updatePlayInfo();
}

function updateOutputTransport() {
  el.btnStopOut.disabled = !sequence;
  el.btnStopOut.textContent = sequence && el.srcVideo.paused ? '▶ Resume' : '⏸ Pause';
}

function sequenceClock() {
  if (!sequence?.items?.length) return { at: 0, total: 0 };
  let before = 0;
  for (let i = 0; i < sequence.i; i++) before += Math.max(0, sequence.items[i].duration || 0);
  const item = sequence.items[sequence.i];
  const local = item ? Math.max(0, Math.min(item.duration || 0, (el.srcVideo.currentTime || item.in) - item.in)) : 0;
  const total = sequence.items.reduce((sum, it) => sum + Math.max(0, it.duration || 0), 0);
  return { at: before + local, total };
}

function setPreviewContext(mode) {
  previewContext = mode === 'edit' || mode === 'stock' || mode === 'source' ? mode : 'source';
}

function currentPreviewMode() {
  if (cropEditingActive()) return 'stock';
  return previewContext;
}

function activateSourcePreview() {
  setPreviewContext('source');
  exitCropEdit();
  store.ui.playRange = null;
  renderSeekDecor();
  if (sequence) stopSequence();
  else updatePlayInfo();
}

function cropEditingActive() {
  return !!(store.ui.cropEditActive || store.ui.horizontalCropEditActive);
}

function exitCropEdit() {
  if (!cropEditingActive()) return;
  store.setUI({ cropEditActive: false, horizontalCropEditActive: false });
}

function selectionPreviewMode() {
  const sel = store.ui.selection;
  if (sel.kind === 'material') return 'stock';
  if (sel.kind === 'output') return 'edit';
  return null;
}

function idlePreviewMode() {
  if (previewContext === 'edit' || previewContext === 'stock' || previewContext === 'source') return previewContext;
  return selectionPreviewMode() || (activeArea === 'edit' ? 'edit' : 'source');
}

function updatePlayInfo() {
  if (!el.playInfo) return;
  if (cropEditingActive()) {
    setPreviewState('stock', 'Cut crop ' + fmtTime(el.srcVideo.currentTime || 0));
    return;
  }
  if (sequence) {
    const clock = sequenceClock();
    setPreviewState('edit', `${el.srcVideo.paused ? 'Edit paused' : 'Edit playing'} ${fmtTime(clock.at)} / ${fmtTime(clock.total)}`);
    return;
  }
  const r = store.ui.playRange;
  if (r) {
    const at = Math.max(0, Math.min(Math.max(0, r.end - r.start), (el.srcVideo.currentTime || r.start) - r.start));
    const mode = r.mode === 'source' ? 'source' : 'stock';
    const label = mode === 'source' ? 'Source range' : 'Stock cut';
    setPreviewState(mode, `${el.srcVideo.paused ? label + ' paused' : label} ${fmtTime(at)} / ${fmtTime(Math.max(0, r.end - r.start))}`);
    return;
  }
  if (!el.srcVideo.paused && el.srcVideo.currentTime > 0) {
    const mode = idlePreviewMode();
    const label = mode === 'edit' ? 'Edit preview' : mode === 'stock' ? 'Cut preview' : 'Source playing';
    setPreviewState(mode, `${label} ${fmtTime(el.srcVideo.currentTime)}`);
    return;
  }
  const mode = idlePreviewMode();
  if (mode === 'edit') {
    setPreviewState('edit', 'Edit ready');
  } else if (mode === 'stock') {
    setPreviewState('stock', 'Cut ready');
  } else {
    setPreviewState(store.activeSource() ? 'source' : 'idle', 'Source ready');
  }
}

function setPreviewState(mode, text) {
  const prevMode = el.origPane?.dataset.previewMode;
  el.playInfo.dataset.mode = mode;
  el.playInfo.textContent = text;
  for (const pane of [el.origPane, el.vertPane]) {
    if (pane) pane.dataset.previewMode = mode;
  }
  if (mode !== prevMode) requestAnimationFrame(() => { cropPreview.refresh(); horizontalPreview.refresh(); });
}

function ensureSource(sourceId, cb) {
  if (store.ui.activeSourceId === sourceId && el.srcVideo.readyState >= 1) { cb(); return; }
  if (store.ui.activeSourceId !== sourceId) store.setUI({ activeSourceId: sourceId });
  el.srcVideo.addEventListener('loadeddata', cb, { once: true });
}

function seekTo(t, cb) {
  const fps = activeFps();
  const duration = activeDuration();
  const targetFrame = frameOfTime(t, fps, duration);
  const targetTime = frameProbeTime(targetFrame, fps, duration);
  if (el.srcVideo.readyState >= 1) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.srcVideo.removeEventListener('seeked', finish);
      cb?.();
    };
    if (cb) {
      el.srcVideo.addEventListener('seeked', finish);
      requestAnimationFrame(() => {
        if (Math.abs(el.srcVideo.currentTime - targetTime) < 1e-4 && !el.srcVideo.seeking) finish();
      });
    }
    try { el.srcVideo.currentTime = targetTime; } catch { finish(); }
  } else {
    pendingSeek = t;
    if (cb) el.srcVideo.addEventListener('loadeddata', cb, { once: true });
  }
}

// ---------- preview seek bar + frame readout ----------
let seekScrub = null;
let seekRaf = 0;
function wireSeek() {
  seekScrub = makeScrubber(el.srcVideo);
  const bar = el.seekBar;
  let dragging = false;
  const tAt = (clientX) => {
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
    return f * (el.srcVideo.duration || 0);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!el.srcVideo.duration) return;
    dragging = true;
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    activateSourcePreview();
    seekScrub(probeTimeOf(tAt(e.clientX))); updateSeek();
  });
  bar.addEventListener('pointermove', (e) => { if (dragging) { activateSourcePreview(); seekScrub(probeTimeOf(tAt(e.clientX))); updateSeek(e.clientX); } });
  bar.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    activateSourcePreview();
    seekTo(tAt(e.clientX));
  });

  el.srcVideo.addEventListener('timeupdate', () => { updateSeek(); updateFrameInfo(); });
  el.srcVideo.addEventListener('seeked', () => { updateSeek(); updateFrameInfo(); });
  el.srcVideo.addEventListener('loadedmetadata', () => { renderSeekDecor(); updateSeek(); updateFrameInfo(); });
  el.srcVideo.addEventListener('play', startSeekLoop);
  el.srcVideo.addEventListener('pause', stopSeekLoop);
  el.srcVideo.addEventListener('ended', stopSeekLoop);
}

function startSeekLoop() { if (!seekRaf) seekLoop(); }
function stopSeekLoop() { cancelAnimationFrame(seekRaf); seekRaf = 0; updateSeek(); }
function seekLoop() { updateSeek(); seekRaf = requestAnimationFrame(seekLoop); }

function updateSeek(overrideX) {
  const d = el.srcVideo.duration || 0;
  let f = 0;
  if (overrideX != null) {
    const r = el.seekBar.getBoundingClientRect();
    f = Math.min(1, Math.max(0, (overrideX - r.left) / (r.width || 1))) * 100;
  } else {
    f = d ? (el.srcVideo.currentTime / d * 100) : 0;
  }
  el.seekFill.style.width = f + '%';
  el.seekHead.style.left = f + '%';
}

function updateFrameInfo() {
  const src = store.activeSource();
  const fps = (src && src.fps) || 0;
  if (!fps || !el.srcVideo.duration) { el.frameInfo.textContent = '-'; return; }
  const frameDur = 1 / fps;
  const totalFrames = Math.round((el.srcVideo.duration || 0) * fps);
  const frame = frameFromTime(el.srcVideo.currentTime, fps, Math.max(0, totalFrames - 1));
  el.frameInfo.textContent = fps + 'fps - 1 frame ' + frameDur.toFixed(3) + 's - #' + frame + '/' + totalFrames;
}

function renderSeekDecor() {
  const d = el.srcVideo.duration || store.activeSource()?.duration || 0;
  if (!d) { el.seekMarks.innerHTML = ''; el.seekRange.style.display = 'none'; return; }
  const sid = store.ui.activeSourceId;
  const mats = store.get().materials.filter(m => m.sourceId === sid);
  el.seekMarks.innerHTML = mats.map(m => {
    const l = m.in / d * 100, w = Math.max(0.3, (m.out - m.in) / d * 100);
    return '<span style="left:' + l + '%;width:' + w + '%"></span>';
  }).join('');
  const r = store.ui.playRange;
  if (r) {
    el.seekRange.style.display = 'block';
    el.seekRange.style.left = (r.start / d * 100) + '%';
    el.seekRange.style.width = Math.max(0.3, (r.end - r.start) / d * 100) + '%';
  } else {
    el.seekRange.style.display = 'none';
  }
}

// ---------- crop sliders ----------
function wireCrop() {
  const startVertical = () => { if (store.resolve()?.material) store.beginAction(); };
  const startSource = () => { if (store.resolve()?.material) store.beginAction(); };
  const applyVertical = () => {
    const crop = { panX: +el.panX.value, panY: +el.panY.value, zoom: +el.zoom.value, bgBlur: +el.bgBlur.value };
    const r = store.resolve();
    if (r?.material) {
      store.updateLive(() => { r.material.crop = crop; });
    } else {
      store.setUI({ crop });
    }
  };
  for (const s of [el.panX, el.panY, el.zoom, el.bgBlur]) {
    s.addEventListener('pointerdown', startVertical);
    s.addEventListener('input', applyVertical);
  }
  el.verticalCropReset.onclick = () => {
    const crop = { panX: .5, panY: .5, zoom: 1, bgBlur: 1 };
    const r = store.resolve();
    if (r?.material) store.update((p) => { r.material.crop = crop; });
    else store.setUI({ crop });
  };

  const applySource = () => {
    const horizontalCrop = { panX: +el.sourcePanX.value, panY: +el.sourcePanY.value, zoom: +el.sourceZoom.value, bgBlur: +el.sourceBgBlur.value };
    const r = store.resolve();
    if (r?.material) {
      store.updateLive(() => { r.material.horizontalCrop = horizontalCrop; });
    } else {
      store.setUI({ horizontalCrop });
    }
  };
  for (const s of [el.sourcePanX, el.sourcePanY, el.sourceZoom, el.sourceBgBlur]) {
    s.addEventListener('pointerdown', startSource);
    s.addEventListener('input', applySource);
  }
  el.sourceCropReset.onclick = () => {
    const horizontalCrop = { panX: .5, panY: .5, zoom: 1, bgBlur: 1 };
    const r = store.resolve();
    if (r?.material) store.update((p) => { r.material.horizontalCrop = horizontalCrop; });
    else store.setUI({ horizontalCrop });
  };

  el.vertPane.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const mode = el.vertPane.dataset.previewMode;
    if (mode !== 'stock' && mode !== 'edit') return;
    const next = !store.ui.cropEditActive;
    if (next) {
      setPreviewContext('stock');
      if (sequence) stopSequence();
      store.ui.playRange = null;
    }
    store.setUI({ cropEditActive: next });
    updatePlayInfo();
    requestAnimationFrame(() => cropPreview.refresh());
  });
  el.origPane.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const mode = el.origPane.dataset.previewMode;
    if (mode !== 'stock' && mode !== 'edit') return;
    const next = !store.ui.horizontalCropEditActive;
    if (next) {
      setPreviewContext('stock');
      if (sequence) stopSequence();
      store.ui.playRange = null;
    }
    store.setUI({ horizontalCropEditActive: next });
    updatePlayInfo();
    requestAnimationFrame(() => horizontalPreview.refresh());
  });
}

// ---------- active editing areas ----------
function wireAreas() {
  const areas = [...document.querySelectorAll('[data-area]')];
  const setArea = (area) => {
    if (!area) return;
    activeArea = area;
    if (area === 'edit') {
      setPreviewContext('edit');
    } else if (!selectionPreviewMode()) {
      setPreviewContext('source');
    }
    const patch = {};
    if (area !== 'source') {
      if (store.ui.cropEditActive) patch.cropEditActive = false;
      if (store.ui.horizontalCropEditActive) patch.horizontalCropEditActive = false;
    }
    if (area !== 'timeline' && (store.ui.editMaterialId || store.ui.editMaterialIds?.length)) {
      patch.editMaterialId = null;
      patch.editMaterialIds = [];
    }
    if (Object.keys(patch).length) store.setUI(patch);
    for (const node of areas) node.classList.toggle('area-active', node.dataset.area === area);
    document.body.dataset.activeArea = area;
    updatePlayInfo();
  };
  for (const node of areas) {
    node.addEventListener('pointerdown', () => setArea(node.dataset.area), { capture: true });
  }
  setArea(activeArea);
}

// ---------- workspace splitters ----------
function wireWorkspaceSplitters() {
  const splitters = [...document.querySelectorAll('.pane-splitter')];
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  let drag = null;

  const fitMonitorColumns = () => {
    if (workspaceLayoutManual || !el.workPane || !el.origPane || !el.vertPane) return;
    const rect = el.workPane.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const headH = el.origPane.querySelector('.pane-head')?.getBoundingClientRect().height || 32;
    const contentH = Math.max(120, rect.height - headH);
    const splittersW = 12;
    const available = Math.max(0, rect.width - splittersW);
    const minMaterials = 160;
    const minHorizontal = 340;
    const minVertical = 150;
    const idealHorizontal = Math.ceil(contentH * 16 / 9) + 2;
    const idealVertical = Math.ceil(contentH * 9 / 16) + 2;
    const verticalMax = Math.max(minVertical, available - minMaterials - minHorizontal);
    const vertical = clamp(idealVertical, minVertical, verticalMax);
    const horizontalMax = Math.max(minHorizontal, available - minMaterials - vertical);
    const horizontal = clamp(idealHorizontal, minHorizontal, horizontalMax);
    const materials = Math.max(minMaterials, available - horizontal - vertical);
    el.workPane.style.setProperty('--materials-col', Math.round(materials) + 'px');
    el.workPane.style.setProperty('--vertical-col', Math.round(vertical) + 'px');
  };

  requestAnimationFrame(fitMonitorColumns);
  window.addEventListener('resize', fitMonitorColumns);

  for (const splitter of splitters) {
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      workspaceLayoutManual = true;
      const rect = el.workPane.getBoundingClientRect();
      drag = {
        el: splitter,
        kind: splitter.dataset.splitter,
        startX: e.clientX,
        workW: rect.width,
        materials: document.getElementById('shelfPane').getBoundingClientRect().width,
        vertical: el.vertPane.getBoundingClientRect().width,
      };
      splitter.classList.add('dragging');
      try { splitter.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (drag.kind === 'materials') {
      const max = Math.max(160, drag.workW - drag.vertical - 340);
      el.workPane.style.setProperty('--materials-col', clamp(drag.materials + dx, 120, max) + 'px');
    } else if (drag.kind === 'vertical') {
      const max = Math.max(180, drag.workW - drag.materials - 340);
      el.workPane.style.setProperty('--vertical-col', clamp(drag.vertical - dx, 150, max) + 'px');
    }
    window.dispatchEvent(new Event('resize'));
  });

  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    try { drag.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    drag.el.classList.remove('dragging');
    drag = null;
  });
}

// ---------- shortcuts ----------
function isTextEntryTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target.type || 'text').toLowerCase();
  return ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(type);
}

function wireShortcuts() {
  document.addEventListener('selectstart', (e) => {
    if (!isTextEntryTarget(e.target)) e.preventDefault();
  });
  window.addEventListener('keydown', (e) => {
    if (!el.exportMode.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeExportMode(null); }
      return;
    }
    // confirm dialog captures Enter/Escape while open
    if (!el.confirm.hidden) {
      if (e.key === 'Enter') { e.preventDefault(); closeConfirm(true); }
      else if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
      return;
    }
    if (isTextEntryTarget(e.target)) return;
    window.getSelection()?.removeAllRanges();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); }
    else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      store.flushSave().then(() => setStatus(store.get().materials.length ? 'Session saved' : 'Session without materials is not saved'));
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === ' ') {
      e.preventDefault();
      if (activeArea === 'edit') {
        if (sequence) toggleOutputPause();
        else playOutputs();
      } else {
        el.btnPlay.click();
      }
    }
  });
}

// ---------- confirm dialog + selection delete ----------
let confirmResolve = null;
function wireConfirm() {
  el.confirmOk.onclick = () => closeConfirm(true);
  el.confirmCancel.onclick = () => closeConfirm(false);
  el.confirm.addEventListener('pointerdown', (e) => { if (e.target === el.confirm) closeConfirm(false); });
  el.exportModeCancel.onclick = () => closeExportMode(null);
  el.exportMode.addEventListener('pointerdown', (e) => { if (e.target === el.exportMode) closeExportMode(null); });
  for (const btn of el.exportMode.querySelectorAll('[data-export-mode]')) {
    btn.addEventListener('click', () => closeExportMode(btn.dataset.exportMode));
  }
}
function askConfirm(message, okLabel = 'Delete', title = 'Confirm Delete') {
  el.confirmTitle.textContent = title;
  el.confirmMsg.textContent = message;
  el.confirmOk.textContent = okLabel;
  el.confirm.hidden = false;
  el.confirmOk.focus();
  return new Promise((res) => { confirmResolve = res; });
}
function closeConfirm(val) {
  if (el.confirm.hidden) return;
  el.confirm.hidden = true;
  const r = confirmResolve; confirmResolve = null;
  if (r) r(val);
}

async function askSessionChoice(initialSessions) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay session-picker-overlay';
  const box = document.createElement('div');
  box.className = 'overlay-box session-picker-box';
  let sessions = await withSessionSizes(initialSessions);
  const storageText = await storageUsageText();
  const render = () => {
    const rows = sessions.map((s, index) => {
      const updated = s.updatedAt || s.savedAt || 0;
      const date = updated ? new Date(updated).toLocaleString() : '';
      const brightness = sessionBrightness(index, sessions.length);
      const thumb = s.thumbnail
        ? `<img src="${escapeAttr(s.thumbnail)}" alt="">`
        : '<span>No thumbnail</span>';
      return `
        <div class="session-choice" data-session-id="${escapeAttr(s.id)}" style="--session-brightness:${brightness}">
          <span class="session-choice-thumb" data-session-open="${escapeAttr(s.id)}">${thumb}</span>
          <button class="session-choice-open" type="button" data-session-open="${escapeAttr(s.id)}">
            <span class="session-choice-title">${escapeHtml((s.name || 'Untitled edit') + (s.exportName ? ` · ${s.exportName}` : ''))}</span>
            <span class="session-choice-meta">${escapeHtml(date)} / ${formatBytes(s.bytes || 0)} / ${s.outputCount || 0} cuts</span>
          </button>
          <button class="session-delete-btn" type="button" data-session-delete="${escapeAttr(s.id)}">Delete</button>
        </div>`;
    }).join('');
    box.innerHTML = `
      <div class="session-picker-title">New / Sessions</div>
      <div class="session-storage">${escapeHtml(storageText)}</div>
      <div class="session-warning">
        <strong><span class="session-warning-icon">🗑</span>一時保存です / Temporary browser storage</strong>
        <span>直近数回分の編集だけ復帰できます。このファイルは自動的に消えることがあります。</span>
        <span>Recent edits can be restored. These files may be removed automatically.</span>
        <small>消える条件: ブラウザのサイトデータ削除、空き容量不足、シークレット終了、このアプリの最近約15セッションから外れた場合。</small>
        <small>Deleted when: site data is cleared, storage is low, private browsing ends, or the session falls outside about the latest 15 sessions in this app.</small>
      </div>
      <button class="session-choice session-choice-new" type="button" data-session-open="new">
        <span class="session-choice-title">New Session</span>
        <span class="session-choice-meta">Create a new temporary URL session</span>
      </button>
      <div class="session-picker-list">${rows || '<div class="session-picker-empty">No saved sessions</div>'}</div>
      <div class="session-picker-actions"><button class="btn btn-sm" type="button" data-session-cancel>Cancel</button></div>`;
  };
  render();
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return new Promise((resolve) => {
    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish(null); });
    box.addEventListener('click', async (e) => {
      const cancel = e.target.closest('[data-session-cancel]');
      if (cancel) { finish(null); return; }
      const del = e.target.closest('[data-session-delete]');
      if (del) {
        e.stopPropagation();
        const id = del.dataset.sessionDelete;
        const session = sessions.find(s => s.id === id);
        if (!window.confirm(`Delete this temporary session?\n${session?.name || 'Untitled edit'}`)) return;
        await db.deleteSession(id);
        if (id === store.sessionId) {
          finish('new');
          return;
        }
        sessions = await withSessionSizes(await db.listSessions().catch(() => []));
        render();
        return;
      }
      const open = e.target.closest('[data-session-open]');
      if (open) finish(open.dataset.sessionOpen);
    });
    box.querySelector('[data-session-open]')?.focus();
  });
}

async function withSessionSizes(sessions) {
  return Promise.all(sessions.map(async (session) => ({
    ...session,
    bytes: await db.estimateSessionBytes(session.id).catch(() => 0),
  })));
}

function sessionBrightness(index, count) {
  if (count <= 1) return '1';
  const t = Math.max(0, Math.min(1, index / Math.max(1, count - 1)));
  return (1 - t * 0.5).toFixed(2);
}

async function storageUsageText() {
  if (!navigator.storage?.estimate) return 'Storage: unavailable';
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return `Storage: ${formatBytes(usage)} used / ${formatBytes(quota)} available quota (browser estimate)`;
  } catch {
    return 'Storage: unavailable';
  }
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

async function deleteSelected() {
  if (store.ui.selectedCaptionId) {
    if (await askConfirm('Delete this caption?')) {
      if (outSeq.deleteCaption(store.ui.selectedCaptionId)) setStatus('Caption deleted');
      else setStatus('Nothing is selected for deletion');
    }
    return;
  }

  const sel = store.ui.selection;
  if (!sel.kind) { setStatus('Nothing is selected for deletion'); return; }

  if (sel.kind === 'output') {
    if (await askConfirm('Delete this output clip?')) {
      outSeq.deleteOutput(sel.id);
      setStatus('Output clip deleted');
    }
  } else if (sel.kind === 'material') {
    const deps = store.get().outputs.filter(o => o.materialId === sel.id).length;
    const msg = deps
      ? 'Delete this material? ' + deps + ' output clip(s) using it will also be deleted.'
      : 'Delete this material?';
    if (await askConfirm(msg)) {
      shelf.deleteMaterial(sel.id);
      setStatus('Material deleted');
    }
  }
}

// ---------- export ----------
// Stream exports straight to disk so long exports don't hold the whole MP4 in
// memory. One picker interaction total: a save dialog for a single target, a
// folder pick (plus upfront overwrite confirmation) for dual export. Falls
// back to the in-memory Blob + download path when pickers are unavailable or
// user activation has expired.
async function pickExportDestinations(targets) {
  if (navigator.userActivation && !navigator.userActivation.isActive) return { kind: 'download' };
  try {
    if (targets.length === 1) {
      if (!window.showSaveFilePicker) return { kind: 'download' };
      const handle = await window.showSaveFilePicker({
        suggestedName: targets[0].fileName,
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      return { kind: 'stream', writables: [await handle.createWritable()] };
    }
    if (!window.showDirectoryPicker) return { kind: 'download' };
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const existing = [];
    for (const t of targets) {
      try { await dir.getFileHandle(t.fileName); existing.push(t.fileName); } catch { /* not found */ }
    }
    if (existing.length && !(await askConfirm(`Overwrite existing file(s)? ${existing.join(', ')}`, 'Overwrite', 'Confirm Overwrite'))) {
      return { kind: 'cancel' };
    }
    const writables = [];
    for (const t of targets) {
      const fileHandle = await dir.getFileHandle(t.fileName, { create: true });
      writables.push(await fileHandle.createWritable());
    }
    return { kind: 'stream', writables };
  } catch (err) {
    if (err?.name === 'AbortError') return { kind: 'cancel' };
    return { kind: 'download' };
  }
}

async function doExport() {
  const settings = await prepareExportSettings();
  if (!settings) return;
  const dests = await pickExportDestinations(settings.targets);
  if (dests.kind === 'cancel') { setStatus('Export canceled'); return; }
  showOverlay('Preparing export...');
  try {
    const completed = [];
    for (let i = 0; i < settings.targets.length; i++) {
      const target = settings.targets[i];
      el.overlayMsg.textContent = `Preparing ${target.label} export...`;
      let blob;
      try {
        blob = await exportProject({
          width: target.width,
          height: target.height,
          fps: settings.fps,
          cropMode: target.cropMode,
          writable: dests.writables?.[i],
          onStatus: (m) => el.overlayMsg.textContent = settings.targets.length > 1 ? `${target.label}: ${m}` : m,
          onProgress: (p) => el.overlayProg.value = Math.round(((i + (p || 0)) / settings.targets.length) * 100),
        });
      } catch (err) {
        // Abort every writable that has not been consumed yet (the one in
        // flight is locked by StreamTarget and cleaned up by output.cancel()).
        for (const w of dests.writables?.slice(i) || []) {
          try { await w.abort?.(); } catch { /* locked or already closed */ }
        }
        throw err;
      }
      if (blob) downloadBlob(blob, target.fileName);
      completed.push(target.fileName);
    }
    setStatus('Export complete: ' + completed.join(', '));
  } finally { hideOverlay(); }
}

async function prepareExportSettings() {
  const p = store.get();
  const items = p.outputs.map(o => {
    const m = p.materials.find(x => x.id === o.materialId);
    return m ? { output: o, material: m, source: p.sources.find(s => s.id === m.sourceId) } : null;
  }).filter(it => it?.source);
  if (!items.length) return null;

  // Name first, mode second: the mode button click is then the most recent
  // user activation, which showSaveFilePicker in doExport needs (transient
  // activation expires in ~5s, so typing a name after it would invalidate it).
  const currentName = p.exportName || p.name || 'viralcut';
  const requested = prompt('Export file name', sanitizeFileName(stripMp4(currentName)) || 'viralcut');
  if (requested == null) return null;
  const baseName = sanitizeFileName(stripMp4(requested)) || 'viralcut';

  const mode = await askExportMode();
  if (!mode) return null;
  const sources = [...new Map(items.map(it => [it.source.id, it.source])).values()];
  const fps = resolveExportFps(sources, p.output.fps || 30);
  if (!fps) return null;
  const targets = exportTargets(mode, baseName, sources);

  store.update((project) => {
    project.exportName = baseName;
    project.output = { ...project.output, fps };
  }, { commit: false });

  return { fps, targets };
}

let exportModeResolve = null;
function askExportMode() {
  el.exportMode.hidden = false;
  const first = el.exportMode.querySelector('[data-export-mode]');
  first?.focus();
  return new Promise((res) => { exportModeResolve = res; });
}

function closeExportMode(value) {
  if (el.exportMode.hidden) return;
  el.exportMode.hidden = true;
  const r = exportModeResolve;
  exportModeResolve = null;
  el.btnExport.focus();
  if (r) r(value);
}

function resolveExportFps(sources, fallback) {
  const values = sources.map(s => Number(s.fps || 0)).filter(v => Number.isFinite(v) && v > 0);
  if (!values.length) return fallback || 30;
  // Mixed frame rates: use the highest so no source has to drop frames,
  // capped at 60 fps.
  return Math.min(60, Math.max(...values));
}

function exportTargets(mode, baseName, sources) {
  const vertical = {
    label: 'Vertical 9:16',
    cropMode: 'vertical',
    fileName: (mode === 'both' ? `${baseName}_vertical` : baseName) + '.mp4',
    ...resolveExportSize(sources, 9 / 16),
  };
  const horizontal = {
    label: 'Horizontal 16:9',
    cropMode: 'horizontal',
    fileName: (mode === 'both' ? `${baseName}_horizontal` : baseName) + '.mp4',
    ...resolveExportSize(sources, 16 / 9),
  };
  if (mode === 'horizontal') return [horizontal];
  if (mode === 'both') return [vertical, horizontal];
  return [vertical];
}

function resolveExportSize(sources, aspect) {
  const maxSourceLong = Math.max(0, ...sources.map(s => Math.max(Number(s.width) || 0, Number(s.height) || 0)));
  const longEdge = Math.min(1080, maxSourceLong || 1080);
  if (aspect >= 1) return { width: even(longEdge), height: even(longEdge / aspect) };
  return { width: even(longEdge * aspect), height: even(longEdge) };
}

function stripMp4(name) {
  return String(name || '').replace(/\.mp4$/i, '');
}

function sanitizeFileName(name) {
  // Windows also rejects trailing dots/spaces in file names.
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
}

function even(v) {
  return Math.max(2, Math.round(v / 2) * 2);
}

function renderSourcePicker(project, ui) {
  const picker = el.sourcePicker;
  if (!picker) return;
  picker.innerHTML = '';
  picker.className = 'source-picker' + (sourcePickerOpen ? ' open' : '');
  const active = project.sources.find(s => s.id === ui.activeSourceId) || project.sources[0] || null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-picker-button';
  button.disabled = !project.sources.length;
  button.append(sourceThumbNode(active), sourceNameNode(active?.fileName || 'No video'));
  button.onclick = (e) => {
    e.stopPropagation();
    if (!project.sources.length) return;
    sourcePickerOpen = !sourcePickerOpen;
    renderSourcePicker(project, store.ui);
  };
  picker.appendChild(button);

  if (!sourcePickerOpen) return;
  const list = document.createElement('div');
  list.className = 'source-picker-list';
  for (const source of project.sources) {
    ensureSourceThumb(source);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'source-picker-option' + (source.id === ui.activeSourceId ? ' selected' : '');
    row.append(sourceThumbNode(source), sourceNameNode(source.fileName));
    row.onclick = (e) => {
      e.stopPropagation();
      sourcePickerOpen = false;
      setPreviewContext('source');
      store.setUI({ activeSourceId: source.id });
    };
    list.appendChild(row);
  }
  picker.appendChild(list);
}

function sourceNameNode(text) {
  const span = document.createElement('span');
  span.className = 'source-picker-name';
  span.textContent = text;
  return span;
}

function sourceThumbNode(source) {
  const slot = document.createElement('span');
  slot.className = 'source-picker-thumb';
  if (!source) {
    slot.textContent = '-';
    return slot;
  }
  const canvas = sourceThumbs.get(source.id);
  if (canvas) slot.appendChild(cloneCanvas(canvas));
  else {
    slot.textContent = '...';
    ensureSourceThumb(source);
  }
  return slot;
}

async function ensureSourceThumb(source) {
  if (!source || sourceThumbs.has(source.id) || sourceThumbBusy.has(source.id)) return;
  sourceThumbBusy.add(source.id);
  try {
    const duration = Math.max(0, Number(source.duration) || 0);
    const t = duration ? Math.min(duration - 0.05, Math.max(0.4, duration * 0.2)) : 0;
    const canvas = await cardThumb(source, t, 128, 72);
    if (canvas) {
      sourceThumbs.set(source.id, canvas);
      renderSourcePicker(store.get(), store.ui);
    }
  } catch {
    /* video may not be restored yet */
  } finally {
    sourceThumbBusy.delete(source.id);
  }
}

// ---------- state -> UI ----------
function onState(project, ui) {
  // source dropdown
  const opts = project.sources.map(s =>
    '<option value="' + escapeAttr(s.id) + '"' + (s.id === ui.activeSourceId ? ' selected' : '') + '>' + escapeHtml(s.fileName) + '</option>').join('');
  if (el.sourceSelect.innerHTML !== opts) el.sourceSelect.innerHTML = opts;
  renderSourcePicker(project, ui);

  // selection side-effects (run once per selection change)
  const sel = ui.selection;
  const key = sel.kind + ':' + sel.id;
  if (key !== lastSelKey) { lastSelKey = key; applySelection(); }

  bindVideo(ui);

  // reflect crop in sliders (output's crop if selected, else draft)
  const r = store.resolve();
  const crop = (r && r.crop) || ui.crop;
  const horizontalCrop = (r && r.material?.horizontalCrop) || ui.horizontalCrop || { panX: .5, panY: .5, zoom: 1, bgBlur: 1 };
  if (crop) {
    if (document.activeElement !== el.panX) el.panX.value = crop.panX;
    if (document.activeElement !== el.panY) el.panY.value = crop.panY;
    if (document.activeElement !== el.zoom) el.zoom.value = crop.zoom;
    if (document.activeElement !== el.bgBlur) el.bgBlur.value = crop.bgBlur ?? 0;
  }
  if (horizontalCrop) {
    if (document.activeElement !== el.sourcePanX) el.sourcePanX.value = horizontalCrop.panX;
    if (document.activeElement !== el.sourcePanY) el.sourcePanY.value = horizontalCrop.panY;
    if (document.activeElement !== el.sourceZoom) el.sourceZoom.value = horizontalCrop.zoom;
    if (document.activeElement !== el.sourceBgBlur) el.sourceBgBlur.value = horizontalCrop.bgBlur ?? 1;
  }
  el.vertPane.classList.toggle('crop-editing', !!ui.cropEditActive);
  el.origPane.classList.toggle('crop-editing', !!ui.horizontalCropEditActive);
  requestAnimationFrame(() => { cropPreview.refresh(); horizontalPreview.refresh(); });

  renderSeekDecor();
  updateChrome();
}

function applySelection() {
  if (store.ui._fromSequence) {
    store.ui._fromSequence = false;
    return;
  }
  const fromTL = store.ui._fromTimeline;
  store.ui._fromTimeline = false;
  const r = store.resolve();
  if (!r || !r.source) {
    if (activeArea !== 'edit') setPreviewContext('source');
    updatePlayInfo();
    return;
  }
  const mode = store.ui.selection.kind === 'output' ? 'edit' : 'stock';
  setPreviewContext(mode);
  store.ui.playRange = null;
  if (mode === 'stock' && sequence) stopSequence();
  if (r.source.id !== store.ui.activeSourceId) {
    pendingSeek = r.in;
    queueMicrotask(() => store.setUI({ activeSourceId: r.source.id }));
  } else {
    seekTo(r.in);
  }
  updatePlayInfo();
  // focus the view to the clip only for shelf/output navigation, not timeline clicks
  // (timeline view should change via wheel/right-drag only)
  if (!fromTL && r.material) queueMicrotask(() => srcTimeline.focusMaterial(r.material));
}

function refreshStateViews() {
  store.setUI({ activeSourceId: store.ui.activeSourceId });
}

function bindVideo(ui) {
  const url = fileOpen.urlFor(ui.activeSourceId);
  if (url && url !== activeUrl) {
    activeUrl = url;
    el.srcVideo.src = url;
    el.srcEmpty.hidden = true;
    el.srcVideo.onloadedmetadata = () => {
      if (pendingSeek != null) { seekTo(pendingSeek); pendingSeek = null; }
    };
  } else if (url && pendingSeek != null && el.srcVideo.readyState >= 1) {
    seekTo(pendingSeek); pendingSeek = null;
  } else if (!url) {
    if (activeUrl || el.srcVideo.getAttribute('src')) {
      activeUrl = null;
      el.srcVideo.removeAttribute('src');
      try { el.srcVideo.load(); } catch { /* ignore */ }
    }
    el.srcEmpty.textContent = ui.activeSourceId ? 'Video is no longer available' : 'Add a video to begin';
    el.srcEmpty.hidden = false;
  }
}

function updateChrome() {
  const p = store.get();
  const activeHasCuts = p.materials.some(m => m.sourceId === store.ui.activeSourceId);
  el.btnAddVideo.disabled = false;
  el.btnAddVideo.classList.toggle('need-video', !p.sources.length);
  el.srcPane.classList.toggle('no-cuts', !!p.sources.length && !activeHasCuts);
  el.sourceSelect.disabled = !p.sources.length;
  el.btnExport.disabled = !p.outputs.length;
  el.btnPlayOut.disabled = !p.outputs.length;
  el.btnUndo.disabled = !store.canUndo();
  el.btnRedo.disabled = !store.canRedo();
}

// ---------- helpers ----------
function setStatus(m) { el.status.textContent = m; }
function showOverlay(m) { el.overlayMsg.textContent = m; el.overlayProg.value = 0; el.overlay.hidden = false; }
function hideOverlay() { el.overlay.hidden = true; }
function guard(fn) {
  return async (...a) => {
    try { await fn(...a); }
    catch (err) {
      if (err?.name === 'AbortError') return;
      console.error(err); setStatus('Error: ' + (err?.message || err)); alert(err?.message || err);
    }
  };
}

init();

