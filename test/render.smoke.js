// Integration smoke for incremental re-render. Uses real ffmpeg (NOT a gate
// test — too slow/heavy). Proves: a full render from a project, then that a
// caption-only edit re-runs ONLY the final mux while reusing the cached scene
// encodes and stitch.
//
// Run: node test/render.smoke.js
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { ensureDirs } from '../src/voice.js';
import { buildProject, saveProject, loadProject } from '../src/project.js';
import { renderProject } from '../src/render.js';

ensureDirs();
const id = `smoke_${Date.now()}`;

function ff(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

// Two synthetic 4s color clips (the "downloaded footage") + a 8s silent voice track.
const s0 = path.join(config.dirs.raw, `${id}_s0.mp4`);
const s1 = path.join(config.dirs.raw, `${id}_s1.mp4`);
const vo = path.join(config.dirs.audio, `${id}_vo.mp3`);
ff(['-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=4:r=30', '-pix_fmt', 'yuv420p', s0]);
ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=4:r=30', '-pix_fmt', 'yuv420p', s1]);
ff(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '8', '-c:a', 'libmp3lame', vo]);

const project = buildProject({
  id, opts: { topic: 'smoke', fades: true, motion: false }, plan: { title: 'Smoke' },
  aspect: '16:9', fps: 30, language: 'English',
  voiceTrack: { path: vo, duration: 8 },
  captions: { enabled: true, cues: [{ start: 0, end: 4, text: 'hello world' }, { start: 4, end: 8, text: 'second line' }] },
  music: null,
  scenes: [
    { index: 0, narration: 'hello world', sourcePath: s0, clipPath: null, duration: 4, motion: false },
    { index: 1, narration: 'second line', sourcePath: s1, clipPath: null, duration: 4, motion: false },
  ],
});
saveProject(project);

console.log('\n[1] First full render (no cache) — expect both scenes + concat + final…');
let t = Date.now();
let r1 = await renderProject(loadProject(id), { onProgress: (s, m) => console.log(`    · ${s}: ${m}`) });
console.log(`  → ${r1.file} in ${Date.now() - t}ms; rerendered scenes=${JSON.stringify(r1.plan.scenesRerendered)} concat=${r1.plan.concat} final=${r1.plan.final}`);
const fullMs = Date.now() - t;
assert(fs.existsSync(r1.outputPath), 'output mp4 should exist');
assertEq(r1.plan.scenesRerendered.length, 2, 'first render encodes both scenes');
assertEq(r1.plan.concat, true, 'first render stitches');

console.log('\n[2] Edit a caption, re-render — expect ONLY final, scenes reused…');
const edited = loadProject(id);
edited.captions.cues[0].text = 'HELLO EDITED';
saveProject(edited);
t = Date.now();
let r2 = await renderProject(loadProject(id), { onProgress: (s, m) => console.log(`    · ${s}: ${m}`) });
const editMs = Date.now() - t;
console.log(`  → ${r2.file} in ${editMs}ms; rerendered scenes=${JSON.stringify(r2.plan.scenesRerendered)} concat=${r2.plan.concat} final=${r2.plan.final}`);
assertEq(r2.plan.scenesRerendered.length, 0, 'caption edit re-encodes no scenes');
assertEq(r2.plan.concat, false, 'caption edit reuses the stitch');
assertEq(r2.plan.final, true, 'caption edit re-runs the final mux');

console.log('\n[3] Trim scene 0, re-render — expect scene 0 + concat + final, scene 1 reused…');
const trimmed = loadProject(id);
trimmed.scenes[0].trim = { in: 0.5, out: 3 };
saveProject(trimmed);
t = Date.now();
let r3 = await renderProject(loadProject(id), { onProgress: (s, m) => console.log(`    · ${s}: ${m}`) });
console.log(`  → ${r3.file} in ${Date.now() - t}ms; rerendered scenes=${JSON.stringify(r3.plan.scenesRerendered)} concat=${r3.plan.concat} final=${r3.plan.final}`);
assertEq(JSON.stringify(r3.plan.scenesRerendered), '[0]', 'trim re-encodes only scene 0');
assertEq(r3.plan.concat, true, 'trim re-stitches');

console.log(`\nSpeedup: caption edit ${editMs}ms vs full ${fullMs}ms (${(fullMs / Math.max(1, editMs)).toFixed(1)}x faster)\n`);
console.log('ALL SMOKE CHECKS PASSED ✔');

// tiny assert helpers (keep deps zero)
function assert(c, m) { if (!c) { console.error('FAIL:', m); process.exit(1); } }
function assertEq(a, b, m) { if (a !== b) { console.error(`FAIL: ${m} (got ${a}, want ${b})`); process.exit(1); } }
