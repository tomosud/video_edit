// export.js - deterministic frame export via Mediabunny/WebCodecs.
import { store } from './store.js';
import { freshFileFor } from './fileOpen.js';
import { activeCaptionText, drawCaption } from './captions.js';
import { drawVerticalFrame, drawHorizontalFrame } from './drawing.js';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  canEncodeAudio,
  canEncodeVideo,
} from './mediabunny.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

// Yield to the event loop between encode batches. requestAnimationFrame stops
// firing in background tabs and setTimeout gets throttled there (down to once
// per minute), so use a MessageChannel message, which is exempt from timer
// throttling and still lets the browser paint progress updates.
const breathChannel = new MessageChannel();
const breathWaiters = [];
breathChannel.port1.onmessage = () => { breathWaiters.shift()?.(); };
function nextBreath() {
  return new Promise((resolve) => {
    breathWaiters.push(resolve);
    breathChannel.port2.postMessage(0);
  });
}

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

// Fixed export audio format. Mediabunny's AudioSampleSource requires every
// input sample to share one sampleRate/channel layout for the whole track,
// while clips can freely mix mono/stereo and 44.1k/48k sources - so every
// sample (and silence for audio-less clips) is converted to this format
// before it is added.
const EXPORT_AUDIO_RATE = 44_100;
const EXPORT_AUDIO_CHANNELS = 2;

function resampleLinear(src, outFrames) {
  const out = new Float32Array(outFrames);
  const step = src.length / outFrames;
  for (let i = 0; i < outFrames; i++) {
    const pos = i * step;
    const i0 = Math.min(src.length - 1, Math.floor(pos));
    const i1 = Math.min(src.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = src[i0] * (1 - t) + src[i1] * t;
  }
  return out;
}

function toUniformAudioSample(sample, timestamp) {
  const frames = sample.numberOfFrames;
  const channels = Math.max(1, sample.numberOfChannels);
  const planes = [];
  for (let c = 0; c < Math.min(channels, EXPORT_AUDIO_CHANNELS); c++) {
    const buf = new Float32Array(frames);
    sample.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
    planes.push(buf);
  }
  let left = planes[0];
  let right = planes[1] || planes[0]; // mono -> duplicate, >2ch -> first two
  if (sample.sampleRate !== EXPORT_AUDIO_RATE) {
    const outFrames = Math.max(1, Math.round(frames * EXPORT_AUDIO_RATE / sample.sampleRate));
    left = resampleLinear(left, outFrames);
    right = planes[1] ? resampleLinear(planes[1], outFrames) : left;
  }
  const data = new Float32Array(left.length * EXPORT_AUDIO_CHANNELS);
  data.set(left, 0);
  data.set(right, left.length);
  return new AudioSample({
    data,
    format: 'f32-planar',
    numberOfChannels: EXPORT_AUDIO_CHANNELS,
    sampleRate: EXPORT_AUDIO_RATE,
    timestamp,
  });
}

// Keep the audio track continuous and uniform for clips without decodable audio.
async function addSilentClip(audioSource, durationSec, outputStartTime) {
  const totalFrames = Math.round(Math.max(0, durationSec) * EXPORT_AUDIO_RATE);
  const chunkFrames = EXPORT_AUDIO_RATE; // 1-second chunks
  for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - offset);
    const sample = new AudioSample({
      data: new Float32Array(frames * EXPORT_AUDIO_CHANNELS),
      format: 'f32-planar',
      numberOfChannels: EXPORT_AUDIO_CHANNELS,
      sampleRate: EXPORT_AUDIO_RATE,
      timestamp: outputStartTime + offset / EXPORT_AUDIO_RATE,
    });
    await audioSource.add(sample);
    sample.close();
  }
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
    const timestamp = outputStartTime + Math.max(0, sample.timestamp - bounds.inTime);
    const uniform = toUniformAudioSample(sample, timestamp);
    sample.close();
    await audioSource.add(uniform);
    uniform.close();
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

// Holding a Web Lock opts the tab out of Chrome's intensive timer throttling,
// so a backgrounded export keeps running instead of crawling.
export function exportProject(options = {}) {
  if (navigator.locks?.request) {
    return navigator.locks.request('viralcut-export', () => runExport(options));
  }
  return runExport(options);
}

