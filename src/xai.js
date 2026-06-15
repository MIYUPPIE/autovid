import { config } from './config.js';
import { llmChat } from './llm.js';

// All planning calls go through the pluggable provider (xAI / OpenRouter /
// local Claude Code). `xaiChat` is kept as a thin alias so the call sites and
// their meaning stay unchanged.
const xaiChat = (messages, opts) => llmChat(messages, opts);

/**
 * Strip markdown fences and parse JSON safely.
 */
export function parseJsonLoose(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  // Grab the outermost JSON object if there is preamble
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(slice);
}

// Is this the (English-based, code-switching) Nigerian Pidgin pseudo-language?
function isPidgin(language) {
  return /pidgin/i.test(language || '');
}

/**
 * The language-specific writing + TTS-pronunciation instruction block shared by
 * every planner. Three regimes:
 *  - English → plain English.
 *  - Nigerian Pidgin → English-based creole; KEEP its natural English/Yoruba/Igbo
 *    code-switching (telling it to "avoid loanwords" would break Pidgin).
 *  - any other language → write natively, spell numbers out, keep diacritics.
 * `codeSwitch` optionally asks any language to mix in natural English the way
 * real speakers do (e.g. Yoruba sprinkled with English) — off by default.
 */
export function languageNote(language = 'English', { codeSwitch = false } = {}) {
  if (isPidgin(language)) {
    return `Write EVERY "narration", "hook", "outro" and "title" in natural NIGERIAN PIDGIN — the way people actually talk on the street in Lagos. It is an English-based creole, so KEEP its natural code-switching (English with sprinkles of Yoruba/Igbo/Hausa) and Pidgin grammar (e.g. "dey", "na", "wetin", "abeg", "make we"). Do NOT write standard English; do NOT translate stiffly.
- Spell out numbers and years as words.
IMPORTANT: keep every "query" field in ENGLISH (they are stock-footage search terms for Pexels/Pixabay).`;
  }
  const nonEnglish = language && language.toLowerCase() !== 'english';
  if (!nonEnglish) {
    const cs = codeSwitch ? ' You may sprinkle in natural English words the way real bilingual speakers do.' : '';
    return `Write all narration in natural, vivid English.${cs}`;
  }
  const cs = codeSwitch
    ? `\n- Code-switch naturally: mix in common English words/phrases where a real bilingual ${language} speaker would, but keep the sentence grammar ${language}.`
    : '';
  return `Write EVERY "narration", the "hook", the "outro" and the "title" in ${language} — natural, fluent, idiomatic ${language} as a native speaker would say it. Do NOT translate word-for-word from English; write it natively.
For clean text-to-speech pronunciation in ${language}:
- Spell out ALL numbers, years and dates as ${language} words (never digits like "1829").
- Use correct ${language} spelling and tone/diacritic marks throughout.
- Avoid English/Latin loanwords, abbreviations, acronyms and symbols; write them out in ${language}.${cs}
IMPORTANT: keep every "query" field in ENGLISH (they are stock-footage search terms for Pexels/Pixabay).`;
}

/**
 * Generate a full video plan from a topic.
 * Returns { title, hook, scenes: [{ index, narration, query, durationSec }], outro }
 * Each scene's `query` is a stock-footage search term; `narration` is voiceover text.
 */
export async function generateVideoPlan({ topic, context, targetSeconds = 60, tone = 'engaging', language = 'English', codeSwitch = false }) {
  const regionNote =
    context === 'africa'
      ? 'The audience and framing are African. Prefer culturally relevant references and stock-footage queries that return African scenes, people, and settings where appropriate.'
      : 'The audience is global/international. Keep references broadly relatable.';

  // Fewer, longer scenes → less choppy and faster to render.
  const sceneCount = Math.max(3, Math.min(config.maxScenes, Math.round(targetSeconds / config.secondsPerScene)));

  const langNote = languageNote(language, { codeSwitch });

  const sys = `You are an award-winning short-form video director and scriptwriter.
You output ONLY valid JSON. No markdown, no commentary.
${regionNote}
${langNote}

Craft for impact, not filler:
- Open with a HOOK that creates curiosity or tension in the first 3 seconds.
- Give the piece a narrative arc: hook → build → payoff → memorable closing line.
- Every scene earns its place; vary the rhythm (some punchy, some reflective). No repetition, no clichés.
- Make it feel like ONE flowing story read by a single narrator, not disconnected sentences.

Pacing: about ${targetSeconds} seconds total across ${sceneCount} scenes (~${config.secondsPerScene}s each), roughly 2.5 spoken words per second.
Stock-footage queries must be concrete, cinematic, 2-5 words, and likely to return results on Pexels/Pixabay (e.g. "aerial city sunrise", "hands counting money").`;

  const user = `Topic: "${topic}"
Tone: ${tone}.
Produce a JSON object with this exact shape:
{
  "title": "string",
  "hook": "one-sentence opening narration that grabs attention",
  "scenes": [
    { "index": 1, "narration": "voiceover text for this scene", "query": "english stock footage search term", "durationSec": ${config.secondsPerScene} }
  ],
  "outro": "closing line that lands the message"
}
Make exactly ${sceneCount} scenes. Ensure durations sum to about ${targetSeconds}.`;

  const raw = await xaiChat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { temperature: 0.9, jsonMode: true }
  );

  const plan = parseJsonLoose(raw);

  // Normalize / guard
  plan.scenes = (plan.scenes || []).slice(0, config.maxScenes).map((s, i) => ({
    index: i + 1,
    narration: String(s.narration || '').trim(),
    query: String(s.query || topic).trim(),
    durationSec: Math.max(2, Math.min(20, Number(s.durationSec) || config.secondsPerScene)),
  }));

  return plan;
}

