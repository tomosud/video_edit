// app.js — entry: wire modules, selection side-effects, ranged playback, persistence
import { store } from './store.js';
import * as projectStore from './projectStore.js';
import * as fileOpen from './fileOpen.js';
import * as cropPreview from './cropPreview.js';
import * as srcTimeline from './sourceTimeline.js';
import * as shelf from './materialShelf.js';
import * as outSeq from './outputSequence.js';
import { exportProject, downloadBlob } from './export.js';
import { fmtTime } from './util.js';

const $ = (id) => document.getElementById(id);
const el = {};
['btnNewProject','btnOpenProject','btnSave','btnAddVideo','sourceSelect','btnUndo','btnRedo',
 'btnExport','status','srcVideo','srcEmpty','origTime','btnPlay','btnLoop','vertCanvas',
 'panX','panY','zoom','overlay','overlayMsg','overlayProg',
 'tlScroll','tlInner','thumbRow','clipBands','tlPlayhead','srcRange',
 'shelf','shelfCount','outList','totalDur'].forEach(id => el[id] = $(id));

let projectOpen = false;
let activeUrl = null;
let pendingSeek = null;
let lastSelKey = '';
let loopEnabled = true;

function init() {
  cropPreview.init(el.vertCanvas, el.srcVideo);
  srcTimeline.init({
    scroll: el.tlScroll, inner: el.tlInner, thumbRow: el.thumbRow,
    bands: el.clipBands, playhead: el.tlPlayhead, range: el.srcRange,
  }, el.srcVideo);
  shelf.init({ shelf: el.shelf, count: el.shelfCount }, { play: playRange });
  outSeq.init({ list: el.outList, total: el.totalDur }, { play: playRange });
  srcTimeline.onPlayRange(playRange);

  wireMenu(); wireTransport(); wireCrop(); wireShortcuts();
  store.subscribe(onState);

  bootstrap();
}

async function bootstrap() {
  try {
    const re = await projectStore.reattach();
    if (re) {
      projectOpen = true;
      if (re.project) store.load(re.project);
      await fileOpen.relinkAll();
    }
  } catch { /* ignore */ }
  if (!projectOpen) await store.restore();
  updateChrome();
}

// ---------- menu ----------
function wireMenu() {
  el.btnNewProject.onclick = guard(async () => {
    const name = await projectStore.newProject();
    projectOpen = true; store.load({ name });
    setStatus('新規プロジェクト: ' + name);
  });
  el.btnOpenProject.onclick = guard(async () => {
    const { name, project } = await projectStore.openProject();
    projectOpen = true;
    if (project) {
      store.load(project);
      const missing = await fileOpen.relinkAll();
      setStatus(missing.length ? `${name}（未リンク ${missing.length}）` : '開いた: ' + name);
    } else { store.load({ name }); setStatus('空フォルダ→新規: ' + name); }
  });
  el.btnAddVideo.onclick = guard(async () => { await fileOpen.addVideo(); });
  el.btnSave.onclick = guard(async () => {
    const ts = await projectStore.save(store.get());
    setStatus('保存 ' + new Date(ts).toLocaleTimeString());
  });
  el.btnUndo.onclick = () => store.undo();
  el.btnRedo.onclick = () => store.redo();
  el.btnExport.onclick = guard(doExport);
  el.sourceSelect.onchange = () => store.setUI({ activeSourceId: el.sourceSelect.value });
}

// ---------- transport / ranged playback ----------
function wireTransport() {
  el.btnPlay.onclick = () => { if (el.srcVideo.paused) el.srcVideo.play(); else el.srcVideo.pause(); };
  el.btnLoop.onclick = () => { loopEnabled = !loopEnabled; el.btnLoop.style.color = loopEnabled ? 'var(--accent)' : ''; };
  el.srcVideo.addEventListener('play', () => el.btnPlay.textContent = '⏸');
  el.srcVideo.addEventListener('pause', () => el.btnPlay.textContent = '▶');
  el.srcVideo.addEventListener('timeupdate', () => {
    el.origTime.textContent = `${fmtTime(el.srcVideo.currentTime)} / ${fmtTime(el.srcVideo.duration)}`;
    const r = store.ui.playRange;
    if (loopEnabled && r && el.srcVideo.currentTime >= r.end - 0.02) el.srcVideo.currentTime = r.start;
  });
  el.btnLoop.style.color = 'var(--accent)';
}

