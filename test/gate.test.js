// Gate tests: deterministic, offline, free, fast (<2s). No network, no LLM, no ffmpeg.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config, RESOLUTIONS } from '../src/config.js';
import { allVoiceIds, isValidVoice, defaultVoice, getVoice, VOICES } from '../src/voices.js';
import { orientationFor, scoreCandidate } from '../src/stock.js';
import { parseJsonLoose, splitScriptIntoScenes } from '../src/xai.js';
import { tagsForTone } from '../src/music.js';
import { activeLlm, llmChat } from '../src/llm.js';
import { buildProportionalSrt } from '../src/voice.js';
import { runPipeline, getJob, acquireFootage, buildSceneTexts, allocateDurations } from '../src/pipeline.js';
import { app } from '../src/server.js';

// ---------- voices ----------
test('voices: defaults follow the audience toggle', () => {
  assert.equal(defaultVoice('africa'), 'en-NG-EzinneNeural');
  assert.equal(defaultVoice('global'), 'en-US-AvaNeural');
});

test('voices: validation accepts known ids and rejects junk', () => {
  assert.equal(isValidVoice('en-NG-AbeoNeural'), true);
  assert.equal(isValidVoice('en-US-AvaNeural'), true);
  assert.equal(isValidVoice('not-a-voice'), false);
  assert.equal(isValidVoice(undefined), false);
});

test('voices: every id is unique and non-empty', () => {
  const ids = allVoiceIds();
  assert.ok(ids.length >= 15);
  assert.equal(new Set(ids).size, ids.length, 'duplicate voice id found');
  assert.ok(VOICES.native.length > 0 && VOICES.africa.length > 0 && VOICES.global.length > 0);
});

test('voices: native group carries engine + script language; MMS voices have a lang code', () => {
  const yor = getVoice('mms-yor');
  assert.ok(yor);
  assert.equal(yor.engine, 'mms');
  assert.equal(yor.mmsLang, 'yor');
  assert.equal(yor.lang, 'Yoruba');
  const swahili = getVoice('sw-KE-ZuriNeural');
  assert.equal(swahili.engine, 'edge');
  assert.equal(swahili.lang, 'Swahili');
  assert.equal(getVoice('en-US-AvaNeural').lang, 'English');
});

// ---------- resolutions ----------
test('config: resolution presets match the README spec', () => {
  assert.deepEqual([RESOLUTIONS['16:9'].w, RESOLUTIONS['16:9'].h], [1920, 1080]);
  assert.deepEqual([RESOLUTIONS['9:16'].w, RESOLUTIONS['9:16'].h], [1080, 1920]);
  assert.deepEqual([RESOLUTIONS['1:1'].w, RESOLUTIONS['1:1'].h], [1080, 1080]);
});

// ---------- stock ranking ----------
test('stock: orientationFor maps aspect → provider orientation', () => {
  assert.equal(orientationFor('16:9'), 'landscape');
  assert.equal(orientationFor('9:16'), 'portrait');
  assert.equal(orientationFor('1:1'), 'square');
  assert.equal(orientationFor('weird'), 'landscape');
});

test('stock: scoreCandidate prefers matching orientation', () => {
  const portrait = { width: 1080, height: 1920, duration: 10 };
  const landscape = { width: 1920, height: 1080, duration: 10 };
  assert.ok(
    scoreCandidate(portrait, 'portrait') > scoreCandidate(landscape, 'portrait'),
    'portrait clip should outrank landscape for a portrait request'
  );
  assert.ok(
    scoreCandidate(landscape, 'landscape') > scoreCandidate(portrait, 'landscape'),
    'landscape clip should outrank portrait for a landscape request'
  );
});

test('stock: scoreCandidate penalizes over-long / oversized clips (download tax)', () => {
  const ideal = { width: 1920, height: 1080, duration: 10 };  // ~10-20MB
  const veryLong = { width: 1920, height: 1080, duration: 60 }; // huge file for 10s of use
  const uhd = { width: 3840, height: 2160, duration: 10 };      // needless 4K bytes
  assert.ok(scoreCandidate(ideal, 'landscape') > scoreCandidate(veryLong, 'landscape'));
  assert.ok(scoreCandidate(ideal, 'landscape') > scoreCandidate(uhd, 'landscape'));
});

test('stock: scoreCandidate rewards adequate duration and resolution', () => {
  const long = { width: 1920, height: 1080, duration: 8 };
  const short = { width: 1920, height: 1080, duration: 2 };
  assert.ok(scoreCandidate(long, 'landscape') > scoreCandidate(short, 'landscape'));
  const hd = { width: 1280, height: 720, duration: 8 };
  const sd = { width: 640, height: 360, duration: 8 };
  assert.ok(scoreCandidate(hd, 'landscape') > scoreCandidate(sd, 'landscape'));
});

