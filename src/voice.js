import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { config } from './config.js';
import { pickAgent } from './http.js';
import { getVoice, edgeVoiceName } from './voices.js';

const execFileP = promisify(execFile);

// "+10%" → 1.10 tempo multiplier for ffmpeg atempo (engines with no native rate).
function rateToTempo(rate) {
  const m = /([+-]?\d+)\s*%/.exec(rate || '');
  const pct = m ? parseInt(m[1], 10) : 0;
  return Math.max(0.5, Math.min(2.0, 1 + pct / 100));
}

/**
 * Probe media duration in seconds using ffprobe.
 */
export async function probeDuration(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  return parseFloat(stdout.trim()) || 0;
}

/**
 * Synthesize a voiceover for `text`, routing to the voice's engine.
 *   edge → mp3 + word-timed SRT
 *   yarn → mp3 via YarnGPT (no SRT; captions are karaoke-timed by the caller)
 * Returns { audioPath, srtPath|null, duration, engine }.
 */
export async function synthesizeVoice({ text, voice, rate = '+0%', pitch = '+0Hz', outBase, onProgress }) {
  const meta = getVoice(voice);
  const engine = meta?.engine || 'edge';
  if (engine === 'yarn') {
    return synthYarn({ text, yarnVoice: meta.yarnVoice, rate, outBase, onProgress });
  }
  return synthEdge({ text, voice: edgeVoiceName(voice), rate, pitch, outBase });
}

async function synthEdge({ text, voice, rate, pitch, outBase }) {
  const audioPath = path.join(config.dirs.audio, `${outBase}.mp3`);
  const srtPath = path.join(config.dirs.audio, `${outBase}.srt`);

  const args = [
    '--voice', voice,
    '--rate', rate,
    '--pitch', pitch,
    '--text', text,
    '--write-media', audioPath,
    '--write-subtitles', srtPath,
  ];

  try {
    await execFileP('edge-tts', args, { maxBuffer: 1024 * 1024 * 16 });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('edge-tts not found. Install with: pip install edge-tts  (see README).');
    }
    throw err;
  }

  const duration = await probeDuration(audioPath);
  return { audioPath, srtPath, duration, engine: 'edge' };
}

// Split text into chunks under YarnGPT's per-request character cap, breaking on
// sentence boundaries (then commas, then hard length) so no word is cut.
export function chunkForYarn(text, max = config.yarnMaxChars) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) || [clean];
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (let s of sentences) {
    // A single sentence longer than max: split on commas / spaces.
    while (s.length > max) {
      const slice = s.slice(0, max);
      const cut = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf(' '));
      const at = cut > max * 0.5 ? cut + 1 : max;
      if (cur) push();
      chunks.push(s.slice(0, at).trim());
      s = s.slice(at);
    }
    if ((cur + s).length > max) push();
    cur += s;
  }
  push();
  return chunks;
}

// Run an async mapper over items with bounded concurrency, preserving order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// YarnGPT statuses worth retrying. Their server returns 500 ("An unexpected
// internal error occurred.") on transient auth/db blips, plus the usual gateway
// codes — a single 5xx must not kill a whole render, so we back off and retry.
const YARN_TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

// Turn YarnGPT's opaque HTTP errors into a message that says what to actually do.
// Their auth layer 500s (instead of 401-ing) when a Bearer key is present but not
// accepted, so a PERSISTENT 500 almost always means a bad/expired key, not a
// payload problem — an empty body 500s the same way, so the request never reaches
// validation. Exported for tests.
export function explainYarnError(status, body = '') {
  const detail = body.slice(0, 200).trim();
  const tail = detail ? ` — ${detail}` : '';
  if (status === 401) {
    return `YarnGPT 401: API key missing or wrong format (must be "Bearer <key>"). Set a valid YARN_API_KEY from https://yarngpt.ai${tail}`;
  }
  if (status === 500) {
    return `YarnGPT 500 after retries: their server returns 500 (not 401) when the key is present but not accepted, so YARN_API_KEY is likely invalid/expired/revoked — verify or rotate it at https://yarngpt.ai. If the key is definitely valid, YarnGPT is having an outage; retry shortly${tail}`;
  }
  if (status >= 500) {
    return `YarnGPT ${status} after retries — the service is having an outage. Retry shortly${tail}`;
  }
  return `YarnGPT ${status}${tail}`;
}

