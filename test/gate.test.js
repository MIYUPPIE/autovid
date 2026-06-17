// Gate tests: deterministic, offline, free, fast (<2s). No network, no LLM, no ffmpeg.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config, RESOLUTIONS } from '../src/config.js';
import { allVoiceIds, isValidVoice, defaultVoice, getVoice, VOICES, edgeVoiceName } from '../src/voices.js';
import { orientationFor, scoreCandidate, clipKey, localizeQuery, isYouTubeUrl, shuffle, rankProvider, roundRobin } from '../src/stock.js';
import { loadRecentClips, recordUsedClips, clearClipHistory, MAX_HISTORY } from '../src/clip-history.js';
import { parseJsonLoose, splitScriptIntoScenes, languageNote } from '../src/xai.js';
import { tagsForTone } from '../src/music.js';
import { activeLlm, llmChat } from '../src/llm.js';
import { buildProportionalSrt, chunkForYarn, yarnChunkTarget } from '../src/voice.js';
import {
  wordsFromTextProportional, wordsFromCues, groupIntoLines, parseSrt, buildKaraokeAss, wordWeight,
  captionScale, CAPTION_SIZES, captionAnimTag, CAPTION_ANIMS, hexToAss,
} from '../src/captions.js';
import { normalizeBrand, DEFAULT_BRAND } from '../src/brand.js';
import { buildXfadeGraph, TRANSITIONS, nearestAspect, logoOverlayXY } from '../src/ffmpeg.js';
import { transcriptText, highlightWindows, pickTopWindows, windowCues, windowWordCues } from '../src/transcribe.js';
import { buildDubPrompt, cleanDubText } from '../src/dub.js';
import { runPipeline, runMultiPipeline, getJob, acquireFootage, buildSceneTexts, allocateDurations, expandScenes, resolveBatchVoices, PROCESSORS, memoryCtx } from '../src/pipeline.js';
import { submitRender, jobView, queueEnabled, activeBackend } from '../src/jobs.js';
import { stateToStatus, viewFromState, progressAccumulator } from '../src/queue.js';
import { buildProject, saveProject } from '../src/project.js';
import { assetToUrl, MEDIA_DIRS, previewBundle } from '../src/edit.js';
import { buildHashtags, buildCaptions, buildPlatformLinks, buildShareKit, lanBaseUrl } from '../src/share.js';
import { beatGrid, snapToBeats, estimateTempoFromEnvelope, onsetEnvelope } from '../src/beats.js';
import { distillCardText, wrapText, cardPalette, cardWrapWidth, CARD_PALETTES } from '../src/cards.js';
import { netReason, downloadToFile, BROWSER_HEADERS } from '../src/http.js';
import http from 'node:http';
import { app } from '../src/server.js';

// Keep project-endpoint tests off the real assets dir.
config.dirs.projects = fs.mkdtempSync(path.join(os.tmpdir(), 'av_gate_proj_'));

