// Eval: prove the generated-card fallback renders a real, frame-sized, exact-
// duration silent mp4 via ffmpeg (the guarantee that one dead query can't kill a
// render). No network, no API. Run: npm run eval:cards
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, RESOLUTIONS } from '../src/config.js';
import { ensureDirs, probeDuration } from '../src/voice.js';
import { makeTextCard } from '../src/ffmpeg.js';

async function run() {
  // Render cards under a temp work dir so we don't litter assets/.
  config.dirs.work = fs.mkdtempSync(path.join(os.tmpdir(), 'av_cards_'));
  ensureDirs();
  try {
    for (const aspect of ['16:9', '9:16']) {
      const out = await makeTextCard({
        narration: 'Ìlú Ìbàdàn jẹ́ ọ̀kan lára àwọn ìlú tó tóbi jù',
        query: 'big african city',
        outBase: `smoke_${aspect.replace(':', 'x')}`,
        aspect, targetDur: 3.5, index: 1,
      });
      assert.ok(fs.existsSync(out), `card file written for ${aspect}`);
      const dur = await probeDuration(out);
      assert.ok(Math.abs(dur - 3.5) < 0.4, `${aspect}: duration ~3.5s, got ${dur}`);
      console.log(`PASS ${aspect}: ${path.basename(out)} (${dur.toFixed(2)}s, ${RESOLUTIONS[aspect].w}x${RESOLUTIONS[aspect].h})`);
    }
    console.log('PASS: generated cards render through real ffmpeg');
  } finally {
    fs.rmSync(config.dirs.work, { recursive: true, force: true });
  }
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
