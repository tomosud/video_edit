// store.js - central editing state + pub/sub + undo/redo + IndexedDB autosave
import * as db from './db.js?v=20260711-sessions';

const HISTORY_LIMIT = 100;
const AUTOSAVE_DEBOUNCE = 500;

function emptyProject() {
  return {
    version: 2,
    name: 'untitled',
    output: { width: 1080, height: 1920, fps: 30 },
    sources: [],     // {id, fileName, mediaKey, size, lastModified, duration, fps, width, height, hasAudio}
    materials: [],   // {id, sourceId, in, out, title?, horizontalCrop?, crop?} - cutout clips (shelf)
    outputs: [],     // {id, materialId, captions:[]} - sequence
    bgm: null,
    savedAt: 0,
  };
}

function emptyUI() {
  return {
    activeSourceId: null,
    selection: { kind: null, id: null },   // kind: 'material' | 'output'
    selectedCaptionId: null,
    view: { start: 0, end: 0 },            // source-timeline visible window (sec)
    crop: { panX: 0.5, panY: 0.5, zoom: 1, bgBlur: 1 }, // draft vertical crop
    playRange: null,                        // {start,end} active loop range
    editMaterialId: null,                   // material currently editable on timelines
    editMaterialIds: [],                    // materials currently editable on timelines
    cropEditActive: false,                  // vertical preview crop sliders are visible
    horizontalCrop: { panX: 0.5, panY: 0.5, zoom: 1, bgBlur: 1 },
    horizontalCropEditActive: false,         // horizontal preview crop sliders are visible
  };
}

class Store {
  constructor() {
    this.project = emptyProject();
    this.ui = emptyUI();
    this.sessionId = null;
    this._subs = new Set();
    this._undo = [];
    this._redo = [];
    this._saveTimer = null;
  }

  // ---- pub/sub ----
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _emit() { for (const fn of this._subs) fn(this.project, this.ui); }

  // ---- read ----
  get() { return this.project; }
  getSource(id) { return this.project.sources.find(s => s.id === id); }
  getMaterial(id) { return this.project.materials.find(m => m.id === id); }
  getOutput(id) { return this.project.outputs.find(o => o.id === id); }
  activeSource() { return this.getSource(this.ui.activeSourceId); }
  setSessionId(id) { this.sessionId = id || null; }

  // resolve a selection (or any {kind,id}) to {source, in, out, crop, material, output}
  resolve(sel = this.ui.selection) {
    if (!sel || !sel.kind) return null;
    if (sel.kind === 'material') {
      const m = this.getMaterial(sel.id);
      if (!m) return null;
      return { material: m, output: null, source: this.getSource(m.sourceId),
               in: m.in, out: m.out, crop: m.crop || null };
    }
    if (sel.kind === 'output') {
      const o = this.getOutput(sel.id);
      if (!o) return null;
      const m = this.getMaterial(o.materialId);
      if (!m) return null;
      return { material: m, output: o, source: this.getSource(m.sourceId),
               in: m.in, out: m.out, crop: m.crop || o.crop };
    }
    return null;
  }

  // ---- mutate ----
  update(mutator, { commit = true } = {}) {
    if (commit) this._pushUndo();
    mutator(this.project, this.ui);
    this._redo.length = 0;
    this._emit();
    this._scheduleSave();
  }

  updateLive(mutator) {
    mutator(this.project, this.ui);
    this._emit();
    this._scheduleSave();
  }

  // begin a continuous action (drag): push one undo snapshot now, then use
  // updateLive(...) for each frame so the whole gesture is a single undo step.
  beginAction() { this._pushUndo(); this._redo.length = 0; }

  setUI(patch) {
    Object.assign(this.ui, patch);
    this._emit();
    this._scheduleSave();
  }

  select(kind, id) {
    this.ui.selection = { kind, id };
    this.ui.selectedCaptionId = null;
    this._emit();
  }

  // ---- history ----
  _snapshot() { return JSON.stringify({ project: this.project }); }
  _pushUndo() {
    this._undo.push(this._snapshot());
    if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
    this._persistHistory();
  }
  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  undo() {
    if (!this._undo.length) return;
    this._redo.push(this._snapshot());
    this.project = JSON.parse(this._undo.pop()).project;
    this._emit(); this._scheduleSave(); this._persistHistory();
  }
  redo() {
    if (!this._redo.length) return;
    this._undo.push(this._snapshot());
    this.project = JSON.parse(this._redo.pop()).project;
    this._emit(); this._scheduleSave(); this._persistHistory();
  }

  // ---- IndexedDB persistence ----
  _scheduleSave() {
    clearTimeout(this._saveTimer);
    if (!this.sessionId || !this.project.sources.length) return;
    this._saveTimer = setTimeout(() => {
      const now = Date.now();
      db.saveSession(this.sessionId, {
        project: this.project,
        ui: persistableUI(this.ui),
        savedAt: now,
        updatedAt: now,
        name: sessionName(this.project),
        sourceCount: this.project.sources.length,
        materialCount: this.project.materials.length,
        outputCount: this.project.outputs.length,
      }).then(() => db.pruneSessions(5)).catch((err) => console.warn('session save failed', err));
    }, AUTOSAVE_DEBOUNCE);
  }
  _persistHistory() {
    if (!this.sessionId || !this.project.sources.length) return;
    db.saveSessionHistory(this.sessionId, this.historyState()).catch(() => {});
  }

