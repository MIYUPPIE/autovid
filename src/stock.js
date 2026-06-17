import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { BROWSER_HEADERS, downloadToFile, pickAgent } from './http.js';

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
    headers: { ...BROWSER_HEADERS, Authorization: config.pexelsKey },
    agent: pickAgent,
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
  const res = await fetch(`https://pixabay.com/api/videos/?${params}`, { headers: BROWSER_HEADERS, agent: pickAgent });
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

// A YouTube watch/share URL — used to route downloads through yt-dlp and to
// recognize a candidate the editor swapped in by hand.
const YT_URL_RE = /(?:youtube\.com\/(?:watch\?|shorts\/|embed\/)|youtu\.be\/)/i;
export function isYouTubeUrl(url) {
  return YT_URL_RE.test(String(url || ''));
}

// Public thumbnail for a video id — no API key, always reachable.
function ytThumb(id) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/**
 * Search YouTube via yt-dlp (no API key). Returns candidates shaped like the other
 * providers but with `provider:'youtube'`, a `thumb` image URL (YouTube can't be
 * previewed in a bare <video> tag) and the watch-page `url`. Width/height are
 * unknown from a flat search, so orientation scoring is a no-op for these — fine,
 * since YouTube is a user-driven extra source, not the auto-pipeline default.
 *
 * Resolves to [] if yt-dlp is missing or the search errors, so a YouTube outage
 * never breaks a search that also has Pexels/Pixabay results.
 */
export async function searchYouTube(query, limit = 12) {
  const q = String(query || '').trim();
  if (!q) return [];
  return new Promise((resolve) => {
    const args = [
      `ytsearch${limit}:${q}`,
      '--flat-playlist', '--dump-json',
      '--no-warnings', '--no-playlist', '--skip-download',
      '--match-filter', 'duration>3', // skip 0-length live/upcoming entries
    ];
    let cp;
    try {
      cp = spawn(config.ytDlpBin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve([]);
    }
    let buf = '';
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    const killer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch { /* gone */ } finish([]); }, config.youtubeSearchTimeout);
    cp.stdout.on('data', (d) => { buf += d; });
    cp.on('error', () => { clearTimeout(killer); finish([]); }); // yt-dlp not installed
    cp.on('close', () => {
      clearTimeout(killer);
      const out = [];
      for (const line of buf.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const d = JSON.parse(t);
          if (!d.id) continue;
          const thumbs = Array.isArray(d.thumbnails) ? d.thumbnails : [];
          out.push({
            provider: 'youtube',
            id: d.id,
            url: d.url || `https://www.youtube.com/watch?v=${d.id}`,
            thumb: (thumbs.length && thumbs[thumbs.length - 1].url) || ytThumb(d.id),
            title: d.title || '',
            duration: d.duration || 0,
            width: 0,
            height: 0,
          });
        } catch { /* skip a malformed json line */ }
      }
      finish(out);
    });
  });
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