/**
 * Bilingual plan: each scene line is written in BOTH languages so it can be
 * spoken first in `language` then in `language2`. Returns scenes with
 * { narration (lang A), narration2 (lang B), query (English), durationSec }.
 */
export async function generateBilingualPlan({ topic, context, targetSeconds = 60, tone = 'engaging', language, language2 }) {
  const sceneCount = Math.max(3, Math.min(config.maxScenes, Math.round(targetSeconds / config.secondsPerScene)));
  const regionNote = context === 'africa'
    ? 'African audience and framing; queries should return African scenes/people where it fits.'
    : 'Global audience; keep references broadly relatable.';

  const sys = `You are an award-winning short-form video scriptwriter producing a BILINGUAL script.
You output ONLY valid JSON. No markdown.
${regionNote}
For each scene write the SAME idea twice: once in ${language} ("line_a") and once in ${language2} ("line_b") as a natural, fluent translation (not word-for-word). Give the video a hook → build → payoff arc.
For clean text-to-speech in both languages: spell out ALL numbers and dates as words in each language; use correct spelling and diacritics/tone marks; avoid English/Latin loanwords, acronyms and symbols.
Each scene also needs an ENGLISH stock-footage "query" (2-5 words, concrete and cinematic).`;

  const user = `Topic: "${topic}"
Tone: ${tone}.
Produce JSON exactly:
{
  "title": "short title in ${language}",
  "scenes": [
    { "index": 1, "line_a": "${language} narration", "line_b": "${language2} translation", "query": "english footage query", "durationSec": ${config.secondsPerScene} }
  ]
}
Make exactly ${sceneCount} scenes. Durations should sum to about ${targetSeconds}.`;

  const raw = await xaiChat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0.85, jsonMode: true },
  );
  const parsed = parseJsonLoose(raw);

  const scenes = (parsed.scenes || []).slice(0, config.maxScenes).map((s, i) => ({
    index: i + 1,
    narration: String(s.line_a || '').trim(),
    narration2: String(s.line_b || '').trim(),
    query: String(s.query || topic).trim(),
    durationSec: Math.max(2, Math.min(20, Number(s.durationSec) || config.secondsPerScene)),
  })).filter((s) => s.narration && s.narration2);

  if (scenes.length === 0) throw new Error('bilingual plan came back empty');
  return { title: String(parsed.title || topic).trim(), hook: '', outro: '', scenes, bilingual: true };
}

/**
 * Split a user-supplied script into scene-sized chunks WITHOUT changing the words.
 * Sentences are packed greedily to ~`wordsPerScene` words each.
 */
