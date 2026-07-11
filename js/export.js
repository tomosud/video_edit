// export.js - deterministic frame export via Mediabunny/WebCodecs.
import { store } from './store.js?v=20260707-horizontal-crop';
import { freshFileFor } from './fileOpen.js?v=20260707-horizontal-crop';
import { activeCaptionText, drawCaption } from './captions.js?v=20260711-source-anchor';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  AudioSampleSink,
  AudioSampleSource,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  canEncodeAudio,
  canEncodeVideo,
} from './mediabunny.js?v=20260707-horizontal-crop';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

function sourceById(project, id) {
  return project.sources.find(s => s.id === id) || null;
}

function clipBounds(project, material, outputFps) {
  const src = sourceById(project, material.sourceId);
  const sourceFps = src?.fps || outputFps || 30;
  const duration = src?.duration || 0;
  const maxFrame = duration ? Math.round(duration * sourceFps) : Number.MAX_SAFE_INTEGER;
  const inFrame = clamp(Math.round(material.in * sourceFps), 0, Math.max(0, maxFrame - 1));
  const outFrame = clamp(Math.round(material.out * sourceFps), inFrame + 1, maxFrame);
  const frameCount = Math.max(1, Math.round((outFrame / sourceFps - inFrame / sourceFps) * outputFps));
  return { sourceFps, inFrame, outFrame, inTime: inFrame / sourceFps, outTime: outFrame / sourceFps, frameCount };
}

function drawFrame(ctx, src, outW, outH, crop) {
  const vw = src.width, vh = src.height;
  if (!vw || !vh) return;
  const { panX = 0.5, panY = 0.5, zoom = 1, bgBlur = 1 } = crop || {};
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

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, outW, outH);

  if ((sx < 0 || sy < 0 || sx + cropW > vw || sy + cropH > vh) && bgBlur > 0) {
    const bgScale = Math.max(outW / vw, outH / vh) * 1.08;
    const bgW = vw * bgScale, bgH = vh * bgScale;
    ctx.save();
    ctx.globalAlpha = clamp(bgBlur, 0, 1);
    ctx.filter = 'blur(24px)';
    ctx.drawImage(src, (outW - bgW) / 2, (outH - bgH) / 2, bgW, bgH);
    ctx.restore();
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
  ctx.drawImage(src, vx, vy, sw, sh, dx, dy, dw, dh);
}

function drawHorizontalFrame(ctx, src, outW, outH, crop) {
  const vw = src.width, vh = src.height;
  if (!vw || !vh) return;
  const { panX = 0.5, panY = 0.5, zoom = 1, bgBlur = 1 } = crop || {};

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, outW, outH);

  if (bgBlur > 0) {
    const bgScale = Math.max(outW / vw, outH / vh) * 1.08;
    const bgW = vw * bgScale, bgH = vh * bgScale;
    ctx.save();
    ctx.globalAlpha = clamp(bgBlur, 0, 1);
    ctx.filter = 'blur(24px)';
    ctx.drawImage(src, (outW - bgW) / 2, (outH - bgH) / 2, bgW, bgH);
    ctx.restore();
  }

  const scale = (outH / vh) * Math.max(0.001, zoom);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = dw <= outW ? (outW - dw) * panX : -(dw - outW) * panX;
  const dy = dh <= outH ? (outH - dh) * panY : -(dh - outH) * panY;
  ctx.drawImage(src, dx, dy, dw, dh);
}

async function makeSourceSession(source) {
  const file = await freshFileFor(source.id);
  if (!file) throw new Error(`A video is not linked: ${source.fileName}`);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error(`Video track not found: ${source.fileName}`);
  const videoSink = new CanvasSink(videoTrack, { poolSize: 3 });
  const audioTrack = await input.getPrimaryAudioTrack();
  const audioSink = audioTrack && await audioTrack.canDecode()
    ? new AudioSampleSink(audioTrack)
    : null;
  return { input, videoSink, audioSink };
}

async function chooseCodec(width, height, bitrate) {
  const candidates = ['avc', 'hevc', 'vp9', 'av1'];
  for (const codec of candidates) {
    try {
      if (await canEncodeVideo(codec, { width, height, bitrate, latencyMode: 'quality' })) return codec;
    } catch {
      /* try next */
    }
  }
  throw new Error('No usable video encoder was found in this browser');
}