// ---------- xai json parsing ----------
test('xai: parseJsonLoose strips ```json fences', () => {
  const out = parseJsonLoose('```json\n{"title":"x","scenes":[]}\n```');
  assert.equal(out.title, 'x');
  assert.deepEqual(out.scenes, []);
});

test('xai: parseJsonLoose tolerates preamble before the object', () => {
  const out = parseJsonLoose('Sure, here you go:\n{"a":1,"b":[2,3]}\nHope that helps!');
  assert.deepEqual(out, { a: 1, b: [2, 3] });
});

// ---------- pipeline regression (the {} jobId bug) ----------
test('pipeline: runPipeline is synchronous, not async', () => {
  // A regression guard. When runPipeline was `async`, the server serialized a
  // Promise and the client received `{"jobId":{}}`. It must stay a plain Function.
  assert.equal(runPipeline.constructor.name, 'Function');
});

test('pipeline: runPipeline returns a string job id synchronously and registers the job', () => {
  // Blank the xAI key so the background worker fails immediately (offline, no network).
  const savedKey = config.xaiKey;
  config.xaiKey = '';
  try {
    const id = runPipeline({
      topic: 'test', context: 'global', aspect: '16:9', targetSeconds: 30,
      tone: 'engaging', voice: 'en-US-AvaNeural', rate: '+0%',
      subtitles: false, bgMusicPath: null, fades: false,
    });
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    assert.ok(getJob(id), 'job should be registered immediately');
  } finally {
    config.xaiKey = savedKey;
  }
});

// ---------- pluggable LLM provider ----------
test('llm: activeLlm reflects the configured provider', () => {
  const saved = config.llmProvider;
  try {
    config.llmProvider = 'xai';
    assert.equal(activeLlm().provider, 'xai');
    assert.equal(activeLlm().model, config.xaiModel);

    config.llmProvider = 'openrouter';
    const or = activeLlm();
    assert.equal(or.provider, 'openrouter');
    assert.equal(or.model, config.openrouterModel);
    assert.equal(or.configured, Boolean(config.openrouterKey));
  } finally {
    config.llmProvider = saved;
  }
});

test('llm: openrouter without a key fails with a clear error (no silent fallback)', async () => {
  const savedP = config.llmProvider;
  const savedK = config.openrouterKey;
  config.llmProvider = 'openrouter';
  config.openrouterKey = '';
  try {
    await assert.rejects(
      () => llmChat([{ role: 'user', content: 'hi' }]),
      /OPENROUTER_API_KEY/,
    );
  } finally {
    config.llmProvider = savedP;
    config.openrouterKey = savedK;
  }
});

// ---------- music ----------
test('music: every tone maps to non-empty Jamendo mood tags', () => {
  for (const tone of ['engaging', 'documentary', 'energetic', 'calm', 'inspirational', 'unknown']) {
    const tags = tagsForTone(tone);
    assert.equal(typeof tags, 'string');
    assert.ok(tags.length > 0);
  }
});

// ---------- script mode (user's own narration, verbatim) ----------
test('script split: chunks rejoin to the exact (whitespace-normalized) script', () => {
  const script = 'One small step. Then a giant leap! Was it worth it? Absolutely yes. The end.';
  const scenes = splitScriptIntoScenes(script, 6);
  assert.ok(scenes.length >= 2, 'should split into multiple scenes');
  assert.equal(scenes.join(' '), script.replace(/\s+/g, ' ').trim(), 'no words added or lost');
});

test('script split: groups sentences toward the target size and never drops content', () => {
  const script = 'Aa bb cc. Dd ee ff. Gg hh ii. Jj kk ll.'; // 4 sentences, 3 words each
  const scenes = splitScriptIntoScenes(script, 6); // ~2 sentences per scene
  assert.ok(scenes.length >= 2 && scenes.length <= 4);
  const words = scenes.join(' ').split(/\s+/).length;
  assert.equal(words, 12);
});

test('script split: empty input yields no scenes', () => {
  assert.deepEqual(splitScriptIntoScenes('   ', 10), []);
  assert.deepEqual(splitScriptIntoScenes('', 10), []);
});

// ---------- flowing narration ----------
test('script: hook folds into first scene, outro into last', () => {
  const plan = {
    hook: 'HOOK.', outro: 'OUTRO.',
    scenes: [{ narration: 'one.' }, { narration: 'two.' }, { narration: 'three.' }],
  };
  const texts = buildSceneTexts(plan);
  assert.equal(texts.length, 3);
  assert.ok(texts[0].startsWith('HOOK.'));
  assert.ok(texts[2].endsWith('OUTRO.'));
  assert.ok(!texts[1].includes('HOOK') && !texts[1].includes('OUTRO'));
});

