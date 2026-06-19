// xAI Grok Imagine video client. SEPARATE from src/llm.js (which is text-only
// chat/completions): the Imagine video API is a POST-then-poll media endpoint.
// You POST a generation request, get a job id, then GET the job until it's done
// and download the resulting mp4 (which already contains xAI-generated speech +
// lip-sync — there is NO field to upload your own audio, so this mode does not
// use GriotVid's neural voiceover).
//
// The pure builders/parsers (buildVideoRequest, readVideoStatus, extractJobId,
// pollUrl, clamps) are gate-tested with zero network. generateVideoClip injects
// its fetch + sleep so the queued→generating→completed state machine is tested
// offline too. Endpoint path/poll-style are config-driven (xAI and proxies have
// shipped this under a couple of routes), so a route change is a .env edit.

import fetch from 'node-fetch';
import { config } from './config.js';
import { pickAgent, downloadToFile } from './http.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Our aspect preset → the API's aspect_ratio enum. Pure.
export function aspectToRatio(aspect) {
  if (aspect === '9:16') return '9:16';
  if (aspect === '1:1') return '1:1';
  return '16:9';
}

// Clamp a clip duration to the API's 1-15s window. Pure.
export function clampDuration(sec, fallback = 10) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(15, Math.round(n)));
}

// Resolution enum guard. Pure.
export function normalizeResolution(r) {
  return ['480p', '720p', '1080p'].includes(r) ? r : '720p';
}

// Build the generation request body. Pure → gate-tested. Per xAI's REST spec the
// image inputs are OBJECTS ({ url } or { file_id }), not bare url strings.
export function buildVideoRequest({
  prompt, model, imageUrl = null, referenceImages = null, duration, aspect, resolution,
}) {
  const body = {
    model: model || config.xaiVideoModel,
    prompt: String(prompt || '').trim(),
    duration: clampDuration(duration),
    aspect_ratio: aspectToRatio(aspect),
    resolution: normalizeResolution(resolution || config.xaiVideoResolution),
  };
  if (imageUrl) body.image = { url: imageUrl };
  if (Array.isArray(referenceImages) && referenceImages.length) {
    body.reference_images = referenceImages.slice(0, 7).map((r) => (typeof r === 'string' ? { url: r } : r));
  }
  return body;
}

// Pull the job id out of a creation response, tolerant of field naming across
// xAI revisions / gateway proxies. Pure.
export function extractJobId(data) {
  return (
    data?.id || data?.request_id || data?.generation_id ||
    data?.data?.id || data?.video?.id || data?.result?.id || null
  );
}

// Normalize a poll/creation response into { status, url, error } where status is
// 'queued' | 'generating' | 'completed' | 'error'. Tolerant of field naming so a
// gateway tweak doesn't silently hang the poll loop. Pure → gate-tested.
export function readVideoStatus(data) {
  const raw = String(data?.status || data?.state || data?.data?.status || '').toLowerCase();
  const url =
    data?.video?.url || data?.url || data?.output?.url ||
    data?.data?.url || data?.data?.video?.url || data?.result?.url ||
    (Array.isArray(data?.assets) && data.assets[0] && (data.assets[0].url || data.assets[0])) ||
    (Array.isArray(data?.output) && data.output[0]) ||
    (Array.isArray(data?.data) && data.data[0] && data.data[0].url) ||
    null;
  const err =
    (data?.error && (data.error.message || data.error)) ||
    data?.failure_reason || data?.failureReason || null;

  const done = ['completed', 'complete', 'done', 'succeeded', 'success', 'ready', 'finished'];
  const failed = ['failed', 'error', 'errored', 'canceled', 'cancelled', 'rejected'];

  if (done.includes(raw) || (!raw && url)) {
    return url
      ? { status: 'completed', url, error: null }
      : { status: 'error', url: null, error: err || 'reported done but returned no video url' };
  }
  if (failed.includes(raw)) {
    return { status: 'error', url: null, error: err || `generation ${raw}` };
  }
  if (['generating', 'processing', 'running', 'in_progress', 'in-progress', 'started', 'pending'].includes(raw)) {
    return { status: 'generating', url: null, error: null };
  }
  return { status: 'queued', url: null, error: null };
}

// Build the poll URL for a job id. Pure (config-driven). `pollPath` is the poll
// route (xAI: /videos), which is NOT the generation route (/videos/generations).
// Default appends the id to the path; XAI_VIDEO_POLL_STYLE=query uses `?id=`.
export function pollUrl(base, pollPath, id, style = config.xaiVideoPollStyle) {
  const root = `${base}${pollPath}`;
  return style === 'query'
    ? `${root}?id=${encodeURIComponent(id)}`
    : `${root}/${encodeURIComponent(id)}`;
}

async function readJson(res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  return { data, text };
}

async function postGeneration(url, body, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.xaiKey}` },
    body: JSON.stringify(body),
    agent: pickAgent,
  });
  const { data, text } = await readJson(res);
  if (!res.ok) throw new Error(`xAI video API ${res.status}: ${text.slice(0, 400)}`);
  return data;
}

async function getGeneration(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${config.xaiKey}` },
    agent: pickAgent,
  });
  const { data, text } = await readJson(res);
  if (!res.ok) throw new Error(`xAI video poll ${res.status}: ${text.slice(0, 400)}`);
  return data;
}

/**
 * Generate ONE clip end to end: POST the request, then poll until the video is
 * ready, returning its URL. `fetchImpl`/`sleepImpl` are injected so the whole
 * state machine is unit-tested offline. Throws a clear error on API failure or
 * timeout.
 */
export async function generateVideoClip(req, {
  fetchImpl = fetch,
  sleepImpl = sleep,
  pollMs = config.xaiVideoPollMs,
  timeoutMs = config.xaiVideoTimeoutMs,
  onPoll = null,
} = {}) {
  if (!config.xaiKey) throw new Error('XAI_API_KEY is not set');
  const base = config.xaiVideoBase;
  const pathName = config.xaiVideoPath;
  const body = buildVideoRequest(req);

  const created = await postGeneration(`${base}${pathName}`, body, fetchImpl);

  // Some deployments return the finished clip on the POST itself.
  const immediate = readVideoStatus(created);
  if (immediate.status === 'completed') return immediate.url;
  if (immediate.status === 'error') throw new Error(`xAI video failed: ${immediate.error}`);

  const id = extractJobId(created);
  if (!id) throw new Error(`xAI video: no job id in response: ${JSON.stringify(created).slice(0, 300)}`);

  const deadline = Date.now() + timeoutMs;
  let last = 'queued';
  while (Date.now() < deadline) {
    await sleepImpl(pollMs);
    const data = await getGeneration(pollUrl(base, config.xaiVideoPollPath, id), fetchImpl);
    const st = readVideoStatus(data);
    last = st.status;
    if (onPoll) onPoll(st.status);
    if (st.status === 'completed') return st.url;
    if (st.status === 'error') throw new Error(`xAI video failed: ${st.error}`);
  }
  throw new Error(`xAI video timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${last})`);
}

/** Download a finished clip to `dest`. Returns the path. */
export async function downloadVideoClip(url, dest) {
  return downloadToFile(url, dest, { idleTimeout: 60000, attempts: 3, minBytes: 1024 });
}
