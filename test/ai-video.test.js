// Gate tests for AI talking-video mode (xAI Grok Imagine). Deterministic,
// offline, free, fast (<2s). No real network, no LLM, no ffmpeg — the xAI video
// client's fetch + sleep are injected, the planner's pure normalizer is fed a
// hand-built plan, and the prompt builders are checked directly.
//
// Run: npm test  (or: node --test test/ai-video.test.js)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aspectToRatio, clampDuration, normalizeResolution, buildVideoRequest,
  extractJobId, readVideoStatus, pollUrl, generateVideoClip,
} from '../src/grok-video.js';
import {
  estDurationForLine, buildScenePrompt, normalizeTalkingPlan, defaultClipCount, resolveClipBudget,
} from '../src/ai-video.js';
import { config } from '../src/config.js';
import { PROCESSORS } from '../src/pipeline.js';

// --- grok-video pure builders --------------------------------------------

test('aspectToRatio maps presets, defaults to 16:9', () => {
  assert.equal(aspectToRatio('9:16'), '9:16');
  assert.equal(aspectToRatio('1:1'), '1:1');
  assert.equal(aspectToRatio('16:9'), '16:9');
  assert.equal(aspectToRatio('garbage'), '16:9');
});

test('clampDuration holds the API 1-15s window', () => {
  assert.equal(clampDuration(0), 1);
  assert.equal(clampDuration(8), 8);
  assert.equal(clampDuration(99), 15);
  assert.equal(clampDuration(NaN, 7), 7);
  assert.equal(clampDuration(8.6), 9); // rounds
});

test('normalizeResolution guards the enum', () => {
  assert.equal(normalizeResolution('1080p'), '1080p');
  assert.equal(normalizeResolution('480p'), '480p');
  assert.equal(normalizeResolution('4k'), '720p');
});

test('buildVideoRequest produces the documented body, omitting empty image fields', () => {
  const body = buildVideoRequest({ prompt: '  hello  ', duration: 50, aspect: '9:16', resolution: '1080p' });
  assert.equal(body.model, config.xaiVideoModel);
  assert.equal(body.prompt, 'hello');
  assert.equal(body.duration, 15);        // clamped
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.resolution, '1080p');
  assert.ok(!('image' in body));
  assert.ok(!('reference_images' in body));
});

test('buildVideoRequest carries image + reference inputs (as objects) and caps refs at 7', () => {
  const refs = Array.from({ length: 10 }, (_, i) => `https://x/${i}.png`);
  const body = buildVideoRequest({ prompt: 'p', aspect: '16:9', imageUrl: 'https://x/a.png', referenceImages: refs });
  assert.deepEqual(body.image, { url: 'https://x/a.png' }); // xAI expects an object, not image_url
  assert.equal(body.reference_images.length, 7);
  assert.deepEqual(body.reference_images[0], { url: 'https://x/0.png' });
});

test('extractJobId reads id across field-name variants', () => {
  assert.equal(extractJobId({ id: 'a' }), 'a');
  assert.equal(extractJobId({ request_id: 'b' }), 'b');
  assert.equal(extractJobId({ generation_id: 'c' }), 'c');
  assert.equal(extractJobId({ data: { id: 'd' } }), 'd');
  assert.equal(extractJobId({}), null);
});

test('readVideoStatus normalizes queued/generating/completed/error', () => {
  assert.deepEqual(readVideoStatus({ status: 'queued' }), { status: 'queued', url: null, error: null });
  assert.deepEqual(readVideoStatus({ status: 'processing' }), { status: 'generating', url: null, error: null });

  const ok = readVideoStatus({ status: 'completed', video: { url: 'https://x/v.mp4' } });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.url, 'https://x/v.mp4');

  // a url with no explicit status still counts as done
  assert.equal(readVideoStatus({ url: 'https://x/v.mp4' }).status, 'completed');

  // done-but-no-url is an error, not a hang
  const noUrl = readVideoStatus({ status: 'succeeded' });
  assert.equal(noUrl.status, 'error');

  const failed = readVideoStatus({ status: 'failed', error: { message: 'nsfw' } });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'nsfw');
});

