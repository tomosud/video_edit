// imageVideo.js - turn a still image into a normal 30-second video source.
import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  canEncodeVideo,
} from './mediabunny.js';

export const IMAGE_DURATION = 30;
export const IMAGE_FPS = 30;
export const IMAGE_MAX_EDGE = 3840;

export function isImageFile(file) {
  return !!file && (file.type?.startsWith('image/') || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name || ''));
}

async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through for browsers that reject the imageOrientation option.
      try { return await createImageBitmap(file); } catch { /* use <img> below */ }
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function outputSize(width, height) {
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height));
  // Video encoders generally require even dimensions.
  const even = value => Math.max(2, Math.min(IMAGE_MAX_EDGE, Math.round(value / 2) * 2));
  return { width: even(width * scale), height: even(height * scale) };
}

async function chooseCodec(width, height, bitrate) {
  for (const codec of ['avc', 'vp9', 'av1', 'hevc']) {
    try {
      if (await canEncodeVideo(codec, { width, height, bitrate, latencyMode: 'quality' })) return codec;
    } catch {
      /* try the next codec */
    }
  }
  throw new Error('No video encoder is available for this image');
}

export async function imageToVideoFile(file) {
  const image = await decodeImage(file);
  try {
    const sourceWidth = image.width || image.naturalWidth || 0;
    const sourceHeight = image.height || image.naturalHeight || 0;
    if (!sourceWidth || !sourceHeight) throw new Error(`Could not decode image: ${file.name}`);

    const size = outputSize(sourceWidth, sourceHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not create a canvas for the image');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(image, 0, 0, size.width, size.height);

    const bitrate = Math.max(2_500_000, Math.min(16_000_000, Math.round(size.width * size.height * 0.8)));
    const codec = await chooseCodec(size.width, size.height, bitrate);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const source = new CanvasSource(canvas, {
      codec,
      bitrate,
      keyFrameInterval: IMAGE_DURATION,
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
    });
    output.addVideoTrack(source, { frameRate: IMAGE_FPS });
    try {
      await output.start();
      // A lone long-duration sample is treated as a single-frame video by
      // native <video> playback in some browsers. A second sample near the
      // end gives the track a real 30-second timestamp span while remaining
      // compact; the first frame is held between the two timestamps.
      const frameDuration = 1 / IMAGE_FPS;
      const lastFrameTime = IMAGE_DURATION - frameDuration;
      await source.add(0, lastFrameTime);
      await source.add(lastFrameTime, frameDuration);
      await output.finalize();
    } catch (err) {
      try { await output.cancel(); } catch { /* ignore */ }
      throw err;
    }

    const base = (file.name || 'image').replace(/\.[^.]*$/, '') || 'image';
    const video = new File([target.buffer], `${base}.mp4`, {
      type: 'video/mp4',
      lastModified: file.lastModified || Date.now(),
    });
    return { file: video, width: size.width, height: size.height };
  } finally {
    try { image.close?.(); } catch { /* ignore */ }
  }
}
