import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

// Round to millisecond precision (timeline math, not audio samples).
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Beat grid: the times (seconds) of every beat across [0, duration) for a given
 * tempo and phase offset. Pure. Used to snap scene cuts onto the music.
 */
export function beatGrid(bpm, duration, offset = 0) {
  if (!(bpm > 0) || !(duration > 0)) return [];
  const period = 60 / bpm;
  const times = [];
  // Walk back to the first non-negative beat, then forward across the track.
  let t = offset - Math.ceil(offset / period) * period;
  for (; t < duration - 1e-9; t += period) {
    if (t >= -1e-9) times.push(r3(Math.max(0, t)));
  }
  return times;
}

/**
 * Snap proportional scene durations so each scene CUT lands on a musical beat.
 * This is the whole point of beat-sync: the picture changes on the beat, which is
 * what makes an edit feel "cut" instead of "assembled" (CapCut's signature move).
 *
 * Inputs: `durations` (per-scene seconds, proportional to narration), `beats`
 * (grid times). Each interior boundary is moved to the nearest beat, but kept
 * strictly increasing, with every scene at least `minDur`, and the TOTAL exactly
 * preserved (the last scene absorbs the remainder) so the video still covers the
 * narration. A boundary further than `maxShift` from any beat is left where it is
 * (don't wreck pacing chasing a distant beat). Pure + fully testable.
 */
export function snapToBeats(durations, beats, { minDur = 1.5, maxShift = 2.0 } = {}) {
  if (!Array.isArray(durations) || durations.length <= 1) return (durations || []).slice();
  const total = durations.reduce((a, b) => a + b, 0);
  if (!beats || beats.length === 0 || total <= 0) return durations.slice();

  // Interior boundaries (cumulative); the final boundary (== total) is fixed.
  const bounds = [];
  let acc = 0;
  for (let i = 0; i < durations.length - 1; i++) { acc += durations[i]; bounds.push(acc); }

  const nearestBeat = (t) => {
    let best = t, bestD = Infinity;
    for (const b of beats) { const d = Math.abs(b - t); if (d < bestD) { bestD = d; best = b; } }
    return { value: best, dist: bestD };
  };

  let prev = 0;
  const snapped = bounds.map((target, i) => {
    const { value, dist } = nearestBeat(target);
    let v = dist <= maxShift ? value : target;            // only snap if a beat is close
    const scenesAfter = durations.length - 1 - i;          // boundaries still to place
    v = Math.max(v, prev + minDur);                        // keep this scene >= floor
    v = Math.min(v, total - scenesAfter * minDur);         // leave room for the rest
    if (v <= prev) v = prev + minDur;
    prev = v;
    return v;
  });

  const out = [];
  let last = 0;
  for (const b of snapped) { out.push(r3(b - last)); last = b; }
  out.push(r3(total - last));
  return out;
}

/**
 * Estimate tempo (BPM) + phase offset from an onset-strength envelope by
 * autocorrelation over the plausible BPM band. Pure: `env` is the per-frame
 * onset strength, `hopSec` the seconds between frames. Deterministic, so it's
 * unit-tested on a synthetic click envelope. Returns { bpm, offset, strength }.
 */
export function estimateTempoFromEnvelope(env, hopSec, { minBpm = 70, maxBpm = 160 } = {}) {
  const n = env?.length || 0;
  if (n < 8 || !(hopSec > 0)) return { bpm: 0, offset: 0, strength: 0 };
  const minLag = Math.max(1, Math.round((60 / maxBpm) / hopSec));
  const maxLag = Math.min(n - 1, Math.round((60 / minBpm) / hopSec));

  let bestLag = 0, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    s /= (n - lag); // normalize so longer lags aren't penalized for fewer terms
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  if (!bestLag) return { bpm: 0, offset: 0, strength: 0 };
  const bpm = Math.round((60 / (bestLag * hopSec)) * 10) / 10;

  // Phase: the strongest onset within the first beat period is the downbeat.
  let offFrame = 0, offMax = -Infinity;
  for (let i = 0; i < Math.min(n, bestLag); i++) { if (env[i] > offMax) { offMax = env[i]; offFrame = i; } }
  return { bpm, offset: r3(offFrame * hopSec), strength: bestScore };
}

/**
 * Build an onset-strength envelope from mono PCM: half-wave-rectified frame-to-
 * frame RMS rise. Pure. `pcm` is Int16-like samples. Returns { env, hopSec }.
 */
export function onsetEnvelope(pcm, sampleRate, hop = 512) {
  const frames = Math.floor((pcm.length - hop) / hop);
  const env = new Array(Math.max(0, frames)).fill(0);
  let prevRms = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const s = f * hop;
    for (let i = s; i < s + hop; i++) { const v = pcm[i] / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / hop);
    env[f] = Math.max(0, rms - prevRms); // onsets = energy going UP
    prevRms = rms;
  }
  return { env, hopSec: hop / sampleRate };
}

/**
 * Detect tempo of an audio file. Decodes mono 11025 Hz PCM via ffmpeg, builds the
 * onset envelope, autocorrelates. Returns { bpm, offset, strength } or a zeroed
 * result on any failure (caller falls back to un-snapped cuts). ffmpeg-dependent,
 * so it's covered by the eval smoke test, not the offline gate.
 */
export async function detectTempo(audioPath, { sampleRate = 11025 } = {}) {
  try {
    const { stdout } = await execFileP('ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', audioPath, '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'],
      { maxBuffer: 1024 * 1024 * 256, encoding: 'buffer' });
    const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
    if (pcm.length < sampleRate) return { bpm: 0, offset: 0, strength: 0 };
    const { env, hopSec } = onsetEnvelope(pcm, sampleRate);
    return estimateTempoFromEnvelope(env, hopSec);
  } catch {
    return { bpm: 0, offset: 0, strength: 0 };
  }
}
