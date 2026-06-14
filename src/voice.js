import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { config, ROOT } from './config.js';
import { getVoice } from './voices.js';

const execFileP = promisify(execFile);
const MMS_SCRIPT = path.join(ROOT, 'src', 'mms_tts.py');

// "+10%" → 1.10 tempo multiplier for ffmpeg atempo (used to honor speaking rate on MMS).
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
 *   mms  → wav via the local GPU model (no SRT; caller estimates subtitle timing)
 * Returns { audioPath, srtPath|null, duration, engine }.
 */
export async function synthesizeVoice({ text, voice, rate = '+0%', pitch = '+0Hz', outBase }) {
  const meta = getVoice(voice);
  const engine = meta?.engine || 'edge';
  if (engine === 'mms') {
    return synthMms({ text, mmsLang: meta.mmsLang, rate, outBase });
  }
  return synthEdge({ text, voice, rate, pitch, outBase });
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

async function synthMms({ text, mmsLang, rate, outBase }) {
  const rawWav = path.join(config.dirs.audio, `${outBase}_mms.wav`);
  const audioPath = path.join(config.dirs.audio, `${outBase}.mp3`);
  const textFile = path.join(config.dirs.audio, `${outBase}.txt`);
  fs.writeFileSync(textFile, text, 'utf8');

  try {
    await execFileP(config.mmsPython, [MMS_SCRIPT, '--lang', mmsLang, '--text-file', textFile, '--out', rawWav],
      { maxBuffer: 1024 * 1024 * 16 });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`MMS python not found at ${config.mmsPython}. Set MMS_PYTHON in .env.`);
    }
    const detail = (err.stderr || err.message || '').toString().split('\n').slice(-3).join(' ');
    throw new Error(`MMS TTS (${mmsLang}) failed: ${detail}`);
  }

  // Encode to mp3 and apply the speaking-rate (MMS has no native rate control).
  const tempo = rateToTempo(rate);
  const af = tempo !== 1 ? ['-filter:a', `atempo=${tempo.toFixed(3)}`] : [];
  await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', rawWav, ...af,
    '-c:a', 'libmp3lame', '-q:a', '3', audioPath], { maxBuffer: 1024 * 1024 * 16 });
  try { fs.unlinkSync(rawWav); } catch { /* ignore */ }

  const duration = await probeDuration(audioPath);
  return { audioPath, srtPath: null, duration, engine: 'mms' };
}

// Encode a wav to mp3, applying the speaking rate (MMS has no native rate control).
async function wavToMp3(rawWav, mp3Path, rate) {
  const tempo = rateToTempo(rate);
  const af = tempo !== 1 ? ['-filter:a', `atempo=${tempo.toFixed(3)}`] : [];
  await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', rawWav, ...af,
    '-c:a', 'libmp3lame', '-q:a', '3', mp3Path], { maxBuffer: 1024 * 1024 * 16 });
  try { fs.unlinkSync(rawWav); } catch { /* ignore */ }
}

/**
 * Synthesize MANY lines for one voice. For MMS this loads the model ONCE for all
 * lines (a big win for long/bilingual scripts); for edge it loops. `items` are
 * [{ id, text, outBase }]; returns [{ id, audioPath, duration }] in order.
 */
export async function synthesizeMany({ items, voice, rate = '+0%' }) {
  if (items.length === 0) return [];
  const meta = getVoice(voice);
  if (meta?.engine === 'mms') {
    const batchFile = path.join(config.dirs.audio, `${items[0].outBase}_batch.json`);
    fs.writeFileSync(batchFile, JSON.stringify(items.map((it) => ({ id: it.outBase, text: it.text }))), 'utf8');
    try {
      await execFileP(config.mmsPython,
        [MMS_SCRIPT, '--lang', meta.mmsLang, '--batch-file', batchFile, '--out-dir', config.dirs.audio],
        { maxBuffer: 1024 * 1024 * 16 });
    } catch (err) {
      const detail = (err.stderr || err.message || '').toString().split('\n').slice(-3).join(' ');
      throw new Error(`MMS batch (${meta.mmsLang}) failed: ${detail}`);
    } finally {
      try { fs.unlinkSync(batchFile); } catch { /* ignore */ }
    }
    const out = [];
    for (const it of items) {
      const wavPath = path.join(config.dirs.audio, `${it.outBase}.wav`);
      const mp3Path = path.join(config.dirs.audio, `${it.outBase}.mp3`);
      await wavToMp3(wavPath, mp3Path, rate);
      out.push({ id: it.id, audioPath: mp3Path, duration: await probeDuration(mp3Path) });
    }
    return out;
  }
  // edge: synthesize each line (network calls are fast enough to loop)
  const out = [];
  for (const it of items) {
    const r = await synthEdge({ text: it.text, voice, rate, pitch: '+0Hz', outBase: it.outBase });
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
 * each cue's length proportional to its character count. Used when the engine
 * gives no timestamps (MMS). Returns the srt path.
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
