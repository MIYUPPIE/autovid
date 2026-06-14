// Gate tests for the editable project document + incremental render planning.
// Deterministic, offline, free, fast (<2s). No network, no LLM, no ffmpeg —
// planRender's job is to decide *what* to re-render, which is pure logic.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '../src/config.js';
import {
  buildProject, validateProject, relayout, hashOf, planRender,
  saveProject, loadProject, listProjects, PROJECT_VERSION,
} from '../src/project.js';

// Point project storage at a throwaway dir and give scenes real files on disk so
// planRender's existence checks behave like production.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av_proj_'));
config.dirs.projects = path.join(tmp, 'projects');

function touch(name) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, 'x');
  return p;
}

// A two-scene project whose clips, voice track, and silent concat all exist on
// disk, with its render cache seeded — i.e. the state right after a fresh render.
function freshProject(id = 'p1') {
  const proj = buildProject({
    id,
    opts: { topic: 'Lagos markets', fades: true, motion: true },
    plan: { title: 'Lagos Markets' },
    aspect: '9:16', fps: 30, language: 'English',
    voiceTrack: { path: touch(`${id}_vo.mp3`), duration: 12 },
    captions: { enabled: true, cues: [{ start: 0, end: 6, text: 'one two' }, { start: 6, end: 12, text: 'three four' }] },
    music: { path: touch(`${id}_music.mp3`), volume: 0.12, meta: { title: 'Groove' } },
    scenes: [
      { index: 0, narration: 'one two', query: 'market', usedQuery: 'market', provider: 'pexels', sourcePath: touch(`${id}_s0_src.mp4`), clipPath: touch(`${id}_s0_norm.mp4`), duration: 6, motion: true },
      { index: 1, narration: 'three four', query: 'crowd', usedQuery: 'crowd', provider: 'pixabay', sourcePath: touch(`${id}_s1_src.mp4`), clipPath: touch(`${id}_s1_norm.mp4`), duration: 6, motion: true },
    ],
  });
  // Seed the cache the way the pipeline does after the first render.
  const seeded = planRender(proj);
  proj.render = {
    scenes: seeded.hashes.scenes, concat: seeded.hashes.concat, final: seeded.hashes.final,
    silentPath: touch(`${id}_silent.mp4`), outputPath: touch(`${id}_final.mp4`), renderedAt: Date.now(),
  };
  return proj;
}

// ---------- build ----------
test('project: buildProject lays scenes on a contiguous timeline', () => {
  const p = freshProject();
  assert.equal(p.version, PROJECT_VERSION);
  assert.equal(p.scenes[0].start, 0);
  assert.equal(p.scenes[1].start, 6);          // starts where scene 0 ends
  assert.equal(p.duration, 12);                // voice track duration wins
  assert.equal(p.aspect, '9:16');
  assert.equal(p.captions.enabled, true);
  assert.equal(p.audio.music.volume, 0.12);
});

// ---------- validation ----------
test('project: validateProject accepts a well-formed doc', () => {
  assert.doesNotThrow(() => validateProject(freshProject()));
});

test('project: validateProject rejects missing voice, empty scenes, bad aspect, zero duration', () => {
  const good = freshProject();
  assert.throws(() => validateProject({ ...good, audio: { voiceTrack: { path: null } } }), /voiceTrack/);
  assert.throws(() => validateProject({ ...good, scenes: [] }), /scenes/);
  assert.throws(() => validateProject({ ...good, aspect: '4:3' }), /aspect/);
  const zero = freshProject();
  zero.scenes[0].duration = 0;
  assert.throws(() => validateProject(zero), /duration/);
});

// ---------- relayout ----------
test('project: relayout recomputes start times and total after a trim', () => {
  const p = freshProject();
  p.scenes[0].duration = 4;       // trimmed shorter
  relayout(p);
  assert.equal(p.scenes[0].start, 0);
  assert.equal(p.scenes[1].start, 4);
  assert.equal(p.duration, 10);
});

