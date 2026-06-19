import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { config, RESOLUTIONS, ROOT } from './config.js';
import { VOICES, isValidVoice, defaultVoice } from './voices.js';
import { ensureDirs, probeDuration } from './voice.js';
import {
  submitRender, submitMulti, submitDub, submitShorts, submitProjectRender, submitAiVideo,
  jobView, queueEnabled, activeBackend, startWorker,
} from './jobs.js';
import { transcriberAvailable } from './transcribe.js';
import { loadProject, saveProject, validateProject, relayout, listProjects, hashOf } from './project.js';
import { activeLlm } from './llm.js';
import { CAPTION_SIZES, CAPTION_ANIMS } from './captions.js';
import { MEDIA_DIRS, previewBundle, resolveAssetPath } from './edit.js';
import { extractThumbs, extractWaveform, TRANSITIONS } from './ffmpeg.js';
import { findClipCandidates, downloadClip, orientationFor, youtubeAvailable } from './stock.js';
import { buildShareKit, lanBaseUrl } from './share.js';
import { loadBrand, saveBrand } from './brand.js';

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

// Stream a raw (application/octet-stream) upload straight to disk. The old
// handlers used express.raw(), which buffers the WHOLE file into memory and
// enforces a body-parser size cap — a multi-GB video blew past the 200mb limit
// with PayloadTooLargeError. Piping req → file write stream has no size cap and
// constant memory use, so arbitrarily large videos upload fine. The browser
// sends the file body raw; express.json() ignores octet-stream so the stream is
// still readable here. Returns { path, bytes }.
function streamUpload(getDir, prefix, fallbackExt) {
  return (req, res) => {
    // Resolve the dir per-request so config.dirs reassignment (tests, runtime
    // config) is honored — matches the old express.raw handlers' behavior.
    const dir = typeof getDir === 'function' ? getDir() : getDir;
    fs.mkdirSync(dir, { recursive: true });
    const ext = (req.query.ext || fallbackExt).toString().replace(/[^a-z0-9]/gi, '') || fallbackExt;
    const dest = path.join(dir, `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`);
    const out = fs.createWriteStream(dest);
    const rm = () => { try { fs.unlinkSync(dest); } catch (_) {} };
    let bytes = 0, done = false;
    const fail = (code, msg) => {
      if (done) return; done = true;
      out.destroy(); rm();
      if (!res.headersSent) res.status(code).json({ error: msg });
    };
    req.on('data', (c) => { bytes += c.length; });
    req.on('aborted', () => { if (!done) { done = true; out.destroy(); rm(); } });
    req.on('error', (e) => fail(500, e.message));
    out.on('error', (e) => fail(500, e.message));
    out.on('finish', () => {
      if (done) return; done = true;
      if (!bytes) { rm(); return res.status(400).json({ error: 'No file' }); }
      res.json({ path: dest, bytes });
    });
    req.pipe(out);
  };
}

// --- Music upload (auto-loop/duck under voice) ---
app.post('/api/music', streamUpload(() => config.dirs.work, 'music', 'mp3'));

// --- Video upload (shorts source, dub source, editor footage swap) ---
app.post('/api/clip', streamUpload(() => config.dirs.raw, 'clip', 'mp4'));

// --- Config / capabilities ---
app.get('/api/voices', (req, res) => {
  res.json({ voices: VOICES, resolutions: RESOLUTIONS });
});

// --- Brand kit (#10): one persisted identity applied to every render ---
app.get('/api/brand', (req, res) => {
  res.json(loadBrand());
});

app.put('/api/brand', (req, res) => {
  res.json(saveBrand(req.body || {}));
});

// Logo image upload for the brand kit. Returns the stored path to put in the brand.
app.post('/api/logo', streamUpload(() => config.dirs.work, 'logo', 'png'));

app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    keys: {
      xai: Boolean(config.xaiKey),
      pexels: Boolean(config.pexelsKey),
      pixabay: Boolean(config.pixabayKey),
      jamendo: Boolean(config.jamendoClientId),
      yarn: Boolean(config.yarnKey),
    },
    features: {
      dub: await transcriberAvailable(), // transcription present → dub/shorts enabled
      youtube: await youtubeAvailable(), // yt-dlp present → YouTube footage source
    },
    llm: activeLlm(),
    model: config.xaiModel,
    queue: { enabled: queueEnabled(), backend: activeBackend() },
  });
});

