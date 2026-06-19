// Local AI-video mode (free, on your GPU). A third generation path: an open
// video model (LTX-Video via services/localvid) generates SILENT clips locally,
// and the rest is the EXACT same free machinery the stock pipeline uses — your
// own neural voiceover, karaoke captions, music, brand, and an editable project.
// Only the footage source changes (generated instead of downloaded), so this is
// $0 per render.
//
// On a 6GB card this is SLOW (minutes per clip). Scenes are split into short
// shots so each clip stays near the model's ~2s length and the picture keeps
// moving; that means more clips, so keep these videos short (15-30s).

import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import { generateVideoPlan, planFromScript } from './xai.js';
import { synthesizeVoice } from './voice.js';
import { buildKaraokeAss, parseSrt, hexToAss } from './captions.js';
import { getVoice } from './voices.js';
import { loadBrand } from './brand.js';
import { autoMusic } from './music.js';
import { normalizeClip, concatSilent, concatWithTransitions, finalizeVideo } from './ffmpeg.js';
import { buildProject, saveProject, planRender } from './project.js';
import { createLocalVideoGenerator, buildVisualPrompt } from './local-video.js';

// Proportional per-scene durations from the measured voice length (by word
// share, floored). Local copy so this module doesn't import pipeline.js. Pure.
export function allocateDurations(sceneTexts, total, floor = 2.5) {
  const words = sceneTexts.map((t) => Math.max(1, String(t || '').trim().split(/\s+/).filter(Boolean).length));
  const sum = words.reduce((a, b) => a + b, 0) || 1;
  let durs = words.map((w) => Math.max(floor, (w / sum) * total));
  const scale = total / durs.reduce((a, b) => a + b, 0);
  return durs.map((d) => d * scale);
}

// Split each scene into short shots (~shotLen each) so one AI clip covers one
// shot and the picture keeps changing. Returns { shots, durations } where each
// shot carries its parent scene's query/narration. Pure → gate-tested.
export function expandToShots(scenes, durations, shotLen = config.localvidSecondsPerScene) {
  const shots = [];
  const out = [];
  scenes.forEach((sc, i) => {
    const d = durations[i] || shotLen;
    const n = Math.max(1, Math.round(d / Math.max(1, shotLen)));
    const each = d / n;
    for (let k = 0; k < n; k++) {
      shots.push({ index: shots.length + 1, query: sc.query, narration: sc.narration, parent: sc.index });
      out.push(each);
    }
  });
  return { shots, durations: out };
}

/**
 * Topic/script → local-AI-generated video. Pure work + progress via ctx; throws
 * on failure. Registered as the 'local-video' processor. Reuses the stock
 * pipeline's voiceover/caption/finalize helpers; only the footage is generated.
 */