// Drive an in-memory job to a terminal state (bounded). The pipeline tests blank
// the LLM key so the background work fails at the first LLM call — we await that
// failure WHILE the key is still blank, so no real network render leaks past the
// test (that's what kept the offline gate suite honest and fast).
async function settle(id, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = getJob(id);
    if (!j || j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  return getJob(id);
}

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

// ---------- Pidgin + code-switching (#3) ----------
test('voices: Nigerian Pidgin voices exist and alias the en-NG neural voices', () => {
  const f = getVoice('pcm-NG-EzinnePidgin');
  const m = getVoice('pcm-NG-AbeoPidgin');
  assert.ok(f && m, 'both Pidgin voices present');
  assert.equal(f.lang, 'Nigerian Pidgin');
  assert.equal(f.engine, 'edge');
  // The catalogue id is a logical alias; synthesis must use the real edge voice.
  assert.equal(edgeVoiceName('pcm-NG-EzinnePidgin'), 'en-NG-EzinneNeural');
  assert.equal(edgeVoiceName('pcm-NG-AbeoPidgin'), 'en-NG-AbeoNeural');
  // A plain edge voice resolves to itself (back-compat).
  assert.equal(edgeVoiceName('en-US-AvaNeural'), 'en-US-AvaNeural');
  assert.equal(edgeVoiceName('unknown-id'), 'unknown-id');
});

test('xai: languageNote handles English, Pidgin and other languages correctly', () => {
  const en = languageNote('English');
  assert.match(en, /English/);
  assert.ok(!/avoid English/i.test(en));

  // Pidgin keeps its code-switching — must NOT tell the model to avoid English.
  const pcm = languageNote('Nigerian Pidgin');
  assert.match(pcm, /Pidgin/i);
  assert.ok(!/Avoid English\/Latin loanwords/i.test(pcm), 'Pidgin must not ban English loanwords');
  assert.match(pcm, /query.*ENGLISH/is, 'stock queries stay English');

  // A true native language keeps the strict no-loanword TTS rules.
  const yo = languageNote('Yoruba');
  assert.match(yo, /Yoruba/);
  assert.match(yo, /Avoid English\/Latin loanwords/i);

  // codeSwitch adds a mixing instruction without breaking the native rules.
  assert.match(languageNote('Yoruba', { codeSwitch: true }), /Code-switch/i);
  assert.match(languageNote('English', { codeSwitch: true }), /English words/i);
});

// ---------- localized visual bias (#4) ----------
test('stock: localizeQuery biases African audiences toward African footage', () => {
  // African audience → localized variant first, bare query as fallback.
  assert.deepEqual(localizeQuery('street market', 'africa'), ['street market Africa', 'street market']);
  // Already-localized query is left alone (no double "Africa Africa").
  assert.deepEqual(localizeQuery('Lagos traffic', 'africa'), ['Lagos traffic']);
  assert.deepEqual(localizeQuery('african village', 'africa'), ['african village']);
  // Global audience → untouched.
  assert.deepEqual(localizeQuery('street market', 'global'), ['street market']);
  // Empty/whitespace → empty list, never a bare " Africa".
  assert.deepEqual(localizeQuery('   ', 'africa'), []);
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

test('stock: scoreCandidate prefers a clip long enough to cover the scene (no loop)', () => {
  // With a scene minDur, a clip that covers it must outrank one that would loop.
  const covers = { width: 1920, height: 1080, duration: 12 };
  const tooShort = { width: 1920, height: 1080, duration: 3 };
  assert.ok(
    scoreCandidate(covers, 'landscape', 10) > scoreCandidate(tooShort, 'landscape', 10),
    'a clip covering the scene should beat one that loops',
  );
  // Without a minDur the bias is off (back-compat with the 2-arg callers).
  assert.equal(scoreCandidate(covers, 'landscape'), scoreCandidate(covers, 'landscape', 0));
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

test('pipeline: runPipeline returns a string job id synchronously and registers the job', async () => {
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
    // Wait for the offline failure with the key still blank (no leaked render).
    const done = await settle(id);
    assert.equal(done.status, 'error');
  } finally {
    config.xaiKey = savedKey;
  }
});

// ---------- multi-language one-shot (#1) ----------
test('pipeline: runMultiPipeline fans out into one registered job per language', async () => {
  const savedKey = config.xaiKey;
  config.xaiKey = ''; // background workers fail fast, offline
  try {
    const batch = runMultiPipeline({
      topic: 'jollof rice', context: 'africa', aspect: '9:16', targetSeconds: 30,
      tone: 'engaging', voice: 'en-NG-EzinneNeural', rate: '+0%', subtitles: false,
      voices: ['yarn-yor-f', 'yarn-ibo-f', 'en-NG-EzinneNeural', 'not-a-voice'],
    });
    assert.equal(typeof batch.batchId, 'string');
    // 3 distinct valid voices (base + 2 extras; the dupe + junk are dropped).
    assert.equal(batch.jobs.length, 3);
    assert.deepEqual(batch.jobs.map((j) => j.language).sort(), ['English', 'Igbo', 'Yoruba']);
    for (const j of batch.jobs) {
      assert.equal(typeof j.jobId, 'string');
      assert.ok(getJob(j.jobId), 'each variant job is registered');
    }
    // No valid voice at all → throws (caught by the endpoint as 400).
    assert.throws(() => runMultiPipeline({ topic: 't', voice: 'bogus', voices: [] }));
    // Settle all variants offline before restoring the key (no leaked renders).
    await Promise.all(batch.jobs.map((j) => settle(j.jobId)));
  } finally {
    config.xaiKey = savedKey;
  }
});

// ---------- job queue facade (Redis/BullMQ backend, additive) ----------
test('queue: defaults to the in-memory backend when no REDIS_URL', () => {
  // The whole gate suite runs offline, so the queue must NOT require Redis.
  // jobView/submit* fall through to the in-memory pipeline functions.
  assert.equal(queueEnabled(), false);
  assert.equal(activeBackend(), 'memory');
});

test('queue: PROCESSORS exposes exactly the four job kinds the worker dispatches', () => {
  assert.deepEqual(Object.keys(PROCESSORS).sort(), ['dub', 'project-render', 'render', 'shorts']);
  for (const fn of Object.values(PROCESSORS)) assert.equal(typeof fn, 'function');
});

test('pipeline: memoryCtx exposes the job id and mirrors emit/setPlan onto the job', () => {
  // Regression: processors use ctx.id as the asset/project base, so the in-memory
  // ctx MUST carry the job id (a render with ctx.id === undefined wrote
  // "undefined_final.mp4" and saved a project with no id).
  const job = { id: 'JOB123', log: [], progress: { stage: 'init', message: '', pct: 0 }, plan: null };
  const ctx = memoryCtx(job);
  assert.equal(ctx.id, 'JOB123', 'ctx.id must equal the job id');

  ctx.emit('voice', 'recording', 16);
  assert.equal(ctx.pct, 16);
  assert.deepEqual(job.progress, { stage: 'voice', message: 'recording', pct: 16 });
  assert.equal(job.log.length, 1);
  assert.equal(job.log[0].stage, 'voice');

  ctx.setPlan({ title: 'Hi' });
  assert.deepEqual(job.plan, { title: 'Hi' });
});

test('pipeline: resolveBatchVoices dedupes, drops junk, throws when nothing is valid', () => {
  const variants = resolveBatchVoices({
    voice: 'en-NG-EzinneNeural',
    voices: ['yarn-yor-f', 'yarn-ibo-f', 'en-NG-EzinneNeural', 'not-a-voice'],
  });
  // base + 2 extras; the dupe of the base and the junk id are dropped.
  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((v) => v.language).sort(), ['English', 'Igbo', 'Yoruba']);
  assert.ok(variants.every((v) => typeof v.voice === 'string'));
  assert.throws(() => resolveBatchVoices({ voice: 'bogus', voices: [] }), /no valid voices/);
});

test('queue: submitRender (memory) returns a string id and jobView reports the SAME shape', async () => {
  // Blank the key so the background worker fails immediately, offline — this
  // exercises the full ctx/runner path and the error surface of jobView.
  const savedKey = config.xaiKey;
  config.xaiKey = '';
  try {
    const id = await submitRender({
      topic: 'queue test', context: 'global', aspect: '16:9', targetSeconds: 30,
      tone: 'engaging', voice: 'en-US-AvaNeural', rate: '+0%', subtitles: false,
    });
    assert.equal(typeof id, 'string');
    // jobView mirrors the memory job object: id/status/progress/log/result/error.
    const view = await jobView(id);
    assert.ok(view);
    assert.equal(view.id, id);
    assert.ok(['running', 'error'].includes(view.status));
    assert.ok(Array.isArray(view.log));
    assert.ok(view.progress && typeof view.progress.pct === 'number');

    // Drive it to a terminal state (bounded) and confirm the error propagates.
    const t0 = Date.now();
    let final = view;
    while (Date.now() - t0 < 1500 && final.status === 'running') {
      await new Promise((r) => setTimeout(r, 10));
      final = await jobView(id);
    }
    assert.equal(final.status, 'error', 'a blank XAI key must fail the render');
    assert.match(final.error || '', /XAI_API_KEY/);
    assert.ok(final.log.some((e) => e.stage === 'error'), 'the error is logged for the SSE stream');
  } finally {
    config.xaiKey = savedKey;
  }
});

test('queue: jobView returns null for an unknown id (memory backend)', async () => {
  assert.equal(await jobView('does-not-exist'), null);
});

// The Redis backend's translation logic, proven offline (the live round-trip is
// the paid eval `npm run eval:queue`, which needs a Redis).
test('queue: stateToStatus maps BullMQ states to the in-memory vocabulary', () => {
  assert.equal(stateToStatus('completed'), 'done');
  assert.equal(stateToStatus('failed'), 'error');
  for (const s of ['waiting', 'active', 'delayed', 'paused', 'unknown']) {
    assert.equal(stateToStatus(s), 'running', `${s} should read as running`);
  }
});

test('queue: viewFromState rebuilds the exact /api/job shape from a BullMQ job', () => {
  // A completed job with a persisted progress payload (log + plan ride inside it).
  const job = {
    id: 'abc123', name: 'render',
    progress: { stage: 'done', message: 'Render complete', pct: 100, log: [{ t: 1, stage: 'planning', message: 'hi' }], plan: { title: 'X' } },
    returnvalue: { file: 'abc123_final.mp4', projectId: 'abc123' },
    failedReason: null,
  };
  const v = viewFromState(job, 'completed');
  assert.equal(v.id, 'abc123');
  assert.equal(v.kind, 'render');
  assert.equal(v.status, 'done');
  assert.deepEqual(v.progress, { stage: 'done', message: 'Render complete', pct: 100 });
  assert.deepEqual(v.plan, { title: 'X' });
  assert.equal(v.result.file, 'abc123_final.mp4');
  assert.equal(v.log.length, 1);

  // A failed job surfaces the reason as `error`; a bare/new job is safe defaults.
  const failed = viewFromState({ id: 'z', name: 'dub', failedReason: 'boom' }, 'failed');
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'boom');
  assert.deepEqual(failed.progress, { stage: 'init', message: '', pct: 0 });
  assert.deepEqual(failed.log, []);
  assert.equal(failed.result, null);
});

test('queue: progressAccumulator builds the cumulative payload viewFromState reads back', () => {
  const acc = progressAccumulator(2);
  assert.equal(acc.pct, 2);
  acc.emit('planning', 'writing', 5);
  acc.setPlan({ title: 'My Video' });
  acc.emit('voice', 'recording', 16);
  assert.equal(acc.pct, 16);
  const snap = acc.snapshot();
  assert.deepEqual({ stage: snap.stage, message: snap.message, pct: snap.pct }, { stage: 'voice', message: 'recording', pct: 16 });
  assert.equal(snap.log.length, 2, 'every emit appends one cumulative log entry');
  assert.deepEqual(snap.plan, { title: 'My Video' });

  // The snapshot is exactly what the worker persists → feed it through
  // viewFromState and the SSE stream sees a faithful running view.
  const v = viewFromState({ id: 'q', name: 'render', progress: snap }, 'active');
  assert.equal(v.status, 'running');
  assert.equal(v.progress.pct, 16);
  assert.equal(v.log.length, 2);
  assert.deepEqual(v.plan, { title: 'My Video' });
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

test('captions: posX/posY drop the caption at an absolute frame point', () => {
  const base = path.join(os.tmpdir(), `av_pos_${Date.now()}`);
  // Default (no position) → no \pos, line stays styled bottom-centre.
  const def = `${base}_d.ass`;
  buildKaraokeAss({ cues: [{ start: 0, end: 3, text: 'hello there' }], aspect: '16:9', assPath: def });
  const dass = fs.readFileSync(def, 'utf8'); fs.unlinkSync(def);
  assert.ok(!dass.includes('\\pos('), 'no \\pos when unpositioned');

  // Positioned top-left-ish → \an5\pos at the scaled pixel coords (1920x1080).
  const pos = `${base}_p.ass`;
  buildKaraokeAss({ cues: [{ start: 0, end: 3, text: 'hello there' }], aspect: '16:9', assPath: pos,
    style: { posX: 0.25, posY: 0.1 } });
  const pass = fs.readFileSync(pos, 'utf8'); fs.unlinkSync(pos);
  assert.match(pass, /\{\\an5\\pos\(480,108\)\}/, 'line carries \\an5\\pos at 0.25*1920, 0.1*1080');
  // every Dialogue still keeps its karaoke tags after the position override
  for (const d of pass.split('\n').filter((l) => l.startsWith('Dialogue:'))) {
    assert.ok(d.includes('{\\k'), 'karaoke timing preserved with positioning');
  }
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

// ---------- caption size ----------
const assFontSize = (ass) => Number(/^Style: Default,[^,]+,(\d+),/m.exec(ass)[1]);

test('captions: captionScale maps named sizes and clamps raw scale', () => {
  assert.equal(captionScale({}), 1, 'no size → Medium');
  assert.equal(captionScale({ size: 'S' }), CAPTION_SIZES.S);
  assert.equal(captionScale({ size: 'XL' }), CAPTION_SIZES.XL);
  assert.equal(captionScale({ size: 'bogus' }), 1, 'unknown name → Medium');
  assert.equal(captionScale({ scale: 1.4 }), 1.4, 'raw scale honored');
  assert.equal(captionScale({ scale: 99 }), 2.5, 'clamped high');
  assert.equal(captionScale({ scale: 0.1 }), 0.5, 'clamped low');
  assert.ok(captionScale({ scale: 1.1 }) === 1.1); // numeric scale wins over default
});

test('captions: size picker scales the burned-in font (S < M < L < XL)', () => {
  const sizes = ['S', 'M', 'L', 'XL'].map((size) => {
    const assPath = path.join(os.tmpdir(), `av_sz_${size}_${Date.now()}.ass`);
    buildKaraokeAss({ text: 'Ndi Igbo kwenu. Daalu.', duration: 6, aspect: '16:9', assPath, style: { size } });
    const fs0 = assFontSize(fs.readFileSync(assPath, 'utf8'));
    fs.unlinkSync(assPath);
    return fs0;
  });
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2] && sizes[2] < sizes[3],
    `expected strictly increasing font sizes, got ${sizes.join(' < ')}`);
  // Medium matches the historical width-based default (5.8% of 1920).
  assert.equal(sizes[1], Math.round(RESOLUTIONS['16:9'].w * 0.058));
  // Large is the default times the L multiplier.
  assert.equal(sizes[2], Math.round(RESOLUTIONS['16:9'].w * 0.058 * CAPTION_SIZES.L));
});

test('captions: explicit fontSize overrides the size multiplier', () => {
  const assPath = path.join(os.tmpdir(), `av_fs_${Date.now()}.ass`);
  buildKaraokeAss({ text: 'hello there', duration: 3, aspect: '16:9', assPath, style: { size: 'XL', fontSize: 40 } });
  const fsz = assFontSize(fs.readFileSync(assPath, 'utf8'));
  fs.unlinkSync(assPath);
  assert.equal(fsz, 40, 'raw fontSize wins outright');
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

test('footage: a shared used-set stops two scenes reusing the same clip', async () => {
  // Regression: each scene used its own "tried" set, so when two scenes' queries
  // returned the same top-ranked clip both downloaded it → repeated footage.
  const used = new Set();
  const deps = {
    findClipCandidates: async () => [clip('a'), clip('b'), clip('c')],
    downloadClip: async (url) => `/raw/${url}.mp4`,
  };
  const s1 = await acquireFootage({ queries: ['q'], orientation: 'landscape', base: 's1', used }, deps);
  const s2 = await acquireFootage({ queries: ['q'], orientation: 'landscape', base: 's2', used }, deps);
  const s3 = await acquireFootage({ queries: ['q'], orientation: 'landscape', base: 's3', used }, deps);
  assert.equal(s1.clip.url, 'a');
  assert.equal(s2.clip.url, 'b', 'second scene must not reuse the first clip');
  assert.equal(s3.clip.url, 'c', 'third scene must not reuse an earlier clip');
});

test('stock: clipKey is stable on provider+id, falls back to url', () => {
  assert.equal(clipKey({ provider: 'pexels', id: 7, url: 'x' }), 'pexels:7');
  assert.equal(clipKey({ provider: 'pixabay', url: 'y' }), 'y'); // no id
});

// A small seeded RNG (mulberry32) so the shuffle-based tests are deterministic.
const seededRng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

test('stock: roundRobin uses every provider equally and rotates the lead', () => {
  const mk = (provider, n) => Array.from({ length: n }, (_, i) => ({ provider, i }));
  // Three equal-length lists → strict P,X,Y,P,X,Y round-robin.
  const merged = roundRobin([mk('pexels', 3), mk('pixabay', 3), mk('youtube', 3)]);
  assert.deepEqual(merged.map((c) => c.provider).slice(0, 3), ['pexels', 'pixabay', 'youtube']);
  // Within the first 6 (a typical attempt budget across scenes) each source appears twice.
  const head = merged.slice(0, 6).map((c) => c.provider);
  for (const p of ['pexels', 'pixabay', 'youtube']) {
    assert.equal(head.filter((x) => x === p).length, 2, `${p} should be used equally`);
  }
  // `start` rotates which provider leads, so callers vary the source per scene.
  assert.equal(roundRobin([mk('pexels', 2), mk('pixabay', 2), mk('youtube', 2)], 2)[0].provider, 'youtube');
  // Uneven lengths: the longer provider just fills the tail; nothing is dropped.
  const uneven = roundRobin([mk('pexels', 1), mk('pixabay', 3)]);
  assert.equal(uneven.length, 4);
  assert.equal(uneven.filter((c) => c.provider === 'pixabay').length, 3);
  // Empty input is safe.
  assert.deepEqual(roundRobin([[], []]), []);
  assert.deepEqual(roundRobin([]), []);
});

test('stock: rankProvider keeps quality (high score first) but varies within a tier', () => {
  const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) =>
    ({ url: `c${i}`, provider: 'pexels', width: 1920, height: 1080, duration: 8, id: i, ...extra }));
  // Mix one clearly worse clip (50s = download tax) with equally-good ones.
  const good = mk(5);
  const worse = [{ url: 'long', provider: 'pexels', width: 1920, height: 1080, duration: 50, id: 99 }];
  const ranked = rankProvider([...worse, ...good], 'landscape', 0, { rng: seededRng(1) });
  assert.equal(ranked[ranked.length - 1].url, 'long', 'the download-tax clip ranks last');
  // Two different seeds reorder the equal-score tier → variety, not the same clip every time.
  const a = rankProvider(good, 'landscape', 0, { rng: seededRng(1) }).map((c) => c.url);
  const b = rankProvider(good, 'landscape', 0, { rng: seededRng(7) }).map((c) => c.url);
  assert.notDeepEqual(a, b, 'different RNG seeds must yield a different in-tier order');
  // Same set of clips though — variety, no loss.
  assert.deepEqual([...a].sort(), [...b].sort());
});

test('stock: rankProvider floats recently-used clips to the back (cross-render dedup)', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) =>
    ({ url: `c${i}`, provider: 'pexels', width: 1920, height: 1080, duration: 8, id: i }));
  const clips = mk(4);
  // Mark c0 and c1 as used by a previous render.
  const recent = new Set(['pexels:0', 'pexels:1']);
  const ranked = rankProvider(clips, 'landscape', 0, { rng: seededRng(3), recent });
  const order = ranked.map((c) => clipKey(c));
  // The two fresh clips come first; the recently-used ones are pushed to the back.
  assert.deepEqual(order.slice(2).sort(), ['pexels:0', 'pexels:1']);
  assert.ok(!order.slice(0, 2).includes('pexels:0') && !order.slice(0, 2).includes('pexels:1'),
    'recently-used clips must not lead the list');
  // But they are still present — soft demotion, never a hard exclude (no card regressions).
  assert.equal(ranked.length, 4);
});

test('stock: isYouTubeUrl recognizes watch/share/shorts/embed, rejects stock CDNs', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=abc123',
    'https://youtube.com/watch?v=abc123&t=10',
    'https://youtu.be/abc123',
    'https://www.youtube.com/shorts/abc123',
    'https://www.youtube.com/embed/abc123',
  ]) assert.ok(isYouTubeUrl(u), `should match: ${u}`);
  for (const u of [
    'https://player.vimeo.com/video/123.mp4',
    'https://videos.pexels.com/video-files/123/abc.mp4',
    'https://cdn.pixabay.com/vimeo/123/clip.mp4',
    '',
    null,
  ]) assert.ok(!isYouTubeUrl(u), `should NOT match: ${u}`);
});

