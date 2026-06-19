// AI talking-video mode (xAI Grok Imagine). A SEPARATE generation path from the
// stock-footage pipeline in pipeline.js: xAI generates the actual video clips AND
// their speech + lip-sync from each scene prompt. There is no neural-voiceover /
// stock-footage step here — the picture and the voice both come from xAI.
//
// Flow: plan (LLM writes spoken lines + shot descriptions + a consistent
// character) → generate one clip per scene via grok-video → fit each to the
// frame keeping its audio → concat → optional captions / brand / music → mp4.
//
// The pure pieces (buildScenePrompt, estDurationForLine, normalizeTalkingPlan)
// are gate-tested; processAiVideo is exercised by the opt-in paid smoke eval.

import path from 'path';
import fs from 'fs';
import { config, RESOLUTIONS } from './config.js';
import { llmChat } from './llm.js';
import { parseJsonLoose, splitScriptIntoScenes } from './xai.js';
import { generateVideoClip, downloadVideoClip } from './grok-video.js';
import { normalizeAvClip, concatAv, finalizeTalkingVideo } from './ffmpeg.js';
import { buildKaraokeAss } from './captions.js';
import { loadBrand } from './brand.js';
import { autoMusic } from './music.js';
import { probeDuration } from './voice.js';

// Roughly 2.5 spoken words/second; +1s of breathing room; clamped to the API's
// 1-15s clip window. Pure → gate-tested.
export function estDurationForLine(line, fallback = config.secondsPerScene) {
  const words = String(line || '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return Math.max(3, Math.min(15, fallback));
  return Math.max(3, Math.min(15, Math.round(words / 2.5) + 1));
}

// Aspect → a framing phrase for the video prompt. Pure.
function framingFor(aspect) {
  if (aspect === '9:16') return 'vertical 9:16 framing, subject centered';
  if (aspect === '1:1') return 'square 1:1 framing';
  return 'wide 16:9 framing';
}

/**
 * Build the text prompt sent to grok-imagine-video for ONE scene. The spoken line
 * goes INTO the prompt as dialogue (xAI speaks it and lip-syncs). The character
 * description is repeated verbatim every scene so the same presenter recurs (the
 * API has no audio-input, and reference-image consistency needs a public image
 * URL we don't have mid-render, so a fixed character description is the lever).
 * Pure → gate-tested.
 */
export function buildScenePrompt({ character, shot, line, tone = 'engaging', language = 'English', aspect = '9:16' }) {
  const who = character ? `${String(character).trim()}. ` : '';
  const setting = shot ? `${String(shot).trim()}. ` : '';
  const speech = line
    ? `The presenter looks at the camera and says, in ${language}: "${String(line).trim()}". `
    : '';
  return (
    `${who}${setting}${speech}` +
    `Cinematic, ${tone} short-form talking-head video. The presenter speaks the line clearly with natural, accurate lip-sync. ` +
    `Clean studio audio, single continuous take, ${framingFor(aspect)}, photorealistic, soft professional lighting.`
  ).replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a raw LLM plan into { title, character, scenes:[{index,line,shot,
 * durationSec}] }. Caps scene count, fills missing shots, recomputes each scene's
 * clip duration from its line length. Pure → gate-tested.
 */
export function normalizeTalkingPlan(parsed, { cap, fallbackTitle = 'AI Video', lines = null } = {}) {
  const character = String(parsed?.character || '').trim();
  const got = Array.isArray(parsed?.scenes) ? parsed.scenes : [];
  // Script mode supplies the verbatim lines; topic mode takes them from the LLM.
  const source = lines
    ? lines.map((line, i) => ({ line, shot: got[i]?.shot }))
    : got;
  const scenes = source.slice(0, cap).map((s, i) => {
    const line = String(s.line || '').trim();
    return {
      index: i + 1,
      line,
      shot: String(s.shot || '').trim(),
      durationSec: estDurationForLine(line),
    };
  }).filter((s) => s.line || s.shot);
  return {
    title: String(parsed?.title || fallbackTitle).trim() || fallbackTitle,
    character,
    scenes,
  };
}

/**
 * Plan a talking-presenter video. Topic mode: the LLM writes the spoken lines +
 * shots + a consistent character + title. Script mode: the user's words are kept
 * verbatim (chunked into scenes) and the LLM only adds shots + character + title.
 * Returns the normalized plan.
 */
export async function generateTalkingPlan({
  topic, script, context = 'global', language = 'English', tone = 'engaging', targetSeconds = 60, aspect = '9:16',
}) {
  const hasScript = Boolean(script && script.trim());
  const region = context === 'africa'
    ? 'The presenter and setting should read as African where it fits naturally.'
    : 'Keep the presenter and setting broadly relatable.';

  if (hasScript) {
    const wordsPerScene = Math.max(12, Math.round(config.secondsPerScene * 2.5));
    let segments = splitScriptIntoScenes(script, wordsPerScene);
    if (segments.length === 0) throw new Error('script is empty');
    const cap = config.maxScriptScenes;
    if (segments.length > cap) {
      const head = segments.slice(0, cap - 1);
      head.push(segments.slice(cap - 1).join(' '));
      segments = head;
    }
    const sys = `You are directing a TALKING-PRESENTER video where one on-camera narrator delivers the user's script to the camera. Output ONLY valid JSON. No markdown. You DO NOT rewrite or translate the narration.
Give ONE \`character\` description (English): the narrator's age, look, clothing, setting and lighting, consistent for EVERY scene so the same person appears throughout.
For each numbered segment give a \`shot\` (English, concrete, cinematic): the framing/setting/action behind the presenter as they speak that line.
${region}`;
    const list = segments.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const user = `Spoken segments (in ${language}):\n${list}\n
Return JSON exactly:
{ "title": "short title", "character": "english description of the recurring presenter", "scenes": [ { "index": 1, "shot": "english shot description" } ] }
Give exactly ${segments.length} shots, in order.`;

    let parsed = {};
    try {
      parsed = parseJsonLoose(await llmChat(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        { temperature: 0.6, jsonMode: true },
      ));
    } catch { parsed = {}; }
    return normalizeTalkingPlan(parsed, { cap, fallbackTitle: 'My Script', lines: segments });
  }

  const sceneCount = Math.max(3, Math.min(config.maxScenes, Math.round(targetSeconds / config.secondsPerScene)));
  const wordsPerScene = Math.round(config.secondsPerScene * 2.5);
  const sys = `You are an award-winning director of TALKING-PRESENTER short-form videos: one charismatic on-camera narrator speaks to the camera across the whole piece. Output ONLY valid JSON. No markdown.
Write every \`line\` (the spoken narration) in natural, fluent ${language}${language.toLowerCase() === 'english' ? '' : ' — idiomatic, not word-for-word from English; spell out numbers/dates as words'}.
Give ONE \`character\` description (English): the narrator's age, look, clothing, setting and lighting, kept consistent across EVERY scene so the same person appears throughout.
For each scene give a \`shot\` (English, concrete, cinematic) describing the framing/setting/action behind the presenter.
Arc: hook → build → payoff → memorable closing line. Keep each \`line\` to about ${wordsPerScene} words so it fits a ${config.secondsPerScene}-second clip.
${region}`;
  const user = `Topic: "${topic}"
Tone: ${tone}.
Return JSON exactly:
{
  "title": "string",
  "character": "english description of the recurring presenter",
  "scenes": [ { "index": 1, "line": "spoken narration in ${language}", "shot": "english shot description" } ]
}
Make exactly ${sceneCount} scenes.`;

  const parsed = parseJsonLoose(await llmChat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0.9, jsonMode: true },
  ));
  return normalizeTalkingPlan(parsed, { cap: config.maxScenes, fallbackTitle: topic || 'AI Video' });
}

