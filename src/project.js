// Project document: the editable timeline that backs every video.
//
// A rendered MP4 is a dead end — captions are burned into pixels and audio is
// mixed into one track, so nothing can be un-baked. This module persists the
// *recipe* instead: scenes, source/normalized clip paths, durations, caption
// cues, music, effects. It is the single source of truth that both the
// generator (pipeline.js) writes and an editor mutates, and that render.js
// turns back into an MP4.
//
// Everything here is deterministic (no network, no ffmpeg, no LLM): build from a
// finished job, validate, save/load JSON, hash each render stage so an edit only
// re-renders what actually changed. The expensive latent/encode work lives in
// render.js; the decisions about *what* to redo live here, where they are cheap
// and fully testable.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

export const PROJECT_VERSION = 1;

// Stable JSON: object keys sorted recursively so a hash depends on values, not
// key insertion order. Arrays keep their order (order is meaningful for scenes).
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        if (value[k] !== undefined) acc[k] = canonical(value[k]);
        return acc;
      }, {});
  }
  return value;
}

// Short deterministic content hash of any JSON-able value.
export function hashOf(value) {
  return crypto.createHash('sha1').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 16);
}

function projectPath(id) {
  return path.join(config.dirs.projects, `${id}.json`);
}

/**
 * Build a project document from a finished pipeline run. `parts` carries the
 * concrete assets the pipeline produced so they survive past the render:
 *   { id, opts, plan, aspect, fps, language, bilingual,
 *     voiceTrack:{path,duration}, captions:{cues,enabled}, music:{path,volume,meta}|null,
 *     scenes:[{index, narration, query, usedQuery, provider, sourcePath, clipPath, duration, motion}] }
 */
export function buildProject(parts) {
  const now = Date.now();
  const {
    id, opts = {}, plan = {}, aspect = '16:9', fps = 30,
    language = 'English', bilingual = false,
    voiceTrack, captions = {}, music = null, scenes = [],
  } = parts;

  let start = 0;
  const timeline = scenes.map((s) => {
    const scene = {
      index: s.index,
      narration: s.narration || '',
      query: s.query || '',
      usedQuery: s.usedQuery || s.query || '',
      provider: s.provider || null,
      source: { path: s.sourcePath || null },   // raw downloaded clip (kept for re-edits)
      clip: { path: s.clipPath || null },        // normalized scene clip (render cache)
      start,
      duration: Number(s.duration) || 0,
      motion: s.motion !== false,
      trim: s.trim || null,                      // { in, out } in source seconds, or null
    };
    start += scene.duration;
    return scene;
  });

  return {
    version: PROJECT_VERSION,
    id,
    createdAt: now,
    updatedAt: now,
    title: plan.title || opts.topic || 'Untitled',
    aspect,
    fps,
    language,
    bilingual: Boolean(bilingual),
    duration: voiceTrack?.duration || start,
    effects: {
      fades: opts.fades !== false,
      motion: opts.motion !== false,
    },
    audio: {
      voiceTrack: { path: voiceTrack?.path || null, duration: voiceTrack?.duration || 0 },
      music: music
        ? { path: music.path || null, volume: typeof music.volume === 'number' ? music.volume : 0.12, meta: music.meta || null }
        : null,
    },
    captions: {
      enabled: captions.enabled !== false && Array.isArray(captions.cues) && captions.cues.length > 0,
      cues: Array.isArray(captions.cues) ? captions.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })) : [],
      style: captions.style || {},
    },
    scenes: timeline,
  };
}

// Throw on a structurally invalid project. Cheap guardrail for the edit endpoint
// so a malformed PUT can't poison a later render.
export function validateProject(p) {
  const errs = [];
  if (!p || typeof p !== 'object') errs.push('project must be an object');
  else {
    if (p.version !== PROJECT_VERSION) errs.push(`version must be ${PROJECT_VERSION}`);
    if (!p.id || typeof p.id !== 'string') errs.push('id must be a non-empty string');
    if (!['16:9', '9:16', '1:1'].includes(p.aspect)) errs.push('aspect must be 16:9, 9:16 or 1:1');
    if (!Array.isArray(p.scenes) || p.scenes.length === 0) errs.push('scenes must be a non-empty array');
    else {
      p.scenes.forEach((s, i) => {
        if (!(Number(s.duration) > 0)) errs.push(`scene ${i}: duration must be > 0`);
        if (!s.source?.path && !s.clip?.path) errs.push(`scene ${i}: needs a source or clip path`);
      });
    }
    if (!p.audio?.voiceTrack?.path) errs.push('audio.voiceTrack.path is required');
  }
  if (errs.length) {
    const e = new Error(`invalid project: ${errs.join('; ')}`);
    e.validation = errs;
    throw e;
  }
  return p;
}

// Recompute each scene's timeline start from its duration, in order. Call after
// any edit that trims, reorders, inserts, or deletes scenes.
export function relayout(p) {
  let start = 0;
  for (const s of p.scenes) {
    s.start = start;
    start += Number(s.duration) || 0;
  }
  p.duration = start;
  return p;
}

/**
 * Decide which render stages are stale for a project, given the hashes recorded
 * the last time it rendered (`prev` = project.render || {}). Pure: no files
 * touched. Returns { scenes:{ [index]: bool }, concat, final, hashes }.
 *
 * - a scene's normalized clip depends only on its source + geometry + motion + trim
 * - the concat depends on the ordered list of scene clip identities
 * - the final mux depends on concat + voice + music + captions + fades
 */
export function planRender(p, prev = {}) {
  const sceneHashes = {};
  const sceneDirty = {};
  for (const s of p.scenes) {
    const h = hashOf({
      source: s.source?.path, duration: s.duration, motion: s.motion,
      trim: s.trim, aspect: p.aspect, fps: p.fps,
    });
    sceneHashes[s.index] = h;
    // Stale if the inputs changed OR the cached normalized clip is gone.
    sceneDirty[s.index] = h !== prev.scenes?.[s.index] || !(s.clip?.path && fs.existsSync(s.clip.path));
  }

  const concatHash = hashOf(p.scenes.map((s) => sceneHashes[s.index]));
  const concatDirty =
    concatHash !== prev.concat ||
    Object.values(sceneDirty).some(Boolean) ||
    !(prev.silentPath && fs.existsSync(prev.silentPath));

  const finalHash = hashOf({
    concat: concatHash,
    voice: p.audio?.voiceTrack?.path,
    music: p.audio?.music,
    captions: p.captions?.enabled ? { cues: p.captions.cues, style: p.captions.style } : null,
    fades: p.effects?.fades,
    aspect: p.aspect,
  });
  const finalDirty = finalHash !== prev.final || concatDirty;

  return {
    scenes: sceneDirty,
    concat: concatDirty,
    final: finalDirty,
    hashes: { scenes: sceneHashes, concat: concatHash, final: finalHash },
  };
}

export function saveProject(p) {
  p.updatedAt = Date.now();
  fs.mkdirSync(config.dirs.projects, { recursive: true });
  fs.writeFileSync(projectPath(p.id), JSON.stringify(p, null, 2), 'utf8');
  return projectPath(p.id);
}

export function loadProject(id) {
  const fp = projectPath(id);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

export function listProjects() {
  if (!fs.existsSync(config.dirs.projects)) return [];
  return fs.readdirSync(config.dirs.projects)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(config.dirs.projects, f), 'utf8'));
        return { id: p.id, title: p.title, aspect: p.aspect, duration: p.duration, updatedAt: p.updatedAt };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