function playRange(a, b) {
  store.ui.playRange = { start: a, end: b };
  seekTo(a, () => el.srcVideo.play());
}

function seekTo(t, cb) {
  if (el.srcVideo.readyState >= 1) {
    el.srcVideo.currentTime = t;
    if (cb) { const h = () => { el.srcVideo.removeEventListener('seeked', h); cb(); }; el.srcVideo.addEventListener('seeked', h); }
  } else {
    pendingSeek = t;
    if (cb) el.srcVideo.addEventListener('loadeddata', cb, { once: true });
  }
}

// ---------- crop sliders ----------
function wireCrop() {
  const start = () => { if (store.ui.selection.kind === 'output') store.beginAction(); };
  const apply = () => {
    const crop = { panX: +el.panX.value, panY: +el.panY.value, zoom: +el.zoom.value };
    const sel = store.ui.selection;
    if (sel.kind === 'output') {
      store.updateLive(() => { const o = store.getOutput(sel.id); if (o) o.crop = crop; });
    } else {
      store.setUI({ crop });
    }
  };
  for (const s of [el.panX, el.panY, el.zoom]) {
    s.addEventListener('pointerdown', start);
    s.addEventListener('input', apply);
  }
}

// ---------- shortcuts ----------
function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); el.btnSave.click(); }
    else if (e.key === ' ') { e.preventDefault(); el.btnPlay.click(); }
  });
}

// ---------- export ----------
async function doExport() {
  showOverlay('書き出し準備中…');
  try {
    const blob = await exportProject({
      onStatus: (m) => el.overlayMsg.textContent = m,
      onProgress: (p) => el.overlayProg.value = Math.round((p || 0) * 100),
      onLog: (m) => console.debug('[ffmpeg]', m),
    });
    downloadBlob(blob, (store.get().name || 'viralcut') + '.mp4');
    setStatus('書き出し完了');
  } finally { hideOverlay(); }
}

// ---------- state -> UI ----------
function onState(project, ui) {
  // source dropdown
  const opts = project.sources.map(s =>
    `<option value="${s.id}"${s.id === ui.activeSourceId ? ' selected' : ''}>${s.fileName}</option>`).join('');
  if (el.sourceSelect.innerHTML !== opts) el.sourceSelect.innerHTML = opts;

  // selection side-effects (run once per selection change)
  const sel = ui.selection;
  const key = sel.kind + ':' + sel.id;
  if (key !== lastSelKey) { lastSelKey = key; applySelection(); }

  bindVideo(ui);

  // reflect crop in sliders (output's crop if selected, else draft)
  const r = store.resolve();
  const crop = (r && r.crop) || ui.crop;
  if (crop) {
    if (document.activeElement !== el.panX) el.panX.value = crop.panX;
    if (document.activeElement !== el.panY) el.panY.value = crop.panY;
    if (document.activeElement !== el.zoom) el.zoom.value = crop.zoom;
  }

  updateChrome();
}

function applySelection() {
  const r = store.resolve();
  if (!r || !r.source) return;
  if (r.source.id !== store.ui.activeSourceId) {
    pendingSeek = r.in;
    queueMicrotask(() => store.setUI({ activeSourceId: r.source.id }));
  } else {
    seekTo(r.in);
  }
  if (r.material) queueMicrotask(() => srcTimeline.focusMaterial(r.material));
}

function bindVideo(ui) {
  const url = fileOpen.urlFor(ui.activeSourceId);
  if (url && url !== activeUrl) {
    activeUrl = url;
    el.srcVideo.src = url;
    el.srcEmpty.hidden = true;
    el.srcVideo.onloadedmetadata = () => {
      if (pendingSeek != null) { el.srcVideo.currentTime = pendingSeek; pendingSeek = null; }
    };
  } else if (url && pendingSeek != null && el.srcVideo.readyState >= 1) {
    el.srcVideo.currentTime = pendingSeek; pendingSeek = null;
  } else if (!url) {
    el.srcEmpty.hidden = ui.activeSourceId != null;
  }
}

function updateChrome() {
  const p = store.get();
  el.btnAddVideo.disabled = !projectOpen;
  el.sourceSelect.disabled = !p.sources.length;
  el.btnSave.disabled = !projectOpen || !projectStore.dirHandle();
  el.btnExport.disabled = !p.outputs.length;
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
      console.error(err); setStatus('エラー: ' + (err?.message || err)); alert(err?.message || err);
    }
  };
}

init();
