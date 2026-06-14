// store.js — central editing state + pub/sub + undo/redo + debounced autosave
import * as db from './db.js';

const HISTORY_LIMIT = 100;
const AUTOSAVE_DEBOUNCE = 500;

function emptyProject() {
  return {
    version: 1,
    name: 'untitled',
    output: { width: 1080, height: 1920, fps: 30 },
    sources: [],   // {id, fileName, relPath, size, lastModified, duration, subtitleFile}
    clips: [],     // {id, sourceId, in, out, crop:{panX,panY,zoom}, texts:[]}
    bgm: null,
    savedAt: 0,
  };
}

class Store {
  constructor() {
    this.project = emptyProject();
    this.ui = { activeSourceId: null, selectedClipId: null };
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
  getClip(id) { return this.project.clips.find(c => c.id === id); }
  activeSource() { return this.getSource(this.ui.activeSourceId); }

  // ---- mutate ----
  // `commit`: push current state to undo stack before applying (a discrete action)
  update(mutator, { commit = true } = {}) {
    if (commit) this._pushUndo();
    mutator(this.project, this.ui);
    this._redo.length = 0;
    this._emit();
    this._scheduleSave();
  }

  // transient update (e.g. dragging) — no history, no redo clear
  updateLive(mutator) {
    mutator(this.project, this.ui);
    this._emit();
    this._scheduleSave();
  }

  setUI(patch) {
    Object.assign(this.ui, patch);
    this._emit();
  }

  // ---- history ----
  _snapshot() {
    return JSON.stringify({ project: this.project });
  }
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
    const prev = JSON.parse(this._undo.pop());
    this.project = prev.project;
    this._emit();
    this._scheduleSave();
    this._persistHistory();
  }
  redo() {
    if (!this._redo.length) return;
    this._undo.push(this._snapshot());
    const next = JSON.parse(this._redo.pop());
    this.project = next.project;
    this._emit();
    this._scheduleSave();
    this._persistHistory();
  }

  // ---- persistence (IndexedDB autosave layer) ----
  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      db.saveAutosave(this.project).catch(console.error);
    }, AUTOSAVE_DEBOUNCE);
  }
  _persistHistory() {
    db.saveHistory({ undo: this._undo, redo: this._redo }).catch(() => {});
  }

  async restore() {
    const saved = await db.loadAutosave();
    if (saved) this.project = saved;
    const hist = await db.loadHistory();
    if (hist) { this._undo = hist.undo || []; this._redo = hist.redo || []; }
    this._emit();
    return !!saved;
  }

  // ---- replace whole project (open project) ----
  load(project) {
    this.project = { ...emptyProject(), ...project };
    this._undo = []; this._redo = [];
    this.ui.activeSourceId = this.project.sources[0]?.id || null;
    this.ui.selectedClipId = null;
    this._emit();
    this._scheduleSave();
    this._persistHistory();
  }
}

export const store = new Store();
export { emptyProject };

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}
