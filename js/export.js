// export.js — FFmpeg.wasm: trim + 9:16 crop/scale per clip, then concat -> MP4
import { store } from './store.js';
import { fileFor } from './fileOpen.js';

const FFMPEG_CDN  = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const UTIL_CDN    = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';
const CORE_MT     = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';   // multi-thread (needs SharedArrayBuffer)
const CORE_ST     = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';      // single-thread fallback

let ffmpeg = null;
let fetchFile = null;

// multi-thread core needs cross-origin isolation + SharedArrayBuffer
const canThread = () => (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined');

async function load(onLog) {
  if (ffmpeg) return ffmpeg;
  const { FFmpeg } = await import(/* @vite-ignore */ FFMPEG_CDN);
  const util = await import(/* @vite-ignore */ UTIL_CDN);
  fetchFile = util.fetchFile;
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => onLog?.(message));

  const mt = canThread();
  const base = mt ? CORE_MT : CORE_ST;
  onLog?.(`loading ffmpeg core (${mt ? 'multi-thread' : 'single-thread'})`);
  const cfg = {
    coreURL: await util.toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await util.toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
  };
  if (mt) cfg.workerURL = await util.toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript');
  await ffmpeg.load(cfg);
  return ffmpeg;
}

function probeDims(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => resolve({ w: 1920, h: 1080 });
    v.src = URL.createObjectURL(file);
  });
}

// crop filter for a 9:16 frame from a wxh source given pan/zoom
function cropFilter(w, h, crop, outW, outH) {
  const zoom = crop.zoom || 1;
  let ch = Math.round(h / zoom);
  let cw = Math.round(ch * 9 / 16);
  if (cw > w) { cw = w; ch = Math.round(cw * 16 / 9); }
  if (ch > h) { ch = h; cw = Math.round(ch * 9 / 16); }
  const x = Math.round((w - cw) * (crop.panX ?? 0.5));
  const y = Math.round((h - ch) * (crop.panY ?? 0.5));
  return `crop=${cw}:${ch}:${x}:${y},scale=${outW}:${outH},setsar=1`;
}

const EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv' };
function extOf(file) {
  const m = file.name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : (EXT[file.type] || 'mp4');
}

export async function exportProject({ onProgress, onLog, onStatus } = {}) {
  const p = store.get();
  if (!p.outputs.length) throw new Error('出力クリップがありません');

  // resolve outputs -> {output, material, source}
  const items = p.outputs.map(o => {
    const m = p.materials.find(x => x.id === o.materialId);
    return m ? { output: o, material: m, sourceId: m.sourceId } : null;
  }).filter(Boolean);
  if (!items.length) throw new Error('有効な出力クリップがありません');

  onStatus?.('FFmpeg を読み込み中…');
  const ff = await load(onLog);
  ff.on('progress', ({ progress }) => onProgress?.(progress));

  const { width: outW, height: outH, fps } = p.output;
  const written = new Set();
  const inputName = {};

  // write each unique source once
  for (const it of items) {
    if (written.has(it.sourceId)) continue;
    const file = fileFor(it.sourceId);
    if (!file) throw new Error('未リンクの動画があります');
    const name = `in_${it.sourceId}.${extOf(file)}`;
    onStatus?.(`入力を書き込み中: ${file.name}`);
    await ff.writeFile(name, await fetchFile(file));
    inputName[it.sourceId] = name;
    written.add(it.sourceId);
  }

  // render each output clip to a normalized segment
  const segs = [];
  for (let i = 0; i < items.length; i++) {
    const { output, material, sourceId } = items[i];
    const file = fileFor(sourceId);
    const { w, h } = await probeDims(file);
    const vf = cropFilter(w, h, output.crop || {}, outW, outH);
    const seg = `seg_${i}.mp4`;
    onStatus?.(`クリップ ${i + 1}/${items.length} を処理中…`);
    await ff.exec([
      '-ss', String(material.in), '-to', String(material.out),
      '-i', inputName[sourceId],
      '-vf', vf,
      '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-b:a', '128k',
      '-movflags', '+faststart',
      seg,
    ]);
    segs.push(seg);
  }

  // concat segments (same codec params -> stream copy)
  onStatus?.('結合中…');
  const list = segs.map(s => `file '${s}'`).join('\n');
  await ff.writeFile('list.txt', new TextEncoder().encode(list));
  await ff.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'output.mp4']);

  const data = await ff.readFile('output.mp4');
  const blob = new Blob([data.buffer], { type: 'video/mp4' });

  // cleanup
  for (const s of segs) await ff.deleteFile(s).catch(() => {});
  for (const n of Object.values(inputName)) await ff.deleteFile(n).catch(() => {});
  await ff.deleteFile('output.mp4').catch(() => {});
  await ff.deleteFile('list.txt').catch(() => {});

  return blob;
}

export function downloadBlob(blob, name = 'viralcut.mp4') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
