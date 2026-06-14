// export.js — browser-native export.
//
// Why not ffmpeg.wasm for the heavy lifting? The source videos can be large
// AV1 streams. ffmpeg.wasm cannot decode them here: copying the whole file into
// MEMFS overflows wasm memory ("Array buffer allocation failed"), and mounting
// via WORKERFS makes the demuxer reads return EAGAIN ("Resource temporarily
// unavailable") so decoding fails. The browser's NATIVE decoder, however, plays
// these files fine (that's what the preview uses).
//
// So we render each output clip with the native <video> decoder onto a 9:16
// canvas (applying crop/pan/zoom), capture canvas + audio with MediaRecorder,
// and record the whole sequence in one pass. If the browser can record MP4
// directly we're done; otherwise we record WebM and transcode just that small,
// already-cropped output to MP4 with ffmpeg.wasm (which now easily fits memory).

import { store } from './store.js';
import { freshFileFor } from './fileOpen.js';

const FFMPEG_BASE = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm';
const FFMPEG_CDN  = `${FFMPEG_BASE}/index.js`;
const FFMPEG_WORKER = `${FFMPEG_BASE}/worker.js`;
const UTIL_CDN    = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';
const CORE_MT     = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';
const CORE_ST     = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

let ffmpeg = null;
const canThread = () => (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined');

// ---------- small DOM/media helpers ----------
function once(el, ev) {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error(`${ev} に失敗`)); };
    const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

function seekTo(video, t) {
  return new Promise((res) => {
    const on = () => { video.removeEventListener('seeked', on); res(); };
    video.addEventListener('seeked', on);
    try { video.currentTime = t; } catch { video.removeEventListener('seeked', on); res(); }
  });
}

// Draw the source frame cropped to a 9:16 (outW x outH) canvas — same math as
// the live crop preview so the export matches what the user sees.
function drawFrame(ctx, video, outW, outH, crop) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const { panX = 0.5, panY = 0.5, zoom = 1 } = crop || {};
  const targetAspect = outW / outH;
  const sourceAspect = vw / vh;

  let baseW, baseH;
  if (sourceAspect > targetAspect) {
    baseH = vh;
    baseW = vh * targetAspect;
  } else {
    baseW = vw;
    baseH = vw / targetAspect;
  }
  const cropW = baseW / zoom;
  const cropH = baseH / zoom;
  const sx = (vw - cropW) * panX;
  const sy = (vh - cropH) * panY;
  const needsBackground = sx < 0 || sy < 0 || sx + cropW > vw || sy + cropH > vh;
  if (needsBackground) {
    const bgScale = Math.max(outW / vw, outH / vh) * 1.08;
    const bgW = vw * bgScale, bgH = vh * bgScale;
    ctx.save();
    ctx.filter = 'blur(24px)';
    ctx.drawImage(video, (outW - bgW) / 2, (outH - bgH) / 2, bgW, bgH);
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.fillRect(0, 0, outW, outH);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);
  }

  const vx = Math.max(0, sx);
  const vy = Math.max(0, sy);
  const vx2 = Math.min(vw, sx + cropW);
  const vy2 = Math.min(vh, sy + cropH);
  const sw = vx2 - vx;
  const sh = vy2 - vy;
  if (sw <= 0 || sh <= 0) return;

  const dx = (vx - sx) / cropW * outW;
  const dy = (vy - sy) / cropH * outH;
  const dw = sw / cropW * outW;
  const dh = sh / cropH * outH;
  ctx.drawImage(video, vx, vy, sw, sh, dx, dy, dw, dh);
}

// Play video from current position until it reaches `outTime`, drawing every
// presented frame to the canvas. Uses requestVideoFrameCallback for accurate
// frame capture, with a rAF fallback.
function recordClip(video, outTime, draw, onTick) {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const finish = () => { if (stopped) return; stopped = true; try { video.pause(); } catch {} resolve(); };
    const fail = (e) => { if (stopped) return; stopped = true; try { video.pause(); } catch {} reject(e); };

    const useRvfc = typeof video.requestVideoFrameCallback === 'function';
    const stepRvfc = (_now, meta) => {
      if (stopped) return;
      const t = (meta && typeof meta.mediaTime === 'number') ? meta.mediaTime : video.currentTime;
      draw();
      if (t >= outTime) { finish(); return; }
      onTick?.(t);
      video.requestVideoFrameCallback(stepRvfc);
    };
    const stepRaf = () => {
      if (stopped) return;
      const t = video.currentTime;
      draw();
      if (t >= outTime) { finish(); return; }
      onTick?.(t);
      requestAnimationFrame(stepRaf);
    };

    video.onended = finish;
    video.onerror = () => fail(new Error('動画の再生に失敗しました'));
    video.play().then(() => {
      if (useRvfc) video.requestVideoFrameCallback(stepRvfc);
      else requestAnimationFrame(stepRaf);
    }).catch(fail);
  });
}

function pickMime(kind) {
  const sup = (m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } };
  const mp4 = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const list = kind === 'mp4' ? mp4 : webm;
  return list.find(sup) || null;
}

