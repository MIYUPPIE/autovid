import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { config } from './config.js';

/**
 * Search Pexels videos. Returns array of candidate { url, width, height, duration, provider }.
 */
async function searchPexels(query, orientation) {
  if (!config.pexelsKey) return [];
  const params = new URLSearchParams({
    query,
    per_page: '15',
    orientation, // landscape | portrait | square
  });
  const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: config.pexelsKey },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const out = [];
  for (const v of data.videos || []) {
    // Pick the highest-res progressive mp4 file under ~1080p
    const files = (v.video_files || [])
      .filter((f) => f.file_type === 'video/mp4' && f.link)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const pick =
      files.find((f) => (f.height || 0) <= 1080) || files[0];
    if (pick) {
      out.push({
        url: pick.link,
        width: pick.width,
        height: pick.height,
        duration: v.duration,
        provider: 'pexels',
        id: v.id,
      });
    }
  }
  return out;
}

/**
 * Search Pixabay videos.
 */
async function searchPixabay(query, orientation) {
  if (!config.pixabayKey) return [];
  const params = new URLSearchParams({
    key: config.pixabayKey,
    q: query,
    per_page: '15',
    video_type: 'film',
  });
  const res = await fetch(`https://pixabay.com/api/videos/?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const out = [];
  for (const v of data.hits || []) {
    const streams = v.videos || {};
    const pick = streams.large || streams.medium || streams.small;
    if (pick && pick.url) {
      out.push({
        url: pick.url,
        width: pick.width,
        height: pick.height,
        duration: v.duration,
        provider: 'pixabay',
        id: v.id,
      });
    }
  }
  return out;
}

export function scoreCandidate(c, want) {
  // Prefer correct orientation, a usable clip length, and ~720-1080p (not 4K).
  let score = 0;
  const ratio = c.width && c.height ? c.width / c.height : 1;
  if (want === 'landscape' && ratio > 1.2) score += 3;
  if (want === 'portrait' && ratio < 0.8) score += 3;
  if (want === 'square' && ratio >= 0.8 && ratio <= 1.2) score += 3;

  const d = c.duration || 0;
  if (d >= 4 && d <= 20) score += 2;       // ideal: long enough, not a huge file
  else if (d > 20 && d <= 35) score += 1;  // usable
  else if (d > 35) score -= 2;             // long clip = big download for a few seconds

  // Judge by the short side so portrait clips (height 1920) aren't mistaken for 4K.
  const shortSide = Math.min(c.width || 0, c.height || 0);
  if (shortSide >= 720 && shortSide <= 1080) score += 2; // sweet spot for a 1080p render
  else if (shortSide > 1080) score -= 1;                 // 4K: needless bytes, we downscale anyway
  return score;
}

/**
 * Return ALL candidate clips for a query, ranked best-first (Pexels + Pixabay).
 * The pipeline tries them in order so one bad/slow download can't kill a render.
 */
export async function findClipCandidates(query, orientation) {
  const [p1, p2] = await Promise.all([
    searchPexels(query, orientation).catch(() => []),
    searchPixabay(query, orientation).catch(() => []),
  ]);
  const all = [...p1, ...p2];
  all.sort((a, b) => scoreCandidate(b, orientation) - scoreCandidate(a, orientation));
  return all;
}

/**
 * Find the single best clip for a query. Kept for back-compat / tests.
 */
export async function findBestClip(query, orientation) {
  const all = await findClipCandidates(query, orientation);
  return all[0] || null;
}

// A finished file smaller than this is treated as a truncated/failed download.
const MIN_CLIP_BYTES = 16 * 1024;

/**
 * Download a clip URL to the raw asset folder. Returns local path.
 *
 * Uses an IDLE timeout (reset on every chunk) so a steadily-streaming file is
 * never killed mid-flight, only a stalled connection. Also caps the total size
 * (config.maxClipMb) — we only use a few seconds, so a giant source is just
 * download tax; oversized files are aborted so the caller tries the next clip.
 * On any failure the partial file is removed and the error is rethrown.
 */
export async function downloadClip(url, filenameBase) {
  const dest = path.join(config.dirs.raw, `${filenameBase}.mp4`);
  const maxBytes = config.maxClipMb * 1024 * 1024;
  const controller = new AbortController();
  let timer;
  const armIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), config.downloadTimeout);
  };
  try {
    armIdle();
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Reject obviously oversized files up front when the server tells us the size.
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      throw new Error(`too large (${Math.round(declared / 1e6)}MB > ${config.maxClipMb}MB)`);
    }

    let got = 0;
    res.body.on('data', (chunk) => {
      armIdle(); // reset the stall clock as bytes arrive
      got += chunk.length;
      if (got > maxBytes) controller.abort(); // bail on files that lied about their size
    });
    await pipeline(res.body, fs.createWriteStream(dest));
    clearTimeout(timer);

    const { size } = fs.statSync(dest);
    if (size < MIN_CLIP_BYTES) throw new Error(`truncated download (${size} bytes)`);
    return dest;
  } catch (err) {
    clearTimeout(timer);
    try { fs.unlinkSync(dest); } catch { /* nothing to clean */ }
    throw err;
  }
}

export function orientationFor(aspect) {
  if (aspect === '9:16') return 'portrait';
  if (aspect === '1:1') return 'square';
  return 'landscape';
}