// Run `fn` over `items` with at most `limit` in flight, preserving order. Local
// copy (pipeline.js#mapLimit is private) so this module stands alone.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Generate one scene's clip with retries, downloading it to the work dir. Throws
// a scene-named error if every attempt fails (a talking video with a hole in it
// is not the product).
async function generateScene({ scene, id, prompt, aspect, onPoll }) {
  const dest = path.join(config.dirs.work, `${id}_s${scene.index}.mp4`);
  let lastErr;
  for (let attempt = 1; attempt <= Math.max(1, config.xaiVideoRetries); attempt++) {
    try {
      const url = await generateVideoClip(
        { prompt, aspect, duration: scene.durationSec, resolution: config.xaiVideoResolution },
        { onPoll },
      );
      await downloadVideoClip(url, dest);
      return dest;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`scene ${scene.index} failed to generate: ${lastErr?.message || lastErr}`);
}

/**
 * The topic/script → AI talking-video pipeline. Pure work + progress via ctx;
 * returns the render result and throws on failure (the runner/worker records
 * it). Registered as the 'ai-video' processor, so it runs identically on the
 * in-memory and Redis backends.
 */
export async function processAiVideo(opts, ctx) {
  const id = ctx.id;
  const {
    topic, script, context = 'global', aspect = '9:16', targetSeconds = 60, tone = 'engaging',
    language = 'English', subtitles = false, fades = true, autoMusic: wantMusic = false,
    captionStyle = {}, resolution = config.xaiVideoResolution,
  } = opts;

  if (!config.xaiKey) throw new Error('XAI_API_KEY is not set');
  if (!RESOLUTIONS[aspect]) throw new Error(`unsupported aspect: ${aspect}`);

  // 1. Plan: spoken lines + shots + a consistent presenter.
  ctx.emit('planning', `Writing the talking-video script (${language})…`, 5);
  const plan = await generateTalkingPlan({ topic, script, context, language, tone, targetSeconds, aspect });
  if (!plan.scenes.length) throw new Error('planning produced no scenes');
  ctx.setPlan(plan);
  const n = plan.scenes.length;
  ctx.emit('planning', `Plan ready: "${plan.title}" — ${n} scenes`, 12);

  // 2. Generate one clip per scene (xAI makes the picture AND the speech), with
  // bounded concurrency so several clips render at once without tripping the rate
  // limit. Estimated cost surfaced up front so the bill is never a surprise.
  const totalSec = plan.scenes.reduce((a, s) => a + s.durationSec, 0);
  const perSec = resolution === '1080p' ? 0.10 : resolution === '480p' ? 0.05 : 0.07;
  ctx.emit('generate', `Generating ${n} AI clips (${totalSec}s, ~$${(totalSec * perSec).toFixed(2)} at ${resolution})…`, 16);

  let done = 0;
  const clips = await mapLimit(plan.scenes, config.xaiVideoConcurrency, async (scene) => {
    const prompt = buildScenePrompt({ character: plan.character, shot: scene.shot, line: scene.line, tone, language, aspect });
    scene.prompt = prompt;
    const raw = await generateScene({
      scene, id, prompt, aspect,
      onPoll: (status) => ctx.emit('generate', `Scene ${scene.index}/${n}: ${status}…`, 16 + Math.round((done / n) * 55)),
    });
    // Fit to the frame, keeping the generated audio + lip-sync untouched.
    const norm = await normalizeAvClip({ input: raw, outBase: `${id}_s${scene.index}`, aspect });
    const realDur = await probeDuration(norm);
    done += 1;
    ctx.emit('generate', `Scene ${scene.index}/${n} ready`, 16 + Math.round((done / n) * 55));
    return { norm, realDur: realDur || scene.durationSec, line: scene.line };
  });

  // 3. Caption cues from each clip's real duration (whole spoken line per scene —
  // we don't get word-level timings back from the video API).
  let captionsPath = null;
  let captionCues = null;
  if (subtitles) {
    let t = 0;
    const cues = [];
    for (const c of clips) {
      if (c.line) cues.push({ start: t, end: t + c.realDur, text: c.line });
      t += c.realDur;
    }
    if (cues.length) {
      captionCues = cues;
      captionsPath = buildKaraokeAss({
        cues, aspect, style: captionStyle, assPath: path.join(config.dirs.audio, `${id}_vo.ass`),
      });
    }
  }

  // 4. Optional background-music bed, ducked under the speech in the final pass.
  let bgMusic = null;
  let musicMeta = null;
  if (wantMusic) {
    ctx.emit('render', 'Finding background music…', 74);
    const picked = await autoMusic({ tone, minSeconds: totalSec, base: id });
    if (picked) { bgMusic = picked.path; musicMeta = picked.meta; }
  }

  // 5. Stitch the talking clips (audio preserved), then the final pass: captions,
  // ducked music, fades, brand logo.
  ctx.emit('render', 'Stitching scenes…', 80);
  const avConcat = await concatAv({ files: clips.map((c) => c.norm), outBase: id });

  const brand = loadBrand();
  ctx.emit('render', 'Rendering final video…', 90);
  const finalPath = await finalizeTalkingVideo({
    avVideo: avConcat, captions: captionsPath, bgMusic, aspect, fades,
    outName: `${id}_final.mp4`, logo: brand.logoPath, logoPosition: brand.logoPosition, logoScale: brand.logoScale,
  });

  ctx.emit('done', 'AI video complete', 100);
  return {
    file: path.basename(finalPath),
    path: finalPath,
    kind: 'ai-video',
    projectId: null, // talking video isn't an editable stock-scene project
    title: plan.title,
    language,
    music: musicMeta,
    captions: captionCues ? captionCues.length : 0,
    scenes: plan.scenes.map((s) => ({ index: s.index, line: s.line, shot: s.shot, durationSec: s.durationSec })),
  };
}
