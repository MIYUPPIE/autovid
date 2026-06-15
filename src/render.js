// Render a project document back into an MP4 — incrementally.
//
// This is the "instant edit" engine. planRender() (project.js) decides which of
// the three stages are stale; we only redo those:
//   1. normalize  — per scene, the expensive GPU encode. Skipped unless the
//                   scene's source/geometry/trim/motion changed.
//   2. concat     — stream-copy stitch of the scene clips. Cheap, redone when
//                   the ordered clip list changes.
//   3. finalize   — mux voice + ducked music + burned captions + fades. Cheapest
//                   re-encode of the whole video; redone for caption/audio edits.
//
// So editing a caption re-runs only finalize (seconds); swapping one clip
// re-normalizes that one scene + concat + finalize; everything else is reused
// from the render cache recorded on project.render.

import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import { normalizeClip, concatSilent, finalizeVideo, makeTextCard } from './ffmpeg.js';
import { buildKaraokeAss } from './captions.js';
import { planRender, saveProject } from './project.js';

/**
 * Re-render `project` into assets/output, reusing cached stages where possible.
 * `onProgress(stage, message)` is optional. Returns:
 *   { outputPath, file, plan } where `plan` lists what was redone vs reused.
 * Mutates and saves the project (updates scene.clip.path + project.render cache).
 */
export async function renderProject(project, { onProgress } = {}) {
  const emit = (stage, message) => onProgress && onProgress(stage, message);
  const prev = project.render || {};
  const plan = planRender(project, prev);

  // 1. Per-scene normalize (only the dirty ones).
  for (const scene of project.scenes) {
    if (!plan.scenes[scene.index]) {
      emit('normalize', `Scene ${scene.index}: reused from cache`);
      continue;
    }
    const input = scene.source?.path;
    // A generated-card scene has no source clip — regenerate the card instead.
    if (scene.card && (!input || !fs.existsSync(input))) {
      emit('normalize', `Scene ${scene.index}: regenerating card`);
      scene.clip = { path: await makeTextCard({
        narration: scene.card.narration, query: scene.card.query,
        outBase: `${project.id}_s${scene.index}`, aspect: project.aspect,
        targetDur: scene.duration, fps: project.fps, index: scene.index,
        brand: project.brand || null,
      }) };
      continue;
    }
    if (!input || !fs.existsSync(input)) {
      throw new Error(`scene ${scene.index}: source clip missing (${input || 'none'})`);
    }
    emit('normalize', `Scene ${scene.index}: re-rendering footage`);
    const out = await normalizeClip({
      input,
      outBase: `${project.id}_s${scene.index}`,
      aspect: project.aspect,
      targetDur: scene.duration,
      fps: project.fps,
      motion: scene.motion,
      index: scene.index,
      trim: scene.trim,
    });
    scene.clip = { path: out };
  }

  // 2. Concat the silent scene clips, in timeline order.
  let silentPath = prev.silentPath;
  if (plan.concat || !silentPath || !fs.existsSync(silentPath)) {
    emit('concat', 'Stitching scenes');
    const sceneFiles = project.scenes.map((s) => s.clip.path);
    silentPath = await concatSilent({ sceneFiles, outBase: project.id });
  } else {
    emit('concat', 'Stitch reused from cache');
  }

  // 3. Captions: rebuild the ASS from the (editable) cues every final pass —
  // it's near-free and always reflects the current text/style.
  let captionsPath = null;
  if (project.captions?.enabled && project.captions.cues?.length) {
    captionsPath = path.join(config.dirs.audio, `${project.id}_vo.ass`);
    const built = buildKaraokeAss({
      cues: project.captions.cues,
      aspect: project.aspect,
      assPath: captionsPath,
      style: project.captions.style || {},
    });
    if (!built) captionsPath = null;
  }

  // 4. Final mux.
  emit('finalize', 'Mixing audio and rendering final video');
  const music = project.audio?.music;
  const outName = `${project.id}_final.mp4`;
  const outputPath = await finalizeVideo({
    silentVideo: silentPath,
    voiceAudio: project.audio.voiceTrack.path,
    captions: captionsPath,
    bgMusic: music?.path || null,
    musicVolume: typeof music?.volume === 'number' ? music.volume : 0.12,
    aspect: project.aspect,
    fades: project.effects?.fades !== false,
    outName,
  });

  // Record the cache so the next render knows what it can reuse.
  project.render = {
    scenes: plan.hashes.scenes,
    concat: plan.hashes.concat,
    final: plan.hashes.final,
    silentPath,
    outputPath,
    renderedAt: Date.now(),
  };
  saveProject(project);

  return {
    outputPath,
    file: path.basename(outputPath),
    plan: {
      scenesRerendered: Object.entries(plan.scenes).filter(([, dirty]) => dirty).map(([i]) => Number(i)),
      concat: plan.concat,
      final: plan.final,
    },
  };
}