export async function processLocalVideo(opts, ctx) {
  const id = ctx.id;
  const {
    topic, script, context = 'global', aspect = '9:16', targetSeconds = 30, tone = 'engaging',
    voice, rate, subtitles = false, fades = true, autoMusic: wantMusic = false,
    captionStyle = {}, transition = 'cut',
  } = opts;

  const brand = loadBrand();
  if (brand.captionPrimary && captionStyle.primary == null) captionStyle.primary = hexToAss(brand.captionPrimary);
  if (brand.captionSecondary && captionStyle.secondary == null) captionStyle.secondary = hexToAss(brand.captionSecondary);
  const language = getVoice(voice)?.lang || 'English';
  const hasScript = Boolean(script && script.trim());
  const xfadeDur = transition && transition !== 'cut' ? config.transitionSeconds : 0;

  // 1. Plan — reuse the stock planners (narration + a `query` we turn into a
  // text-to-video prompt).
  ctx.emit('planning', hasScript ? 'Planning visuals for your script…' : `Writing the script (${language})…`, 4);
  const plan = hasScript
    ? await planFromScript({ script, context, language })
    : await generateVideoPlan({ topic, context, targetSeconds, tone, language });
  ctx.setPlan(plan);
  ctx.emit('planning', `Plan ready: "${plan.title}" — ${plan.scenes.length} scenes`, 8);

  // 2. Voiceover (FREE) — one continuous narration, same as the stock pipeline.
  ctx.emit('voice', `Recording the ${language} narration…`, 10);
  const sceneTexts = plan.scenes.map((s) => s.narration).filter(Boolean);
  const fullText = [plan.hook, ...sceneTexts, plan.outro].filter(Boolean).join(' ');
  const m = await synthesizeVoice({ text: fullText, voice, rate, outBase: `${id}_vo` });
  const voiceDur = m.duration;

  let captionsPath = null;
  let captionCues = null;
  if (subtitles) {
    const assPath = path.join(config.dirs.audio, `${id}_vo.ass`);
    const cues = m.cues?.length
      ? m.cues
      : (m.srtPath && fs.existsSync(m.srtPath) ? parseSrt(fs.readFileSync(m.srtPath, 'utf8')) : null);
    captionCues = cues && cues.length ? cues : null;
    captionsPath = cues && cues.length
      ? buildKaraokeAss({ cues, aspect, assPath, style: captionStyle })
      : buildKaraokeAss({ text: fullText, duration: voiceDur, aspect, assPath, style: captionStyle });
  }

  // 3. Split into short shots → one AI clip each.
  const durations = allocateDurations(sceneTexts, voiceDur);
  const { shots, durations: shotDurs } = expandToShots(plan.scenes, durations);
  const ns = shots.length;
  ctx.emit('generate', `Generating ${ns} AI clips on your GPU — this is slow (minutes each), grab a coffee…`, 12);

  // 4. Spawn the local model once; generate every shot through it (GPU = serial).
  ctx.emit('generate', 'Loading the local video model (first run downloads it)…', 13);
  const gen = await createLocalVideoGenerator({ onDiag: (l) => ctx.emit('generate', l, ctx.pct) });
  const normFiles = [];
  try {
    for (let i = 0; i < ns; i++) {
      const shot = shots[i];
      const prompt = buildVisualPrompt({ query: shot.query, narration: shot.narration, context });
      const raw = path.join(config.dirs.raw, `${id}_s${shot.index}_raw.mp4`);
      ctx.emit('generate', `Clip ${shot.index}/${ns}: generating…`, 13 + Math.round((i / ns) * 60));
      await gen.generate({ prompt, aspect, durationSec: shotDurs[i], out: raw });
      // Fit to the frame + exact shot duration; the clip has its own motion, so
      // no Ken Burns, and freeze (not loop) the short tail to reach the duration.
      const norm = await normalizeClip({
        input: raw, outBase: `${id}_s${shot.index}`, aspect,
        targetDur: shotDurs[i] + xfadeDur, motion: false, index: i, freeze: true,
      });
      normFiles.push(norm);
      ctx.emit('generate', `Clip ${shot.index}/${ns} ready`, 13 + Math.round(((i + 1) / ns) * 60));
    }
  } finally {
    gen.close();
  }

  // 5. Optional music, stitch, final pass — all reused from the stock pipeline.
  let bgMusic = null;
  let musicMeta = null;
  if (wantMusic) {
    ctx.emit('render', 'Finding background music…', 76);
    const picked = await autoMusic({ tone, minSeconds: voiceDur, base: id });
    if (picked) { bgMusic = picked.path; musicMeta = picked.meta; }
  }

  ctx.emit('render', xfadeDur ? `Stitching with ${transition}…` : 'Stitching scenes…', 82);
  const silent = xfadeDur
    ? await concatWithTransitions({ sceneFiles: normFiles, clipDurs: shotDurs.map((d) => d + xfadeDur), outBase: id, transition, dur: xfadeDur })
    : await concatSilent({ sceneFiles: normFiles, outBase: id });

  ctx.emit('render', 'Mixing audio and rendering final video…', 90);
  const finalPath = await finalizeVideo({
    silentVideo: silent, voiceAudio: m.audioPath, captions: captionsPath,
    bgMusic, aspect, fades, outName: `${id}_final.mp4`,
    logo: brand.logoPath, logoPosition: brand.logoPosition, logoScale: brand.logoScale,
  });

  // 6. Editable project (so the local-AI render opens in the same editor).
  const project = buildProject({
    id, opts, plan, aspect, fps: 30, language, bilingual: false, brand,
    voiceTrack: { path: m.audioPath, duration: voiceDur },
    captions: { enabled: Boolean(subtitles && captionCues), cues: captionCues || [], style: captionStyle },
    music: bgMusic ? { path: bgMusic, volume: 0.12, meta: musicMeta } : null,
    scenes: shots.map((sh, i) => ({
      index: sh.index, narration: sh.narration, query: sh.query, usedQuery: sh.query,
      provider: 'local-ai', sourcePath: path.join(config.dirs.raw, `${id}_s${sh.index}_raw.mp4`),
      clipPath: normFiles[i], duration: shotDurs[i], motion: false,
    })),
  });
  const seeded = planRender(project);
  project.render = {
    scenes: seeded.hashes.scenes, concat: seeded.hashes.concat, final: seeded.hashes.final,
    silentPath: silent, outputPath: finalPath, renderedAt: Date.now(),
  };
  saveProject(project);

  ctx.emit('done', 'Local AI video complete', 100);
  return {
    file: path.basename(finalPath), path: finalPath, projectId: id, kind: 'local-video',
    title: plan.title, language, music: musicMeta, scenes: plan.scenes,
  };
}
