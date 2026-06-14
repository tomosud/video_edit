// app.js — entry point: wire UI, sources, transport, shortcuts, persistence
import { store } from './store.js';
import * as projectStore from './projectStore.js';
import * as fileOpen from './fileOpen.js';
import * as cropPreview from './cropPreview.js';
import * as trim from './trimTimeline.js';
import * as clips from './clipList.js';
import { exportProject, downloadBlob } from './export.js';
import { fmtTime } from './util.js';

const $ = (id) => document.getElementById(id);

const el = {
  btnOpenProject: $('btnOpenProject'),
  btnNewProject: $('btnNewProject'),
  btnAddVideo: $('btnAddVideo'),
  btnUndo: $('btnUndo'),
  btnRedo: $('btnRedo'),
  btnSave: $('btnSave'),
  btnExport: $('btnExport'),
  status: $('status'),
  sourceSelect: $('sourceSelect'),
  sourceTime: $('sourceTime'),
  sourceVideo: $('sourceVideo'),
  sourceEmpty: $('sourceEmpty'),
  btnPlay: $('btnPlay'),
  btnSetIn: $('btnSetIn'),
  btnSetOut: $('btnSetOut'),
  btnAddClip: $('btnAddClip'),
  previewCanvas: $('previewCanvas'),
  panX: $('panX'), panY: $('panY'), zoom: $('zoom'),
  clipList: $('clipList'),
  totalDur: $('totalDur'),
  overlay: $('overlay'),
  overlayMsg: $('overlayMsg'),
  overlayProg: $('overlayProg'),
  stripZoom: $('stripZoom'),
};

let projectOpen = false;
let activeUrl = null;

function init() {
  cropPreview.init(el.previewCanvas, el.sourceVideo);
  trim.init({
    scroll: $('stripScroll'),
    inner: $('stripInner'),
    thumbRow: $('thumbRow'),
    trimIn: $('trimIn'),
    trimOut: $('trimOut'),
    trimRange: $('trimRange'),
    playhead: $('playhead'),
    stripZoom: el.stripZoom,
  }, el.sourceVideo);
  clips.init(el.clipList, el.totalDur);

  wireHeader();
  wireTransport();
  wireCrop();
  wireShortcuts();

  store.subscribe(onState);

  // initialize crop draft
  store.setUI({ crop: { panX: 0.5, panY: 0.5, zoom: 1 } });

  // try restore previous session
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
  // overlay restore (autosave) if no project file
  if (!projectOpen) await store.restore();
  updateChrome();
}

// ---------- header ----------
function wireHeader() {
  el.btnNewProject.onclick = guard(async () => {
    const name = await projectStore.newProject();
    projectOpen = true;
    store.load({ name });
    setStatus(`新規プロジェクト: ${name}`);
  });

  el.btnOpenProject.onclick = guard(async () => {
    const { name, project } = await projectStore.openProject();
    projectOpen = true;
    if (project) {
      store.load(project);
      const missing = await fileOpen.relinkAll();
      setStatus(missing.length ? `${name}（未リンク ${missing.length} 件）` : `開いた: ${name}`);
    } else {
      store.load({ name });
      setStatus(`空フォルダを新規プロジェクトに: ${name}`);
    }
  });

  el.btnAddVideo.onclick = guard(async () => { await fileOpen.addVideo(); });

  el.btnSave.onclick = guard(async () => {
    const ts = await projectStore.save(store.get());
    setStatus('保存しました ' + new Date(ts).toLocaleTimeString());
  });

  el.btnUndo.onclick = () => store.undo();
  el.btnRedo.onclick = () => store.redo();

  el.btnExport.onclick = guard(doExport);
}

// ---------- transport ----------
function wireTransport() {
  el.btnPlay.onclick = () => {
    if (el.sourceVideo.paused) el.sourceVideo.play(); else el.sourceVideo.pause();
  };
  el.sourceVideo.addEventListener('play', () => el.btnPlay.textContent = '⏸');
  el.sourceVideo.addEventListener('pause', () => el.btnPlay.textContent = '▶');
  el.sourceVideo.addEventListener('timeupdate', () => {
    el.sourceTime.textContent = `${fmtTime(el.sourceVideo.currentTime)} / ${fmtTime(el.sourceVideo.duration)}`;
  });

  el.btnSetIn.onclick = () => trim.setIn();
  el.btnSetOut.onclick = () => trim.setOut();
  el.btnAddClip.onclick = () => clips.addClipFromTrim(trim.getTrim());

  el.sourceSelect.onchange = () => store.setUI({ activeSourceId: el.sourceSelect.value });
}

// ---------- crop sliders ----------
function wireCrop() {
  const apply = () => store.setUI({ crop: {
    panX: parseFloat(el.panX.value),
    panY: parseFloat(el.panY.value),
    zoom: parseFloat(el.zoom.value),
  }});
  el.panX.oninput = apply;
  el.panY.oninput = apply;
  el.zoom.oninput = apply;
}

// ---------- shortcuts ----------
function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); el.btnSave.click(); }
    else if (e.key === 'i') trim.setIn();
    else if (e.key === 'o') trim.setOut();
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
  } finally {
    hideOverlay();
  }
}

// ---------- state -> UI ----------
function onState(project, ui) {
  // source select
  const opts = project.sources.map(s =>
    `<option value="${s.id}"${s.id === ui.activeSourceId ? ' selected' : ''}>${s.fileName}</option>`).join('');
  if (el.sourceSelect.innerHTML !== opts) el.sourceSelect.innerHTML = opts;

  // bind active source video
  const url = fileOpen.urlFor(ui.activeSourceId);
  if (url && url !== activeUrl) {
    activeUrl = url;
    el.sourceVideo.src = url;
    el.sourceEmpty.hidden = true;
  } else if (!url) {
    el.sourceEmpty.hidden = project.sources.length > 0; // show "add video" only when none
  }

  // crop sliders reflect draft
  if (ui.crop) {
    if (document.activeElement !== el.panX) el.panX.value = ui.crop.panX;
    if (document.activeElement !== el.panY) el.panY.value = ui.crop.panY;
    if (document.activeElement !== el.zoom) el.zoom.value = ui.crop.zoom;
  }

  updateChrome();
}

function updateChrome() {
  const p = store.get();
  const hasSources = p.sources.length > 0;
  el.btnAddVideo.disabled = !projectOpen;
  el.btnSave.disabled = !projectOpen || !projectStore.dirHandle();
  el.btnExport.disabled = !p.clips.length;
  el.btnUndo.disabled = !store.canUndo();
  el.btnRedo.disabled = !store.canRedo();
}

// ---------- helpers ----------
function setStatus(msg) { el.status.textContent = msg; }
function showOverlay(msg) { el.overlayMsg.textContent = msg; el.overlayProg.value = 0; el.overlay.hidden = false; }
function hideOverlay() { el.overlay.hidden = true; }

function guard(fn) {
  return async (...a) => {
    try { await fn(...a); }
    catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled picker
      console.error(err);
      setStatus('エラー: ' + (err?.message || err));
      alert(err?.message || err);
    }
  };
}

init();
