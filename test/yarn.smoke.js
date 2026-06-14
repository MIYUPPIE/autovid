// Periodic eval: proves the YarnGPT integration actually produces speakable
// Yoruba/Igbo/Hausa audio end to end (real network call, paid). Gated by the
// API key. Run: npm run eval:yarn   (requires YARN_API_KEY)
import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from '../src/config.js';
import { synthesizeVoice, probeDuration } from '../src/voice.js';
import { buildKaraokeAss } from '../src/captions.js';

// Short native-language lines, one per language, with their YarnGPT speaker.
const CASES = [
  { lang: 'Yoruba', voice: 'yarn-yor-f', text: 'Ẹ kú àárọ̀, ará mi. Báwo ni gbogbo nǹkan ṣe ń lọ?' },
  { lang: 'Igbo',   voice: 'yarn-ibo-f', text: 'Ndị Igbo kwenu! Daalụ nke ukwuu maka ọbịbịa unu.' },
  { lang: 'Hausa',  voice: 'yarn-hau-f', text: 'Sannu da zuwa, abokaina. Ina kwana? Mu fara aiki.' },
];

async function main() {
  if (!config.yarnKey) {
    console.error('SKIP: YARN_API_KEY not set — eval requires the real YarnGPT API.');
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yarn_'));
  // Synthesize into the configured audio dir (synthesizeVoice writes there).
  fs.mkdirSync(config.dirs.audio, { recursive: true });

  let pass = 0, total = 0;
  for (const c of CASES) {
    total += 1;
    process.stdout.write(`\n▶ ${c.lang} (${c.voice}) — "${c.text.slice(0, 40)}…"\n`);
    try {
      const outBase = `smoke_${c.voice}_${Date.now()}`;
      const r = await synthesizeVoice({ text: c.text, voice: c.voice, rate: '+0%', outBase });
      const dur = await probeDuration(r.audioPath);
      // 1) audio exists and is plausibly long enough to be real speech.
      const ok1 = fs.existsSync(r.audioPath) && fs.statSync(r.audioPath).size > 2048;
      // 2) duration is in a sane band for ~10 spoken words (roughly 1.5–15s).
      const ok2 = dur >= 1.5 && dur <= 15;
      // 3) karaoke captions build from that real duration and cover it.
      const assPath = path.join(tmp, `${outBase}.ass`);
      const ass = buildKaraokeAss({ text: c.text, duration: dur, aspect: '9:16', assPath });
      const ok3 = Boolean(ass) && fs.readFileSync(assPath, 'utf8').includes('{\\k');
      console.log(`    ${ok1 ? '✓' : '✗'} audio written (${(fs.statSync(r.audioPath).size / 1024).toFixed(0)} KB)`);
      console.log(`    ${ok2 ? '✓' : '✗'} duration sane (${dur.toFixed(2)}s)`);
      console.log(`    ${ok3 ? '✓' : '✗'} karaoke captions built`);
      try { fs.unlinkSync(r.audioPath); } catch { /* ignore */ }
      if (ok1 && ok2 && ok3) pass += 1;
    } catch (e) {
      console.error(`    ✗ failed: ${e.message}`);
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\nSCORE: ${pass}/${total} languages OK`);
  if (pass < total) { console.error('YARN EVAL FAILED'); process.exit(1); }
  console.log('YARN EVAL PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
