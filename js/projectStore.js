// projectStore.js - project workspace I/O (.viralcut/project.json, history, exports)
import * as db from './db.js?v=20260627-nativepreview3';

const WORK_DIR = '.viralcut';
const PROJECT_FILE = 'project.json';
const HISTORY_FILE = 'history.json';
const WORKSPACE_FILE = 'workspace.json';

const GITIGNORE = `# ViralCut local working data
${WORK_DIR}/

# exported/source media
*.mp4
*.mov
*.mkv
*.webm
*.m4v
`;

export const fsSupported = 'showDirectoryPicker' in window;

let _dirHandle = null;
let _workHandle = null;
let _workspaceId = null;

export function dirHandle() { return _dirHandle; }
export function workspaceId() { return _workspaceId; }
export function sourceHandleKey(sourceId) {
  return _workspaceId ? `workspace:${_workspaceId}:source:${sourceId}:handle` : `source:${sourceId}:handle`;
}

async function ensurePermission(handle, mode = 'readwrite') {
  const opts = { mode };
  if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
  if (!handle.requestPermission) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function writeFile(dir, name, contents) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(contents);
  await w.close();
}

async function writeBlob(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

async function readTextFile(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    return await f.text();
  } catch {
    return null;
  }
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `ws_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function ensureWorkspace(dir) {
  _dirHandle = dir;
  await writeFile(dir, '.gitignore', GITIGNORE);
  _workHandle = await dir.getDirectoryHandle(WORK_DIR, { create: true });

  const text = await readTextFile(_workHandle, WORKSPACE_FILE);
  const meta = text ? JSON.parse(text) : { id: newId(), createdAt: Date.now() };
  _workspaceId = meta.id || newId();
  await writeFile(_workHandle, WORKSPACE_FILE, JSON.stringify({ ...meta, id: _workspaceId, updatedAt: Date.now() }, null, 2));
  await db.saveHandle('projectDir', dir);
  return dir;
}

async function sourceAccessSnapshot(source) {
  const handleKey = source.handleKey || source.access?.handleKey || sourceHandleKey(source.id);
  const access = {
    handleKey,
    fileName: source.fileName,
    size: source.size,
    lastModified: source.lastModified,
    permission: 'unknown',
    savedAt: Date.now(),
  };
  try {
    const handle = await db.loadHandle(handleKey);
    if (handle?.queryPermission) access.permission = await handle.queryPermission({ mode: 'read' });
    else if (handle) access.permission = 'prompt';
    else access.permission = 'missing-handle';
  } catch {
    access.permission = 'unknown';
  }
  return access;
}

async function projectForSave(project) {
  const sources = [];
  for (const source of (project.sources || [])) {
    const access = await sourceAccessSnapshot(source);
    sources.push({ ...source, handleKey: access.handleKey, access });
  }
  return {
    ...project,
    workspaceId: _workspaceId,
    sources,
    savedAt: Date.now(),
  };
}

async function adoptProjectWorkspace(project) {
  if (!project?.workspaceId || project.workspaceId === _workspaceId || !_workHandle) return;
  _workspaceId = project.workspaceId;
  await writeFile(_workHandle, WORKSPACE_FILE, JSON.stringify({ id: _workspaceId, updatedAt: Date.now() }, null, 2));
}

// Create a new project in a freshly chosen workspace folder.
export async function newProject() {
  if (!fsSupported) throw new Error('This browser does not support the File System Access API. Use Chrome or Edge.');
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  await ensureWorkspace(dir);
  return dir.name;
}

// Open an existing workspace folder.
export async function openProject() {
  if (!fsSupported) throw new Error('This browser does not support the File System Access API. Use Chrome or Edge.');
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  await ensureWorkspace(dir);
  const text = await readTextFile(_workHandle, PROJECT_FILE);
  const project = text ? JSON.parse(text) : null;
  await adoptProjectWorkspace(project);
  return { name: dir.name, project };
}

// Try to silently reattach to the last workspace folder.
export async function reattach() {
  const handle = await db.loadHandle('projectDir');
  if (!handle) return null;
  if (!(await ensurePermission(handle))) return null;
  await ensureWorkspace(handle);
  const text = await readTextFile(_workHandle, PROJECT_FILE);
  const project = text ? JSON.parse(text) : null;
  await adoptProjectWorkspace(project);
  return { name: handle.name, project };
}

export async function save(project) {
  if (!_dirHandle || !_workHandle) throw new Error('Project folder is not open');
  if (!(await ensurePermission(_dirHandle))) throw new Error('Write permission is not available');
  const out = await projectForSave(project);
  await writeFile(_workHandle, PROJECT_FILE, JSON.stringify(out, null, 2));
  await writeFile(_dirHandle, '.gitignore', GITIGNORE);
  return out.savedAt;
}

export async function saveHistory(history) {
  if (!_dirHandle || !_workHandle) return;
  if (!(await ensurePermission(_dirHandle))) return;
  await writeFile(_workHandle, HISTORY_FILE, JSON.stringify({ ...history, savedAt: Date.now() }, null, 2));
}

export async function loadHistory() {
  if (!_workHandle) return null;
  const text = await readTextFile(_workHandle, HISTORY_FILE);
  return text ? JSON.parse(text) : null;
}

export async function saveOutputBlob(blob, name) {
  if (!_dirHandle) throw new Error('Project folder is not open');
  if (!(await ensurePermission(_dirHandle))) throw new Error('Write permission is not available');
  await writeBlob(_dirHandle, name, blob);
  return name;
}

// Read a subtitle vtt for a source.
export async function readSubtitle(relPath) {
  if (!_dirHandle || !relPath) return null;
  const [folder, file] = relPath.split('/');
  try {
    const sub = await _dirHandle.getDirectoryHandle(folder);
    return await readTextFile(sub, file);
  } catch {
    return null;
  }
}