// ---------- hashing ----------
test('project: hashOf is stable and order-independent for object keys', () => {
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  // Array order IS significant (scene order matters).
  assert.notEqual(hashOf([1, 2]), hashOf([2, 1]));
});

// ---------- incremental render planning (the "instant edit" core) ----------
test('plan: a freshly seeded project is fully clean — nothing re-renders', () => {
  const p = freshProject();
  const plan = planRender(p, p.render);
  assert.equal(plan.scenes[0], false);
  assert.equal(plan.scenes[1], false);
  assert.equal(plan.concat, false);
  assert.equal(plan.final, false);
});

test('plan: a fresh project with no cache is fully dirty', () => {
  const p = freshProject();
  const plan = planRender(p, {});      // no prev cache
  assert.equal(plan.scenes[0], true);
  assert.equal(plan.scenes[1], true);
  assert.equal(plan.concat, true);
  assert.equal(plan.final, true);
});

test('plan: editing a caption re-renders ONLY the final mux', () => {
  const p = freshProject();
  p.captions.cues[0].text = 'ONE TWO edited';
  const plan = planRender(p, p.render);
  assert.equal(plan.scenes[0], false, 'no footage re-encode');
  assert.equal(plan.scenes[1], false);
  assert.equal(plan.concat, false, 'no re-stitch');
  assert.equal(plan.final, true, 'only the mux/caption-burn re-runs');
});

test('plan: changing music volume re-renders only the final mux', () => {
  const p = freshProject();
  p.audio.music.volume = 0.3;
  const plan = planRender(p, p.render);
  assert.equal(plan.concat, false);
  assert.equal(plan.final, true);
});

test('plan: trimming one scene re-renders that scene + concat + final, not the other scene', () => {
  const p = freshProject();
  p.scenes[0].trim = { in: 1.5, out: 5 };
  const plan = planRender(p, p.render);
  assert.equal(plan.scenes[0], true, 'trimmed scene re-normalizes');
  assert.equal(plan.scenes[1], false, 'untouched scene is reused');
  assert.equal(plan.concat, true, 'clip list changed → re-stitch');
  assert.equal(plan.final, true);
});

test('plan: reordering scenes re-stitches but does NOT re-encode any scene', () => {
  const p = freshProject();
  p.scenes.reverse();
  relayout(p);
  const plan = planRender(p, p.render);
  assert.equal(plan.scenes[0], false, 'scene 0 clip unchanged');
  assert.equal(plan.scenes[1], false, 'scene 1 clip unchanged');
  assert.equal(plan.concat, true, 'order changed → re-stitch');
  assert.equal(plan.final, true);
});

test('plan: a missing cached clip forces that scene to re-render even if inputs match', () => {
  const p = freshProject();
  fs.unlinkSync(p.scenes[1].clip.path);   // cache evicted / cleaned up
  const plan = planRender(p, p.render);
  assert.equal(plan.scenes[0], false);
  assert.equal(plan.scenes[1], true, 'gone-from-disk clip is stale');
  assert.equal(plan.concat, true);
});

// ---------- persistence ----------
test('project: save/load/list round-trips and stamps updatedAt', async () => {
  const p = freshProject('round1');
  const before = p.updatedAt;
  await new Promise((r) => setTimeout(r, 2));
  saveProject(p);
  assert.ok(p.updatedAt >= before);

  const loaded = loadProject('round1');
  assert.equal(loaded.id, 'round1');
  assert.equal(loaded.scenes.length, 2);
  assert.equal(loaded.title, 'Lagos Markets');

  saveProject(freshProject('round2'));
  const ids = listProjects().map((x) => x.id);
  assert.ok(ids.includes('round1') && ids.includes('round2'));
});

test('project: loadProject returns null for an unknown id', () => {
  assert.equal(loadProject('does-not-exist'), null);
});