test('readVideoStatus finds the url in assets/output/data array shapes', () => {
  assert.equal(readVideoStatus({ status: 'done', assets: [{ url: 'https://x/a.mp4' }] }).url, 'https://x/a.mp4');
  assert.equal(readVideoStatus({ status: 'done', output: ['https://x/o.mp4'] }).url, 'https://x/o.mp4');
  assert.equal(readVideoStatus({ status: 'done', data: [{ url: 'https://x/d.mp4' }] }).url, 'https://x/d.mp4');
});

test('pollUrl builds path- and query-style URLs from the poll path (/videos, not /videos/generations)', () => {
  assert.equal(pollUrl('https://api.x.ai/v1', '/videos', 'abc', 'path'),
    'https://api.x.ai/v1/videos/abc');
  assert.equal(pollUrl('https://api.x.ai/v1', '/videos', 'a b', 'query'),
    'https://api.x.ai/v1/videos?id=a%20b');
});

// --- generateVideoClip state machine (injected fetch + sleep) -------------

function jsonRes(body, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

test('generateVideoClip POSTs then polls queued→generating→completed', async () => {
  const prevKey = config.xaiKey;
  config.xaiKey = 'test-key'; // generateVideoClip refuses without a key
  try {
    const calls = [];
    // Mirrors xAI's real shape: POST → { request_id }, poll → pending → done.
    const responses = [
      jsonRes({ request_id: 'job_1' }),                                  // POST create
      jsonRes({ status: 'pending' }),                                    // poll 1
      jsonRes({ status: 'pending' }),                                    // poll 2
      jsonRes({ status: 'done', video: { url: 'https://x/final.mp4' } }), // poll 3
    ];
    let i = 0;
    const fetchImpl = async (url, opts) => { calls.push({ url, method: opts?.method || 'GET' }); return responses[i++]; };
    const statuses = [];

    const url = await generateVideoClip(
      { prompt: 'a presenter says hi', aspect: '9:16', duration: 6 },
      { fetchImpl, sleepImpl: async () => {}, pollMs: 0, timeoutMs: 10000, onPoll: (s) => statuses.push(s) },
    );

    assert.equal(url, 'https://x/final.mp4');
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/videos\/generations$/);   // POST: /videos/generations
    assert.match(calls[1].url, /\/videos\/job_1$/);         // POLL: /videos/{id} (no "generations")
    assert.deepEqual(statuses, ['generating', 'generating', 'completed']);
  } finally {
    config.xaiKey = prevKey;
  }
});

test('generateVideoClip returns immediately when POST already has the video', async () => {
  const prevKey = config.xaiKey;
  config.xaiKey = 'test-key';
  try {
    let polls = 0;
    const fetchImpl = async (url, opts) => {
      if ((opts?.method || 'GET') === 'POST') return jsonRes({ status: 'completed', url: 'https://x/now.mp4' });
      polls++; return jsonRes({});
    };
    const url = await generateVideoClip({ prompt: 'p', aspect: '1:1' }, { fetchImpl, sleepImpl: async () => {}, pollMs: 0 });
    assert.equal(url, 'https://x/now.mp4');
    assert.equal(polls, 0);
  } finally {
    config.xaiKey = prevKey;
  }
});

test('generateVideoClip throws a clear error when the API reports failure', async () => {
  const prevKey = config.xaiKey;
  config.xaiKey = 'test-key';
  try {
    let i = 0;
    const responses = [jsonRes({ id: 'j' }), jsonRes({ status: 'failed', error: 'content blocked' })];
    const fetchImpl = async () => responses[i++];
    await assert.rejects(
      () => generateVideoClip({ prompt: 'p', aspect: '9:16' }, { fetchImpl, sleepImpl: async () => {}, pollMs: 0 }),
      /content blocked/,
    );
  } finally {
    config.xaiKey = prevKey;
  }
});

test('generateVideoClip times out instead of polling forever', async () => {
  const prevKey = config.xaiKey;
  config.xaiKey = 'test-key';
  try {
    let i = 0;
    const fetchImpl = async () => (i++ === 0 ? jsonRes({ id: 'j' }) : jsonRes({ status: 'generating' }));
    await assert.rejects(
      () => generateVideoClip({ prompt: 'p', aspect: '9:16' }, { fetchImpl, sleepImpl: async () => {}, pollMs: 1, timeoutMs: 5 }),
      /timed out/,
    );
  } finally {
    config.xaiKey = prevKey;
  }
});

