// Eval: prove concatWithTransitions crossfades real clips through ffmpeg and the
// xfade offset math yields the expected total length. No network/API. Builds two
// short solid-color clips, crossfades them, checks the result duration.
// Run: npm run eval:transitions
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { ensureDirs, probeDuration } from '../src/voice.js';
import { concatWithTransitions } from '../src/ffmpeg.js';

const execFileP = promisify(execFile);

async function makeColorClip(file, color, seconds) {
  await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=${seconds}:r=30`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

async function run() {
  config.dirs.work = fs.mkdtempSync(path.join(os.tmpdir(), 'av_trans_'));
  ensureDirs();
  try {
    const dur = 0.4;
    const clipLen = 3; // each scene 2.6s + 0.4 headroom = 3.0
    const a = path.join(config.dirs.work, 'a.mp4');
    const b = path.join(config.dirs.work, 'b.mp4');
    const c = path.join(config.dirs.work, 'c.mp4');
    await Promise.all([
      makeColorClip(a, 'red', clipLen),
      makeColorClip(b, 'green', clipLen),
      makeColorClip(c, 'blue', clipLen),
    ]);
    const out = await concatWithTransitions({
      sceneFiles: [a, b, c], clipDurs: [clipLen, clipLen, clipLen],
      outBase: 'trans_smoke', transition: 'fade', dur,
    });
    assert.ok(fs.existsSync(out), 'crossfaded output written');
    const got = await probeDuration(out);
    const expected = clipLen * 3 - dur * 2; // 9 - 0.8 = 8.2
    assert.ok(Math.abs(got - expected) < 0.3, `expected ~${expected}s, got ${got}`);
    console.log(`PASS: 3 clips crossfaded → ${got.toFixed(2)}s (expected ~${expected}s)`);
  } finally {
    fs.rmSync(config.dirs.work, { recursive: true, force: true });
  }
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