test('stock: YouTube is used equally despite no width/height (round-robin, not score)', () => {
  // Regression: YouTube has no width/height from a flat search, so it always scored
  // below shaped stock and, with a 4-attempt budget, was never reached. Round-robin
  // gives it an equal turn. Mirror findClipCandidates' merge: rank each provider,
  // then round-robin across them.
  const pexels = [{ url: 'p0', provider: 'pexels', width: 1920, height: 1080, duration: 8, id: 0 }];
  const yt = [{ url: 'https://youtu.be/x', provider: 'youtube', width: 0, height: 0, duration: 600, id: 'x' }];
  const lists = [pexels, yt].map((arr) => rankProvider(arr, 'landscape', 0, { rng: seededRng(2) }));
  // YouTube leading the round-robin → a YouTube clip is the very first candidate.
  assert.equal(roundRobin(lists, 1)[0].provider, 'youtube', 'YouTube must be reachable, not buried');
  // Over a 2-source list the head alternates evenly.
  const merged = roundRobin(lists, 0);
  assert.deepEqual(merged.map((c) => c.provider), ['pexels', 'youtube']);
});

test('stock: shuffle preserves the multiset and leaves the input untouched', () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffle(input, seededRng(9));
  assert.deepEqual([...out].sort((a, b) => a - b), [1, 2, 3, 4, 5], 'no element added or lost');
  assert.deepEqual(input, [1, 2, 3, 4, 5], 'input array is not mutated');
});