// One throttled, retrying call to the YarnGPT API. Retries transient 5xx/429 with
// exponential backoff (honoring Retry-After), and aborts a stalled attempt at
// yarnTimeoutMs. fetchImpl/sleepImpl are injected so the retry path is unit-tested
// without real network or timers. Returns the node-fetch Response. Exported for tests.
export async function yarnFetch(apiPath, init, { fetchImpl = fetch, sleepImpl = sleep, retries = config.yarnRetries } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.yarnTimeoutMs);
    let res;
    try {
      res = await fetchImpl(`${config.yarnBase}${apiPath}`, { ...init, signal: ctrl.signal, agent: pickAgent });
    } catch (err) {
      clearTimeout(timer);
      const netErr = err.name === 'AbortError'
        ? new Error(`YarnGPT request timed out after ${Math.round(config.yarnTimeoutMs / 1000)}s.`)
        : new Error(`YarnGPT request failed (network): ${err.message}`);
      if (attempt >= retries) throw netErr;
      await sleepImpl(Math.min(15000, config.yarnBackoffMs * 2 ** attempt));
      continue;
    }
    clearTimeout(timer);
    if (res.ok || !YARN_TRANSIENT.has(res.status) || attempt >= retries) return res;
    const retryAfter = Number(res.headers?.get?.('retry-after')) || 0;
    const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(15000, config.yarnBackoffMs * 2 ** attempt);
    await sleepImpl(wait);
  }
}

// One YarnGPT request → mp3 bytes on disk. Throws with a clear, actionable message
// on auth/quota/network/timeout failure so the pipeline surfaces it.
async function yarnRequest({ text, yarnVoice, outPath, fetchImpl, sleepImpl } = {}) {
  if (!config.yarnKey) throw new Error('YARN_API_KEY not set — required for Yoruba/Igbo/Hausa voices.');
  const res = await yarnFetch('/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.yarnKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: yarnVoice, response_format: 'mp3' }),
  }, { fetchImpl, sleepImpl });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(explainYarnError(res.status, body));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 256) throw new Error('YarnGPT returned an empty/too-small audio body.');
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Probe the YarnGPT API with the configured key WITHOUT synthesizing audio: POST
 * an empty body. Auth runs before body validation, so a valid key returns 422
 * (missing text) while a rejected key 500s and a missing/misformatted key 401s.
 * This is the only honest "will Yoruba/Igbo/Hausa actually work" signal — the
 * mere presence of YARN_API_KEY says nothing. Returns { ok, status, reason,
 * message }. Zero synthesis cost; no retries (callers want a fast verdict).
 */
