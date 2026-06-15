// Eval: prove detectTempo recovers a known BPM through the REAL ffmpeg decode
// path. Synthesizes a click track WAV (no network, no API), decodes + analyzes it.
// Run: npm run eval:beats
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTempo } from '../src/beats.js';

// Minimal 16-bit mono PCM WAV writer (so ffmpeg has a real file to decode).
function writeWav(file, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, samples[i] | 0)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

async function run() {
  const sr = 22050;
  const bpm = 120;                       // 0.5s per beat
  const seconds = 10;
  const period = Math.round(sr * 60 / bpm);
  const n = sr * seconds;
  const samples = new Array(n).fill(0);
  // A short decaying 1 kHz burst on each beat (a metronome).
  for (let beat = 0; beat * period < n; beat++) {
    const start = beat * period;
    for (let i = 0; i < 1200 && start + i < n; i++) {
      const env = Math.exp(-i / 300);
      samples[start + i] = Math.round(Math.sin((2 * Math.PI * 1000 * i) / sr) * 12000 * env);
    }
  }

  const file = path.join(os.tmpdir(), `av_beat_${Date.now()}.wav`);
  writeWav(file, samples, sr);
  try {
    const { bpm: got, offset, strength } = await detectTempo(file);
    console.log(`detectTempo → ${got} BPM (offset ${offset}s, strength ${strength.toFixed(4)})`);
    // Allow the half/double-tempo octave error common to all tempo trackers.
    const ok = Math.abs(got - bpm) <= 4 || Math.abs(got - bpm * 2) <= 6 || Math.abs(got - bpm / 2) <= 4;
    assert.ok(ok, `expected ~${bpm} (or its octave), got ${got}`);
    console.log('PASS: tempo recovered through real ffmpeg decode');
  } finally {
    fs.unlinkSync(file);
  }
}

run().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