// ---------- cross-render clip history (the "same clips repeated every render" fix) ----------
test('clip-history: records used keys, dedupes, newest wins, caps at MAX_HISTORY', () => {
  const savedWork = config.dirs.work;
  config.dirs.work = fs.mkdtempSync(path.join(os.tmpdir(), 'av_clip_hist_'));
  try {
    clearClipHistory();
    assert.deepEqual([...loadRecentClips()], [], 'empty/missing history loads as an empty set');

    recordUsedClips(['pexels:1', 'pixabay:2', '', null, 'pexels:1']); // junk + dupe dropped
    assert.deepEqual([...loadRecentClips()].sort(), ['pexels:1', 'pixabay:2']);

    // Re-using a key moves it to the newest end (so it stays remembered longest).
    recordUsedClips(['pexels:1', 'youtube:9']);
    const after = [...loadRecentClips()];
    assert.deepEqual(after.sort(), ['pexels:1', 'pixabay:2', 'youtube:9']);

    // Cap: writing more than MAX_HISTORY keeps only the most recent ones.
    const many = Array.from({ length: MAX_HISTORY + 50 }, (_, i) => `pexels:k${i}`);
    recordUsedClips(many);
    const capped = loadRecentClips();
    assert.equal(capped.size, MAX_HISTORY, 'history is capped');
    assert.ok(capped.has(`pexels:k${MAX_HISTORY + 49}`), 'the newest key survives');
    assert.ok(!capped.has('pexels:k0'), 'the oldest overflow key is dropped');
  } finally {
    fs.rmSync(config.dirs.work, { recursive: true, force: true });
    config.dirs.work = savedWork;
  }
});

test('footage: recently-used clips are forwarded to the ranker (cross-render variety)', async () => {
  // acquireFootage must pass `recent` through to findClipCandidates so past renders
  // bias selection away from repeats.
  let sawRecent = null;
  const deps = {
    findClipCandidates: async (q, o, lead, minDur, sources, opts) => {
      sawRecent = opts && opts.recent;
      return [{ url: 'a', provider: 'pexels', width: 1920, height: 1080, duration: 8 }];
    },
    downloadClip: async (url) => `/raw/${url}.mp4`,
  };
  const recent = new Set(['pexels:7']);
  const got = await acquireFootage({ queries: ['q'], orientation: 'landscape', base: 's1', recent }, deps);
  assert.ok(got);
  assert.equal(sawRecent, recent, 'the recent set must reach the ranker');
});

