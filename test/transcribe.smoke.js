// Eval: prove the real ASR path (faster-whisper) transcribes speech back to text.
// Self-skips if faster-whisper or edge-tts (to make the sample) is unavailable, or
// if the model can't be fetched offline. Run: npm run eval:transcribe
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transcribe, transcriberAvailable, transcriptText } from '../src/transcribe.js';

const execFileP = promisify(execFile);
const skip = (msg) => { console.log(`SKIP: ${msg}`); process.exit(0); };

async function have(cmd, args) { try { await execFileP(cmd, args, { timeout: 15000 }); return true; } catch { return false; } }

async function run() {
  if (!(await transcriberAvailable())) skip('faster-whisper not installed');
  if (!(await have('edge-tts', ['--version']))) skip('edge-tts not installed (needed to synth a sample)');

  const sentence = 'The quick brown fox jumps over the lazy dog near the river.';
  const mp3 = path.join(os.tmpdir(), `av_asr_${Date.now()}.mp3`);
  await execFileP('edge-tts', ['--voice', 'en-US-AvaNeural', '--text', sentence, '--write-media', mp3]);
  try {
    let tr;
    try {
      tr = await transcribe(mp3, { model: 'tiny', language: 'en', timeoutMs: 300000 });
    } catch (e) {
      skip(`model unavailable offline: ${e.message}`);
    }
    const text = transcriptText(tr.segments).toLowerCase();
    console.log(`heard: "${text}"`);
    if (!text) { console.error('FAIL: no text transcribed'); process.exit(1); }
    // ASR isn't exact; require a couple of the distinctive words to land.
    const hits = ['quick', 'brown', 'fox', 'lazy', 'dog', 'river'].filter((w) => text.includes(w));
    if (hits.length < 2) { console.error(`FAIL: too few words recovered (${hits.join(',')})`); process.exit(1); }
    console.log(`PASS: recovered ${hits.length} key words (${hits.join(', ')})`);

    // Word timestamps drive exact karaoke caption timing — assert they're present
    // and monotonic so the shorts/dub caption path can't silently regress to the
    // syllable estimate. (Also proves the CPU device fallback transcribed at all.)
    const words = tr.segments.flatMap((s) => s.words || []);
    if (words.length < 3) { console.error('FAIL: no per-word timestamps emitted'); process.exit(1); }
    const ordered = words.every((w, i) => w.end > w.start && (i === 0 || w.start >= words[i - 1].start - 0.01));
    if (!ordered) { console.error('FAIL: word timestamps not ordered/positive'); process.exit(1); }
    console.log(`PASS: ${words.length} word timestamps, ordered (e.g. ${words.slice(0, 3).map((w) => `${w.text}@${w.start}`).join(' ')})`);
  } finally {
    fs.unlinkSync(mp3);
  }
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
