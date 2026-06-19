// JS side of the local AI-video service. Spawns the persistent Python LTX worker
// (services/localvid/ltx_generate.py) once per render, hands it one scene job at
// a time over stdin, and resolves each clip as the worker reports it done. The
// model is heavy to load, so reusing one process across a render's scenes is the
// whole point.
//
// The pure helpers (dimsForAspect, buildVisualPrompt, parseWorkerLine) are gate-
// tested with no Python. The generator itself shells out, mirroring how
// transcribe.js shells out to faster-whisper.

import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import { config, ROOT } from './config.js';

// Worker script path (one place so the server, pipeline and tests agree).
export const WORKER_SCRIPT = path.join(ROOT, 'services', 'localvid', 'ltx_generate.py');

// Cheap heuristic for whether the local-AI mode can even be attempted: the worker
// script exists and the configured python looks resolvable. The real readiness
// (diffusers installed, model downloaded, GPU) surfaces when a render runs.
export function localVideoConfigured() {
  const py = config.localvidPython;
  const pyOk = py === 'python' || py === 'python3' || fs.existsSync(py);
  return fs.existsSync(WORKER_SCRIPT) && pyOk;
}

// Map an aspect to model dims (short side = `base`, divisible by 32). Pure.
export function dimsForAspect(aspect, base = config.localvidBase) {
  const r32 = (n) => Math.max(160, Math.round(n / 32) * 32);
  const long = r32((base * 16) / 9);
  const short = r32(base);
  if (aspect === '16:9') return { width: long, height: short };
  if (aspect === '1:1') return { width: short, height: short };
  return { width: short, height: long }; // 9:16
}

// Build a rich text-to-video prompt from a scene. The planners give a short
// stock-style `query`; AI generation wants something more descriptive. Pure.
export function buildVisualPrompt({ query, narration, context, style } = {}) {
  const subject = String(query || narration || '').trim().replace(/["\n]+/g, ' ');
  const region = context === 'africa' ? 'authentic African setting, ' : '';
  const look = style || 'cinematic, photorealistic, smooth natural camera motion, soft natural lighting, highly detailed';
  return `${region}${subject}. ${look}`.replace(/\s+/g, ' ').trim();
}

// Parse one worker stdout line into a protocol message, or null if it's not JSON
// (stray prints). Pure → gate-tested.
export function parseWorkerLine(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('{')) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Coerce a desired clip length (seconds) into a frame count the worker accepts
// (num_frames % 8 == 1, capped). Pure.
export function framesForDuration(durationSec, fps = config.localvidFps, maxFrames = config.localvidMaxFrames) {
  const raw = Math.round((Number(durationSec) || 2) * fps);
  const capped = Math.max(9, Math.min(maxFrames, raw));
  return capped - ((capped - 1) % 8);
}

/**
 * Spawn the LTX worker and return a generator with generate()/close(). Resolves
 * once the worker reports it's ready (model loaded). Throws if Python/model fail
 * to start (so the render fails fast with a clear, actionable message).
 */
export async function createLocalVideoGenerator({ onDiag = null } = {}) {
  const child = spawn(config.localvidPython, [WORKER_SCRIPT], {
    env: { ...process.env, LTX_MODEL: config.localvidModel },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (onDiag) readline.createInterface({ input: child.stderr }).on('line', (l) => onDiag(l));

  const pending = new Map(); // job id → { resolve, reject }
  let readyResolve, readyReject;
  const readyP = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  let settledReady = false;
  const settleReady = (fn, v) => { if (!settledReady) { settledReady = true; fn(v); } };

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = parseWorkerLine(line);
    if (!msg) return;
    if (msg.event === 'ready') settleReady(readyResolve, msg);
    else if (msg.event === 'fatal') settleReady(readyReject, new Error(msg.error || 'local video worker failed to start'));
    else if (msg.event === 'done') { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p.resolve(msg.out); } }
    else if (msg.event === 'error') { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p.reject(new Error(msg.error)); } }
  });

  child.on('exit', (code) => {
    const err = new Error(`local video worker exited (code ${code}) — check the server log for the Python traceback`);
    settleReady(readyReject, err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
  child.on('error', (e) => settleReady(readyReject, new Error(`could not start local video worker (${config.localvidPython}): ${e.message}`)));

  const readyTimer = setTimeout(
    () => settleReady(readyReject, new Error(`local video worker not ready after ${Math.round(config.localvidReadyTimeoutMs / 1000)}s (first run downloads the model — give it longer or pre-download)`)),
    config.localvidReadyTimeoutMs,
  );
  try { await readyP; } finally { clearTimeout(readyTimer); }

  let seq = 0;
  return {
    /** Generate one silent clip. Returns the output path. */
    generate({ prompt, aspect, durationSec, out, seed = null }) {
      const id = `g${++seq}`;
      const { width, height } = dimsForAspect(aspect);
      const job = {
        id, prompt, width, height,
        num_frames: framesForDuration(durationSec), fps: config.localvidFps,
        steps: config.localvidSteps, out, seed,
      };
      const resultP = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      const timer = setTimeout(() => {
        const p = pending.get(id);
        if (p) { pending.delete(id); p.reject(new Error(`scene ${id} generation timed out after ${Math.round(config.localvidJobTimeoutMs / 1000)}s`)); }
      }, config.localvidJobTimeoutMs);
      child.stdin.write(`${JSON.stringify(job)}\n`);
      return resultP.finally(() => clearTimeout(timer));
    },
    close() { try { child.stdin.end(); } catch { /* already closed */ } },
  };
}