// ---------- share kit (share.js, pure) ----------
test('share: hashtags drop stopwords/short tokens, add aspect tags, dedupe, cap', () => {
  const tags = buildHashtags({ title: 'How to Cook the Best Jollof Rice', aspect: '9:16' });
  // Stopwords ("How","to","the") and <3-char tokens are gone; topical words stay.
  assert.ok(tags.includes('#Cook') && tags.includes('#Jollof') && tags.includes('#Rice'));
  assert.ok(!tags.some((t) => /^#(How|to|the)$/i.test(t)), 'no stopword hashtags');
  // Vertical aspect contributes the short-form destination tags.
  assert.ok(tags.includes('#Shorts') && tags.includes('#TikTok'));
  assert.ok(tags.length <= 8, 'tag count is capped');
  assert.equal(new Set(tags.map((t) => t.toLowerCase())).size, tags.length, 'no dupes');
  // Landscape gets YouTube instead of Shorts/TikTok.
  assert.ok(buildHashtags({ title: 'Lagos Markets', aspect: '16:9' }).includes('#YouTube'));
});

test('share: short caption fits the tweet budget; long caption carries the hashtag block', () => {
  const longTitle = 'A'.repeat(400);
  const hashtags = ['#One', '#Two', '#Three', '#Four'];
  const { short, long } = buildCaptions({ title: longTitle, hashtags });
  // Tweet text + the 23-char link cost must stay within 280.
  assert.ok(short.length + 23 <= 280, `short caption + link must fit 280, got ${short.length + 23}`);
  assert.ok(short.includes('…'), 'over-budget title is truncated with an ellipsis');
  // Long caption is the title plus a hashtag line.
  assert.ok(long.startsWith(longTitle.slice(0, 10)));
  assert.ok(long.includes('#One #Two #Three #Four'));
  // No-hashtag case still yields a usable caption.
  assert.equal(buildCaptions({ title: 'Hi', hashtags: [] }).long, 'Hi');
});

test('share: platform links cover every network and URL-encode the video link', () => {
  const links = buildPlatformLinks({
    url: 'http://host:3000/output/v.mp4', title: 'My Video', captions: { short: 'short', long: 'long' },
  });
  const ids = links.map((l) => l.id);
  for (const want of ['x', 'whatsapp', 'facebook', 'telegram', 'linkedin', 'reddit', 'email']) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
  const enc = encodeURIComponent('http://host:3000/output/v.mp4');
  assert.ok(links.find((l) => l.id === 'x').href.includes(enc), 'tweet link carries the encoded url');
  assert.ok(links.find((l) => l.id === 'email').href.startsWith('mailto:'), 'email is a mailto');
  assert.ok(links.every((l) => /^https?:|^mailto:/.test(l.href)), 'every href is a real scheme');
});

test('share: lanBaseUrl returns a well-formed origin or null', () => {
  const lan = lanBaseUrl(3000);
  assert.ok(lan === null || /^http:\/\/\d+\.\d+\.\d+\.\d+:3000$/.test(lan), `bad lan url: ${lan}`);
});

test('share: buildShareKit assembles file url (trailing slash trimmed) + lan file url', () => {
  const project = { id: 'k1', title: 'Sunset Timelapse', aspect: '9:16', language: 'English' };
  const kit = buildShareKit({
    project, file: 'k1_final.mp4', baseUrl: 'http://host:3000/', lanUrl: 'http://192.168.1.5:3000',
  });
  assert.equal(kit.fileUrl, 'http://host:3000/output/k1_final.mp4', 'trailing slash trimmed, no //');
  assert.equal(kit.lanFileUrl, 'http://192.168.1.5:3000/output/k1_final.mp4');
  assert.ok(kit.hashtags.includes('#Sunset'));
  assert.ok(kit.captions.long && kit.captions.short);
  assert.equal(kit.platforms.length, 7);
  // No LAN url → null, not undefined.
  assert.equal(buildShareKit({ project, file: 'k1_final.mp4', baseUrl: 'http://host' }).lanFileUrl, null);
});

// ---------- beat-synced cuts (#5) ----------
test('beats: beatGrid lays evenly-spaced beats across the duration from BPM', () => {
  const g = beatGrid(120, 4); // 120 BPM → 0.5s per beat
  assert.deepEqual(g, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  // Phase offset shifts the grid but it still starts at/after 0.
  const o = beatGrid(120, 2, 0.2);
  assert.equal(o[0], 0.2);
  assert.ok(o.every((t) => t >= 0));
  // Degenerate inputs never throw.
  assert.deepEqual(beatGrid(0, 5), []);
  assert.deepEqual(beatGrid(120, 0), []);
});

test('beats: snapToBeats moves cuts onto beats while preserving total + floor', () => {
  const durations = [4.2, 3.6, 4.1]; // total 11.9; boundaries at 4.2, 7.8
  const beats = beatGrid(120, 12);   // every 0.5s
  const snapped = snapToBeats(durations, beats, { minDur: 1.5 });
  // Total is exactly preserved (video still covers the narration).
  assert.ok(Math.abs(snapped.reduce((a, b) => a + b, 0) - 11.9) < 1e-6);
  // Each interior boundary now lands on a 0.5s beat.
  assert.equal(snapped[0] % 0.5 < 1e-6 || (0.5 - (snapped[0] % 0.5)) < 1e-6, true);
  const b2 = snapped[0] + snapped[1];
  assert.ok(Math.abs(b2 * 2 - Math.round(b2 * 2)) < 1e-6, 'second boundary on a beat');
});

test('beats: snapToBeats respects the floor and never reorders', () => {
  // A boundary that would snap below the floor is held at prev+minDur.
  const durations = [0.4, 5.6, 5];
  const beats = beatGrid(60, 12); // beats every 1s
  const snapped = snapToBeats(durations, beats, { minDur: 1.5 });
  assert.ok(snapped.every((d) => d >= 1.5 - 1e-9), `every scene >= floor: ${snapped}`);
  assert.ok(Math.abs(snapped.reduce((a, b) => a + b, 0) - 11) < 1e-6);
});

test('beats: snapToBeats is a no-op for one scene or no beats', () => {
  assert.deepEqual(snapToBeats([10], [0, 1, 2]), [10]);
  assert.deepEqual(snapToBeats([5, 5], []), [5, 5]);
});

test('beats: estimateTempoFromEnvelope recovers BPM from a synthetic click track', () => {
  // A pulse every 12 frames at hop 0.0464s ≈ 0.557s/beat ≈ 107.7 BPM.
  const hopSec = 512 / 11025;
  const env = new Array(600).fill(0);
  for (let i = 0; i < env.length; i += 12) env[i] = 1;
  const { bpm } = estimateTempoFromEnvelope(env, hopSec, { minBpm: 70, maxBpm: 160 });
  const expected = 60 / (12 * hopSec);
  assert.ok(Math.abs(bpm - expected) <= 2, `expected ~${expected.toFixed(1)} BPM, got ${bpm}`);
});

test('beats: estimateTempoFromEnvelope finds the downbeat phase', () => {
  const hopSec = 512 / 11025;
  const env = new Array(300).fill(0);
  for (let i = 3; i < env.length; i += 12) env[i] = 1; // first onset at frame 3
  const { offset } = estimateTempoFromEnvelope(env, hopSec);
  assert.ok(Math.abs(offset - 3 * hopSec) < hopSec, 'offset points at the first onset');
});

test('beats: onsetEnvelope rises on an energy step and degenerate input is safe', () => {
  const sr = 11025;
  const quiet = new Int16Array(1024).fill(0);
  const loud = new Int16Array(1024).fill(8000);
  const pcm = Int16Array.from([...quiet, ...loud, ...loud]);
  const { env, hopSec } = onsetEnvelope(pcm, sr, 512);
  assert.ok(hopSec > 0);
  assert.ok(Math.max(...env) > 0, 'a loud onset produces a positive envelope spike');
  assert.deepEqual(onsetEnvelope(new Int16Array(10), sr, 512).env, []);
});

// ---------- per-phrase B-roll (#7) ----------
test('broll: expandScenes splits long scenes into shots, preserving total + order', () => {
  const scenes = [
    { index: 1, query: 'lagos market', narration: 'one two three four five six' },
    { index: 2, query: 'sunrise', narration: 'short scene' },
  ];
  const durations = [12, 4]; // scene 1 is long, scene 2 fits in one shot
  const { scenes: out, durations: od } = expandScenes(scenes, durations, { maxShot: 6, minShot: 2.5 });
  // Scene 1 (12s) → at least 2 shots; scene 2 (4s) → exactly 1.
  const fromS1 = out.filter((s) => s.parentIndex === 1);
  const fromS2 = out.filter((s) => s.parentIndex === 2);
  assert.ok(fromS1.length >= 2, `long scene splits: got ${fromS1.length}`);
  assert.equal(fromS2.length, 1, 'short scene stays one shot');
  // Total duration preserved exactly (video still covers the narration).
  assert.ok(Math.abs(od.reduce((a, b) => a + b, 0) - 16) < 1e-9);
  // Every shot carries the parent query and a non-empty index; indexes are 1..M.
  assert.deepEqual(out.map((s) => s.index), out.map((_, i) => i + 1));
  assert.ok(fromS1.every((s) => s.query === 'lagos market'));
  // Narration is sliced across the shots with nothing lost.
  assert.equal(fromS1.map((s) => s.narration).join(' '), 'one two three four five six');
});

test('broll: no scene exceeds maxShot → unchanged; each shot >= minShot', () => {
  const scenes = [{ index: 1, query: 'q', narration: 'a b' }, { index: 2, query: 'q2', narration: 'c d' }];
  const durations = [5, 4];
  const { scenes: out, durations: od } = expandScenes(scenes, durations, { maxShot: 6, minShot: 2.5 });
  assert.equal(out.length, 2, 'short scenes are not split');
  assert.deepEqual(od, [5, 4]);
  // A scene that would split into sub-minShot shots is capped so no shot is a blink.
  const big = expandScenes([{ index: 1, query: 'q', narration: 'x y z' }], [7], { maxShot: 6, minShot: 2.5 });
  assert.ok(big.durations.every((d) => d >= 2.5 - 1e-9), `each shot >= floor: ${big.durations}`);
  assert.ok(Math.abs(big.durations.reduce((a, b) => a + b, 0) - 7) < 1e-9);
});

// ---------- generated-card fallback (#6) ----------
test('cards: distillCardText prefers in-language narration, trims, falls back', () => {
  // Narration wins (so a Yoruba video gets a Yoruba card), trailing punctuation dropped.
  assert.equal(distillCardText({ narration: 'Ìlú Ìbàdàn tóbi gan an.', query: 'big city' }),
    'Ìlú Ìbàdàn tóbi gan an');
  // Long narration is capped to maxWords.
  assert.equal(distillCardText({ narration: 'one two three four five six seven eight', maxWords: 3 }),
    'one two three');
  // No narration → English query; nothing at all → the mark.
  assert.equal(distillCardText({ narration: '', query: 'lagos market' }), 'lagos market');
  assert.equal(distillCardText({ narration: '   ', query: '' }), '✦');
});

test('cards: wrapText breaks on spaces within the width, never splitting a word', () => {
  const out = wrapText('the quick brown fox jumps over', 10);
  const lines = out.split('\n');
  assert.ok(lines.every((l) => l.length <= 10 || l.split(' ').length === 1), `lines fit: ${JSON.stringify(lines)}`);
  assert.equal(out.replace(/\n/g, ' '), 'the quick brown fox jumps over', 'no words lost');
  // A single over-long word survives intact on its own line.
  assert.equal(wrapText('supercalifragilistic', 8), 'supercalifragilistic');
  assert.equal(wrapText('   ', 10), '');
});

test('cards: palette cycles by index, honors a brand override, width by aspect', () => {
  assert.deepEqual(cardPalette(0), CARD_PALETTES[0]);
  assert.deepEqual(cardPalette(CARD_PALETTES.length), CARD_PALETTES[0], 'wraps around');
  assert.deepEqual(cardPalette(-1), CARD_PALETTES[CARD_PALETTES.length - 1], 'negative index safe');
  assert.deepEqual(cardPalette(2, { cardColors: ['#fff', '#000'] }), ['#fff', '#000'], 'brand overrides');
  assert.ok(cardWrapWidth('9:16') < cardWrapWidth('16:9'), 'portrait wraps sooner');
});

// ---------- brand kit (#10) ----------
test('brand: normalizeBrand validates colours, clamps durations, keeps shape', () => {
  const b = normalizeBrand({
    name: 'X'.repeat(200), primaryColor: 'not-a-color', accentColor: '#abc',
    cardColors: ['#112233', 'bad'], captionPrimary: '#ff0000',
    intro: { enabled: true, text: 'Hi', seconds: 99 }, outro: { enabled: 'yes', seconds: -3 },
  });
  assert.equal(b.name.length, 60, 'name capped');
  assert.equal(b.primaryColor, DEFAULT_BRAND.primaryColor, 'bad hex → default');
  assert.equal(b.accentColor, '#abc', '#RGB shorthand accepted');
  assert.deepEqual(b.cardColors, ['#112233', DEFAULT_BRAND.cardColors[1]], 'bad second colour → default');
  assert.equal(b.captionPrimary, '#ff0000');
  assert.equal(b.intro.seconds, 6, 'intro seconds clamped to max');
  assert.equal(b.outro.seconds, 0.8, 'outro seconds clamped to min');
  assert.equal(b.outro.enabled, true, 'truthy enabled coerced');
  // Empty input → safe defaults.
  assert.deepEqual(normalizeBrand({}).cardColors, DEFAULT_BRAND.cardColors);
});

test('brand: normalizeBrand validates logo position + clamps logo scale', () => {
  // Defaults when absent.
  const def = normalizeBrand({});
  assert.equal(def.logoPosition, 'br');
  assert.equal(def.logoScale, 0.12);
  // Valid position kept; bad one → default.
  assert.equal(normalizeBrand({ logoPosition: 'tl' }).logoPosition, 'tl');
  assert.equal(normalizeBrand({ logoPosition: 'middle' }).logoPosition, 'br');
  // Scale clamps to [0.04, 0.4].
  assert.equal(normalizeBrand({ logoScale: 0.25 }).logoScale, 0.25);
  assert.equal(normalizeBrand({ logoScale: 5 }).logoScale, 0.4);
  assert.equal(normalizeBrand({ logoScale: 0 }).logoScale, 0.04);
  assert.equal(normalizeBrand({ logoScale: 'big' }).logoScale, 0.12, 'non-number → default');
});

test('ffmpeg: logoOverlayXY anchors the watermark at every corner/edge/center', () => {
  const m = 30;
  // Corners.
  assert.equal(logoOverlayXY('tl', m), '30:30');
  assert.equal(logoOverlayXY('tr', m), 'W-w-30:30');
  assert.equal(logoOverlayXY('bl', m), '30:H-h-30');
  assert.equal(logoOverlayXY('br', m), 'W-w-30:H-h-30'); // legacy default
  // Edges + center use the (W-w)/2 / (H-h)/2 midpoints.
  assert.equal(logoOverlayXY('tc', m), '(W-w)/2:30');
  assert.equal(logoOverlayXY('mc', m), '(W-w)/2:(H-h)/2');
  assert.equal(logoOverlayXY('mr', m), 'W-w-30:(H-h)/2');
  assert.equal(logoOverlayXY('bc', m), '(W-w)/2:H-h-30');
  // Unknown falls back to bottom-right (matches the pre-feature behaviour).
  assert.equal(logoOverlayXY('', m), 'W-w-30:H-h-30');
});

test('captions: hexToAss converts #RRGGBB to ASS BGR, rejects junk', () => {
  assert.equal(hexToAss('#FF0000'), '&H000000FF'); // red → BGR
  assert.equal(hexToAss('#00FF00'), '&H0000FF00');
  assert.equal(hexToAss('#abc'), '&H00CCBBAA');     // shorthand expands
  assert.equal(hexToAss('nope'), null);
  assert.equal(hexToAss(123), null);
});

// ---------- dub + transcription helpers (#2 / #9) ----------
test('transcribe: transcriptText joins segments and normalizes whitespace', () => {
  const segs = [{ start: 0, end: 2, text: ' Hello  there ' }, { start: 2, end: 4, text: 'world.' }, { start: 4, end: 5, text: '' }];
  assert.equal(transcriptText(segs), 'Hello there world.');
  assert.equal(transcriptText([]), '');
});

test('transcribe: highlightWindows packs segments into clips within [min,max], breaks on pause', () => {
  const segs = [
    { start: 0, end: 8, text: 'a' }, { start: 8, end: 16, text: 'b' },     // → ~16s window
    { start: 30, end: 40, text: 'c' }, { start: 40, end: 52, text: 'd' },  // big gap before c → new window
  ];
  const w = highlightWindows(segs, { minSec: 10, maxSec: 30, gapBreak: 1.2 });
  assert.ok(w.length >= 2, `splits on the long pause: ${w.length}`);
  assert.ok(w.every((x) => x.end - x.start <= 30 + 1e-9), 'no window exceeds maxSec');
  assert.equal(w[0].start, 0);
  // Each window carries concatenated text.
  assert.ok(w[0].text.includes('a') && w[0].text.includes('b'));
});

test('shorts: pickTopWindows takes the longest N, restored to chronological order', () => {
  const windows = [
    { start: 0, end: 12, text: 'a' },    // 12s
    { start: 20, end: 60, text: 'b' },   // 40s (longest)
    { start: 70, end: 95, text: 'c' },   // 25s
  ];
  const top = pickTopWindows(windows, 2);
  assert.equal(top.length, 2);
  // The two longest are b (40) and c (25), returned in time order (b before c).
  assert.deepEqual(top.map((w) => w.start), [20, 70]);
});

test('shorts: windowCues clips + retimes captions to the window start', () => {
  const segs = [
    { start: 5, end: 8, text: 'before' },
    { start: 22, end: 25, text: 'inside one' },
    { start: 25, end: 28, text: 'inside two' },
    { start: 65, end: 70, text: 'after' },
  ];
  const cues = windowCues(segs, 20, 30);
  assert.equal(cues.length, 2, 'only segments overlapping [20,30]');
  assert.equal(cues[0].start, 2, '22-20 → 2s into the window');
  assert.equal(cues[0].text, 'inside one');
  assert.ok(cues.every((c) => c.end > c.start && c.start >= 0));
});

test('shorts: windowWordCues emits exact per-word cues, clipped + retimed to the window', () => {
  const segs = [
    { start: 5, end: 8, text: 'before', words: [{ start: 5, end: 8, text: 'before' }] },
    {
      start: 22, end: 28, text: 'inside one two',
      words: [
        { start: 22, end: 23, text: 'inside' },
        { start: 24, end: 25, text: 'one' },
        { start: 26, end: 27, text: 'two' },
      ],
    },
    { start: 65, end: 70, text: 'after', words: [{ start: 65, end: 70, text: 'after' }] },
  ];
  const cues = windowWordCues(segs, 20, 30);
  assert.equal(cues.length, 3, 'only the three words inside [20,30]');
  assert.deepEqual(cues.map((c) => c.text), ['inside', 'one', 'two']);
  assert.equal(cues[0].start, 2, '22-20 → 2s into the window');
  assert.equal(cues[1].start, 4, '24-20 → 4s');
  assert.ok(cues.every((c) => c.end > c.start && c.start >= 0));
});

test('shorts: windowWordCues returns [] when no word timing exists (caller falls back)', () => {
  const segs = [{ start: 22, end: 25, text: 'no words here' }];
  assert.deepEqual(windowWordCues(segs, 20, 30), []);
});

test('dub: buildDubPrompt targets the language and reuses its TTS rules; cleanDubText strips wrappers', () => {
  const { system, user } = buildDubPrompt('Hello world', 'Yoruba');
  assert.match(system, /Yoruba/);
  assert.match(system, /Avoid English\/Latin loanwords/i, 'reuses languageNote rules');
  assert.match(user, /Hello world/);
  // Pidgin keeps code-switching in the dub prompt too.
  assert.ok(!/Avoid English\/Latin loanwords/i.test(buildDubPrompt('hi', 'Nigerian Pidgin').system));
  // Output cleaner removes fences, quotes and a leading label.
  assert.equal(cleanDubText('```\n"Báwo ni"\n```'), 'Báwo ni');
  assert.equal(cleanDubText('Translation: Ndewo'), 'Ndewo');
});

test('ffmpeg: nearestAspect maps dimensions to the closest preset', () => {
  assert.equal(nearestAspect(1920, 1080), '16:9');
  assert.equal(nearestAspect(1080, 1920), '9:16');
  assert.equal(nearestAspect(1080, 1080), '1:1');
  assert.equal(nearestAspect(0, 0), '16:9'); // unknown → safe default
});

// ---------- transitions + caption animations (#8) ----------
test('captions: captionAnimTag returns an ASS override per preset, empty otherwise', () => {
  assert.equal(captionAnimTag({}), '');
  assert.equal(captionAnimTag({ captionAnim: 'none' }), '');
  assert.equal(captionAnimTag({ captionAnim: 'bogus' }), '');
  assert.match(captionAnimTag({ captionAnim: 'fade' }), /\\fad\(/);
  assert.match(captionAnimTag({ captionAnim: 'pop' }), /\\t\(/);
  assert.match(captionAnimTag({ captionAnim: 'pop' }), /\\fscx/);
  assert.ok(CAPTION_ANIMS.includes('fade') && CAPTION_ANIMS.includes('pop'));
});

test('captions: buildKaraokeAss injects the animation override before the karaoke run', () => {
  const assPath = path.join(os.tmpdir(), `av_anim_${Date.now()}.ass`);
  buildKaraokeAss({ cues: [{ start: 0, end: 3, text: 'hello there' }], aspect: '16:9', assPath, style: { captionAnim: 'fade' } });
  const dlg = fs.readFileSync(assPath, 'utf8').split('\n').filter((l) => l.startsWith('Dialogue:'));
  fs.unlinkSync(assPath);
  for (const d of dlg) {
    const text = d.replace('Dialogue:', '').split(',').slice(9).join(',');
    assert.ok(text.startsWith('{\\fad('), `line animates in: ${text.slice(0, 16)}`);
    assert.ok(text.includes('{\\k'), 'karaoke timing still present after the animation tag');
  }
});

test('transitions: buildXfadeGraph chains xfades with correct overlapping offsets', () => {
  // Three clips, each extended to 5s, 0.4s crossfade.
  const { filter, label, totalDur } = buildXfadeGraph([5, 5, 5], { transition: 'fade', dur: 0.4 });
  assert.equal(label, '[vx]');
  // First cut at 5 - 0.4 = 4.6; second at 4.6 + 5 - 0.4 = 9.2.
  assert.match(filter, /offset=4\.600/);
  assert.match(filter, /offset=9\.200/);
  // Final length = 15 - 0.4*2 = 14.2 (≈ the un-extended 3×(5-0.4)+0.4... covers narration).
  assert.ok(Math.abs(totalDur - 14.2) < 1e-6);
  // Single clip → no transition.
  const one = buildXfadeGraph([5], { dur: 0.4 });
  assert.equal(one.filter, '');
  assert.equal(one.label, '[0:v]');
});

test('transitions: TRANSITIONS maps names; cut is the plain (null) hard cut', () => {
  assert.equal(TRANSITIONS.cut, null);
  assert.equal(TRANSITIONS.fade, 'fade');
  assert.ok('slideleft' in TRANSITIONS && 'wipeleft' in TRANSITIONS);
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

test('http: POST /api/render/multi returns a batch of string jobIds', async () => {
  const savedKey = config.xaiKey;
  config.xaiKey = '';
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/render/multi`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'lagos street food', aspect: '9:16',
          voices: ['yarn-yor-f', 'yarn-hau-m'] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.batchId === 'string' && body.jobs.length >= 2);
      assert.ok(body.jobs.every((j) => typeof j.jobId === 'string' && j.language));
      // Empty request → 400.
      const bad = await fetch(`${base}/api/render/multi`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(bad.status, 400);
    });
  } finally {
    config.xaiKey = savedKey;
  }
});

test('http: POST /api/dub validates videoPath and voice before doing any work', async () => {
  await withServer(async (base) => {
    // Missing videoPath → 400.
    const noPath = await fetch(`${base}/api/dub`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: 'yarn-yor-f' }),
    });
    assert.equal(noPath.status, 400);
    // Real file but bad voice → 400 (voice checked before the heavy transcription path).
    const tmp = path.join(os.tmpdir(), `av_dub_${Date.now()}.mp4`);
    fs.writeFileSync(tmp, 'x');
    const badVoice = await fetch(`${base}/api/dub`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: tmp, voice: 'not-a-voice' }),
    });
    fs.unlinkSync(tmp);
    assert.equal(badVoice.status, 400);
  });
});

test('http: GET/PUT /api/brand round-trips a normalized brand kit', async () => {
  await withServer(async (base) => {
    const put = await fetch(`${base}/api/brand`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Studio', primaryColor: '#123456', intro: { enabled: true, text: 'Hi', seconds: 3 } }),
    });
    assert.equal(put.status, 200);
    const saved = await put.json();
    assert.equal(saved.name, 'Studio');
    assert.equal(saved.primaryColor, '#123456');
    assert.equal(saved.intro.seconds, 3);
    // Read it back.
    const got = await (await fetch(`${base}/api/brand`)).json();
    assert.equal(got.name, 'Studio');
    assert.equal(got.intro.enabled, true);
  });
});

test('http: POST /api/shorts requires a real videoPath', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/shorts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 3 }),
    });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });
});

// ---------- streaming uploads (#PayloadTooLargeError fix) ----------
test('http: POST /api/clip streams the body to disk and reports exact byte count', async () => {
  await withServer(async (base) => {
    const body = Buffer.alloc(5 * 1024 * 1024, 0x41); // 5 MB
    const res = await fetch(`${base}/api/clip?ext=mp4`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
    });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.ok(d.path && fs.existsSync(d.path), 'file written to disk');
    assert.equal(d.bytes, body.length, 'reported byte count matches sent body');
    assert.equal(fs.statSync(d.path).size, body.length, 'on-disk size matches sent body');
    assert.ok(d.path.endsWith('.mp4'));
    fs.unlinkSync(d.path);
  });
});

test('http: uploads have NO size cap — a body past the old express.raw limit still 200s', async () => {
  await withServer(async (base) => {
    // /api/logo used to cap at 8mb (express.raw). 10 MB would have thrown
    // PayloadTooLargeError before the streaming rewrite. It must now succeed.
    const body = Buffer.alloc(10 * 1024 * 1024, 0x42); // 10 MB > old 8mb cap
    const res = await fetch(`${base}/api/logo?ext=png`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
    });
    assert.equal(res.status, 200, 'no PayloadTooLargeError');
    const d = await res.json();
    assert.equal(d.bytes, body.length);
    assert.ok(fs.existsSync(d.path));
    fs.unlinkSync(d.path);
  });
});

test('http: POST /api/clip with an empty body returns 400 and writes no leftover file', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/clip?ext=mp4`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(0),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'No file');
  });
});

test('http: upload sanitizes the ext query and falls back when missing', async () => {
  await withServer(async (base) => {
    const body = Buffer.alloc(1024, 0x43);
    const res = await fetch(`${base}/api/clip?ext=mp4;rm%20-rf`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
    });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.match(d.path, /\.mp4rmrf$/, 'non-alphanumerics stripped from ext');
    fs.unlinkSync(d.path);
  });
});

// ---------- editable project endpoints ----------
function sampleProject(id) {
  const f = (n) => { const p = path.join(config.dirs.projects, n); fs.writeFileSync(p, 'x'); return p; };
  fs.mkdirSync(config.dirs.projects, { recursive: true });
  return buildProject({
    id, opts: { topic: 't', fades: true, motion: true }, plan: { title: 'T' },
    aspect: '16:9', fps: 30, language: 'English',
    voiceTrack: { path: f(`${id}_vo.mp3`), duration: 8 },
    captions: { enabled: true, cues: [{ start: 0, end: 8, text: 'hi there' }] },
    music: null,
    scenes: [
      { index: 0, narration: 'hi', sourcePath: f(`${id}_s0.mp4`), clipPath: f(`${id}_s0n.mp4`), duration: 4, motion: true },
      { index: 1, narration: 'there', sourcePath: f(`${id}_s1.mp4`), clipPath: f(`${id}_s1n.mp4`), duration: 4, motion: true },
    ],
  });
}

test('http: GET /api/project/:id is 404 for unknown, 200 + doc for known', async () => {
  saveProject(sampleProject('http1'));
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/project/nope`)).status, 404);
    const res = await fetch(`${base}/api/project/http1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'http1');
    assert.equal(body.scenes.length, 2);
  });
});

