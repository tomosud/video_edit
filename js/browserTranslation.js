// browserTranslation.js - copy Primary into visible Second fields and capture browser translation
import { store } from './store.js';

const APPLY_DELAY_MS = 700;
const TRANSLATION_EVENT = 'viralcut:caption-translation';

let buttonEl = null;
let rootEl = null;
let onStatus = () => {};
let enabled = false;
let observer = null;
let applyTimer = 0;
let syncTimer = 0;
let copiedSourceById = new Map();

export function init({ button, root, status } = {}) {
  buttonEl = button || null;
  rootEl = root || null;
  onStatus = typeof status === 'function' ? status : () => {};
  if (!buttonEl || !rootEl) return;

  observer = new MutationObserver(scheduleCapture);
  buttonEl.addEventListener('click', toggle);
  store.subscribe(scheduleCopySync);
  updateButton();
}

export function isEnabled() {
  return enabled;
}

function toggle() {
  enabled = !enabled;
  clearTimeout(applyTimer);
  clearTimeout(syncTimer);
  updateButton();

  if (!enabled) {
    observer?.disconnect();
    copiedSourceById.clear();
    onStatus('Auto translate off');
    return;
  }

  observer.observe(rootEl, { childList: true, characterData: true, subtree: true });
  copiedSourceById.clear();
  copyPrimaryIntoSecond();
  onStatus('Primary copied to Second — now use the browser Translate command');
}

function updateButton() {
  if (!buttonEl) return;
  buttonEl.classList.toggle('active', enabled);
  buttonEl.setAttribute('aria-pressed', String(enabled));
  buttonEl.textContent = `🌐 Auto: ${enabled ? 'On' : 'Off'}`;
  buttonEl.title = enabled
    ? 'Primary is copied into visible Second fields. Use the browser Translate command to translate only Second.'
    : 'Copy Primary into Second, then capture browser translation from the visible Second fields.';
}

function scheduleCopySync() {
  if (!enabled || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = 0;
    copyPrimaryIntoSecond();
  }, 0);
}

function copyPrimaryIntoSecond() {
  if (!enabled) return;
  const rows = collectPrimaryCaptions(store.get());
  const nextIds = new Set(rows.map(row => row.id));
  for (const id of copiedSourceById.keys()) {
    if (!nextIds.has(id)) copiedSourceById.delete(id);
  }

  const updates = rows.filter(row => copiedSourceById.get(row.id) !== row.source);
  if (!updates.length) return;
  for (const row of updates) copiedSourceById.set(row.id, row.source);
  const sourceById = new Map(updates.map(row => [row.id, row.source]));
  store.update((project) => {
    for (const output of project.outputs || []) {
      for (const caption of output.captions || []) {
        if (sourceById.has(caption.id)) caption.secondaryText = sourceById.get(caption.id);
      }
    }
  });
  document.dispatchEvent(new CustomEvent(TRANSLATION_EVENT, {
    detail: { updates: updates.map(row => ({ id: row.id, text: row.source })) },
  }));
}

function scheduleCapture() {
  if (!enabled) return;
  clearTimeout(applyTimer);
  applyTimer = setTimeout(captureTranslatedSecond, APPLY_DELAY_MS);
}

function captureTranslatedSecond() {
  if (!enabled) return;
  const translatedById = new Map();
  for (const target of rootEl.querySelectorAll('[data-caption-translation]')) {
    const id = target.dataset.captionTranslation;
    const translated = String(target.innerText || target.textContent || '').trim();
    if (id && translated) translatedById.set(id, translated);
  }

  const updates = [];
  for (const [id, translated] of translatedById) {
    const caption = findCaption(store.get(), id);
    const source = translationLines(caption?.text).join('\n');
    if (caption && translated !== source && String(caption.secondaryText || '') !== translated) {
      updates.push({ id, text: translated });
    }
  }
  if (!updates.length) return;

  const updatesById = new Map(updates.map(row => [row.id, row.text]));
  store.update((project) => {
    for (const output of project.outputs || []) {
      for (const caption of output.captions || []) {
        if (updatesById.has(caption.id)) caption.secondaryText = updatesById.get(caption.id);
      }
    }
  });
  document.dispatchEvent(new CustomEvent(TRANSLATION_EVENT, { detail: { updates } }));
  onStatus(`Captured ${updates.length} translated caption${updates.length === 1 ? '' : 's'} from Second`);
}

function collectPrimaryCaptions(project) {
  const rows = [];
  for (const output of project?.outputs || []) {
    for (const caption of output.captions || []) {
      if (!caption.id) continue;
      const source = translationLines(caption.text).join('\n');
      rows.push({ id: caption.id, source });
    }
  }
  return rows;
}

function findCaption(project, id) {
  for (const output of project?.outputs || []) {
    const caption = (output.captions || []).find(row => row.id === id);
    if (caption) return caption;
  }
  return null;
}

export function translationLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

export { TRANSLATION_EVENT };
