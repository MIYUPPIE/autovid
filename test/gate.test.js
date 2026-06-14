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
import { buildProportionalSrt, chunkForYarn, yarnChunkTarget } from '../src/voice.js';
import {
  wordsFromTextProportional, wordsFromCues, groupIntoLines, parseSrt, buildKaraokeAss, wordWeight,
} from '../src/captions.js';
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

test('voices: native group carries engine + script language; YarnGPT voices have a speaker', () => {
  const yor = getVoice('yarn-yor-f');
  assert.ok(yor);
  assert.equal(yor.engine, 'yarn');
  assert.equal(yor.yarnVoice, 'Idera');
  assert.equal(yor.lang, 'Yoruba');
  // Every native YarnGPT voice names a speaker and one of the three languages.
  const yarn = VOICES.native.filter((v) => v.engine === 'yarn');
  assert.equal(yarn.length, 6);
  assert.ok(yarn.every((v) => v.yarnVoice && ['Yoruba', 'Igbo', 'Hausa'].includes(v.lang)));
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

// ---------- karaoke captions (the "one giant caption block" fix) ----------
test('captions: proportional word timing covers the whole audio, in order, no overlap', () => {
  const words = wordsFromTextProportional('Báwo ni ọ̀rẹ́ mi. Ẹ kú àárọ̀ o.', 8);
  assert.ok(words.length >= 6, 'every word becomes a cue');
  assert.equal(words[0].start, 0);
  assert.ok(Math.abs(words[words.length - 1].end - 8) < 1e-6, 'last word ends at audio end');
  for (let i = 0; i < words.length; i++) {
    assert.ok(words[i].end > words[i].start, 'each word has positive duration');
    if (i > 0) assert.ok(words[i].start >= words[i - 1].end - 1e-9, 'words never overlap');
  }
});

test('captions: empty / zero-duration inputs produce no words (never crash)', () => {
  assert.deepEqual(wordsFromTextProportional('', 5), []);
  assert.deepEqual(wordsFromTextProportional('hi', 0), []);
});

test('captions: word weight grows with syllables and punctuation adds a pause', () => {
  assert.ok(wordWeight('banana') > wordWeight('cat'), 'more vowel groups = longer');
  assert.ok(wordWeight('end.') > wordWeight('end'), 'full stop adds a breath');
  assert.ok(wordWeight('!!!') >= 1, 'pure punctuation still floors at 1');
});

test('captions: cue-based timing keeps each word inside its own cue window', () => {
  const cues = [{ start: 0, end: 2, text: 'one two' }, { start: 3, end: 5, text: 'three four five' }];
  const words = wordsFromCues(cues);
  assert.equal(words.length, 5);
  assert.ok(words[0].start >= 0 && words[1].end <= 2 + 1e-9, 'first cue words stay in [0,2]');
  assert.ok(words[2].start >= 3 - 1e-9 && words[4].end <= 5 + 1e-9, 'second cue words stay in [3,5]');
});

test('captions: lines break on length and on sentence end', () => {
  const words = wordsFromTextProportional('a b c d e f g h. i j', 10);
  const lines = groupIntoLines(words, { maxWords: 4, maxChars: 100 });
  assert.ok(lines.every((l) => l.length <= 4), 'never exceeds max words per line');
  // The word ending in "." must be the last token of its line.
  const dotLine = lines.find((l) => l.some((w) => w.text.endsWith('.')));
  assert.ok(dotLine[dotLine.length - 1].text.endsWith('.'), 'sentence end closes the line');
});

test('captions: parseSrt is the inverse of edge-style cues', () => {
  const srt = '1\n00:00:00,000 --> 00:00:02,500\nHello there\n\n2\n00:00:02,500 --> 00:00:04,000\nWorld\n';
  const cues = parseSrt(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello there');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 2.5);
  assert.equal(cues[1].end, 4);
});

test('captions: buildKaraokeAss writes a valid ASS with \\k tags and every word', () => {
  const assPath = path.join(os.tmpdir(), `av_${Date.now()}.ass`);
  const out = buildKaraokeAss({ text: 'Ndi Igbo kwenu. Daalu.', duration: 6, aspect: '9:16', assPath });
  assert.equal(out, assPath);
  const ass = fs.readFileSync(assPath, 'utf8');
  fs.unlinkSync(assPath);
  assert.match(ass, /\[Events\]/);
  assert.match(ass, /PlayResX: 1080/); // sized to the 9:16 frame
  assert.match(ass, /Dialogue: /);
  assert.match(ass, /\{\\k\d+\}/, 'uses karaoke timing tags');
  for (const w of ['Ndi', 'Igbo', 'kwenu.', 'Daalu.']) assert.ok(ass.includes(w), `keeps word ${w}`);
});

test('captions: ASS Events Format matches the Dialogue layout (no "0,," leak)', () => {
  // Regression: a short Format line made libass spill margin/effect values
  // ("0,,") into the visible caption text. Format must declare all 10 V4+ event
  // fields, and every Dialogue's Text must begin with the karaoke override, not
  // a stray field value.
  const assPath = path.join(os.tmpdir(), `av_fmt_${Date.now()}.ass`);
  buildKaraokeAss({ cues: [{ start: 0, end: 4, text: 'Ìlú Ìbàdàn jẹ́ ọ̀kan lára àwọn' }], aspect: '9:16', assPath });
  const lines = fs.readFileSync(assPath, 'utf8').split('\n');
  fs.unlinkSync(assPath);

  const fmt = lines.find((l) => l.startsWith('Format:') && l.includes('Text'));
  const fmtFields = fmt.replace('Format:', '').split(',').map((s) => s.trim());
  assert.deepEqual(fmtFields,
    ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text']);

  for (const d of lines.filter((l) => l.startsWith('Dialogue:'))) {
    // Text is everything after the first 9 commas; it must start with "{\k".
    const text = d.replace('Dialogue:', '').split(',').slice(9).join(',');
    assert.ok(text.startsWith('{\\k'), `Dialogue text leaked a field: "${text.slice(0, 12)}"`);
    assert.ok(!/^0,/.test(text), 'no stray "0," prefix in caption text');
  }
});

test('captions: long line is split so it fits the frame width', () => {
  // A long single cue must become several short display lines (so nothing runs
  // off-screen), with no words lost.
  const assPath = path.join(os.tmpdir(), `av_wrap_${Date.now()}.ass`);
  const text = 'Ilu Ibadan je okan lara awon ilu to tobi julo ni ile Yoruba pelu itan oloro ati ojo iwaju to dara gan an';
  buildKaraokeAss({ cues: [{ start: 0, end: 10, text }], aspect: '9:16', assPath });
  const dlg = fs.readFileSync(assPath, 'utf8').split('\n').filter((l) => l.startsWith('Dialogue:'));
  fs.unlinkSync(assPath);
  assert.ok(dlg.length >= 3, `long text should break into several cues, got ${dlg.length}`);
  const shown = dlg.map((d) => d.split(',').slice(9).join(',').replace(/\{\\k\d+\}/g, '')).join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(shown.split(' ').length, text.split(' ').length, 'no words lost across wrapped lines');
});

test('captions: nothing to show → null (no file, no crash)', () => {
  const assPath = path.join(os.tmpdir(), `av_empty_${Date.now()}.ass`);
  assert.equal(buildKaraokeAss({ text: '', duration: 5, assPath }), null);
  assert.equal(fs.existsSync(assPath), false);
});

// ---------- YarnGPT request chunking (2000-char cap) ----------
test('yarn: short text is a single chunk; nothing added or lost', () => {
  const t = 'Ẹ kú àárọ̀, ará mi.';
  assert.deepEqual(chunkForYarn(t, 1800), [t]);
});

test('yarn: long text splits under the cap on sentence boundaries, losing no words', () => {
  const sentence = 'Eyi ni gbolohun kan to gun die die. ';
  const text = sentence.repeat(120); // well over 1800 chars
  const chunks = chunkForYarn(text, 200);
  assert.ok(chunks.length > 1, 'splits into multiple requests');
  assert.ok(chunks.every((c) => c.length <= 200), 'every chunk respects the cap');
  const rejoinWords = chunks.join(' ').split(/\s+/).filter(Boolean).length;
  const srcWords = text.split(/\s+/).filter(Boolean).length;
  assert.equal(rejoinWords, srcWords, 'no words dropped across the split');
});

test('yarn: empty text yields no chunks', () => {
  assert.deepEqual(chunkForYarn('   ', 1800), []);
});

test('yarn: chunk target aims for ~concurrency chunks, floored and capped', () => {
  const opts = { concurrency: 4, min: 100, max: 1800 };
  // Short text: floored so we don't split mid-sentence into tiny pieces.
  assert.equal(yarnChunkTarget(80, opts), 100);
  // Medium text: ~len/concurrency so one parallel wave of 4 covers it.
  assert.equal(yarnChunkTarget(800, opts), 200);
  // Long text: capped at the hard per-request limit.
  assert.equal(yarnChunkTarget(100000, opts), 1800);
});

test('yarn: a typical narration splits into about concurrency chunks (one wave)', () => {
  // ~4 sentences, ~260 chars — should fan out into ≤4 parallel requests.
  const narration =
    'Ilu Ibadan je okan lara awon ilu to tobi julo. Lati igba atijo, o ti je ibudo fun owo ati asa. ' +
    'Awon eniyan re mo fun ise agbe ati eko. Ni ode oni, Ibadan n tesiwaju gege bi ilu to ni itan oloro.';
  const chunks = chunkForYarn(narration, yarnChunkTarget(narration.length, { concurrency: 4, min: 100, max: 1800 }));
  assert.ok(chunks.length >= 2 && chunks.length <= 4, `expected 2-4 chunks, got ${chunks.length}`);
  assert.equal(chunks.join(' ').split(/\s+/).length, narration.split(/\s+/).length, 'no words lost');
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