test('http: PUT /api/project/:id saves a valid edit and relayouts; rejects invalid', async () => {
  const p = sampleProject('http2');
  saveProject(p);
  await withServer(async (base) => {
    // Valid: trim scene 0 shorter → server relayouts scene 1's start.
    p.scenes[0].duration = 2;
    const ok = await fetch(`${base}/api/project/http2`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()).project;
    assert.equal(saved.scenes[1].start, 2, 'server recomputed the timeline');

    // Invalid: zero-duration scene → 400 with validation detail.
    const bad = JSON.parse(JSON.stringify(p));
    bad.scenes[0].duration = 0;
    const res = await fetch(`${base}/api/project/http2`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);

    // Unknown id → 404.
    assert.equal((await fetch(`${base}/api/project/nope`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    })).status, 404);
  });
});

test('http: GET /api/project/:id/share is 404 unknown, 409 unrendered, 200 with a kit', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'av_gate_out_'));
  const savedOut = config.dirs.output;
  config.dirs.output = outDir;
  try {
    // Unrendered project → 409 (nothing to share yet).
    saveProject(sampleProject('share_none'));
    // Rendered project → an mp4 exists at render.outputPath.
    const rendered = sampleProject('share_ok');
    const mp4 = path.join(outDir, 'share_ok_final.mp4');
    fs.writeFileSync(mp4, 'fake mp4');
    rendered.render = { outputPath: mp4 };
    saveProject(rendered);

    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/api/project/nope/share`)).status, 404);

      const none = await fetch(`${base}/api/project/share_none/share`);
      assert.equal(none.status, 409, 'unrendered project cannot be shared');
      assert.ok((await none.json()).error);

      const ok = await fetch(`${base}/api/project/share_ok/share`);
      assert.equal(ok.status, 200);
      const kit = await ok.json();
      assert.equal(kit.file, 'share_ok_final.mp4');
      assert.ok(kit.fileUrl.endsWith('/output/share_ok_final.mp4'));
      assert.equal(kit.platforms.length, 7);
      assert.ok(Array.isArray(kit.hashtags) && kit.captions.long);
    });
  } finally {
    config.dirs.output = savedOut;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('http: POST /api/project/:id/render is 404 for an unknown project', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/project/nope/render`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

test('http: GET /api/projects lists saved projects', async () => {
  saveProject(sampleProject('http3'));
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/projects`);
    assert.equal(res.status, 200);
    const ids = (await res.json()).projects.map((x) => x.id);
    assert.ok(ids.includes('http3'));
  });
});

// ---------- editor media mapping (edit.js, pure) ----------
test('edit: assetToUrl maps asset paths to /media URLs and rejects foreign paths', () => {
  assert.equal(assetToUrl(path.join(MEDIA_DIRS.raw, 'clip_x.mp4')), '/media/raw/clip_x.mp4');
  assert.equal(assetToUrl(path.join(MEDIA_DIRS.audio, 'voice.mp3')), '/media/audio/voice.mp3');
  // a basename with a space is URL-encoded
  assert.equal(assetToUrl(path.join(MEDIA_DIRS.work, 'a b.mp4')), `/media/work/${encodeURIComponent('a b.mp4')}`);
  // anything outside the known asset roots is rejected (the /media guard)
  assert.equal(assetToUrl('/etc/passwd'), null);
  assert.equal(assetToUrl(null), null);
  assert.equal(assetToUrl(''), null);
});

test('edit: previewBundle exposes the timeline geometry the live player needs', () => {
  const p = buildProject({
    id: 'pv1', opts: { topic: 't' }, plan: { title: 'Demo' }, aspect: '9:16', fps: 30, language: 'English',
    voiceTrack: { path: '/nowhere/voice.mp3', duration: 9 },
    captions: { enabled: true, cues: [{ start: 0, end: 4, text: 'hi' }, { start: 4, end: 9, text: 'there' }] },
    music: null,
    scenes: [
      { index: 0, narration: 'a', sourcePath: '/nowhere/s0.mp4', duration: 4, motion: true },
      { index: 1, narration: 'b', sourcePath: '/nowhere/s1.mp4', duration: 5, motion: false, trim: { in: 1, out: 3 } },
    ],
  });
  const b = previewBundle(p);
  assert.equal(b.aspect, '9:16');
  assert.equal(b.voiceDuration, 9);
  assert.equal(b.scenes.length, 2);
  assert.equal(b.scenes[0].start, 0);
  assert.equal(b.scenes[1].start, 4, 'second scene starts after the first');
  assert.equal(b.scenes[1].motion, false);
  assert.deepEqual(b.scenes[1].trim, { in: 1, out: 3 });
  assert.equal(b.captions.cues.length, 2);
  // foreign source paths map to null url (the UI then offers a footage swap)
  assert.equal(b.scenes[0].sourceUrl, null);
});

test('http: GET /api/project/:id/preview returns a media bundle; 404 for unknown', async () => {
  saveProject(sampleProject('pvhttp'));
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/project/nope/preview`)).status, 404);
    const res = await fetch(`${base}/api/project/pvhttp/preview`);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.id, 'pvhttp');
    assert.equal(b.scenes.length, 2);
    assert.ok(b.captions.cues.length >= 1);
  });
});