async function chooseAudioCodec(sampleRate, numberOfChannels, bitrate) {
  const candidates = ['aac', 'opus'];
  for (const codec of candidates) {
    try {
      if (await canEncodeAudio(codec, { sampleRate, numberOfChannels, bitrate })) return codec;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function getFrameCanvas(session, sourceFps, sourceFrame) {
  const t = Math.max(0, sourceFrame / sourceFps);
  const wrapped = await session.videoSink.getCanvas(t);
  if (!wrapped?.canvas) throw new Error(`Failed to read frame: ${sourceFrame}`);
  return wrapped.canvas;
}

async function addAudioClip(audioSource, session, bounds, outputStartTime) {
  if (!session?.audioSink) return;
  for await (let sample of session.audioSink.samples(bounds.inTime, bounds.outTime)) {
    let startFrame = 0;
    let endFrame = sample.numberOfFrames;
    if (sample.timestamp < bounds.inTime) {
      startFrame = Math.round((bounds.inTime - sample.timestamp) * sample.sampleRate);
    }
    if (sample.timestamp + sample.duration > bounds.outTime) {
      endFrame = Math.round((bounds.outTime - sample.timestamp) * sample.sampleRate);
    }
    startFrame = clamp(startFrame, 0, sample.numberOfFrames);
    endFrame = clamp(endFrame, startFrame, sample.numberOfFrames);
    if (startFrame > 0 || endFrame < sample.numberOfFrames) {
      const trimmed = sample.trim(startFrame, endFrame);
      sample.close();
      sample = trimmed;
    }
    if (sample.numberOfFrames <= 0) {
      sample.close();
      continue;
    }
    sample.setTimestamp(outputStartTime + Math.max(0, sample.timestamp - bounds.inTime));
    await audioSource.add(sample);
    sample.close();
  }
}

function outputItems(project) {
  return project.outputs.map(o => {
    const material = project.materials.find(m => m.id === o.materialId);
    return material ? { output: o, material, sourceId: material.sourceId } : null;
  }).filter(Boolean);
}

function cropForItem(item, cropMode) {
  if (cropMode === 'horizontal') {
    return { panX: 0.5, panY: 0.5, zoom: 1, bgBlur: 1, ...(item.material.horizontalCrop || item.material.sourceCrop || {}) };
  }
  return { panX: 0.5, panY: 0.5, zoom: 1, bgBlur: 1, ...(item.material.crop || {}) };
}

export async function exportProject({ width, height, fps: requestedFps, cropMode = 'vertical', onProgress, onStatus } = {}) {
  const project = store.get();
  const items = outputItems(project);
  if (!items.length) throw new Error('No output clips to export');

  const outW = even(width || project.output.width || 608);
  const outH = even(height || project.output.height || 1080);
  const fps = requestedFps || project.output.fps || 30;
  const frameDur = 1 / fps;
  const bitrate = Math.max(2_500_000, Math.round(outW * outH * fps * 0.16));
  const codec = await chooseCodec(outW, outH, bitrate);
  const sourceIds = [...new Set(items.map(it => it.sourceId))];
  const wantsAudio = sourceIds.some(id => sourceById(project, id)?.hasAudio);
  const audioSampleRate = 48_000;
  const audioChannels = 2;
  const audioBitrate = 160_000;
  const audioCodec = wantsAudio ? await chooseAudioCodec(audioSampleRate, audioChannels, audioBitrate) : null;
  if (wantsAudio && !audioCodec) {
    throw new Error('No usable audio encoder was found in this browser');
  }

  onStatus?.(`Preparing encoder (${outW}x${outH} ${fps}fps ${codec}${audioCodec ? ` + ${audioCodec}` : ''})...`);

  const target = new BufferTarget();
  const format = new Mp4OutputFormat();
  const output = new Output({ format, target });
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { alpha: false });
  const canvasSource = new CanvasSource(canvas, {
    codec,
    bitrate,
    keyFrameInterval: Math.max(1, Math.round(fps * 2)),
    latencyMode: 'quality',
    hardwareAcceleration: 'prefer-hardware',
  });
  output.addVideoTrack(canvasSource, { frameRate: fps });
  const audioSource = audioCodec ? new AudioSampleSource({
    codec: audioCodec,
    bitrate: audioBitrate,
    transform: {
      sampleRate: audioSampleRate,
      numberOfChannels: audioChannels,
      sampleFormat: 'f32',
    },
  }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const sessions = new Map();
  try {
    for (const id of sourceIds) {
      const src = sourceById(project, id);
      if (!src) throw new Error(`Source not found: ${id}`);
      sessions.set(id, await makeSourceSession(src));
    }

    const bounds = items.map(it => ({ ...it, bounds: clipBounds(project, it.material, fps) }));
    const totalFrames = bounds.reduce((sum, it) => sum + it.bounds.frameCount, 0) || 1;
    let outFrame = 0;
    let outTime = 0;

    for (let i = 0; i < bounds.length; i++) {
      const it = bounds[i];
      const src = sourceById(project, it.sourceId);
      const session = sessions.get(it.sourceId);
      onStatus?.(`Encoding clip ${i + 1}/${bounds.length}...`);
      if (audioSource) await addAudioClip(audioSource, session, it.bounds, outTime);

      for (let localFrame = 0; localFrame < it.bounds.frameCount; localFrame++) {
        const sourceFrame = clamp(
          Math.round((it.bounds.inTime + localFrame / fps) * it.bounds.sourceFps),
          it.bounds.inFrame,
          it.bounds.outFrame - 1,
        );
        const sourceCanvas = await getFrameCanvas(session, it.bounds.sourceFps, sourceFrame);
        const crop = cropForItem(it, cropMode);
        if (cropMode === 'horizontal') drawHorizontalFrame(ctx, sourceCanvas, outW, outH, crop);
        else drawFrame(ctx, sourceCanvas, outW, outH, crop);
        drawCaption(ctx, outW, outH, activeCaptionText(project, Math.round((outTime + localFrame / fps) * 1000)));
        await canvasSource.add(outFrame / fps, frameDur);

        outFrame++;
        if ((outFrame & 7) === 0 || outFrame === totalFrames) {
          onProgress?.(Math.min(1, outFrame / totalFrames));
          await new Promise(requestAnimationFrame);
        }
      }
      outTime += it.bounds.frameCount / fps;
      if (src) onStatus?.(`${src.fileName}: ${it.bounds.inFrame}-${it.bounds.outFrame - 1}`);
    }

    await output.finalize();
    onProgress?.(1);
    onStatus?.('Export complete');
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    for (const session of sessions.values()) {
      try { session.input.dispose(); } catch { /* ignore */ }
    }
  }
}

export function downloadBlob(blob, name = 'viralcut.mp4') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
