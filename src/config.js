import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, '..');

export const config = {
  xaiKey: process.env.XAI_API_KEY || '',
  pexelsKey: process.env.PEXELS_API_KEY || '',
  pixabayKey: process.env.PIXABAY_API_KEY || '',
  jamendoClientId: process.env.JAMENDO_CLIENT_ID || '',
  xaiModel: process.env.XAI_MODEL || 'grok-4-latest',
  xaiBase: 'https://api.x.ai/v1',

  // --- AI talking-video mode (xAI Grok Imagine) ---
  // A SEPARATE generation path from the stock-footage pipeline: xAI generates the
  // actual video clips AND their speech/lip-sync from each scene prompt. Uses the
  // same XAI_API_KEY. The Imagine video API is a POST-then-poll endpoint (not
  // chat/completions). Endpoint path is configurable because xAI/proxies have
  // shipped it under a couple of routes — confirm yours in the xAI dashboard.
  xaiVideoModel: process.env.XAI_VIDEO_MODEL || 'grok-imagine-video',
  xaiVideoBase: process.env.XAI_VIDEO_BASE || 'https://api.x.ai/v1',
  // POST here to start a generation (returns { request_id }); POLL the SEPARATE
  // path below with that id (xAI uses GET /v1/videos/{request_id}, which drops
  // the "generations" segment — they are NOT the same path).
  xaiVideoPath: process.env.XAI_VIDEO_PATH || '/videos/generations',
  xaiVideoPollPath: process.env.XAI_VIDEO_POLL_PATH || '/videos',
  // How the poll URL carries the job id: 'path' → `${pollPath}/${id}` (default,
  // what xAI uses), 'query' → `${pollPath}?id=${id}` (some gateways).
  xaiVideoPollStyle: process.env.XAI_VIDEO_POLL_STYLE || 'path',
  // Output resolution for generated clips: 480p | 720p | 1080p.
  xaiVideoResolution: process.env.XAI_VIDEO_RESOLUTION || '720p',
  // Poll cadence + per-clip timeout (generation is async, ~30-120s/clip).
  xaiVideoPollMs: parseInt(process.env.XAI_VIDEO_POLL_MS || '6000', 10),
  xaiVideoTimeoutMs: parseInt(process.env.XAI_VIDEO_TIMEOUT_MS || '300000', 10),
  // How many scene clips to generate at once. Safe to overlap because every API
  // call (POST + poll) goes through a global rate gate below; concurrency just
  // overlaps the long waits, it does not burst the request rate.
  xaiVideoConcurrency: parseInt(process.env.XAI_VIDEO_CONCURRENCY || '3', 10),
  // Minimum spacing between ANY two xAI video requests, in ms. Lower tiers cap at
  // 1 request/second, so 1100ms keeps every POST + poll safely under it. Raise if
  // your team's RPS is below 1; lower it if you have a higher tier.
  xaiVideoMinIntervalMs: parseInt(process.env.XAI_VIDEO_MIN_INTERVAL_MS || '1100', 10),
  // Retries for a single scene's generation before the render gives up on it.
  xaiVideoRetries: parseInt(process.env.XAI_VIDEO_RETRIES || '2', 10),

  // LLM provider for scriptwriting/planning: 'xai' (default) | 'openrouter' | 'claude-code'.
  llmProvider: process.env.LLM_PROVIDER || 'xai',
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
  openrouterBase: process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1',
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  port: parseInt(process.env.PORT || '3000', 10),
  ttsEngine: process.env.TTS_ENGINE || 'edge-tts',

  // Job queue. With REDIS_URL set, renders/dubs/shorts are enqueued to a
  // BullMQ queue backed by Redis instead of an in-memory map, so a render
  // survives a server restart (the job persists; a worker re-runs it). Without
  // it, the in-memory path runs (single box, work lost if the process dies).
  redisUrl: process.env.REDIS_URL || '',
  // BullMQ queue name + key prefix (lets several apps share one Redis).
  queueName: process.env.QUEUE_NAME || 'griotvid',
  queuePrefix: process.env.QUEUE_PREFIX || 'griotvid',
  // How many jobs one worker runs at once. Renders are GPU/CPU-heavy, so 1 is
  // the safe default on a single box; raise it only with the cores to spare.
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '1', 10),
  // When Redis is on, also run a worker inside the web process (single-box
  // convenience, default on). Set WORKER_INLINE=0 to make the web server
  // enqueue-only and run `npm run worker` as a separate process (scale-out).
  workerInline: process.env.WORKER_INLINE !== '0',
  // SSE/poll cadence for reading job status (ms).
  jobPollMs: parseInt(process.env.JOB_POLL_MS || '400', 10),

  // Public origin a shared link should point at. Empty = derive from the request
  // host (localhost/LAN). Set this when the app is reached through a tunnel or a
  // real domain so the links a post carries resolve for other people.
  shareBaseUrl: process.env.SHARE_BASE_URL || '',

  // YarnGPT — hosted Nigerian-language TTS for Yoruba / Igbo / Hausa.
  yarnKey: process.env.YARN_API_KEY || '',
  yarnBase: process.env.YARN_BASE || 'https://yarngpt.ai/api/v1',
  // Max characters per YarnGPT request (their hard cap is 2000; stay under it).
  yarnMaxChars: parseInt(process.env.YARN_MAX_CHARS || '1800', 10),
  // YarnGPT is slow (~0.2s/char) but serves a SMALL parallel pool. Measured:
  // 4 concurrent requests finish together (~9s); 8 overwhelm it (~125s). So we
  // split the narration into ~yarnConcurrency sentence-aligned chunks and run
  // them in one parallel wave. yarnMinChunkChars floors the size so we don't
  // split mid-sentence on short text. Cuts a 60s single call to ~15-30s.
  yarnConcurrency: parseInt(process.env.YARN_CONCURRENCY || '4', 10),
  yarnMinChunkChars: parseInt(process.env.YARN_MIN_CHUNK_CHARS || '100', 10),
  // Per-request timeout so a stalled chunk can't hang the whole render.
  yarnTimeoutMs: parseInt(process.env.YARN_TIMEOUT_MS || '180000', 10),
  // YarnGPT 500s on transient auth/db blips ("An unexpected internal error
  // occurred."), so one bad chunk must not kill a whole render: retry transient
  // 5xx/429 with exponential backoff (base yarnBackoffMs, capped at 15s) before
  // giving up. Mirrors the xAI video 429 retry.
  yarnRetries: parseInt(process.env.YARN_RETRIES || '3', 10),
  yarnBackoffMs: parseInt(process.env.YARN_BACKOFF_MS || '800', 10),
  maxClips: parseInt(process.env.MAX_CLIPS || '12', 10),
  downloadTimeout: parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '30000', 10),

  // YouTube footage source. No API key needed — we shell out to yt-dlp for both
  // search (ytsearch) and download. Only a short opening SECTION is pulled per
  // clip (we trim later anyway) so a 30-minute source stays a ~2MB download.
  ytDlpBin: process.env.YTDLP_BIN || 'yt-dlp',
  // Seconds of footage to grab from the head of a YouTube video.
  youtubeSectionSeconds: parseInt(process.env.YOUTUBE_SECTION_SECONDS || '30', 10),
  // Max source height to pull. Output tops out at 1080 (9:16 = 1080x1920), so a
  // 1080p source needs no upscaling. The OLD format string forced progressive
  // mp4, which YouTube only serves at 360p — that was the "bad quality". We now
  // pull separate hi-res video + audio and merge, capped here.
  youtubeMaxHeight: parseInt(process.env.YOUTUBE_MAX_HEIGHT || '1080', 10),
  // Hard timeout for one yt-dlp download so a stuck pull can't hang a render.
  youtubeDownloadTimeout: parseInt(process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS || '90000', 10),
  // Timeout for one yt-dlp search.
  youtubeSearchTimeout: parseInt(process.env.YOUTUBE_SEARCH_TIMEOUT_MS || '25000', 10),
  // Skip clips bigger than this — we only use a few seconds, so a 75MB source is
  // pure download tax. Abort and try the next candidate instead.
  maxClipMb: parseInt(process.env.MAX_CLIP_MB || '35', 10),

  // ffmpeg encoder. 'auto' uses h264_nvenc when present (RTX GPU), else libx264 veryfast.
  encoder: process.env.VIDEO_ENCODER || 'auto',

  // Pacing: one scene per ~SCENE_SECONDS of narration. Fewer, longer scenes feel
  // less choppy and render faster (fewer downloads/encodes).
  secondsPerScene: parseInt(process.env.SCENE_SECONDS || '10', 10),
  maxScenes: parseInt(process.env.MAX_SCENES || '8', 10),
  // Script mode follows the user's own length, so allow more scenes than topic mode.
  maxScriptScenes: parseInt(process.env.MAX_SCRIPT_SCENES || '20', 10),
  // Per-phrase B-roll (#7): a scene longer than this many seconds is split into
  // multiple short shots so the picture changes more often (modern pacing).
  maxShotSeconds: parseInt(process.env.MAX_SHOT_SECONDS || '6', 10),
  // Scene transition crossfade length (#8). Each scene clip is normalized this
  // many seconds longer so the xfade overlap nets back to the intended cut times.
  transitionSeconds: parseFloat(process.env.TRANSITION_SECONDS || '0.4'),

  // --- Local AI video (free, runs on your own GPU via LTX-Video) ---
  // A third generation mode: an open video model generates SILENT clips locally
  // (zero per-render cost), and your existing free voiceover + captions ride on
  // top. Tuned for a 6GB card by default (small clips, CPU offload in the Python
  // worker); it is SLOW (minutes per clip). Raise the size knobs if you have more
  // VRAM. The Python worker lives in services/localvid/.
  localvidPython: process.env.LOCALVID_PYTHON || '/home/okhub/anaconda3/envs/tf_gpu/bin/python',
  localvidModel: process.env.LTX_MODEL || 'Lightricks/LTX-Video',
  // Short-side resolution the model generates at (divisible by 32). The render's
  // normalize step upscales to the real frame, so small here = less VRAM/time.
  localvidBase: parseInt(process.env.LOCALVID_BASE || '384', 10),
  localvidFps: parseInt(process.env.LOCALVID_FPS || '24', 10),
  // Frames per generated clip (must end up % 8 == 1; the worker coerces). 49 ≈ 2s.
  localvidMaxFrames: parseInt(process.env.LOCALVID_FRAMES || '49', 10),
  localvidSteps: parseInt(process.env.LOCALVID_STEPS || '30', 10),
  // One AI clip covers ~this many seconds of the video (kept near the clip length
  // so the freeze-pad tail stays short). Smaller = more clips = slower but livelier.
  localvidSecondsPerScene: parseInt(process.env.LOCALVID_SCENE_SECONDS || '4', 10),
  // Model load (first run downloads several GB) can be slow; per-clip is minutes.
  localvidReadyTimeoutMs: parseInt(process.env.LOCALVID_READY_TIMEOUT_MS || '900000', 10),
  localvidJobTimeoutMs: parseInt(process.env.LOCALVID_JOB_TIMEOUT_MS || '900000', 10),

  dirs: {
    raw: path.join(ROOT, 'assets', 'raw'),
    audio: path.join(ROOT, 'assets', 'audio'),
    output: path.join(ROOT, 'assets', 'output'),
    work: path.join(ROOT, 'assets', 'work'),
    // Editable timeline documents (one JSON per video). The render cache
    // (normalized scene clips, silent concat) lives in work/; voice in audio/.
    projects: path.join(ROOT, 'assets', 'projects'),
  },
};

// Resolution presets keyed by aspect ratio
export const RESOLUTIONS = {
  '16:9': { w: 1920, h: 1080, label: 'Landscape (YouTube)' },
  '9:16': { w: 1080, h: 1920, label: 'Vertical (Shorts/Reels/TikTok)' },
  '1:1': { w: 1080, h: 1080, label: 'Square (Feed)' },
};
