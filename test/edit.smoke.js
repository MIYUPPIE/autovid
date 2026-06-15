// Edit smoke: proves the editor's media helpers against REAL ffmpeg.
// Synthesizes a test clip + tone (no network, no project assets needed), then:
//   - extractThumbs returns N real, on-disk, non-empty jpg frames
//   - extractWaveform returns N peaks in [0,1] that actually track the audio
// Run: npm run eval:edit   (needs ffmpeg on PATH)
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '../src/config.js';
import { extractThumbs, extractWaveform } from '../src/ffmpeg.js';

const execFileP = promisify(execFile);

async function ff(args) {
  await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
}

async function main() {
  // Keep generated frames off the real work dir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av_edit_smoke_'));
  config.dirs.work = tmp;

  // 1. A 4s 320x180 test-pattern clip and a 3s sine tone.
  const clip = path.join(tmp, 'clip.mp4');
  const tone = path.join(tmp, 'tone.mp3');
  const silent = path.join(tmp, 'silent.wav');
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=4', '-pix_fmt', 'yuv420p', clip]);
  // 0.8-amplitude tone (explicit, so the expected peak is known) + a silent clip to contrast against.
  await ff(['-f', 'lavfi', '-i', "aevalsrc=0.8*sin(2*PI*440*t):d=3", '-ac', '1', tone]);
  await ff(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '2', silent]);
  console.log('✓ synthesized test clip + tone + silence');

  // 2. Thumbnails: 6 frames, all on disk and non-trivial in size.
  const thumbs = await extractThumbs({ input: clip, outBase: 'smoke', count: 6, start: 0, length: 4 });
  assert.equal(thumbs.length, 6, 'six thumbnails');
  for (const t of thumbs) {
    assert.ok(fs.existsSync(t), `thumb exists: ${t}`);
    assert.ok(fs.statSync(t).size > 500, `thumb is a real jpg: ${t}`);
    assert.ok(t.endsWith('.jpg'));
  }
  console.log('✓ extractThumbs wrote 6 real frames');

  // 3. Re-running reuses cached frames (same paths, no error, still on disk).
  const again = await extractThumbs({ input: clip, outBase: 'smoke', count: 6, start: 0, length: 4 });
  assert.deepEqual(again, thumbs, 'cached thumbnails reused');
  console.log('✓ thumbnail cache reused on re-open');

  // 4. Waveform: 200 peaks, all within [0,1], peak near the known 0.8 amplitude,
  //    and clearly louder than silence (proves it tracks the actual audio).
  const peaks = await extractWaveform({ input: tone, buckets: 200 });
  assert.equal(peaks.length, 200, '200 peaks');
  assert.ok(peaks.every((p) => p >= 0 && p <= 1), 'peaks normalized to [0,1]');
  const max = Math.max(...peaks);
  assert.ok(max > 0.6 && max <= 1, `waveform peak ~tracks the 0.8 tone (got ${max})`);
  const silentPeaks = await extractWaveform({ input: silent, buckets: 200 });
  const silentMax = Math.max(...silentPeaks);
  assert.ok(silentMax < 0.05, `silence reads near zero (got ${silentMax})`);
  assert.ok(max > silentMax * 5, 'tone reads much louder than silence');
  console.log(`✓ extractWaveform: tone peak ${max} vs silence ${silentMax}`);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nALL EDIT SMOKE CHECKS PASSED');
}

main().catch((err) => { console.error('EDIT SMOKE FAILED:', err.message); process.exit(1); });
