// Dub-an-existing-video (#2): translate a transcript into a target language for
// voiceover. The translation goes through the project's pluggable LLM (Grok /
// OpenRouter / local Claude Code) — never a hosted ASR/translate API. The prompt
// builder and output cleaner are pure (gate-tested); the network call is thin.

import { llmChat } from './llm.js';
import { languageNote } from './xai.js';

/**
 * Build the translate-for-dub prompt. Reuses languageNote so the target language
 * gets the same native-writing + clean-TTS rules the scriptwriter uses (numbers
 * spelled out, diacritics kept, Pidgin code-switching preserved). Pure.
 */
export function buildDubPrompt(text, targetLanguage) {
  const note = languageNote(targetLanguage);
  const system =
    `You are a professional video dubber. Translate the user's transcript into ${targetLanguage} ` +
    'for a natural-sounding voiceover. Preserve meaning, tone and energy; make it fluent and idiomatic, ' +
    'NOT word-for-word. Output ONLY the translated narration text — no commentary, no quotes, no labels.\n' +
    note;
  const user = `Transcript to dub into ${targetLanguage}:\n\n${text}`;
  return { system, user };
}

/** Strip stray fences/quotes/labels an LLM may wrap the translation in. Pure. */
export function cleanDubText(raw) {
  return String(raw || '')
    .replace(/```[a-z]*/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*(translation|narration)\s*:\s*/i, '')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
}

/** Translate a transcript into the target language for dubbing. */
export async function translateForDub(text, targetLanguage) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('dub: nothing to translate');
  const { system, user } = buildDubPrompt(clean, targetLanguage);
  const raw = await llmChat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { temperature: 0.4 });
  const out = cleanDubText(raw);
  if (!out) throw new Error('dub: empty translation');
  return out;
}
