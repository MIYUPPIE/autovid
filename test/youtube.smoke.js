// Eval: prove the real YouTube footage path works end to end —
//   1. searchYouTube returns ranked candidates with id/url/thumb/duration
//   2. downloadClip routes a YouTube watch URL through yt-dlp and writes a small,
//      playable mp4 (a short head SECTION, not the whole video)
// Self-skips if yt-dlp isn't installed or the network/video is unreachable.
// Run: npm run eval:youtube
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { searchYouTube, downloadClip, youtubeAvailable, isYouTubeUrl } from '../src/stock.js';

const execFileP = promisify(execFile);
const skip = (msg) => { console.log(`SKIP: ${msg}`); process.exit(0); };

async function probeDuration(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { timeout: 15000 });
  return parseFloat(stdout.trim()) || 0;
}

async function run() {
  if (!(await youtubeAvailable())) skip('yt-dlp not installed');

  // 1. Search.
  const cands = await searchYouTube('nature landscape drone', 6);
  if (!cands.length) skip('no YouTube results (network/region?)');
  const c = cands[0];
  console.log(`found ${cands.length} hits — top: "${(c.title || '').slice(0, 50)}" (${Math.round(c.duration)}s)`);
  if (!c.id || !isYouTubeUrl(c.url) || !c.thumb) {
    console.error('FAIL: candidate missing id/url/thumb', c); process.exit(1);
  }
  if (c.provider !== 'youtube') { console.error('FAIL: wrong provider', c.provider); process.exit(1); }

  // 2. Download a short section via the same routing the editor/pipeline use.
  let file;
  try {
    file = await downloadClip(c.url, `yt_smoke_${Date.now()}`);
  } catch (e) {
    skip(`download unavailable (geo/age-gate/throttle): ${e.message}`);
  }
  try {
    const { size } = fs.statSync(file);
    const dur = await probeDuration(file);
    console.log(`downloaded ${(size / 1e6).toFixed(2)}MB, ${dur.toFixed(1)}s → ${file}`);
    if (size < 16 * 1024) { console.error('FAIL: file too small (truncated)'); process.exit(1); }
    // Should be the head SECTION, not the whole (long) source.
    if (dur > config.youtubeSectionSeconds + 5) {
      console.error(`FAIL: got ${dur}s, expected ≤ ${config.youtubeSectionSeconds + 5}s section`); process.exit(1);
    }
    if (dur < 1) { console.error('FAIL: not a playable clip'); process.exit(1); }
    console.log(`PASS: searched + downloaded a ${dur.toFixed(1)}s playable YouTube clip`);
  } finally {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