async function runExport({ width, height, fps: requestedFps, cropMode = 'vertical', onProgress, onStatus, writable } = {}) {
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
  const audioSampleRate = EXPORT_AUDIO_RATE;
  const audioChannels = EXPORT_AUDIO_CHANNELS;
  const audioBitrate = 160_000;
  const audioCodec = wantsAudio ? await chooseAudioCodec(audioSampleRate, audioChannels, audioBitrate) : null;
  if (wantsAudio && !audioCodec) {
    throw new Error('No usable audio encoder was found in this browser');
  }

  onStatus?.(`Preparing encoder (${outW}x${outH} ${fps}fps ${codec}${audioCodec ? ` + ${audioCodec}` : ''})...`);

  // Stream straight to disk when a writable is provided; BufferTarget keeps
  // the whole MP4 in memory (~150MB/min at 1080x1920@60fps) and is only safe
  // for short exports.
  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
  const format = new Mp4OutputFormat();
  const output = new Output({ format, target });
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { alpha: false });
  const canvasSource = new CanvasSource(canvas, {
    codec,
    bitrate,
    keyFrameInterval: 2, // seconds (mediabunny unit), not frames
    latencyMode: 'quality',
    hardwareAcceleration: 'prefer-hardware',
  });
  output.addVideoTrack(canvasSource, { frameRate: fps });
  // No mediabunny transform here: samples are already converted to the fixed
  // export format above (the transform cannot fix mixed-format inputs anyway).
  const audioSource = audioCodec ? new AudioSampleSource({
    codec: audioCodec,
    bitrate: audioBitrate,
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
      if (audioSource) {
        if (session?.audioSink) await addAudioClip(audioSource, session, it.bounds, outTime);
        else await addSilentClip(audioSource, it.bounds.frameCount / fps, outTime);
      }

      // Map each output frame to a source timestamp, then decode sequentially:
      // canvasesAtTimestamps pipelines the decoder, unlike per-frame getCanvas
      // which seeks on every call. Timestamps are monotonically non-decreasing.
      const timestamps = new Array(it.bounds.frameCount);
      for (let localFrame = 0; localFrame < it.bounds.frameCount; localFrame++) {
        const sourceFrame = clamp(
          Math.round((it.bounds.inTime + localFrame / fps) * it.bounds.sourceFps),
          it.bounds.inFrame,
          it.bounds.outFrame - 1,
        );
        timestamps[localFrame] = Math.max(0, sourceFrame / it.bounds.sourceFps);
      }
      const crop = cropForItem(it, cropMode);
      let localFrame = 0;
      for await (const wrapped of session.videoSink.canvasesAtTimestamps(timestamps)) {
        if (!wrapped?.canvas) throw new Error(`Failed to read frame at ${timestamps[localFrame]}s`);
        if (cropMode === 'horizontal') drawHorizontalFrame(ctx, wrapped.canvas, outW, outH, crop);
        else drawVerticalFrame(ctx, wrapped.canvas, outW, outH, crop);
        drawCaption(
          ctx,
          outW,
          outH,
          activeCaptionText(project, Math.round((outTime + localFrame / fps) * 1000)),
          { layout: cropMode },
        );
        await canvasSource.add(outFrame / fps, frameDur);

        outFrame++;
        localFrame++;
        if ((outFrame & 7) === 0 || outFrame === totalFrames) {
          onProgress?.(Math.min(1, outFrame / totalFrames));
          await nextBreath();
        }
      }
      outTime += it.bounds.frameCount / fps;
      if (src) onStatus?.(`${src.fileName}: ${it.bounds.inFrame}-${it.bounds.outFrame - 1}`);
    }

    await output.finalize();
    onProgress?.(1);
    onStatus?.('Export complete');
    // StreamTarget commits and closes the writable itself during finalize.
    return writable ? null : new Blob([target.buffer], { type: 'video/mp4' });
  } catch (err) {
    try { await output.cancel(); } catch { /* ignore */ }
    throw err;
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

