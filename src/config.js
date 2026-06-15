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

  // LLM provider for scriptwriting/planning: 'xai' (default) | 'openrouter' | 'claude-code'.
  llmProvider: process.env.LLM_PROVIDER || 'xai',
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
  openrouterBase: process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1',
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  port: parseInt(process.env.PORT || '3000', 10),
  ttsEngine: process.env.TTS_ENGINE || 'edge-tts',

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
  maxClips: parseInt(process.env.MAX_CLIPS || '12', 10),
  downloadTimeout: parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '30000', 10),
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
