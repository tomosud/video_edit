// mediaSession.js - shared Mediabunny frame sessions for preview-oriented exact frame reads
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from '../lib/mediabunny.min.js?v=20260627-nativepreview3';
import { fileFor, freshFileFor } from './fileOpen.js?v=20260627-nativepreview3';
import { frameProbeTime } from './util.js?v=20260627-nativepreview3';

const sessions = new Map(); // key -> { file, input, ready, sink, chain }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function cloneCanvas(source) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, source.width || 1);
  c.height = Math.max(1, source.height || 1);
  const ctx = c.getContext('2d');
  if (ctx && source.width && source.height) ctx.drawImage(source, 0, 0);
  return c;
}

function sessionKey(source, opts) {
  const height = opts.height || 0;
  const width = opts.width || 0;
  const fit = opts.fit || '';
  return `${source.id}:${width}x${height}:${fit}`;
}

function disposeEntry(entry) {
  try { entry.input?.dispose(); } catch { /* ignore */ }
}

async function linkedFile(source) {
  return fileFor(source.id) || await freshFileFor(source.id);
}

async function openFrameSession(source, opts = {}) {
  const file = await linkedFile(source);
  if (!file) throw new Error(`Video access has not been restored: ${source.fileName || source.id}`);

  const key = sessionKey(source, opts);
  const existing = sessions.get(key);
  if (existing && existing.file === file) return existing;
  if (existing) disposeEntry(existing);

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const ready = (async () => {
    if (!(await input.canRead())) throw new Error(`Mediabunny cannot read this video: ${source.fileName || source.id}`);
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error(`Video track not found: ${source.fileName || source.id}`);
    if (!(await videoTrack.canDecode().catch(() => false))) {
      throw new Error(`WebCodecs cannot decode this video: ${source.fileName || source.id}`);
    }
    const sinkOpts = { poolSize: opts.poolSize || 2 };
    if (opts.width) sinkOpts.width = opts.width;
    if (opts.height) sinkOpts.height = opts.height;
    if (opts.fit) sinkOpts.fit = opts.fit;
    return new CanvasSink(videoTrack, sinkOpts);
  })();
  const entry = { file, input, ready, sink: null, chain: Promise.resolve() };
  entry.ready = ready.then((sink) => { entry.sink = sink; return sink; });
  sessions.set(key, entry);
  return entry;
}

export async function getVideoFrameCanvas(source, frame, fps, opts = {}) {
  const frameRate = fps || source.fps || 30;
  const duration = source.duration || 0;
  const maxFrame = duration ? Math.max(0, Math.round(duration * frameRate) - 1) : frame;
  const safeFrame = clamp(Math.round(frame), 0, maxFrame);
  const entry = await openFrameSession(source, opts);
  const job = entry.chain.catch(() => {}).then(async () => {
    const sink = await entry.ready;
    const t = frameProbeTime(safeFrame, frameRate, duration);
    const wrapped = await sink.getCanvas(t);
    if (!wrapped?.canvas) throw new Error(`Could not read frame: ${safeFrame}`);
    return cloneCanvas(wrapped.canvas);
  });
  entry.chain = job.catch(() => {});
  return job;
}

export function disposeMediaSessions() {
  for (const entry of sessions.values()) disposeEntry(entry);
  sessions.clear();
}
