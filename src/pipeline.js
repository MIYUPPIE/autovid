import path from 'path';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { generateVideoPlan, generateBilingualPlan, planFromScript, planBilingualFromScript, suggestAlternativeQueries } from './xai.js';
import { findClipCandidates, downloadClip, orientationFor, clipKey, localizeQuery } from './stock.js';
import { synthesizeVoice, synthesizeMany } from './voice.js';
import { buildKaraokeAss, parseSrt } from './captions.js';
import { getVoice } from './voices.js';
import fs from 'fs';
import { autoMusic } from './music.js';
import { normalizeClip, concatSilent, concatWithTransitions, finalizeVideo, assembleVoiceTrack, makeTextCard } from './ffmpeg.js';
import { buildProject, saveProject, planRender, loadProject } from './project.js';
import { renderProject } from './render.js';
import { detectTempo, beatGrid, snapToBeats } from './beats.js';

// Bilingual pacing: gap between the two language reads, and after each scene.
const GAP_BETWEEN_LANGS = 0.25;
const GAP_BETWEEN_SCENES = 0.5;

// In-memory job registry. For production, back this with Redis.
const jobs = new Map();

export function getJob(id) {
  return jobs.get(id);
}

// Coarse progress percentages for an incremental re-render, by stage.
const RENDER_PCT = { init: 2, normalize: 40, concat: 80, finalize: 90, done: 100, error: 100 };

/**
 * Kick off an incremental re-render of a saved project. Registers a job in the
 * same map the /api/job endpoints poll, so the client reuses existing plumbing.
 * Returns the job id, or null if the project doesn't exist.
 */
