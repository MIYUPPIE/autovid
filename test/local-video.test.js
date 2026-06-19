// Gate tests for local AI-video mode (free, LTX-Video on your GPU). Deterministic,
// offline, free, fast — no Python, no model, no GPU. Covers the pure helpers
// (dims, prompt, worker-protocol parse, frame math, shot splitting) and that the
// processor is registered. The actual GPU generation is exercised by the opt-in
// self-test (services/localvid), not here.
//
// Run: npm test  (or: node --test test/local-video.test.js)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dimsForAspect, buildVisualPrompt, parseWorkerLine, framesForDuration, localVideoConfigured,
} from '../src/local-video.js';
import { allocateDurations, expandToShots } from '../src/local-video-pipeline.js';
import { PROCESSORS } from '../src/pipeline.js';

test('dimsForAspect returns 32-divisible dims with the right orientation', () => {
  const v = dimsForAspect('9:16', 384);
  assert.equal(v.width % 32, 0);
  assert.equal(v.height % 32, 0);
  assert.ok(v.height > v.width, '9:16 is portrait');

  const h = dimsForAspect('16:9', 384);
  assert.ok(h.width > h.height, '16:9 is landscape');

  const s = dimsForAspect('1:1', 384);
  assert.equal(s.width, s.height);
  assert.equal(s.width, 384); // already /32
});

test('buildVisualPrompt enriches the stock query and tags African context', () => {
  const p = buildVisualPrompt({ query: 'aerial city sunrise', context: 'africa' });
  assert.match(p, /aerial city sunrise/);
  assert.match(p, /African setting/);
  assert.match(p, /cinematic/);

  // falls back to narration when no query, and stays global by default
  const p2 = buildVisualPrompt({ narration: 'a busy market', context: 'global' });
  assert.match(p2, /a busy market/);
  assert.doesNotMatch(p2, /African/);
});

test('parseWorkerLine reads protocol JSON and ignores stray prints', () => {
  assert.deepEqual(parseWorkerLine('{"event":"ready"}'), { event: 'ready' });
  assert.deepEqual(parseWorkerLine('  {"event":"done","id":"g1","out":"/x.mp4"} '),
    { event: 'done', id: 'g1', out: '/x.mp4' });
  assert.equal(parseWorkerLine('Loading model 50%...'), null);
  assert.equal(parseWorkerLine(''), null);
});

test('framesForDuration yields a valid (%8==1) capped frame count', () => {
  const f = framesForDuration(2, 24, 49);
  assert.equal((f - 1) % 8, 0);
  assert.ok(f <= 49 && f >= 9);
  assert.equal(framesForDuration(100, 24, 49), 49); // capped, still %8==1
  assert.equal((framesForDuration(100, 24, 49) - 1) % 8, 0);
});

test('allocateDurations splits the voice length by word share and sums back', () => {
  const durs = allocateDurations(['a a a a', 'b b'], 12, 1);
  assert.equal(durs.length, 2);
  assert.ok(durs[0] > durs[1], 'longer text gets more time');
  assert.ok(Math.abs(durs.reduce((a, b) => a + b, 0) - 12) < 1e-6, 'sums to total');
});

test('expandToShots splits scenes into ~shotLen shots, preserving total time', () => {
  const scenes = [{ index: 1, query: 'q1', narration: 'n1' }, { index: 2, query: 'q2', narration: 'n2' }];
  const { shots, durations } = expandToShots(scenes, [9, 3], 3);
  assert.equal(shots.length, 4); // 9/3=3 shots + 3/3=1 shot
  assert.equal(shots[0].query, 'q1');
  assert.equal(shots[3].query, 'q2');
  assert.ok(Math.abs(durations.reduce((a, b) => a + b, 0) - 12) < 1e-6);
  // indices are sequential across the flattened shot list
  assert.deepEqual(shots.map((s) => s.index), [1, 2, 3, 4]);
});

test('local-video is registered as a queue processor', () => {
  assert.equal(typeof PROCESSORS['local-video'], 'function');
});

test('localVideoConfigured returns a boolean (worker script presence check)', () => {
  assert.equal(typeof localVideoConfigured(), 'boolean');
});