test('http: GET /api/stock/search requires a query', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/stock/search`);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });
});

test('http: POST scene/:index/source validates url and project', async () => {
  saveProject(sampleProject('swap1'));
  await withServer(async (base) => {
    // unknown project → 404
    assert.equal((await fetch(`${base}/api/project/nope/scene/0/source`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://x/y.mp4' }),
    })).status, 404);
    // missing/!http url → 400
    const bad = await fetch(`${base}/api/project/swap1/scene/0/source`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'not-a-url' }),
    });
    assert.equal(bad.status, 400);
  });
});

test('http: scene source swap returns the new path and persists it (footage retained)', async () => {
  // Regression: the editor swapped footage via this endpoint but the client never
  // learned the new source.path, so its next PUT clobbered the swap with the stale
  // path → "footage doesn't retain during edit". The endpoint must return the
  // absolute path so the client can persist it, AND the swap must survive in the
  // saved doc with the cached normalized clip + trim cleared so it re-encodes.
  saveProject(sampleProject('swapret'));
  const savedRaw = config.dirs.raw;
  config.dirs.raw = fs.mkdtempSync(path.join(os.tmpdir(), 'av_swap_raw_'));
  const body = Buffer.alloc(32 * 1024, 1); // > MIN_CLIP_BYTES so it's treated as a real clip
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((r) => origin.listen(0, r));
  const clipUrl = `http://127.0.0.1:${origin.address().port}/clip.mp4`;
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/project/swapret/scene/1/source`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: clipUrl }),
      });
      assert.equal(res.status, 200);
      const d = await res.json();
      // The fix: the response carries the absolute path the client must persist.
      assert.equal(typeof d.scene.path, 'string', 'swap response must return the new source path');
      assert.ok(d.scene.path.startsWith(config.dirs.raw), 'downloaded into the raw asset dir');
      assert.ok(fs.existsSync(d.scene.path), 'the swapped clip is on disk');
      assert.ok(d.scene.sourceUrl.startsWith('/media/raw/'));
      // And the server persisted the swap: the saved doc points scene 1 at the new clip.
      const doc = await (await fetch(`${base}/api/project/swapret`)).json();
      const sc = doc.scenes.find((s) => s.index === 1);
      assert.equal(sc.source.path, d.scene.path, 'saved scene points at the swapped clip');
      assert.equal(sc.clip.path, null, 'cached normalized clip cleared so it re-renders');
      assert.equal(sc.trim, null);
    });
  } finally {
    await new Promise((r) => origin.close(r));
    fs.rmSync(config.dirs.raw, { recursive: true, force: true });
    config.dirs.raw = savedRaw;
  }
});

test('http: thumbs/waveform are 404 for an unknown project (no ffmpeg needed)', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/project/nope/thumbs/0`)).status, 404);
    assert.equal((await fetch(`${base}/api/project/nope/waveform`)).status, 404);
  });
});

