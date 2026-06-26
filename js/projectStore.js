// projectStore.js — project folder I/O (project.json, .gitignore, subtitles/)
import * as db from './db.js';

const GITIGNORE = `# ViralCut — keep edit data in git, source media stays at original paths
*.mp4
*.mov
*.mkv
*.webm
*.m4v
`;

export const fsSupported = 'showDirectoryPicker' in window;

let _dirHandle = null;
export function dirHandle() { return _dirHandle; }

async function ensurePermission(handle, mode = 'readwrite') {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function writeFile(dir, name, contents) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(contents);
  await w.close();
}

async function readTextFile(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    return await f.text();
  } catch { return null; }
}

// Create a new project in a freshly chosen folder
export async function newProject() {
  if (!fsSupported) throw new Error('このブラウザは File System Access API 非対応です（Chrome/Edge を使用）');
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  _dirHandle = dir;
  await db.saveHandle('projectDir', dir);
  await writeFile(dir, '.gitignore', GITIGNORE);
  // ensure standard subfolders exist
  await dir.getDirectoryHandle('subtitles', { create: true });
  return dir.name;
}

// Open an existing project folder
export async function openProject() {
  if (!fsSupported) throw new Error('このブラウザは File System Access API 非対応です（Chrome/Edge を使用）');
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  _dirHandle = dir;
  await db.saveHandle('projectDir', dir);
  const text = await readTextFile(dir, 'project.json');
  if (!text) return { name: dir.name, project: null }; // empty folder -> treat as new
  return { name: dir.name, project: JSON.parse(text) };
}

// Try to silently reattach to the last project folder (with stored permission)
export async function reattach() {
  const handle = await db.loadHandle('projectDir');
  if (!handle) return null;
  if (!(await ensurePermission(handle))) return null;
  _dirHandle = handle;
  const text = await readTextFile(handle, 'project.json');
  return { name: handle.name, project: text ? JSON.parse(text) : null };
}

// Save project.json (+ gitignore) and subtitle files
export async function save(project) {
  if (!_dirHandle) throw new Error('プロジェクトフォルダが開かれていません');
  if (!(await ensurePermission(_dirHandle))) throw new Error('書き込み権限がありません');
  const out = { ...project, savedAt: Date.now() };
  await writeFile(_dirHandle, 'project.json', JSON.stringify(out, null, 2));
  await writeFile(_dirHandle, '.gitignore', GITIGNORE);
  return out.savedAt;
}

// Read a subtitle vtt for a source
export async function readSubtitle(relPath) {
  if (!_dirHandle || !relPath) return null;
  const [folder, file] = relPath.split('/');
  try {
    const sub = await _dirHandle.getDirectoryHandle(folder);
    return await readTextFile(sub, file);
  } catch { return null; }
}
