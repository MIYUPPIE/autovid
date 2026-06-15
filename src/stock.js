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

export function scoreCandidate(c, want, minDur = 0) {
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

  // Prefer a clip that covers the whole scene so it doesn't visibly loop. A clip
  // shorter than the scene gets `-stream_loop`-ed (the same footage replays),
  // which reads as repetition; bias toward ones long enough to avoid that.
  if (minDur > 0) {
    if (d >= minDur) score += 3;                 // covers the scene, no loop
    else if (d >= minDur * 0.7) score += 1;      // close — at most a short tail loop
    else if (d > 0) score -= 2;                  // far too short → obvious repeat
  }

  // Judge by the short side so portrait clips (height 1920) aren't mistaken for 4K.
  const shortSide = Math.min(c.width || 0, c.height || 0);
  if (shortSide >= 720 && shortSide <= 1080) score += 2; // sweet spot for a 1080p render
  else if (shortSide > 1080) score -= 1;                 // 4K: needless bytes, we downscale anyway
  return score;
}

// Stable identity for a clip so the pipeline can dedup the SAME clip whether it
// shows up under two queries or two scenes. Provider+id is stable across the two
// resolutions a provider may hand back; url is the fallback.
export function clipKey(c) {
  return c && c.id != null ? `${c.provider}:${c.id}` : c?.url;
}

// Merge two score-sorted lists, alternating provider on score ties. Without this
// a stable concat ([...pexels, ...pixabay]) keeps every tied Pexels clip ahead of
// every Pixabay clip, so with a small per-query attempt budget Pixabay is never
// reached. Alternating on ties keeps the ranking but balances the providers.
// `startFromB` flips which provider wins a score tie at the head of the list, so
// callers can rotate the lead provider across scenes and actually use both
// sources instead of always leading with Pexels.
export function interleaveByScore(a, b, orientation, startFromB = false, minDur = 0) {
  const out = [];
  let i = 0, j = 0, lastFromA = startFromB;
  while (i < a.length || j < b.length) {
    if (j >= b.length) { out.push(a[i++]); continue; }
    if (i >= a.length) { out.push(b[j++]); continue; }
    const sa = scoreCandidate(a[i], orientation, minDur);
    const sb = scoreCandidate(b[j], orientation, minDur);
    if (sa > sb) { out.push(a[i++]); lastFromA = true; }
    else if (sb > sa) { out.push(b[j++]); lastFromA = false; }
    else if (lastFromA) { out.push(b[j++]); lastFromA = false; }
    else { out.push(a[i++]); lastFromA = true; }
  }
  return out;
}

/**
 * Return ALL candidate clips for a query, ranked best-first and provider-balanced
 * (Pexels + Pixabay interleaved). The pipeline tries them in order so one
 * bad/slow download can't kill a render, and so footage isn't all one source.
 * `lead` ('pexels' | 'pixabay') picks which provider wins a score tie at the
 * head — rotate it across scenes for genuine source variety. `minDur` biases
 * toward clips long enough to cover the scene without looping.
 */
export async function findClipCandidates(query, orientation, lead = 'pexels', minDur = 0) {
  const [p1, p2] = await Promise.all([
    searchPexels(query, orientation).catch(() => []),
    searchPixabay(query, orientation).catch(() => []),
  ]);
  const byScore = (arr) =>
    arr.slice().sort((a, b) => scoreCandidate(b, orientation, minDur) - scoreCandidate(a, orientation, minDur));
  return interleaveByScore(byScore(p1), byScore(p2), orientation, lead === 'pixabay', minDur);
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

// Words that already pin a query to an African context — if any is present we
// don't bolt another region term on top.
const AFRICA_HINT = /\b(africa|african|nigeria|nigerian|lagos|abuja|kenya|kenyan|nairobi|ghana|ghanaian|accra|south\s?africa|johannesburg|ethiopia|ethiopian|tanzania|swahili|yoruba|igbo|hausa|sahel|savanna|savannah)\b/i;

/**
 * Bias a stock-footage query toward African scenes when the audience is African.
 * Generic queries ("street market", "students studying") otherwise return mostly
 * Western stock; appending "Africa" pulls culturally relevant footage. Returns an
 * ordered query list: the localized variant FIRST, then the bare query as a
 * fallback so a thin localized result set still finds something. For non-African
 * audiences (or queries already localized) it's just the original query.
 */
export function localizeQuery(query, context) {
  const q = String(query || '').trim();
  if (!q || context !== 'africa' || AFRICA_HINT.test(q)) return [q].filter(Boolean);
  return [`${q} Africa`, q];
}

export function orientationFor(aspect) {
  if (aspect === '9:16') return 'portrait';
  if (aspect === '1:1') return 'square';
  return 'landscape';
}