// Build a validated render-opts object from a request body. Throws { status, error }
// on a bad request (empty topic+script). Shared by /api/render and /api/render/multi.
function buildRenderOpts(b = {}) {
  const topic = (b.topic || '').toString().trim();
  const script = (b.script || '').toString().trim();
  if (!topic && !script) { const e = new Error('topic or script is required'); e.status = 400; throw e; }

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
  if (b.captionAnim && CAPTION_ANIMS.includes(b.captionAnim)) captionStyle.captionAnim = b.captionAnim;
  const fades = b.fades !== false;
  const motion = b.motion !== false; // Ken Burns on by default
  const autoMusic = Boolean(b.autoMusic);
  const codeSwitch = Boolean(b.codeSwitch); // mix in natural English the way bilingual speakers do
  const beatSync = b.beatSync !== false;    // snap cuts to the music beat (on by default)
  const bRoll = b.bRoll !== false;          // split long scenes into short shots (on by default)
  const transition = TRANSITIONS[b.transition] !== undefined ? b.transition : 'cut'; // scene crossfade (#8)
  const bgMusicPath = b.bgMusicPath && fs.existsSync(b.bgMusicPath) ? b.bgMusicPath : null;
  const useYouTube = Boolean(b.useYouTube); // pull footage from YouTube too (yt-dlp)

  return {
    topic, script, context, aspect, targetSeconds, tone, voice, voice2, rate,
    subtitles, captionStyle, bgMusicPath, fades, motion, autoMusic, codeSwitch, beatSync, bRoll, transition, useYouTube,
  };
}

