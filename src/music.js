import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { config } from './config.js';

// Tone → Jamendo mood/genre tags. Instrumental beds that sit under a voiceover.
const TONE_TAGS = {
  engaging: 'corporate inspiring positive',
  documentary: 'cinematic ambient atmospheric',
  energetic: 'energetic upbeat electronic',
  calm: 'calm ambient peaceful',
  inspirational: 'inspiring uplifting cinematic',
};

export function tagsForTone(tone) {
  return TONE_TAGS[tone] || TONE_TAGS.engaging;
}

/**
 * Fetch one royalty-free instrumental track from Jamendo matching the tone.
 * Returns { url, name, artist, license } or null (no key / no results / error).
 */
export async function fetchMusicTrack({ tone, minSeconds = 0 }) {
  if (!config.jamendoClientId) return null;
  const params = new URLSearchParams({
    client_id: config.jamendoClientId,
    format: 'json',
    limit: '20',
    fuzzytags: tagsForTone(tone),
    vocalinstrumental: 'instrumental', // no competing vocals under the narration
    audioformat: 'mp32',
    include: 'licenses',
    order: 'popularity_total',
  });
  let data;
  try {
    const res = await fetch(`https://api.jamendo.com/v3.0/tracks/?${params}`);
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  const hits = (data.results || []).filter((t) => t.audio || t.audiodownload);
  if (hits.length === 0) return null;

  // Prefer a track at least as long as the video so the loop seam is rarely heard.
  const longEnough = hits.filter((t) => (t.duration || 0) >= minSeconds);
  const pool = longEnough.length ? longEnough : hits;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return {
    // Use the streaming `audio` URL: it's a directly-fetchable signed mp3. The
    // `audiodownload` endpoint 302-redirects in a way node-fetch rejects.
    url: pick.audio || pick.audiodownload,
    name: pick.name,
    artist: pick.artist_name,
    license: pick.license_ccurl || pick.shareurl || '',
  };
}

/**
 * Download a music URL into the work dir. Returns local path, or null on failure.
 */
export async function downloadMusic(url, base) {
  const dest = path.join(config.dirs.work, `${base}_music.mp3`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.downloadTimeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(res.body, fs.createWriteStream(dest));
    return dest;
  } catch {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-shot: pick + download a track for the tone. Returns { path, meta } or null.
 */
export async function autoMusic({ tone, minSeconds, base }) {
  const track = await fetchMusicTrack({ tone, minSeconds });
  if (!track) return null;
  const filePath = await downloadMusic(track.url, base);
  if (!filePath) return null;
  return { path: filePath, meta: track };
}