test('durations: allocation is proportional, respects a floor, and covers the audio', () => {
  const texts = ['a'.repeat(100), 'b'.repeat(50), 'c']; // very uneven
  const total = 30;
  const d = allocateDurations(texts, total, 2.5);
  assert.equal(d.length, 3);
  assert.ok(d[2] >= 2.5, 'tiny scene is floored');
  assert.ok(d[0] > d[1], 'longer text gets more time');
  // Sum must be >= audio length so the picture always covers the narration.
  assert.ok(d.reduce((a, b) => a + b, 0) >= total - 0.001);
});

test('subtitles: proportional SRT has one cue per sentence within the duration', () => {
  const srtPath = path.join(os.tmpdir(), `av_${Date.now()}.srt`);
  buildProportionalSrt('First sentence here. Second one. Third and last!', 9, srtPath);
  const txt = fs.readFileSync(srtPath, 'utf8');
  fs.unlinkSync(srtPath);
  const cues = txt.trim().split(/\n\n+/);
  assert.equal(cues.length, 3);
  assert.match(txt, /00:00:00,000 --> /); // starts at zero
  assert.ok(!/00:00:(09|1[0-9])/.test(txt) || /00:00:09,000/.test(txt), 'cues stay within duration');
});

// ---------- footage resilience (the "aborted download killed the render" bug) ----------
const clip = (url, provider = 'pexels') => ({ url, provider, width: 1920, height: 1080, duration: 8 });

test('footage: a failed download is skipped and the next candidate is used', async () => {
  const deps = {
    findClipCandidates: async () => [clip('a'), clip('b'), clip('c')],
    downloadClip: async (url) => {
      if (url === 'a') throw new Error('The operation was aborted.'); // stalled clip
      return `/raw/${url}.mp4`;
    },
  };
  const got = await acquireFootage({ queries: ['q'], orientation: 'landscape', base: 's1' }, deps);
  assert.ok(got, 'should recover from one bad download');
  assert.equal(got.clip.url, 'b');
  assert.equal(got.usedQuery, 'q');
});

test('footage: falls back to alternative queries when the primary query fails entirely', async () => {
  const deps = {
    findClipCandidates: async (q) => (q === 'good' ? [clip('x')] : [clip('dead')]),
    downloadClip: async (url) => {
      if (url === 'dead') throw new Error('HTTP 404');
      return `/raw/${url}.mp4`;
    },
  };
  const got = await acquireFootage(
    { queries: ['bad', 'good'], orientation: 'landscape', base: 's1' }, deps,
  );
  assert.ok(got);
  assert.equal(got.usedQuery, 'good');
  assert.equal(got.clip.url, 'x');
});

test('footage: returns null only when every candidate of every query fails', async () => {
  const deps = {
    findClipCandidates: async () => [clip('a'), clip('b')],
    downloadClip: async () => { throw new Error('boom'); },
  };
  const got = await acquireFootage({ queries: ['q1', 'q2'], orientation: 'landscape', base: 's1' }, deps);
  assert.equal(got, null);
});

test('footage: caps download attempts per query and never retries the same url', async () => {
  const seen = [];
  const many = Array.from({ length: 10 }, (_, i) => clip(`u${i}`));
  const deps = {
    findClipCandidates: async () => many, // same list returned for both queries
    downloadClip: async (url) => { seen.push(url); throw new Error('nope'); },
  };
  const got = await acquireFootage({ queries: ['q1', 'q2'], orientation: 'landscape', base: 's1' }, deps);
  assert.equal(got, null);
  // 4 new candidates per query → q1 tries u0-u3, q2 skips those and tries u4-u7.
  assert.deepEqual(seen, ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
  assert.equal(new Set(seen).size, seen.length, 'no url should be downloaded twice');
});

// ---------- HTTP contract ----------
async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('http: GET /api/health reports keys as booleans', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.keys.xai, 'boolean');
    assert.equal(typeof body.keys.pexels, 'boolean');
    assert.equal(typeof body.keys.pixabay, 'boolean');
    assert.equal(typeof body.model, 'string');
  });
});

test('http: GET /api/voices returns voice groups and resolutions', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/voices`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.voices.africa));
    assert.ok(Array.isArray(body.voices.global));
    assert.ok(body.resolutions['9:16']);
  });
});

test('http: POST /api/render rejects an empty topic with 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: '   ' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('http: POST /api/render returns a STRING jobId (not {})', async () => {
  // The exact regression: a Promise here serializes to {}. Blank the key so the
  // background worker errors immediately and we stay offline.
  const savedKey = config.xaiKey;
  config.xaiKey = '';
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'street food markets', aspect: '9:16' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.jobId, 'string');
      assert.ok(body.jobId.length > 0);
    });
  } finally {
    config.xaiKey = savedKey;
  }
});