export function startProjectRender(projectId) {
  const project = loadProject(projectId);
  if (!project) return null;
  const id = nanoid(10);
  const job = {
    id, kind: 'render', status: 'running', createdAt: Date.now(),
    log: [], progress: { stage: 'init', message: 'Starting re-render', pct: 2 },
    result: null, error: null,
  };
  jobs.set(id, job);

  (async () => {
    try {
      const out = await renderProject(project, {
        onProgress: (stage, message) => emit(job, stage, message, RENDER_PCT[stage] ?? job.progress.pct),
      });
      job.result = { file: out.file, path: out.outputPath, projectId, plan: out.plan };
      job.status = 'done';
      emit(job, 'done', 'Re-render complete', 100);
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      emit(job, 'error', err.message, job.progress.pct);
    }
  })();

  return id;
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
 * `used` is a Set of clip keys claimed by THIS render (shared across scenes) so
 * the same clip is never used twice — that's what kept producing repeated footage
 * when several scenes' queries returned the same top-ranked clip. A clip is
 * claimed the moment it's selected (before the await) so concurrent scenes don't
 * race onto the same one. Defaults to a fresh per-call Set for standalone use.
 *
 * `deps` is injectable so this is unit-testable without hitting the network.
 */
export async function acquireFootage(
  { queries, orientation, base, onAttempt, used = new Set(), lead = 'pexels', minDur = 0 },
  deps = { findClipCandidates, downloadClip },
) {
  for (const q of queries) {
    let candidates = [];
    try { candidates = await deps.findClipCandidates(q, orientation, lead, minDur); } catch { candidates = []; }
    let attempts = 0;
    for (const clip of candidates) {
      const key = clipKey(clip);
      if (used.has(key) || attempts >= CANDIDATES_PER_QUERY) continue;
      used.add(key); // claim it now so a concurrent scene won't grab the same clip
      attempts += 1;
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

/**
 * Per-phrase B-roll (#7): split each long scene into several short SHOTS so the
 * picture changes every few seconds instead of holding one clip for ~10s — the
 * dense pacing modern short-form expects. Narration/captions are global (anchored
 * to the audio), so splitting a scene visually is safe: it only changes WHICH clip
 * shows when. Each shot reuses the parent's query; the pipeline's clip-dedup gives
 * each shot DIFFERENT footage, so one scene becomes a mini montage.
 *
 * Pure. Returns { scenes, durations } renumbered 1..M, with the total duration and
 * order preserved (each scene's shots sum to its original duration). A scene at or
 * under `maxShot` stays a single shot; narration is sliced across shots by word so
 * the card-fallback text of each shot still reflects what's being said then.
 */
export function expandScenes(scenes, durations, { maxShot = 6, minShot = 2.5 } = {}) {
  const outScenes = [];
  const outDur = [];
  scenes.forEach((sc, i) => {
    const d = durations[i] || 0;
    const k = d > maxShot ? Math.min(Math.floor(d / minShot), Math.ceil(d / maxShot)) : 1;
    const shots = Math.max(1, k);
    const words = String(sc.narration || '').trim().split(/\s+/).filter(Boolean);
    for (let j = 0; j < shots; j++) {
      const slice = shots > 1
        ? words.slice(Math.floor((j * words.length) / shots), Math.floor(((j + 1) * words.length) / shots)).join(' ')
        : (sc.narration || '');
      outScenes.push({
        index: outScenes.length + 1,
        query: sc.query,
        narration: slice || sc.narration || '',
        parentIndex: sc.index,
      });
      // Distribute the scene's seconds evenly across its shots (sum preserved).
      outDur.push(d / shots);
    }
  });
  return { scenes: outScenes, durations: outDur };
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
/**
 * Multi-language one-shot (#1): one idea/script → N narrated videos at once, one
 * per chosen voice/language. Each is a full independent pipeline run (its own
 * narration, durations, footage), launched together so a creator gets the Yorùbá,
 * Igbo, Hausa and English cuts from a single action. Returns a batch descriptor:
 *   { batchId, jobs: [{ voice, language, jobId }] }
 * `voices` is deduped; the optional base `opts.voice` is included too.
 */
export function runMultiPipeline(opts) {
  const wanted = [];
  const seen = new Set();
  for (const v of [opts.voice, ...(opts.voices || [])]) {
    if (v && getVoice(v) && !seen.has(v)) { seen.add(v); wanted.push(v); }
  }
  if (wanted.length === 0) throw new Error('no valid voices for a multi-language batch');
  const batchId = nanoid(10);
  const jobsOut = wanted.map((voice) => {
    const language = getVoice(voice)?.lang || 'English';
    // Strip voice2 so each variant is a single-language render in `voice`.
    const jobId = runPipeline({ ...opts, voice, voice2: null, batchId });
    return { voice, language, jobId };
  });
  return { batchId, jobs: jobsOut };
}

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
        captionStyle = {}, codeSwitch = false, beatSync = true, bRoll = true,
        transition = 'cut',
      } = opts;
      // Crossfade headroom: with transitions on, each scene clip is rendered this
      // much longer so the xfade overlap nets back to the intended cut times.
      const xfadeDur = transition && transition !== 'cut' ? config.transitionSeconds : 0;
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
        plan = await generateVideoPlan({ topic, context, targetSeconds, tone, language, codeSwitch });
      }
      job.plan = plan;
      const n = plan.scenes.length;
      emit(job, 'planning', `Plan ready: "${plan.title}" — ${n} scenes`, 12);

      // 2. Voice track + per-scene visual durations + caption timing.
      // captionCues is the editable source of truth saved to the project doc.
      let master, captionsPath = null, durations, captionCues = null;
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
          captionCues = track.cues;
          captionsPath = buildKaraokeAss({
            cues: track.cues, aspect, style: captionStyle,
            assPath: path.join(config.dirs.audio, `${id}_vo.ass`),
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
          // Prefer real timing windows: YarnGPT returns per-chunk cues from the
          // measured audio; edge gives a word-timed SRT. Only fall back to a
          // proportional spread when neither is available.
          const cues = m.cues?.length
            ? m.cues
            : (m.srtPath && fs.existsSync(m.srtPath) ? parseSrt(fs.readFileSync(m.srtPath, 'utf8')) : null);
          captionCues = cues && cues.length ? cues : null;
          captionsPath = cues && cues.length
            ? buildKaraokeAss({ cues, aspect, assPath, style: captionStyle })
            : buildKaraokeAss({ text: fullText, duration: m.duration, aspect, assPath, style: captionStyle });
        }
        durations = allocateDurations(sceneTexts, m.duration);
      }
      const masterDur = master.duration;

      // 2a. Per-phrase B-roll (#7): split long scenes into short shots so the
      // picture changes more often. Single-narration path only (bilingual pacing
      // is bound to its two-read scene structure). Captions are global, so this
      // only affects which clip shows when. Beat-sync then snaps every shot cut.
      let visualScenes = plan.scenes;
      if (!bilingual && bRoll && durations.length) {
        const exp = expandScenes(plan.scenes, durations, { maxShot: config.maxShotSeconds });
        visualScenes = exp.scenes;
        durations = exp.durations;
        if (visualScenes.length > plan.scenes.length) {
          emit(job, 'editing', `Cutting ${plan.scenes.length} scenes into ${visualScenes.length} shots…`, 13);
        }
      }

      // 2b. Background music: explicit upload wins; else auto-fetch from Jamendo.
      // Fetched BEFORE footage so beat-sync can land scene cuts on the music.
      let bgMusic = bgMusicPath || null;
      let musicMeta = null;
      if (!bgMusic && wantMusic) {
        emit(job, 'render', 'Finding background music…', 13);
        const picked = await autoMusic({ tone, minSeconds: masterDur, base: id });
        if (picked) { bgMusic = picked.path; musicMeta = picked.meta; }
      }

      // 2c. Beat-sync: snap each scene CUT onto the music's beat grid so the
      // picture changes on the beat (CapCut's signature feel). Only on the single
      // flowing-narration path; bilingual pacing is driven by its two reads. Any
      // failure (no ffmpeg, silent track) falls back to the proportional cuts.
      let beat = null;
      if (beatSync && bgMusic && !bilingual && durations.length > 1) {
        try {
          const tempo = await detectTempo(bgMusic);
          if (tempo.bpm >= 60 && tempo.bpm <= 200) {
            const grid = beatGrid(tempo.bpm, masterDur, tempo.offset);
            const snapped = snapToBeats(durations, grid);
            beat = { bpm: tempo.bpm, offset: tempo.offset };
            durations = snapped;
            emit(job, 'render', `Syncing cuts to ${Math.round(tempo.bpm)} BPM…`, 15);
          }
        } catch { /* keep proportional cuts */ }
      }

      // 3+4. Footage + normalize per scene, with bounded concurrency (overlaps
      // network downloads with GPU encodes). One bad download can't kill the render.
      let done = 0;
      const vn = visualScenes.length;
      // Shared across every scene of THIS render so no clip is reused — kills the
      // repeated-footage problem when different scenes' queries overlap (and gives
      // each B-roll shot of one scene distinct footage → a mini montage).
      const usedClips = new Set();
      const sceneFiles = await mapLimit(visualScenes, 3, async (scene, i) => {
        const base = `${id}_s${scene.index}`;
        // Alternate the lead provider scene-to-scene so footage draws from both
        // Pexels and Pixabay instead of always topping out on Pexels.
        const lead = i % 2 === 0 ? 'pexels' : 'pixabay';
        const minDur = durations[i]; // prefer a clip that covers the scene without looping
        let acquired = await acquireFootage({
          queries: localizeQuery(scene.query, context), orientation, base, used: usedClips, lead, minDur,
          onAttempt: (q, clip) =>
            emit(job, 'footage', `Scene ${scene.index}: trying ${clip.provider} clip for "${q}"…`, 20 + Math.round((done / vn) * 55)),
        });
        if (!acquired) {
          const alts = await suggestAlternativeQueries(scene.query, context);
          acquired = await acquireFootage({ queries: alts, orientation, base, used: usedClips, lead, minDur });
        }
        // Last resort: a branded text card so ONE dead query can never kill the
        // whole render (#6). The card shows a short phrase from the narration.
        if (!acquired) {
          const card = { narration: scene.narration, query: scene.query };
          const norm = await makeTextCard({
            narration: card.narration, query: card.query, outBase: base,
            aspect, targetDur: durations[i] + xfadeDur, index: i,
          });
          scene.usedQuery = scene.query;
          scene.provider = 'card';
          done += 1;
          emit(job, 'editing', `Shot ${scene.index}/${vn}: generated card (no footage found)`, 20 + Math.round((done / vn) * 55));
          return { norm, source: null, card };
        }
        scene.usedQuery = acquired.usedQuery;
        scene.provider = acquired.clip.provider;

        const norm = await normalizeClip({
          input: acquired.path, outBase: base, aspect, targetDur: durations[i] + xfadeDur, motion, index: i,
        });
        done += 1;
        emit(job, 'editing', `Shot ${scene.index}/${vn} ready (${acquired.clip.provider})`, 20 + Math.round((done / vn) * 55));
        // Keep both paths: the normalized clip feeds the concat now, the raw
        // source survives for re-edits (re-trim / re-frame) from the project doc.
        return { norm, source: acquired.path };
      });

      // 5. Stitch the silent scene clips: a hard-cut stream-copy (fast), or an
      // xfade crossfade when a transition is chosen (#8).
      emit(job, 'render', xfadeDur ? `Stitching scenes with ${transition}…` : 'Stitching scenes…', 80);
      const normFiles = sceneFiles.map((r) => r.norm);
      const silent = xfadeDur
        ? await concatWithTransitions({ sceneFiles: normFiles, clipDurs: durations.map((d) => d + xfadeDur), outBase: id, transition, dur: xfadeDur })
        : await concatSilent({ sceneFiles: normFiles, outBase: id });

      // 7. Single final pass: narration + ducked music + subtitles + fades
      emit(job, 'render', 'Mixing audio and rendering final video…', 90);
      const finalPath = await finalizeVideo({
        silentVideo: silent, voiceAudio: master.audioPath, captions: captionsPath,
        bgMusic, aspect, fades, outName: `${id}_final.mp4`,
      });

      // 8. Persist the editable project document (the timeline behind this MP4).
      // This is what an editor mutates and render.js re-renders incrementally.
      const project = buildProject({
        id, opts, plan, aspect, fps: 30,
        language: bilingual ? `${language} + ${language2}` : language, bilingual,
        voiceTrack: { path: master.audioPath, duration: masterDur },
        captions: { enabled: Boolean(subtitles && captionCues), cues: captionCues || [], style: captionStyle },
        music: bgMusic ? { path: bgMusic, volume: 0.12, meta: musicMeta, beat } : null,
        scenes: visualScenes.map((sc, i) => ({
          index: sc.index, narration: sc.narration, query: sc.query,
          usedQuery: sc.usedQuery, provider: sc.provider,
          sourcePath: sceneFiles[i].source, clipPath: sceneFiles[i].norm,
          card: sceneFiles[i].card || null,
          duration: durations[i], motion,
        })),
      });
      // Seed the render cache so the first edit only redoes what actually changed,
      // not the whole video (the assets this run produced are already on disk).
      const seeded = planRender(project);
      project.render = {
        scenes: seeded.hashes.scenes, concat: seeded.hashes.concat, final: seeded.hashes.final,
        silentPath: silent, outputPath: finalPath, renderedAt: Date.now(),
      };
      saveProject(project);

      job.result = {
        file: path.basename(finalPath),
        path: finalPath,
        projectId: id,
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