// Fisher-Yates shuffle using an injectable RNG (so tests are deterministic and
// production gets real variety). Returns a NEW array; the input is untouched.
export function shuffle(arr, rng = Math.random) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Rank ONE provider's candidates for selection. Best-first by score, with two
 * deliberate twists that fix the "same clip every render" complaint:
 *   1. Clips are grouped into equal-score TIERS and shuffled within each tier, so
 *      the same query doesn't always return the same top clip — variety with no
 *      quality loss (a tier's clips are equally good by our scoring).
 *   2. `recent` (clip keys used by previous renders) floats matching clips to the
 *      BACK. Soft, not hard: a recently-used clip is still available if the fresh
 *      pool runs dry, so we never regress to a text card just to avoid a repeat.
 *      This is what stops Pexels/Pixabay handing back the same footage every time
 *      you generate a similar topic.
 */
export function rankProvider(arr, orientation, minDur = 0, { rng = Math.random, recent = new Set() } = {}) {
  const groups = new Map(); // `${fresh}:${score}` -> [clips]
  for (const c of arr || []) {
    const fresh = recent.has(clipKey(c)) ? 0 : 1;
    const key = `${fresh}:${scoreCandidate(c, orientation, minDur)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const order = [...groups.keys()].sort((x, y) => {
    const [fx, sx] = x.split(':').map(Number);
    const [fy, sy] = y.split(':').map(Number);
    return fy - fx || sy - sx; // fresh before recent, then higher score first
  });
  const out = [];
  for (const k of order) out.push(...shuffle(groups.get(k), rng));
  return out;
}

/**
 * Round-robin merge across providers so every source is used EQUALLY at the head
 * of the list, regardless of absolute score. YouTube clips carry no width/height
 * from a flat search, so under the old score-merge they always ranked below shaped
 * stock and were never reached within the per-query attempt budget — round-robin
 * gives each enabled source an equal turn. `start` rotates which provider goes
 * first so callers can vary the lead per scene. Each list is assumed already
 * ranked (see rankProvider); empty providers are skipped.
 */
export function roundRobin(lists, start = 0) {
  const ls = (lists || []).filter((l) => l && l.length);
  if (!ls.length) return [];
  const n = ls.length;
  const s = ((start % n) + n) % n;
  const max = Math.max(...ls.map((l) => l.length));
  const out = [];
  for (let r = 0; r < max; r++) {
    for (let k = 0; k < n; k++) {
      const list = ls[(s + k) % n];
      if (r < list.length) out.push(list[r]);
    }
  }
  return out;
}

/**
 * Return ALL candidate clips for a query, ranked best-first WITHIN each provider
 * and round-robined ACROSS providers so Pexels, Pixabay and YouTube are used
 * equally (not always topped out on Pexels). The pipeline tries them in order so
 * one bad/slow download can't kill a render. `lead` names the provider that goes
 * first in the round-robin — rotate it across scenes for source variety. `minDur`
 * biases toward clips long enough to cover the scene without looping.
 *
 * `sources` selects which providers to pull (default: the two free-stock APIs; add
 * 'youtube' for yt-dlp results). `opts.rng` injects an RNG for deterministic tests;
 * `opts.recent` is a Set of clip keys from past renders, floated to the back so
 * footage isn't repeated render-to-render. The 5-arg call sites stay unchanged.
 */
export async function findClipCandidates(
  query, orientation, lead = 'pexels', minDur = 0,
  sources = ['pexels', 'pixabay'], { rng = Math.random, recent = new Set() } = {},
) {
  const want = new Set(sources);
  const [p1, p2, yt] = await Promise.all([
    want.has('pexels') ? searchPexels(query, orientation).catch(() => []) : [],
    want.has('pixabay') ? searchPixabay(query, orientation).catch(() => []) : [],
    want.has('youtube') ? searchYouTube(query).catch(() => []) : [],
  ]);
  const ranked = {
    pexels: rankProvider(p1, orientation, minDur, { rng, recent }),
    pixabay: rankProvider(p2, orientation, minDur, { rng, recent }),
    youtube: rankProvider(yt, orientation, minDur, { rng, recent }),
  };
  // Keep the caller's source order, drop empty providers, rotate so `lead` is first.
  const order = sources.filter((s) => ranked[s] && ranked[s].length);
  const start = Math.max(0, order.indexOf(lead));
  return roundRobin(order.map((s) => ranked[s]), start);
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
 * Delegates to downloadToFile, which sends browser headers (so Cloudflare-fronted
 * CDNs like cdn.pixabay.com don't reset the connection from a VPS IP), retries
 * transient failures, applies an IDLE-stall timeout and a size cap, and throws an
 * error with a real, non-empty message. On any failure the partial file is removed.
 */
export async function downloadClip(url, filenameBase) {
  if (isYouTubeUrl(url)) return downloadYouTube(url, filenameBase);
  const dest = path.join(config.dirs.raw, `${filenameBase}.mp4`);
  return downloadToFile(url, dest, {
    idleTimeout: config.downloadTimeout,
    maxBytes: config.maxClipMb * 1024 * 1024,
    minBytes: MIN_CLIP_BYTES,
    attempts: 3,
  });
}

/**
 * Build the yt-dlp argv for a section download. Pure + exported so the format
 * logic is unit-testable without spawning anything.
 *
 * QUALITY: the old string was `b[height<=720][ext=mp4]/…` — `b[ext=mp4]` means a
 * PROGRESSIVE (pre-muxed) mp4, which YouTube only serves at 360p (itag 18). So
 * every YouTube clip came out 360p regardless of what the source offered. Now we
 * select separate hi-res video + audio (`bv*+ba`) capped at maxHeight and let
 * yt-dlp merge them, with `-S` sorting to prefer the highest res ≤ cap and h264/
 * aac/mp4 so the downstream ffmpeg stays a fast copy/no-extra-transcode path.
 */
export function ytDlpDownloadArgs(url, dest, { sec, maxHeight } = {}) {
  const s = Math.max(5, Number(sec) || 30);
  const h = Math.max(240, Number(maxHeight) || 1080);
  return [
    url,
    // Prefer merged video+audio at the best resolution ≤ h; fall back to best
    // single-file ≤ h, then absolute best. NEVER pin to progressive-only.
    '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`,
    // Within the picked set, prefer highest res, then fps, then h264/aac/mp4.
    '-S', `res,fps,vcodec:h264,acodec:aac,ext:mp4`,
    '--download-sections', `*0-${s}`, '--force-keyframes-at-cuts',
    '--no-playlist', '--no-warnings', '--no-part',
    '-N', '4',                         // parallel fragments → faster hi-res pulls
    '--merge-output-format', 'mp4',
    '-o', dest,
  ];
}

/**
 * Download a short opening SECTION of a YouTube video as mp4 via yt-dlp. We only
 * ever use a few seconds of footage and trim later, so pulling just the head keeps
 * a long source to a small download. Pulls up to config.youtubeMaxHeight (1080p
 * by default), writes to the raw asset folder, returns the local path. Throws a
 * real message on failure (missing yt-dlp, geo-block, age-gate, timeout) so the
 * caller can fall through to the next candidate.
 */
export async function downloadYouTube(url, filenameBase) {
  fs.mkdirSync(config.dirs.raw, { recursive: true });
  const dest = path.join(config.dirs.raw, `${filenameBase}.mp4`);
  const args = ytDlpDownloadArgs(url, dest, {
    sec: config.youtubeSectionSeconds,
    maxHeight: config.youtubeMaxHeight,
  });
  return new Promise((resolve, reject) => {
    let cp;
    try {
      cp = spawn(config.ytDlpBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return reject(new Error(`yt-dlp not available: ${e.message}`));
    }
    let err = '';
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const killer = setTimeout(() => {
      try { cp.kill('SIGKILL'); } catch { /* gone */ }
      finish(reject, new Error('youtube download timed out'));
    }, config.youtubeDownloadTimeout);
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', (e) => { clearTimeout(killer); finish(reject, new Error(`yt-dlp not available: ${e.message}`)); });
    cp.on('close', (code) => {
      clearTimeout(killer);
      if (fs.existsSync(dest) && fs.statSync(dest).size > MIN_CLIP_BYTES) return finish(resolve, dest);
      try { fs.unlinkSync(dest); } catch { /* nothing to clean */ }
      const last = err.trim().split('\n').filter(Boolean).pop() || `exit ${code}`;
      finish(reject, new Error(`youtube download failed: ${last}`));
    });
  });
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

// Is yt-dlp present? Cached after the first probe — `--version` is cheap and the
// answer doesn't change during a run. Drives the YouTube toggle in the UI.
let _ytAvail = null;
export async function youtubeAvailable() {
  if (_ytAvail != null) return _ytAvail;
  _ytAvail = await new Promise((resolve) => {
    let cp;
    try { cp = spawn(config.ytDlpBin, ['--version'], { stdio: 'ignore' }); }
    catch { return resolve(false); }
    const t = setTimeout(() => { try { cp.kill(); } catch { /* gone */ } resolve(false); }, 4000);
    cp.on('error', () => { clearTimeout(t); resolve(false); });
    cp.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
  return _ytAvail;
}

export function orientationFor(aspect) {
  if (aspect === '9:16') return 'portrait';
  if (aspect === '1:1') return 'square';
  return 'landscape';
}
