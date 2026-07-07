// mediaInfo.js - Mediabunny-backed source metadata probing
import { ALL_FORMATS, BlobSource, Input } from './mediabunny.js?v=20260707-mediabunny-single';

const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

function snapFps(raw) {
  if (!isFinite(raw) || raw <= 0) return 30;
  let best = COMMON_FPS[0], bestErr = Infinity;
  for (const c of COMMON_FPS) {
    const e = Math.abs(c - raw);
    if (e < bestErr) { bestErr = e; best = c; }
  }
  return (bestErr / best < 0.05) ? best : Math.round(raw * 1000) / 1000;
}

async function resolveDuration(input, tracks, firstTimestamp) {
  const meta = await input.getDurationFromMetadata(tracks, { skipLiveWait: true });
  if (meta != null && isFinite(meta) && meta > firstTimestamp) {
    if (meta - firstTimestamp >= 1) return meta - firstTimestamp;
    const computed = await input.computeDuration(tracks, { skipLiveWait: true });
    return Math.max(0, (isFinite(computed) ? Math.max(meta, computed) : meta) - firstTimestamp);
  }
  const computed = await input.computeDuration(tracks, { skipLiveWait: true });
  return Math.max(0, (isFinite(computed) ? computed : 0) - firstTimestamp);
}

export async function readMediaInfo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) throw new Error('Mediabunny could not read this media file.');

    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    const tracks = [videoTrack, audioTrack].filter(Boolean);
    if (!tracks.length) throw new Error('No audio or video track was found.');

    const firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0);
    const duration = await resolveDuration(input, tracks, firstTimestamp);

    let width = 0, height = 0, fps = 30, videoDecodable = false;
    if (videoTrack) {
      width = await videoTrack.getDisplayWidth().catch(() => 0);
      height = await videoTrack.getDisplayHeight().catch(() => 0);
      videoDecodable = await videoTrack.canDecode().catch(() => false);
      try {
        const stats = await videoTrack.computePacketStats(120);
        fps = snapFps(stats.averagePacketRate);
      } catch {
        fps = 30;
      }
    }

    const hasAudio = audioTrack !== null;
    const audioDecodable = audioTrack ? await audioTrack.canDecode().catch(() => false) : false;
    return { duration, fps, width, height, hasAudio, videoDecodable, audioDecodable };
  } finally {
    input.dispose();
  }
}
