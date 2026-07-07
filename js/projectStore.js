// projectStore.js - folder-based project persistence has been removed.
export const fsSupported = false;

export function dirHandle() { return null; }
export function workspaceId() { return null; }
export function sourceHandleKey(sourceId) { return `temporary:${sourceId}:handle`; }

function removed() {
  throw new Error('Project folder save/open was removed. ViralCut now keeps edits only in the current browser session.');
}

export async function newProject() { removed(); }
export async function openProject() { removed(); }
export async function reattach() { return null; }
export async function save() { removed(); }
export async function saveHistory() {}
export async function loadHistory() { return null; }
export async function saveOutputBlob() { removed(); }
export async function readSubtitle() { return null; }