// --- Start a render ---
app.post('/api/render', async (req, res) => {
  let opts;
  try { opts = buildRenderOpts(req.body); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try { res.json({ jobId: await submitRender(opts) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- AI talking video (xAI Grok Imagine): xAI generates the clips AND speech ---
// Separate from /api/render. No stock footage, no neural voiceover — the picture
// and the voice both come from xAI, with lip-sync to the generated speech.
function buildAiVideoOpts(b = {}) {
  const topic = (b.topic || '').toString().trim();
  const script = (b.script || '').toString().trim();
  if (!topic && !script) { const e = new Error('topic or script is required'); e.status = 400; throw e; }
  const context = b.context === 'africa' ? 'africa' : 'global';
  const aspect = RESOLUTIONS[b.aspect] ? b.aspect : '9:16';
  const targetSeconds = Math.max(15, Math.min(180, Number(b.targetSeconds) || 45));
  const tone = (b.tone || 'engaging').toString();
  const language = (b.language || 'English').toString().trim() || 'English';
  const resolution = ['480p', '720p', '1080p'].includes(b.resolution) ? b.resolution : config.xaiVideoResolution;
  const captionStyle = {};
  if (b.captionSize && CAPTION_SIZES[b.captionSize]) captionStyle.size = b.captionSize;
  if (Number(b.captionScale) > 0) captionStyle.scale = Number(b.captionScale);
  if (b.captionAnim && CAPTION_ANIMS.includes(b.captionAnim)) captionStyle.captionAnim = b.captionAnim;
  return {
    topic, script, context, aspect, targetSeconds, tone, language, resolution,
    subtitles: Boolean(b.subtitles), fades: b.fades !== false, autoMusic: Boolean(b.autoMusic), captionStyle,
  };
}

app.post('/api/ai-video', async (req, res) => {
  if (!config.xaiKey) return res.status(503).json({ error: 'XAI_API_KEY is not set — AI video needs an xAI key with Grok Imagine access' });
  let opts;
  try { opts = buildAiVideoOpts(req.body); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try { res.json({ jobId: await submitAiVideo(opts) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Dub an existing video (#2): transcribe → translate → re-narrate ---
app.post('/api/dub', async (req, res) => {
  const b = req.body || {};
  const videoPath = (b.videoPath || '').toString();
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(400).json({ error: 'videoPath is required (upload via /api/clip first)' });
  }
  if (!isValidVoice(b.voice)) return res.status(400).json({ error: 'a valid target voice is required' });
  if (!(await transcriberAvailable())) {
    return res.status(503).json({ error: 'transcription unavailable — run: pip install faster-whisper' });
  }
  const captionStyle = {};
  if (b.captionSize && CAPTION_SIZES[b.captionSize]) captionStyle.size = b.captionSize;
  if (b.captionAnim && CAPTION_ANIMS.includes(b.captionAnim)) captionStyle.captionAnim = b.captionAnim;
  try {
    const jobId = await submitDub({
      videoPath, voice: b.voice, rate: (b.rate || '+0%').toString(),
      subtitles: b.subtitles !== false, aspect: b.aspect, captionStyle,
      sourceLang: b.sourceLang || null, model: (b.model || 'base').toString(),
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Repurpose a long video into shorts (#9) ---
app.post('/api/shorts', async (req, res) => {
  const b = req.body || {};
  const videoPath = (b.videoPath || '').toString();
  if (!videoPath || !fs.existsSync(videoPath)) {
    return res.status(400).json({ error: 'videoPath is required (upload via /api/clip first)' });
  }
  if (!(await transcriberAvailable())) {
    return res.status(503).json({ error: 'transcription unavailable — run: pip install faster-whisper' });
  }
  const captionStyle = {};
  if (b.captionSize && CAPTION_SIZES[b.captionSize]) captionStyle.size = b.captionSize;
  if (b.captionAnim && CAPTION_ANIMS.includes(b.captionAnim)) captionStyle.captionAnim = b.captionAnim;
  try {
    const jobId = await submitShorts({
      videoPath, count: Math.max(1, Math.min(10, Number(b.count) || 3)),
      aspect: RESOLUTIONS[b.aspect] ? b.aspect : '9:16',
      subtitles: b.subtitles !== false, captionStyle,
      minSec: Math.max(5, Number(b.minSec) || 15), maxSec: Math.max(15, Number(b.maxSec) || 60),
      model: (b.model || 'base').toString(), sourceLang: b.sourceLang || null,
    });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Multi-language one-shot (#1): one idea → N narrated videos at once ---
app.post('/api/render/multi', async (req, res) => {
  let opts;
  try { opts = buildRenderOpts(req.body); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const voices = Array.isArray(req.body?.voices) ? req.body.voices.filter(isValidVoice) : [];
  try {
    const batch = await submitMulti({ ...opts, voices });
    res.json(batch);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
app.post('/api/project/:id/render', async (req, res) => {
  try {
    const jobId = await submitProjectRender(req.params.id);
    if (!jobId) return res.status(404).json({ error: 'not found' });
    res.json({ jobId });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// In-editor stock search: candidate clips for a query, previewable by URL (Pexels
// /Pixabay) or thumbnail (YouTube). `sources` is a comma list (pexels,pixabay,
// youtube) — defaults to the two free-stock APIs so the fast inline search stays
// fast; the browse-all modal passes youtube too. `limit` caps the result count.
const STOCK_SOURCES = new Set(['pexels', 'pixabay', 'youtube']);
app.get('/api/stock/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const orientation = orientationFor((req.query.aspect || '16:9').toString());
  const sources = (req.query.sources || 'pexels,pixabay')
    .toString().split(',').map((s) => s.trim().toLowerCase()).filter((s) => STOCK_SOURCES.has(s));
  const limit = Math.max(1, Math.min(40, Number(req.query.limit) || 24));
  try {
    const all = await findClipCandidates(q, orientation, 'pexels', 0, sources.length ? sources : ['pexels', 'pixabay']);
    res.json({
      candidates: all.slice(0, limit).map((c) => ({
        provider: c.provider, id: c.id, url: c.url, thumb: c.thumb || null,
        title: c.title || null, width: c.width, height: c.height, duration: c.duration,
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
    // Return the absolute `path` too: the editor stores it on its working copy so
    // its next PUT keeps the swap instead of overwriting it with the stale path.
    res.json({ ok: true, scene: { index: scene.index, path: dest, sourceUrl: `/media/raw/${encodeURIComponent(path.basename(dest))}` } });
  } catch (err) {
    res.status(502).json({ error: `download failed: ${err.message}` });
  }
});

// --- Poll job status ---
app.get('/api/job/:id', async (req, res) => {
  const job = await jobView(req.params.id);
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
// Polls jobView on an interval so the exact same wire format works for both
// backends: in-memory reads the live object; Redis reads BullMQ's persisted
// progress. Each `data:` frame carries one new log entry + current progress +
// status; an `end` event carries the final result/error.
app.get('/api/job/:id/stream', async (req, res) => {
  if (!(await jobView(req.params.id))) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let lastIdx = 0;
  let closed = false;
  req.on('close', () => { closed = true; });

  async function tick() {
    if (closed) return;
    let job = null;
    try { job = await jobView(req.params.id); } catch { /* transient redis read */ }
    if (job) {
      while (lastIdx < job.log.length) {
        const entry = job.log[lastIdx++];
        res.write(`data: ${JSON.stringify({ ...entry, progress: job.progress, status: job.status })}\n\n`);
      }
      if (job.status === 'done' || job.status === 'error') {
        res.write(`event: end\ndata: ${JSON.stringify({ status: job.status, result: job.result, error: job.error })}\n\n`);
        return res.end();
      }
    }
    setTimeout(tick, config.jobPollMs);
  }
  tick();
});

export { app };

// Only listen when run directly (node src/server.js), not when imported by tests.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  // Job backend. With Redis on, run a worker inside this process too
  // (single-box convenience) unless WORKER_INLINE=0, in which case the web
  // server only enqueues and a separate `npm run worker` does the work.
  let backendLine = '  Queue: in-memory (jobs lost on restart)';
  if (queueEnabled()) {
    if (config.workerInline) {
      startWorker();
      backendLine = `  Queue: redis @ ${config.redisUrl} (inline worker, concurrency=${config.workerConcurrency})`;
    } else {
      backendLine = `  Queue: redis @ ${config.redisUrl} (enqueue-only — run \`npm run worker\`)`;
    }
  }
  app.listen(config.port, () => {
    console.log(`\n  GriotVid running →  http://localhost:${config.port}`);
    console.log(`  Keys: xai=${Boolean(config.xaiKey)} pexels=${Boolean(config.pexelsKey)} pixabay=${Boolean(config.pixabayKey)}`);
    console.log(`  Model: ${config.xaiModel}`);
    console.log(`${backendLine}\n`);
  });
}
