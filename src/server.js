import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config, RESOLUTIONS, ROOT } from './config.js';
import { VOICES, isValidVoice, defaultVoice } from './voices.js';
import { ensureDirs, probeDuration } from './voice.js';
import { runPipeline, getJob, startProjectRender } from './pipeline.js';
import { loadProject, saveProject, validateProject, relayout, listProjects, hashOf } from './project.js';
import { activeLlm } from './llm.js';
import { CAPTION_SIZES } from './captions.js';
import { MEDIA_DIRS, previewBundle, resolveAssetPath } from './edit.js';
import { extractThumbs, extractWaveform } from './ffmpeg.js';
import { findClipCandidates, downloadClip, orientationFor } from './stock.js';
import { buildShareKit, lanBaseUrl } from './share.js';

ensureDirs();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(config.dirs.output));

// Asset media for the live-preview editor. Static serving gives HTTP range
// requests for free, so <video> scrubbing/seeking works. Each prefix maps to one
// asset dir; edit.js#assetToUrl produces exactly these URLs.
for (const [key, dir] of Object.entries(MEDIA_DIRS)) {
  app.use(`/media/${key}`, express.static(dir));
}

// --- Raw multipart music upload (no external dep) ---
app.post('/api/music', express.raw({ type: '*/*', limit: '30mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file' });
  const ext = (req.query.ext || 'mp3').toString().replace(/[^a-z0-9]/gi, '');
  const name = `music_${Date.now()}.${ext}`;
  const dest = path.join(config.dirs.work, name);
  fs.writeFileSync(dest, req.body);
  res.json({ path: dest });
});

// --- Raw video upload (footage replacement for the editor) ---
app.post('/api/clip', express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file' });
  const ext = (req.query.ext || 'mp4').toString().replace(/[^a-z0-9]/gi, '') || 'mp4';
  const name = `clip_${Date.now()}.${ext}`;
  const dest = path.join(config.dirs.raw, name);
  fs.mkdirSync(config.dirs.raw, { recursive: true });
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
  // Caption size: a named preset (S/M/L/XL) or a raw multiplier. Stored on the
  // project so it survives into edits and re-renders; captions.js clamps it.
  const captionStyle = {};
  if (b.captionSize && CAPTION_SIZES[b.captionSize]) captionStyle.size = b.captionSize;
  if (Number(b.captionScale) > 0) captionStyle.scale = Number(b.captionScale);
  const fades = b.fades !== false;
  const motion = b.motion !== false; // Ken Burns on by default
  const autoMusic = Boolean(b.autoMusic);
  const bgMusicPath = b.bgMusicPath && fs.existsSync(b.bgMusicPath) ? b.bgMusicPath : null;

  const id = runPipeline({
    topic, script, context, aspect, targetSeconds, tone, voice, voice2, rate,
    subtitles, captionStyle, bgMusicPath, fades, motion, autoMusic,
  });
  res.json({ jobId: id });
});

// --- Editable projects (timeline documents behind each video) ---

// List saved projects (most recently edited first).
app.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects() });
});

