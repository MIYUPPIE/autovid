// PAID smoke eval for AI talking-video mode (xAI Grok Imagine). Unlike the gate
// tests this hits the REAL xAI video API and spends real money (~$0.15-0.25 for
// one short clip), so it is double-gated: it needs XAI_API_KEY *and* an explicit
// AIVIDEO_SMOKE=1 opt-in, otherwise it skips cleanly (exit 0). It never runs as
// part of `npm test`.
//
// What it proves: a real generation request comes back as a downloadable mp4,
// the clip carries BOTH a video and an audio stream (xAI's speech + lip-sync),
// and our normalize step fits it to the frame without dropping the audio.
//
// Run: AIVIDEO_SMOKE=1 XAI_API_KEY=... node test/aivideo.smoke.js
//   full pipeline (LLM plan → multi-scene → stitch → final): add FULL=1
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { ensureDirs } from '../src/voice.js';
import { generateVideoClip, downloadVideoClip, buildVideoRequest } from '../src/grok-video.js';
import { normalizeAvClip } from '../src/ffmpeg.js';
import { processAiVideo } from '../src/ai-video.js';

function streamKinds(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

if (!config.xaiKey) {
  console.log('• SKIP: XAI_API_KEY not set — AI talking-video smoke needs a real xAI key with Grok Imagine access.');
  process.exit(0);
}
if (process.env.AIVIDEO_SMOKE !== '1') {
  console.log('• SKIP: this eval spends real money on the xAI video API.');
  console.log('  Opt in explicitly:  AIVIDEO_SMOKE=1 XAI_API_KEY=... node test/aivideo.smoke.js');
  process.exit(0);
}

ensureDirs();
const id = `aivideo_smoke_${Date.now()}`;
const aspect = '9:16';

console.log(`\nAI talking-video smoke → ${config.xaiVideoModel} @ ${config.xaiVideoBase}${config.xaiVideoPath}`);
console.log('Generating one short 480p clip to keep the bill minimal…\n');

// 1. One real generation (cheapest knobs: 3s @ 480p).
const req = buildVideoRequest({
  prompt: 'A friendly news presenter in a modern studio looks at the camera and says, in English: '
    + '"This is a GriotVid test clip." Clear studio audio, accurate lip-sync, photorealistic.',
  aspect, duration: 3, resolution: '480p',
});
console.log('request body:', JSON.stringify(req));

const url = await generateVideoClip(req, { onPoll: (s) => process.stdout.write(`  status: ${s}\r`) });
console.log(`\n  got clip url: ${url}`);

const raw = `${config.dirs.work}/${id}_raw.mp4`;
await downloadVideoClip(url, raw);
assert.ok(fs.existsSync(raw) && fs.statSync(raw).size > 1024, 'downloaded clip should be a non-trivial file');

const kinds = streamKinds(raw);
console.log(`  streams: ${kinds.join(', ')}`);
assert.ok(kinds.includes('video'), 'generated clip must contain a video stream');
assert.ok(kinds.includes('audio'), 'generated clip must contain an audio stream (xAI speech)');

// 2. Normalize must keep the audio (lip-sync) intact.
const norm = await normalizeAvClip({ input: raw, outBase: `${id}_s1`, aspect });
const normKinds = streamKinds(norm);
assert.ok(normKinds.includes('video') && normKinds.includes('audio'), 'normalize must preserve video + audio');
console.log(`  normalized: ${norm} (${normKinds.join(', ')})`);

// 3. Optional full pipeline (costs more — several clips + an LLM plan).
if (process.env.FULL === '1') {
  console.log('\nFULL=1 → running the whole topic → AI talking-video pipeline…');
  const ctx = {
    id: `${id}_full`,
    emit: (stage, message, pct) => console.log(`  [${pct}%] ${stage}: ${message}`),
    setPlan: (p) => console.log(`  plan: "${p.title}" — ${p.scenes.length} scenes`),
  };
  const result = await processAiVideo(
    { topic: 'why mornings matter', aspect, targetSeconds: 20, language: 'English', subtitles: true, resolution: '480p' },
    ctx,
  );
  assert.ok(fs.existsSync(result.path), 'final mp4 should exist');
  const finalKinds = streamKinds(result.path);
  assert.ok(finalKinds.includes('video') && finalKinds.includes('audio'), 'final must have video + audio');
  console.log(`  final: ${result.path} (${finalKinds.join(', ')})`);
}

console.log('\n✓ AI talking-video smoke passed.\n');
