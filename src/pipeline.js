import path from 'path';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { generateVideoPlan, generateBilingualPlan, planFromScript, planBilingualFromScript, suggestAlternativeQueries } from './xai.js';
import { findClipCandidates, downloadClip, orientationFor } from './stock.js';
import { synthesizeVoice, synthesizeMany } from './voice.js';
import { buildKaraokeAss, parseSrt } from './captions.js';
import { getVoice } from './voices.js';
import fs from 'fs';
import { autoMusic } from './music.js';
import { normalizeClip, concatSilent, finalizeVideo, assembleVoiceTrack } from './ffmpeg.js';

// Bilingual pacing: gap between the two language reads, and after each scene.
const GAP_BETWEEN_LANGS = 0.25;
const GAP_BETWEEN_SCENES = 0.5;

// In-memory job registry. For production, back this with Redis.
const jobs = new Map();

export function getJob(id) {
  return jobs.get(id);
}

function emit(job, stage, message, pct) {
  job.progress = { stage, message, pct };
  job.log.push({ t: Date.now(), stage, message });
}

// How many clips we'll attempt to download per query before giving up on it.
const CANDIDATES_PER_QUERY = 4;

/**
 * Acquire footage for one scene, resilient to slow/dead downloads.
 * Tries the ranked candidates for the primary query, then for each fallback
 * query, downloading in order until one succeeds. Returns { path, clip, usedQuery }
 * or null if nothing could be downloaded.
 *
 * `deps` is injectable so this is unit-testable without hitting the network.
 */