export async function verifyYarn({ fetchImpl = fetch } = {}) {
  if (!config.yarnKey) return { ok: false, status: 0, reason: 'no-key', message: 'YARN_API_KEY not set.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(15000, config.yarnTimeoutMs));
  let res;
  try {
    res = await fetchImpl(`${config.yarnBase}/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.yarnKey}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl.signal,
      agent: pickAgent,
    });
  } catch (err) {
    return { ok: false, status: 0, reason: 'network', message: `YarnGPT unreachable: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
  const s = res.status;
  if (s === 422 || (s >= 200 && s < 300)) return { ok: true, status: s, reason: 'ok', message: 'YarnGPT key accepted.' };
  const body = await res.text().catch(() => '');
  if (s === 401) return { ok: false, status: s, reason: 'bad-key', message: explainYarnError(401, body) };
  if (s >= 500) return { ok: false, status: s, reason: 'rejected-or-down', message: explainYarnError(s, body) };
  return { ok: false, status: s, reason: 'unknown', message: explainYarnError(s, body) };
}

// Chars-per-chunk target: aim for ~yarnConcurrency sentence-aligned chunks so
// one parallel wave covers the whole narration (YarnGPT serves ~4 at once).
// Floor the size so we don't split mid-sentence on short text; cap at the hard
// per-request limit so long narrations still respect the API.
export function yarnChunkTarget(len, {
  concurrency = config.yarnConcurrency,
  min = config.yarnMinChunkChars,
  max = config.yarnMaxChars,
} = {}) {
  return Math.min(max, Math.max(min, Math.ceil((len || 0) / Math.max(1, concurrency))));
}

async function synthYarn({ text, yarnVoice, rate, outBase, onProgress }) {
  const audioPath = path.join(config.dirs.audio, `${outBase}.mp3`);
  const len = (text || '').replace(/\s+/g, ' ').trim().length;
  const chunks = chunkForYarn(text, yarnChunkTarget(len));
  if (chunks.length === 0) throw new Error('YarnGPT: empty narration text.');

  // 1. Synthesize chunks concurrently (bounded), preserving order.
  let done = 0;
  onProgress && onProgress(0, chunks.length);
  const rawParts = await mapLimit(chunks, config.yarnConcurrency, async (chunk, i) => {
    const part = path.join(config.dirs.audio, `${outBase}_y${i}.mp3`);
    await yarnRequest({ text: chunk, yarnVoice, outPath: part });
    onProgress && onProgress(++done, chunks.length);
    return part;
  });

  // 2. Normalize each part to a uniform format (and apply speaking rate), then
  //    probe its REAL duration. Those measured windows are what the captions
  //    anchor to — distributing words across the whole audio drifts because each
  //    chunk carries its own leading/trailing silence and pacing.
  const tempo = rateToTempo(rate);
  const af = tempo !== 1 ? ['-filter:a', `atempo=${tempo.toFixed(3)}`] : [];
  const normParts = [];
  const cues = [];
  let t = 0;
  for (let i = 0; i < rawParts.length; i++) {
    const n = path.join(config.dirs.audio, `${outBase}_yn${i}.mp3`);
    await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', rawParts[i], ...af,
      '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '3', n], { maxBuffer: 1024 * 1024 * 16 });
    const d = await probeDuration(n);
    cues.push({ start: t, end: t + d, text: chunks[i] });
    t += d;
    normParts.push(n);
  }

  // 3. Concat the uniform parts (stream-copy, seamless) into the final mp3.
  if (normParts.length === 1) {
    fs.renameSync(normParts[0], audioPath);
  } else {
    const listPath = path.join(config.dirs.audio, `${outBase}_ylist.txt`);
    fs.writeFileSync(listPath, normParts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', audioPath], { maxBuffer: 1024 * 1024 * 16 });
    for (const f of [...normParts, listPath]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
  for (const f of rawParts) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

  const duration = await probeDuration(audioPath);
  return { audioPath, srtPath: null, duration, engine: 'yarn', cues };
}

/**
 * Synthesize MANY lines for one voice (used by bilingual mode, one line per
 * scene). `items` are [{ id, text, outBase }]; returns [{ id, audioPath,
 * duration }] in order. Both edge and yarn are network calls, so we loop.
 */
export async function synthesizeMany({ items, voice, rate = '+0%' }) {
  if (items.length === 0) return [];
  const meta = getVoice(voice);
  const out = [];
  for (const it of items) {
    const r = meta?.engine === 'yarn'
      ? await synthYarn({ text: it.text, yarnVoice: meta.yarnVoice, rate, outBase: it.outBase })
      : await synthEdge({ text: it.text, voice: edgeVoiceName(voice), rate, pitch: '+0Hz', outBase: it.outBase });
    out.push({ id: it.id, audioPath: r.audioPath, duration: r.duration });
  }
  return out;
}

/**
 * List available edge-tts voices (raw). Useful for the /api/voices/refresh route.
 */
export async function listEdgeVoices() {
  const { stdout } = await execFileP('edge-tts', ['--list-voices'], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout;
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const f = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${f}`;
}

/**
 * Build an SRT for `text` spread across `duration` seconds, one cue per sentence,
 * each cue's length proportional to its character count. Legacy sentence-level
 * fallback; the pipeline now uses karaoke captions (see captions.js). Returns the srt path.
 */
export function buildProportionalSrt(text, duration, srtPath) {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?…]+[.!?…]*/g) || [text.trim()];
  const cleaned = sentences.map((s) => s.trim()).filter(Boolean);
  const totalChars = cleaned.reduce((a, s) => a + s.length, 0) || 1;

  let t = 0;
  const lines = [];
  cleaned.forEach((s, i) => {
    const dur = (s.length / totalChars) * duration;
    const start = t;
    const end = Math.min(duration, t + dur);
    t = end;
    lines.push(`${i + 1}`, `${srtTime(start)} --> ${srtTime(end)}`, s, '');
  });
  fs.writeFileSync(srtPath, lines.join('\n'), 'utf8');
  return srtPath;
}

/**
 * Write an SRT from explicit cues [{ start, end, text }] (seconds). Used for
 * bilingual videos where each line's exact timing is known from its audio.
 */
export function writeSrtCues(cues, srtPath) {
  const lines = [];
  cues.forEach((c, i) => {
    lines.push(`${i + 1}`, `${srtTime(c.start)} --> ${srtTime(c.end)}`, c.text.trim(), '');
  });
  fs.writeFileSync(srtPath, lines.join('\n'), 'utf8');
  return srtPath;
}

export function ensureDirs() {
  for (const d of Object.values(config.dirs)) {
    fs.mkdirSync(d, { recursive: true });
  }
}
