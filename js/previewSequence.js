// previewSequence.js - deterministic output-sequence preview via Mediabunny exact frames
import { store } from './store.js?v=20260627-nativepreview3';
import { getVideoFrameCanvas } from './mediaSession.js?v=20260627-nativepreview3';
import * as cropPreview from './cropPreview.js?v=20260627-nativepreview3';

let token = 0;
let playing = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function frameBounds(item, source) {
  const fps = source.fps || 30;
  const duration = source.duration || 0;
  const maxFrame = duration ? Math.round(duration * fps) : Number.MAX_SAFE_INTEGER;
  const inFrame = clamp(Math.round(item.in * fps), 0, Math.max(0, maxFrame - 1));
  const outFrame = clamp(Math.round(item.out * fps), inFrame + 1, maxFrame);
  return { fps, inFrame, outFrame };
}

export function isOutputPreviewPlaying() {
  return playing;
}

export function stopOutputPreview() {
  token++;
  playing = false;
}

export async function playOutputPreview(items, hooks = {}) {
  stopOutputPreview();
  const runToken = ++token;
  playing = true;

  let nextDue = performance.now();

  try {
    for (const item of items) {
      if (runToken !== token) return;
      const source = store.getSource(item.sourceId);
      if (!source) continue;
      const bounds = frameBounds(item, source);
      hooks.onClip?.(item, source, bounds);

      for (let frame = bounds.inFrame; frame < bounds.outFrame; frame++) {
        if (runToken !== token) return;
        const canvas = await getVideoFrameCanvas(source, frame, bounds.fps, {
          height: 720,
          fit: 'contain',
          poolSize: 3,
        });
        if (runToken !== token) return;

        cropPreview.drawFrame(canvas, item.crop);
        hooks.onFrame?.(item, source, frame, frame / bounds.fps);

        nextDue += 1000 / bounds.fps;
        const wait = nextDue - performance.now();
        if (wait > 1) await sleep(wait);
        else await new Promise(requestAnimationFrame);
      }
    }
  } finally {
    if (runToken === token) {
      playing = false;
      hooks.onEnd?.();
    }
  }
}