// ---------- ffmpeg (only for the small WebM -> MP4 transcode fallback) ----------
async function blobWorkerURL() {
  const res = await fetch(FFMPEG_WORKER, { cache: 'reload' });
  if (!res.ok) throw new Error(`worker.js の取得に失敗 (${res.status})`);
  let code = await res.text();
  code = code.replace(/(["'])(\.\.?\/[^"']+)\1/g, (_m, q, rel) => q + new URL(rel, FFMPEG_WORKER + '').href + q);
  return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}

async function loadFfmpeg(onLog) {
  if (ffmpeg) return ffmpeg;
  const { FFmpeg } = await import(/* @vite-ignore */ FFMPEG_CDN);
  const util = await import(/* @vite-ignore */ UTIL_CDN);
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => onLog?.(message));
  const mt = canThread();
  const base = mt ? CORE_MT : CORE_ST;
  const cfg = {
    classWorkerURL: await blobWorkerURL(),
    coreURL: await util.toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await util.toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
  };
  if (mt) cfg.workerURL = await util.toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript');
  await ffmpeg.load(cfg);
  return ffmpeg;
}

async function transcodeToMp4(webmBlob, { onLog, onStatus }) {
  onStatus?.('MP4 に変換中…');
  const ff = await loadFfmpeg(onLog);
  const tail = [];
  ff.on('log', ({ message }) => { tail.push(message); if (tail.length > 40) tail.shift(); });
  await ff.writeFile('rec.webm', new Uint8Array(await webmBlob.arrayBuffer()));
  let rc;
  try {
    rc = await ff.exec([
      '-i', 'rec.webm',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      'out.mp4',
    ]);
  } catch (e) {
    throw new Error(`MP4 変換に失敗: ${e?.message || e}\n${tail.slice(-12).join('\n')}`);
  }
  if (rc) throw new Error(`MP4 変換が失敗 (code ${rc})\n${tail.slice(-12).join('\n')}`);
  const data = await ff.readFile('out.mp4');
  await ff.deleteFile('rec.webm').catch(() => {});
  await ff.deleteFile('out.mp4').catch(() => {});
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// ---------- main ----------
export async function exportProject({ onProgress, onLog, onStatus } = {}) {
  const p = store.get();
  if (!p.outputs.length) throw new Error('出力クリップがありません');

  const items = p.outputs.map(o => {
    const m = p.materials.find(x => x.id === o.materialId);
    return m ? { output: o, material: m, sourceId: m.sourceId } : null;
  }).filter(Boolean);
  if (!items.length) throw new Error('有効な出力クリップがありません');

  const outW = p.output.width, outH = p.output.height, fps = p.output.fps || 30;
  const totalDur = items.reduce((s, it) => s + Math.max(0, it.material.out - it.material.in), 0) || 1;

  // resolve a fresh File + object URL per unique source
  onStatus?.('入力を準備中…');
  const urlBySource = {};
  for (const it of items) {
    if (urlBySource[it.sourceId]) continue;
    const file = await freshFileFor(it.sourceId);
    if (!file) throw new Error('未リンクの動画があります');
    urlBySource[it.sourceId] = URL.createObjectURL(file);
  }

  // canvas (output frame)
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, outW, outH);

  // hidden video decoder
  const video = document.createElement('video');
  video.playsInline = true; video.preload = 'auto';

  // audio graph: tap the element's audio into a MediaStream we can record
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const actx = new AudioCtx();
  try { await actx.resume(); } catch {}
  const audioDest = actx.createMediaStreamDestination();
  let srcNode = null;
  try {
    srcNode = actx.createMediaElementSource(video);
    srcNode.connect(audioDest);
  } catch (e) {
    onLog?.(`audio tap unavailable, exporting video only: ${e?.message || e}`);
  }

  // combined stream + recorder
  const vStream = canvas.captureStream(fps);
  const tracks = [...vStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()];
  const stream = new MediaStream(tracks);

  const mp4Mime = pickMime('mp4');
  const webmMime = pickMime('webm');
  const mime = mp4Mime || webmMime;
  if (!mime) throw new Error('この環境は録画書き出しに対応していません');
  onLog?.(`recording as ${mime}`);

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const recDone = new Promise((res) => { rec.onstop = res; });

  const cleanup = () => {
    try { srcNode && srcNode.disconnect(); } catch {}
    try { actx.close(); } catch {}
    try { vStream.getTracks().forEach(t => t.stop()); } catch {}
    for (const u of Object.values(urlBySource)) URL.revokeObjectURL(u);
    video.removeAttribute('src'); video.load?.();
  };

  try {
    rec.start(250);
    try { rec.pause(); } catch {}

    let elapsed = 0;
    for (let i = 0; i < items.length; i++) {
      const { output, material, sourceId } = items[i];
      onStatus?.(`クリップ ${i + 1}/${items.length} を録画中…`);

      const url = urlBySource[sourceId];
      if (video.src !== url) { video.src = url; await once(video, 'loadedmetadata'); }
      await seekTo(video, material.in);
      drawFrame(ctx, video, outW, outH, material.crop);

      try { rec.resume(); } catch {}
      const base = elapsed;
      await recordClip(video, material.out, () => drawFrame(ctx, video, outW, outH, material.crop),
        (t) => onProgress?.(Math.min(1, (base + Math.max(0, t - material.in)) / totalDur)));
      try { rec.pause(); } catch {}

      elapsed += Math.max(0, material.out - material.in);
      onProgress?.(Math.min(1, elapsed / totalDur));
    }

    rec.stop();
    await recDone;
  } finally {
    cleanup();
  }

  let blob = new Blob(chunks, { type: mp4Mime ? 'video/mp4' : 'video/webm' });
  if (!mp4Mime) blob = await transcodeToMp4(blob, { onLog, onStatus });

  onStatus?.('完了');
  onProgress?.(1);
  return blob;
}

export function downloadBlob(blob, name = 'viralcut.mp4') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