export async function acquireFootage(
  { queries, orientation, base, onAttempt },
  deps = { findClipCandidates, downloadClip },
) {
  const tried = new Set();
  for (const q of queries) {
    let candidates = [];
    try { candidates = await deps.findClipCandidates(q, orientation); } catch { candidates = []; }
    let used = 0;
    for (const clip of candidates) {
      if (tried.has(clip.url) || used >= CANDIDATES_PER_QUERY) continue;
      tried.add(clip.url);
      used += 1;
      onAttempt && onAttempt(q, clip);
      try {
        const filePath = await deps.downloadClip(clip.url, base);
        return { path: filePath, clip, usedQuery: q };
      } catch {
        // slow/stalled/truncated/4xx — fall through to the next candidate
      }
    }
  }
  return null;
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

// The full script as one ordered string per scene (hook folds into the first
// scene, outro into the last) so the narration reads as one continuous story.
export function buildSceneTexts(plan) {
  const n = plan.scenes.length;
  return plan.scenes.map((s, i) => {
    let t = s.narration || '';
    if (i === 0 && plan.hook) t = `${plan.hook} ${t}`;
    if (i === n - 1 && plan.outro) t = `${t} ${plan.outro}`;
    return t.trim();
  });
}

// Split `total` seconds across scenes proportional to text length; never below a
// floor so no clip is a blink. Sum may slightly exceed total — the final mux trims
// the video to the audio length, so video always covers the narration.
export function allocateDurations(sceneTexts, total, floor = 2.5) {
  const lens = sceneTexts.map((t) => Math.max(1, t.length));
  const sum = lens.reduce((a, b) => a + b, 0);
  return lens.map((l) => Math.max(floor, (l / sum) * total));
}

/**
 * Run the full pipeline. Options shape:
 * { topic, context:'africa'|'global', aspect, targetSeconds, tone, voice, rate,
 *   subtitles:bool, bgMusicPath:string|null, fades:bool, motion:bool, autoMusic:bool }
 */
export function runPipeline(opts) {
  const id = nanoid(10);
  const job = {
    id,
    status: 'running',
    createdAt: Date.now(),
    opts,
    log: [],
    progress: { stage: 'init', message: 'Starting', pct: 0 },
    result: null,
    error: null,
  };
  jobs.set(id, job);

  (async () => {
    try {
      const {
        topic, script, context, aspect, targetSeconds, tone, voice, voice2, rate,
        subtitles, bgMusicPath, fades, motion = true, autoMusic: wantMusic = false,
      } = opts;
      const orientation = orientationFor(aspect);
      const language = getVoice(voice)?.lang || 'English';
      const hasScript = Boolean(script && script.trim());
      const bilingual = Boolean(voice2 && getVoice(voice2));
      const language2 = bilingual ? getVoice(voice2).lang : null;

      // 1. Plan — four combinations of {topic|script} × {single|bilingual}.
      let plan;
      if (bilingual && hasScript) {
        emit(job, 'planning', `Localizing your script into ${language} + ${language2}…`, 5);
        plan = await planBilingualFromScript({ script, context, language, language2 });
      } else if (bilingual) {
        emit(job, 'planning', `Writing a bilingual script (${language} + ${language2})…`, 5);
        plan = await generateBilingualPlan({ topic, context, targetSeconds, tone, language, language2 });
      } else if (hasScript) {
        emit(job, 'planning', 'Planning visuals for your script…', 5);
        plan = await planFromScript({ script, context, language });
      } else {
        emit(job, 'planning', `Writing the script with Grok (${language})…`, 5);
        plan = await generateVideoPlan({ topic, context, targetSeconds, tone, language });
      }
      job.plan = plan;
      const n = plan.scenes.length;
      emit(job, 'planning', `Plan ready: "${plan.title}" — ${n} scenes`, 12);

      // 2. Voice track + per-scene visual durations + caption timing.
      let master, captionsPath = null, durations;
      if (bilingual) {
        // Each scene line spoken in language A then language B (own voice/engine each).
        emit(job, 'voice', `Recording ${language} lines…`, 14);
        const resA = await synthesizeMany({
          items: plan.scenes.map((sc) => ({ id: sc.index, text: sc.narration, outBase: `${id}_s${sc.index}_a` })),
          voice, rate,
        });
        emit(job, 'voice', `Recording ${language2} lines…`, 17);
        const resB = await synthesizeMany({
          items: plan.scenes.map((sc) => ({ id: sc.index, text: sc.narration2, outBase: `${id}_s${sc.index}_b` })),
          voice: voice2, rate,
        });

        const lines = [];
        durations = [];
        for (let i = 0; i < n; i++) {
          const sc = plan.scenes[i];
          const tailGap = i === n - 1 ? 0.2 : GAP_BETWEEN_SCENES;
          lines.push({ audioPath: resA[i].audioPath, text: subtitles ? sc.narration : '', gapAfter: GAP_BETWEEN_LANGS });
          lines.push({ audioPath: resB[i].audioPath, text: subtitles ? sc.narration2 : '', gapAfter: tailGap });
          durations.push(resA[i].duration + GAP_BETWEEN_LANGS + resB[i].duration + tailGap);
        }
        const track = await assembleVoiceTrack({ lines, outBase: `${id}_vo` });
        master = { audioPath: track.path, duration: track.duration };
        // Karaoke captions from each line's exact spoken window (both languages).
        if (subtitles && track.cues.length) {
          captionsPath = buildKaraokeAss({
            cues: track.cues, aspect, assPath: path.join(config.dirs.audio, `${id}_vo.ass`),
          });
        }
      } else {
        // ONE flowing narration for the whole video (single utterance → no choppy seams).
        emit(job, 'voice', `Recording one continuous ${language} narration…`, 16);
        const sceneTexts = buildSceneTexts(plan);
        const fullText = sceneTexts.join(' ');
        const m = await synthesizeVoice({
          text: fullText, voice, rate, outBase: `${id}_vo`,
          onProgress: (n, total) => total > 1 &&
            emit(job, 'voice', `Recording ${language} narration… (${n}/${total} chunks)`, 16),
        });
        master = { audioPath: m.audioPath, duration: m.duration };
        if (subtitles) {
          const assPath = path.join(config.dirs.audio, `${id}_vo.ass`);
          // Edge gives real line timings (SRT) → karaoke within each line.
          // YarnGPT gives none → karaoke timed proportionally across the audio.
          const cues = m.srtPath && fs.existsSync(m.srtPath) ? parseSrt(fs.readFileSync(m.srtPath, 'utf8')) : null;
          captionsPath = cues && cues.length
            ? buildKaraokeAss({ cues, aspect, assPath })
            : buildKaraokeAss({ text: fullText, duration: m.duration, aspect, assPath });
        }
        durations = allocateDurations(sceneTexts, m.duration);
      }
      const masterDur = master.duration;

      // 3+4. Footage + normalize per scene, with bounded concurrency (overlaps
      // network downloads with GPU encodes). One bad download can't kill the render.
      let done = 0;
      const sceneFiles = await mapLimit(plan.scenes, 3, async (scene, i) => {
        const base = `${id}_s${scene.index}`;
        let acquired = await acquireFootage({
          queries: [scene.query], orientation, base,
          onAttempt: (q, clip) =>
            emit(job, 'footage', `Scene ${scene.index}: trying ${clip.provider} clip for "${q}"…`, 20 + Math.round((done / n) * 55)),
        });
        if (!acquired) {
          const alts = await suggestAlternativeQueries(scene.query, context);
          acquired = await acquireFootage({ queries: alts, orientation, base });
        }
        if (!acquired) throw new Error(`No usable footage for scene ${scene.index} ("${scene.query}")`);
        scene.usedQuery = acquired.usedQuery;
        scene.provider = acquired.clip.provider;

        const norm = await normalizeClip({
          input: acquired.path, outBase: base, aspect, targetDur: durations[i], motion, index: i,
        });
        done += 1;
        emit(job, 'editing', `Scene ${scene.index}/${n} ready (${acquired.clip.provider})`, 20 + Math.round((done / n) * 55));
        return norm;
      });

      // 5. Concatenate the silent scene clips (stream-copy, fast)
      emit(job, 'render', 'Stitching scenes…', 80);
      const silent = await concatSilent({ sceneFiles, outBase: id });

      // 6. Background music: explicit upload wins; else auto-fetch from Jamendo
      let bgMusic = bgMusicPath || null;
      let musicMeta = null;
      if (!bgMusic && wantMusic) {
        emit(job, 'render', 'Finding background music…', 84);
        const picked = await autoMusic({ tone, minSeconds: masterDur, base: id });
        if (picked) { bgMusic = picked.path; musicMeta = picked.meta; }
      }

      // 7. Single final pass: narration + ducked music + subtitles + fades
      emit(job, 'render', 'Mixing audio and rendering final video…', 90);
      const finalPath = await finalizeVideo({
        silentVideo: silent, voiceAudio: master.audioPath, captions: captionsPath,
        bgMusic, aspect, fades, outName: `${id}_final.mp4`,
      });

      job.result = {
        file: path.basename(finalPath),
        path: finalPath,
        title: plan.title,
        language: bilingual ? `${language} + ${language2}` : language,
        bilingual,
        music: musicMeta,
        scenes: plan.scenes,
      };
      job.status = 'done';
      emit(job, 'done', 'Render complete', 100);
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      emit(job, 'error', err.message, job.progress.pct);
    }
  })();

  return id;
}