// Load one project's full timeline document.
app.get('/api/project/:id', (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

// Save edits. The render cache lives server-side; preserve it across edits so the
// next re-render only redoes what the edit actually changed.
app.put('/api/project/:id', (req, res) => {
  const existing = loadProject(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const incoming = req.body || {};
  incoming.id = req.params.id;            // path is authoritative
  incoming.render = existing.render;      // keep the cache the client never sees
  try {
    validateProject(incoming);
  } catch (err) {
    return res.status(400).json({ error: err.message, validation: err.validation || null });
  }
  relayout(incoming);                     // recompute scene start times after trims/reorders
  saveProject(incoming);
  res.json({ ok: true, project: incoming });
});

// Kick off an incremental re-render. Poll progress via /api/job/:id (same as renders).
app.post('/api/project/:id/render', (req, res) => {
  const jobId = startProjectRender(req.params.id);
  if (!jobId) return res.status(404).json({ error: 'not found' });
  res.json({ jobId });
});

// Share kit: caption + hashtags + per-platform composer links for a rendered
// video, plus the absolute file URL the in-browser native share sheet hands to
// the OS. 409 if the video hasn't been rendered yet (nothing to share).
app.get('/api/project/:id/share', (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const out = p.render?.outputPath;
  const fallback = path.join(config.dirs.output, `${p.id}_final.mp4`);
  const file = out && fs.existsSync(out)
    ? path.basename(out)
    : (fs.existsSync(fallback) ? path.basename(fallback) : null);
  if (!file) return res.status(409).json({ error: 'render the video before sharing' });

  // SHARE_BASE_URL wins (tunnel/domain); otherwise use the origin the client
  // actually reached us on so the link resolves at least on this network.
  const baseUrl = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
  const lanUrl = config.shareBaseUrl ? null : lanBaseUrl(config.port, req.protocol);
  res.json(buildShareKit({ project: p, file, baseUrl, lanUrl }));
});

// --- Live-preview editor support ---

// Media bundle: per-scene source URLs + voice/music URLs + timeline geometry,
// everything the in-browser player needs to play the timeline before any render.
app.get('/api/project/:id/preview', (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(previewBundle(p));
});

// Filmstrip thumbnails for one scene's source clip, across its trim window.
// Cached on disk by source+trim hash so re-opening a scene is instant.
app.get('/api/project/:id/thumbs/:index', async (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const scene = p.scenes.find((s) => String(s.index) === String(req.params.index));
  const input = resolveAssetPath(scene?.source?.path);
  if (!input) return res.status(404).json({ error: 'scene source missing' });
  const count = Math.max(1, Math.min(24, Number(req.query.n) || 8));
  const trim = scene.trim || {};
  const start = Number(trim.in) > 0 ? Number(trim.in) : 0;
  let length = Number(trim.out) > start ? Number(trim.out) - start : null;
  if (length == null) { const d = await probeDuration(input); length = d ? d - start : null; }
  try {
    const base = `${p.id}_thumb_${scene.index}_${hashOf({ src: input, start, length, count })}`;
    const files = await extractThumbs({ input, outBase: base, count, start, length });
    res.json({ thumbs: files.map((f) => `/media/work/${encodeURIComponent(path.basename(f))}`) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Narration waveform peaks (0..1), cached as JSON so it's computed once.
app.get('/api/project/:id/waveform', async (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const voice = resolveAssetPath(p.audio?.voiceTrack?.path);
  if (!voice) return res.status(404).json({ error: 'voice track missing' });
  const buckets = Math.max(50, Math.min(2000, Number(req.query.buckets) || 800));
  const cacheFile = path.join(config.dirs.work, `${p.id}_peaks_${buckets}.json`);
  try {
    if (fs.existsSync(cacheFile)) return res.json(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    const peaks = await extractWaveform({ input: voice, buckets });
    const payload = { peaks, duration: p.audio.voiceTrack.duration || 0 };
    fs.writeFileSync(cacheFile, JSON.stringify(payload));
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// In-editor stock search: candidate clips for a query, previewable by URL.
app.get('/api/stock/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const orientation = orientationFor((req.query.aspect || '16:9').toString());
  try {
    const all = await findClipCandidates(q, orientation);
    res.json({
      candidates: all.slice(0, 12).map((c) => ({
        provider: c.provider, id: c.id, url: c.url,
        width: c.width, height: c.height, duration: c.duration,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply a chosen stock clip (or any direct mp4 URL) as a scene's footage. Downloads
// it, points the scene at it, and clears that scene's trim + cached normalized clip
// so the next render re-encodes only this scene. Saves the project.
app.post('/api/project/:id/scene/:index/source', async (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const scene = p.scenes.find((s) => String(s.index) === String(req.params.index));
  if (!scene) return res.status(404).json({ error: 'scene not found' });
  const url = (req.body?.url || '').toString();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'a video url is required' });
  try {
    const dest = await downloadClip(url, `${p.id}_swap_${scene.index}_${Date.now()}`);
    scene.source = { path: dest };
    scene.clip = { path: null };
    scene.trim = null;
    saveProject(p);
    res.json({ ok: true, scene: { index: scene.index, sourceUrl: `/media/raw/${encodeURIComponent(path.basename(dest))}` } });
  } catch (err) {
    res.status(502).json({ error: `download failed: ${err.message}` });
  }
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
