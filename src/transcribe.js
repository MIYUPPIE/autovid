// Speech-to-text via faster-whisper (a local, free ASR model — no hosted API).
// Node shells out to src/transcribe.py, which emits JSON segments. This powers
// dub-an-existing-video (#2) and long→shorts (#9). The pure helpers that shape
// the transcript (join text, window math) are unit-tested in the offline gate;
// the model call itself is covered by an opt-in smoke.

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY = path.join(__dirname, 'transcribe.py');

let _available = null;
/** Is faster-whisper importable? Cached. */
export async function transcriberAvailable() {
  if (_available !== null) return _available;
  try {
    // find_spec checks the package is installed WITHOUT importing it (importing
    // faster_whisper loads ctranslate2 and can take >15s) — keeps /api/health fast.
    await execFileP('python3', ['-c',
      'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("faster_whisper") else 1)'],
      { timeout: 15000 });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * Transcribe a media file. Returns { language, duration, segments:[{start,end,text}] }.
 * Throws a clear error if faster-whisper is missing or the model fails. `model`
 * is a whisper size ('tiny'|'base'|'small'|…); 'base' balances speed/quality.
 */
export async function transcribe(mediaPath, { model = 'base', language = null, timeoutMs = 600000 } = {}) {
  if (!(await transcriberAvailable())) {
    throw new Error('faster-whisper not installed. Run: pip install faster-whisper');
  }
  const args = [PY, mediaPath, model, language || ''];
  const { stdout } = await execFileP('python3', args, { maxBuffer: 1024 * 1024 * 64, timeout: timeoutMs });
  let parsed;
  try { parsed = JSON.parse(stdout.trim().split('\n').pop()); }
  catch { throw new Error('transcribe: could not parse model output'); }
  if (parsed.error) throw new Error(`transcribe: ${parsed.error}`);
  parsed.segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  return parsed;
}

/** Join segment texts into one clean transcript string. Pure. */
export function transcriptText(segments) {
  return (segments || []).map((s) => (s.text || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Pick highlight windows for shorts (#9): greedily pack consecutive segments into
 * clips of about [minSec, maxSec], breaking on a long pause between segments or
 * when the next segment would overflow maxSec. Returns [{start,end,text}] windows.
 * Pure + testable; the actual cutting is ffmpeg's job.
 */
export function highlightWindows(segments, { minSec = 15, maxSec = 60, gapBreak = 1.2 } = {}) {
  const segs = (segments || []).filter((s) => s && s.end > s.start);
  const windows = [];
  let cur = null;
  const close = () => { if (cur && cur.end - cur.start >= Math.min(minSec, 1)) windows.push(cur); cur = null; };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!cur) { cur = { start: s.start, end: s.end, text: s.text || '' }; continue; }
    const gap = s.start - cur.end;
    const wouldBe = s.end - cur.start;
    if (wouldBe > maxSec || (gap > gapBreak && cur.end - cur.start >= minSec)) {
      close();
      cur = { start: s.start, end: s.end, text: s.text || '' };
    } else {
      cur.end = s.end;
      cur.text = `${cur.text} ${s.text || ''}`.trim();
    }
  }
  close();
  return windows;
}

/**
 * Choose the best `count` windows for shorts: longest first (more substantial
 * clips), then restored to chronological order. Pure → testable.
 */
export function pickTopWindows(windows, count = 3) {
  return (windows || [])
    .slice()
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .slice(0, Math.max(1, count))
    .sort((a, b) => a.start - b.start);
}

/**
 * Caption cues for one highlight window, retimed so the window starts at t=0
 * (matches an ffmpeg `-ss start -i` cut). Keeps only segments overlapping the
 * window, clamps to its bounds. Pure → testable. Feeds buildKaraokeAss.
 */
export function windowCues(segments, start, end) {
  return (segments || [])
    .filter((s) => s && s.end > start && s.start < end && (s.text || '').trim())
    .map((s) => ({
      start: Math.max(0, s.start - start),
      end: Math.min(end, s.end) - start,
      text: s.text.trim(),
    }))
    .filter((c) => c.end > c.start);
}