export function splitScriptIntoScenes(script, wordsPerScene) {
  const text = String(script || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const sentences = text.match(/[^.!?…]+[.!?…]*/g) || [text];
  const scenes = [];
  let cur = '';
  let curWords = 0;
  for (const sRaw of sentences) {
    const s = sRaw.trim();
    if (!s) continue;
    const w = s.split(/\s+/).length;
    if (curWords > 0 && curWords + w > wordsPerScene) {
      scenes.push(cur.trim());
      cur = s;
      curWords = w;
    } else {
      cur = cur ? `${cur} ${s}` : s;
      curWords += w;
    }
  }
  if (cur.trim()) scenes.push(cur.trim());
  return scenes;
}

/**
 * Bilingual plan from the USER'S OWN script. The script is chunked into scenes;
 * each chunk is rendered in BOTH languages — kept faithful to the user's wording
 * in whichever language it's already written, translated naturally into the other.
 * Returns scenes with { narration (lang A), narration2 (lang B), query }.
 */
export async function planBilingualFromScript({ script, context, language, language2 }) {
  const wordsPerScene = Math.max(12, Math.round(config.secondsPerScene * 2.5));
  let segments = splitScriptIntoScenes(script, wordsPerScene);
  if (segments.length === 0) throw new Error('script is empty');
  const cap = config.maxScriptScenes;
  if (segments.length > cap) {
    const head = segments.slice(0, cap - 1);
    head.push(segments.slice(cap - 1).join(' '));
    segments = head;
  }

  const sys = `You localize a user's script into a BILINGUAL video. Output ONLY valid JSON. No markdown.
For each numbered segment, give its text in ${language} ("line_a") and in ${language2} ("line_b").
If a segment is already written in ${language} or ${language2}, keep that language faithful to the user's exact wording; produce the OTHER language as a natural, fluent translation (not word-for-word).
For clean text-to-speech: spell out ALL numbers, years and dates as words in each language; use correct spelling and diacritics/tone marks; avoid English/Latin loanwords, acronyms and symbols in non-English text.
Also give an ENGLISH stock-footage "query" (2-5 words, concrete and cinematic) for each segment.
${context === 'africa' ? 'Bias queries toward African scenes/people/settings where it fits.' : ''}`;

  const list = segments.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const user = `Segments:\n${list}\n
Return JSON exactly:
{ "title": "short title", "scenes": [ { "index": 1, "line_a": "${language} text", "line_b": "${language2} text", "query": "english query" } ] }
Give exactly ${segments.length} scenes, in order.`;

  let parsed = {};
  try {
    const raw = await xaiChat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { temperature: 0.5, jsonMode: true },
    );
    parsed = parseJsonLoose(raw);
  } catch {
    parsed = {};
  }
  const got = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scenes = segments.map((seg, i) => {
    const g = got[i] || {};
    return {
      index: i + 1,
      narration: String(g.line_a || '').trim(),
      narration2: String(g.line_b || '').trim(),
      query: String(g.query || seg.split(/\s+/).slice(0, 4).join(' ')).trim(),
      durationSec: config.secondsPerScene,
    };
  }).filter((s) => s.narration && s.narration2);

  if (scenes.length === 0) throw new Error('bilingual script localization came back empty');
  return { title: String(parsed.title || 'My Script').trim(), hook: '', outro: '', scenes, bilingual: true, fromScript: true };
}

/**
 * Build a plan from the USER'S OWN script. The narration is taken verbatim
 * (chunked into scenes); Grok only supplies an English stock-footage query for
 * each chunk plus a title. Returns the same shape as generateVideoPlan, with
 * hook/outro empty (the script already contains its own opening/closing).
 */
export async function planFromScript({ script, context, language = 'English' }) {
  const wordsPerScene = Math.max(12, Math.round(config.secondsPerScene * 2.5));
  let segments = splitScriptIntoScenes(script, wordsPerScene);
  if (segments.length === 0) throw new Error('script is empty');
  // Cap scene count (each scene is a download+encode); merge the tail if needed.
  const cap = config.maxScriptScenes;
  if (segments.length > cap) {
    const head = segments.slice(0, cap - 1);
    head.push(segments.slice(cap - 1).join(' '));
    segments = head;
  }

  const sys = `You are a video director planning visuals for a narration the user wrote.
You output ONLY valid JSON. No markdown. You DO NOT rewrite or translate the narration.
For each numbered narration segment, give ONE concrete, cinematic English stock-footage
search query (2-5 words) likely to return results on Pexels/Pixabay.
${context === 'africa' ? 'Bias queries toward African scenes/people/settings where it fits.' : 'Keep queries broadly relatable.'}
The narration may be in ${language}; your queries must still be in ENGLISH.`;

  const list = segments.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const user = `Narration segments:\n${list}\n
Return JSON exactly:
{ "title": "short english title for the video", "queries": ["query for segment 1", "query for segment 2", ...] }
Give exactly ${segments.length} queries, in order.`;

  let parsed = {};
  try {
    const raw = await xaiChat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { temperature: 0.7, jsonMode: true },
    );
    parsed = parseJsonLoose(raw);
  } catch {
    parsed = {};
  }
  const queries = Array.isArray(parsed.queries) ? parsed.queries : [];

  const scenes = segments.map((seg, i) => ({
    index: i + 1,
    narration: seg, // verbatim — the user's words
    query: String(queries[i] || seg.split(/\s+/).slice(0, 4).join(' ')).trim(),
    durationSec: config.secondsPerScene,
  }));

  return {
    title: String(parsed.title || 'My Script').trim(),
    hook: '',
    outro: '',
    scenes,
    fromScript: true,
  };
}

/**
 * Given a scene that returned no footage, ask Grok for alternative queries.
 */
export async function suggestAlternativeQueries(originalQuery, context) {
  const raw = await xaiChat(
    [
      {
        role: 'system',
        content: 'You output ONLY a JSON array of 4 short alternative stock-footage search queries (2-4 words each).',
      },
      {
        role: 'user',
        content: `Original query "${originalQuery}" returned no results. Context: ${context}. Give 4 broader/alternative visual queries as a JSON array of strings.`,
      },
    ],
    { temperature: 0.9 }
  );
  try {
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? arr.slice(0, 4) : [];
  } catch {
    return [];
  }
}