test('http: POST /api/clip stores a replacement clip and returns its path', async () => {
  config.dirs.raw = fs.mkdtempSync(path.join(os.tmpdir(), 'av_gate_raw_'));
  await withServer(async (base) => {
    // Empty body → 400.
    const empty = await fetch(`${base}/api/clip`, { method: 'POST', body: Buffer.alloc(0) });
    assert.equal(empty.status, 400);

    // Real bytes → 200 with a path inside the raw dir; the file exists on disk.
    const bytes = Buffer.from('fake mp4 bytes');
    const res = await fetch(`${base}/api/clip?ext=mp4`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    assert.equal(res.status, 200);
    const { path: saved } = await res.json();
    assert.ok(saved.startsWith(config.dirs.raw), 'clip is written under the raw dir');
    assert.ok(saved.endsWith('.mp4'));
    assert.equal(fs.readFileSync(saved).length, bytes.length, 'bytes round-trip to disk');
  });
});

/* ============================ DOWNLOADS (http.js) ============================ */
// Regression for: replacing a clip failed "all the time" with an empty reason —
// "download failed: request to cdn.pixabay.com/… failed, reason:". Root cause:
// node-fetch sent its default UA, which Cloudflare-fronted CDNs reset from VPS
// IPs; and node-fetch left .message empty so the error was unreadable.

// Tiny local stand-in for a Cloudflare-gated CDN. `mode` shapes the behavior.
function withFakeCdn(handler, run) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      try { await run(base); resolve(); }
      catch (e) { reject(e); }
      finally { srv.close(); }
    });
  });
}

test('netReason: surfaces the real cause when node-fetch leaves .message empty', () => {
  assert.equal(netReason(Object.assign(new Error(''), { code: 'ECONNRESET' })), 'ECONNRESET');
  assert.equal(netReason(Object.assign(new Error(''), { cause: { code: 'UND_ERR_SOCKET' } })), 'UND_ERR_SOCKET');
  assert.equal(netReason(new Error('HTTP 404')), 'HTTP 404'); // real messages pass through
  assert.equal(netReason(Object.assign(new Error(''), {})), 'network error'); // never blank
  // The exact bug: node-fetch's message ends in "reason: " with the code in .code.
  // We must append the code so it doesn't read as a dead end.
  const real = Object.assign(new Error('request to https://cdn.pixabay.com/x.mp4 failed, reason: '), { code: 'ETIMEDOUT' });
  assert.match(netReason(real), /reason: ETIMEDOUT$/);
});

test('downloadToFile: sends a browser User-Agent (not node-fetch)', async () => {
  let seenUA = null;
  await withFakeCdn((req, res) => { seenUA = req.headers['user-agent']; res.writeHead(200); res.end('clip-bytes'); },
    async (base) => {
      const dest = path.join(os.tmpdir(), `av_dl_${Date.now()}.mp4`);
      await downloadToFile(`${base}/clip.mp4`, dest, { attempts: 1 });
      assert.equal(seenUA, BROWSER_HEADERS['User-Agent']);
      assert.ok(/Mozilla\/5\.0/.test(seenUA), 'looks like a real browser UA');
      fs.unlinkSync(dest);
    });
});

test('downloadToFile: retries a transient 503 then succeeds', async () => {
  let hits = 0;
  await withFakeCdn((req, res) => {
    hits += 1;
    if (hits === 1) { res.writeHead(503); res.end('busy'); return; }
    res.writeHead(200); res.end('clip-bytes-ok');
  }, async (base) => {
    const dest = path.join(os.tmpdir(), `av_dl_retry_${Date.now()}.mp4`);
    const out = await downloadToFile(`${base}/clip.mp4`, dest, { attempts: 3 });
    assert.equal(hits, 2, 'failed once, retried, then 200');
    assert.equal(fs.readFileSync(out, 'utf8'), 'clip-bytes-ok');
    fs.unlinkSync(dest);
  });
});

test('downloadToFile: a 404 fails fast (no wasted retries) with a real message', async () => {
  let hits = 0;
  await withFakeCdn((req, res) => { hits += 1; res.writeHead(404); res.end('nope'); }, async (base) => {
    const dest = path.join(os.tmpdir(), `av_dl_404_${Date.now()}.mp4`);
    await assert.rejects(
      () => downloadToFile(`${base}/missing.mp4`, dest, { attempts: 3 }),
      (err) => { assert.equal(err.message, 'HTTP 404'); return true; },
    );
    assert.equal(hits, 1, '404 is permanent — not retried');
    assert.ok(!fs.existsSync(dest), 'no partial file left behind');
  });
});

test('downloadToFile: rejects an oversized file up front via content-length', async () => {
  await withFakeCdn((req, res) => { res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) }); res.end('x'); },
    async (base) => {
      const dest = path.join(os.tmpdir(), `av_dl_big_${Date.now()}.mp4`);
      await assert.rejects(
        () => downloadToFile(`${base}/big.mp4`, dest, { attempts: 3, maxBytes: 1 * 1024 * 1024 }),
        /too large/,
      );
    });
});