  async flushSave() {
    clearTimeout(this._saveTimer);
    if (!this.sessionId || !this.project.sources.length) return;
    const now = Date.now();
    await db.saveSession(this.sessionId, {
      project: this.project,
      ui: persistableUI(this.ui),
      savedAt: now,
      updatedAt: now,
      name: sessionName(this.project),
      sourceCount: this.project.sources.length,
      materialCount: this.project.materials.length,
      outputCount: this.project.outputs.length,
    });
    await db.saveSessionHistory(this.sessionId, this.historyState()).catch(() => {});
    await db.pruneSessions(5).catch(() => {});
  }

  historyState() {
    return { undo: this._undo, redo: this._redo };
  }

  loadHistoryState(hist) {
    this._undo = Array.isArray(hist?.undo) ? hist.undo.slice(-HISTORY_LIMIT) : [];
    this._redo = Array.isArray(hist?.redo) ? hist.redo.slice(-HISTORY_LIMIT) : [];
    this._emit();
  }

  async restore(sessionId = this.sessionId) {
    if (!sessionId) return false;
    this.sessionId = sessionId;
    const saved = await db.loadSession(sessionId);
    if (!saved?.project) return false;
    this.project = migrate({ ...emptyProject(), ...saved.project });
    this._undo = []; this._redo = [];
    this.ui = normalizeUI(saved.ui);
    if (!this.getSource(this.ui.activeSourceId)) this.ui.activeSourceId = this.project.sources[0]?.id || null;
    this._emit();
    const hist = await db.loadSessionHistory(sessionId).catch(() => null);
    this.loadHistoryState(hist);
    return true;
  }

  async restoreLegacyAutosave() {
    const saved = await db.loadAutosave();
    if (!saved?.project) return false;
    this.project = migrate({ ...emptyProject(), ...saved.project });
    this._undo = []; this._redo = [];
    this.ui = normalizeUI(saved.ui);
    if (!this.getSource(this.ui.activeSourceId)) this.ui.activeSourceId = this.project.sources[0]?.id || null;
    this._emit();
    const hist = await db.loadHistory().catch(() => null);
    this.loadHistoryState(hist);
    this._scheduleSave();
    return true;
  }

  load(project) {
    this.project = migrate({ ...emptyProject(), ...project });
    this._undo = []; this._redo = [];
    this.ui = emptyUI();
    this.ui.activeSourceId = this.project.sources[0]?.id || null;
    this._emit(); this._scheduleSave(); this._persistHistory();
  }
}

function sessionName(project) {
  return project.name && project.name !== 'untitled'
    ? project.name
    : project.sources[0]?.fileName || 'Untitled edit';
}

function persistableUI(ui) {
  return {
    activeSourceId: ui.activeSourceId,
    selection: ui.selection,
    view: ui.view,
    crop: ui.crop,
    horizontalCrop: ui.horizontalCrop,
  };
}

function normalizeUI(saved = {}) {
  const ui = { ...emptyUI(), ...(saved || {}) };
  ui.crop = { ...defaultCrop(), ...(saved.crop || {}) };
  ui.horizontalCrop = { ...defaultHorizontalCrop(), ...(saved.horizontalCrop || saved.sourceCrop || {}) };
  delete ui.sourceCrop;
  ui.cropEditActive = false;
  ui.horizontalCropEditActive = false;
  return ui;
}

// migrate older (v1: clips[]) projects to v2 (materials/outputs)
function migrate(p) {
  if (p.version >= 2) return normalizeProject(p);
  const materials = [], outputs = [];
  for (const c of (p.clips || [])) {
    const mId = c.id || uid('mat');
    materials.push({ id: mId, sourceId: c.sourceId, in: c.in, out: c.out, crop: c.crop || defaultCrop() });
    outputs.push({ id: uid('out'), materialId: mId, texts: c.texts || [] });
  }
  return normalizeProject({ ...p, version: 2, materials, outputs, clips: undefined });
}

function defaultCrop() { return { panX: .5, panY: .5, zoom: 1, bgBlur: 1 }; }
function defaultHorizontalCrop() { return { panX: .5, panY: .5, zoom: 1, bgBlur: 1 }; }

function normalizeProject(p) {
  const outputs = p.outputs || [];
  for (const m of (p.materials || [])) {
    if (!m.crop) {
      const out = outputs.find(o => o.materialId === m.id && o.crop);
      m.crop = out?.crop || defaultCrop();
    }
    m.crop = { ...defaultCrop(), ...m.crop };
    m.horizontalCrop = { ...defaultHorizontalCrop(), ...(m.horizontalCrop || m.sourceCrop || {}) };
    delete m.sourceCrop;
  }
  for (const o of outputs) {
    delete o.crop;
    delete o.caption;
    o.captions = Array.isArray(o.captions) ? o.captions : [];
  }
  return p;
}

export const store = new Store();
export { emptyProject };

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