// --- planner pure pieces -------------------------------------------------

test('estDurationForLine scales with word count and clamps to 3-15s', () => {
  assert.equal(estDurationForLine('', 10), 10);                  // empty → fallback (clamped)
  assert.equal(estDurationForLine('', 99), 15);                  // fallback also clamped
  assert.equal(estDurationForLine('one two three four five'), 3); // 5 words → 2+1=3
  assert.equal(estDurationForLine(Array(40).fill('word').join(' ')), 15); // long → capped
});

test('buildScenePrompt embeds character, shot, spoken line, language and framing', () => {
  const p = buildScenePrompt({
    character: 'A 30-year-old Nigerian woman in a navy blazer',
    shot: 'modern studio, warm light',
    line: 'Welcome back to the channel',
    tone: 'warm', language: 'Yoruba', aspect: '9:16',
  });
  assert.match(p, /navy blazer/);
  assert.match(p, /modern studio/);
  assert.match(p, /in Yoruba: "Welcome back to the channel"/);
  assert.match(p, /vertical 9:16 framing/);
  assert.match(p, /lip-sync/);
});

test('normalizeTalkingPlan (topic mode) caps scenes and derives durations', () => {
  const parsed = {
    title: 'Test',
    character: 'A presenter',
    scenes: [
      { line: 'short line here', shot: 'a' },
      { line: Array(30).fill('w').join(' '), shot: 'b' },
      { line: '', shot: '' }, // dropped (no line, no shot)
    ],
  };
  const plan = normalizeTalkingPlan(parsed, { cap: 8 });
  assert.equal(plan.title, 'Test');
  assert.equal(plan.character, 'A presenter');
  assert.equal(plan.scenes.length, 2);
  assert.equal(plan.scenes[0].index, 1);
  assert.ok(plan.scenes[0].durationSec >= 3 && plan.scenes[0].durationSec <= 15);
  assert.equal(plan.scenes[1].durationSec, 13); // 30 words → 12+1
});

test('normalizeTalkingPlan (script mode) keeps verbatim lines and pairs shots', () => {
  const parsed = { title: 'My Script', character: 'X', scenes: [{ shot: 'shot one' }, { shot: 'shot two' }] };
  const lines = ['First sentence the user wrote.', 'Second sentence.'];
  const plan = normalizeTalkingPlan(parsed, { cap: 20, lines });
  assert.equal(plan.scenes.length, 2);
  assert.equal(plan.scenes[0].line, 'First sentence the user wrote.');
  assert.equal(plan.scenes[0].shot, 'shot one');
  assert.equal(plan.scenes[1].line, 'Second sentence.');
});

test('defaultClipCount is ~1 clip per 30s (the user-requested ratio)', () => {
  assert.equal(defaultClipCount(30), 1);   // 30s → 1 clip
  assert.equal(defaultClipCount(60), 2);   // 60s → 2 clips
  assert.equal(defaultClipCount(45), 2);   // rounds
  assert.equal(defaultClipCount(15), 1);   // floor of 1
});

test('resolveClipBudget honors a pinned clip count and caps each clip at 15s', () => {
  // 30s / 1 clip → one clip, duration capped at 15s (a clip cannot be 30s).
  const a = resolveClipBudget(30, 1);
  assert.equal(a.sceneCount, 1);
  assert.equal(a.clipSeconds, 15);
  assert.equal(a.wordsPerScene, 38); // 15 * 2.5

  // 60s / 2 clips → two clips, each capped at 15s.
  const b = resolveClipBudget(60, 2);
  assert.equal(b.sceneCount, 2);
  assert.equal(b.clipSeconds, 15);

  // blank clips → default ratio.
  assert.equal(resolveClipBudget(60, null).sceneCount, 2);
  assert.equal(resolveClipBudget(30, null).sceneCount, 1);

  // never exceeds maxClips.
  assert.equal(resolveClipBudget(600, 99, 8).sceneCount, 8);
});

test('ai-video is registered as a queue processor', () => {
  assert.equal(typeof PROCESSORS['ai-video'], 'function');
});
