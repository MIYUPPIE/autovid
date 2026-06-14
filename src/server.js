import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config, RESOLUTIONS, ROOT } from './config.js';
import { VOICES, isValidVoice, defaultVoice } from './voices.js';
import { ensureDirs } from './voice.js';
import { runPipeline, getJob } from './pipeline.js';
import { activeLlm } from './llm.js';

ensureDirs();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(config.dirs.output));

// --- Raw multipart music upload (no external dep) ---
app.post('/api/music', express.raw({ type: '*/*', limit: '30mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file' });
  const ext = (req.query.ext || 'mp3').toString().replace(/[^a-z0-9]/gi, '');
  const name = `music_${Date.now()}.${ext}`;
  const dest = path.join(config.dirs.work, name);
  fs.writeFileSync(dest, req.body);
  res.json({ path: dest });
});

// --- Config / capabilities ---
app.get('/api/voices', (req, res) => {
  res.json({ voices: VOICES, resolutions: RESOLUTIONS });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    keys: {
      xai: Boolean(config.xaiKey),
      pexels: Boolean(config.pexelsKey),
      pixabay: Boolean(config.pixabayKey),
      jamendo: Boolean(config.jamendoClientId),
      yarn: Boolean(config.yarnKey),
    },
    llm: activeLlm(),
    model: config.xaiModel,
  });
});

// --- Start a render ---
app.post('/api/render', (req, res) => {
  const b = req.body || {};
  const topic = (b.topic || '').toString().trim();
  const script = (b.script || '').toString().trim();
  if (!topic && !script) return res.status(400).json({ error: 'topic or script is required' });

  const context = b.context === 'africa' ? 'africa' : 'global';
  const aspect = RESOLUTIONS[b.aspect] ? b.aspect : '16:9';
  const targetSeconds = Math.max(15, Math.min(180, Number(b.targetSeconds) || 60));
  const tone = (b.tone || 'engaging').toString();
  const voice = isValidVoice(b.voice) ? b.voice : defaultVoice(context);
  // Optional second voice → bilingual (each line spoken in both languages).
  const voice2 = isValidVoice(b.voice2) && b.voice2 !== voice ? b.voice2 : null;
  const rate = (b.rate || '+0%').toString();
  const subtitles = Boolean(b.subtitles);
  const fades = b.fades !== false;
  const motion = b.motion !== false; // Ken Burns on by default
  const autoMusic = Boolean(b.autoMusic);
  const bgMusicPath = b.bgMusicPath && fs.existsSync(b.bgMusicPath) ? b.bgMusicPath : null;

  const id = runPipeline({
    topic, script, context, aspect, targetSeconds, tone, voice, voice2, rate,
    subtitles, bgMusicPath, fades, motion, autoMusic,
  });
  res.json({ jobId: id });
});

// --- Poll job status ---
app.get('/api/job/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    plan: job.plan || null,
    result: job.result,
    error: job.error,
  });
});

// --- SSE progress stream ---
app.get('/api/job/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let lastIdx = 0;
  const tick = setInterval(() => {
    while (lastIdx < job.log.length) {
      const entry = job.log[lastIdx++];
      res.write(`data: ${JSON.stringify({ ...entry, progress: job.progress, status: job.status })}\n\n`);
    }
    if (job.status === 'done' || job.status === 'error') {
      res.write(`event: end\ndata: ${JSON.stringify({ status: job.status, result: job.result, error: job.error })}\n\n`);
      clearInterval(tick);
      res.end();
    }
  }, 400);

  req.on('close', () => clearInterval(tick));
});

export { app };

// Only listen when run directly (node src/server.js), not when imported by tests.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  app.listen(config.port, () => {
    console.log(`\n  AutoVid running →  http://localhost:${config.port}`);
    console.log(`  Keys: xai=${Boolean(config.xaiKey)} pexels=${Boolean(config.pexelsKey)} pixabay=${Boolean(config.pixabayKey)}`);
    console.log(`  Model: ${config.xaiModel}\n`);
  });
}
