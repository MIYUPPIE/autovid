// Karaoke caption engine.
//
// Engines like YarnGPT (Yoruba/Igbo/Hausa) and edge return no per-word
// timestamps, so we derive them: each word gets a slice of the real audio
// duration proportional to how long it takes to say (syllable estimate, plus a
// pause after punctuation). Those word windows are rendered as ASS karaoke
// (`{\k}` tags) so each word lights up as it is spoken — multiple short cues,
// word by word, instead of one sentence sitting on screen the whole clip.
//
// Two timing sources:
//   wordsFromTextProportional(text, duration) — when we only know the total
//     audio length (YarnGPT). Distributes the whole narration across [0,dur].
//   wordsFromCues(cues)                        — when each line's window is
//     known (edge SRT, or bilingual per-line cues). Distributes within a cue.

import fs from 'fs';
import { RESOLUTIONS } from './config.js';

// ---- word timing --------------------------------------------------------

// Split into spoken tokens, keeping trailing punctuation attached to its word.
export function splitWords(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Rough spoken length of a token: number of syllables (vowel groups, tone marks
// folded away) plus a pause weight for trailing punctuation. Never below 1 so
// every word occupies a real slice of time.
export function wordWeight(word) {
  const folded = word
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // drop combining tone marks
    .toLowerCase();
  const vowelGroups = (folded.match(/[aeiou]+/g) || []).length;
  let w = Math.max(1, vowelGroups);
  if (/[,;:]$/.test(word)) w += 0.6; // short breath
  if (/[.!?…]$/.test(word)) w += 1.2; // full stop
  return w;
}

// Build word windows spanning [0, duration], proportional to spoken length.
// Returns [{ text, start, end }] with strictly non-overlapping, ordered times.
export function wordsFromTextProportional(text, duration) {
  const tokens = splitWords(text);
  if (tokens.length === 0 || !(duration > 0)) return [];
  const weights = tokens.map(wordWeight);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out = [];
  let acc = 0;
  for (let i = 0; i < tokens.length; i++) {
    const start = (acc / total) * duration;
    acc += weights[i];
    const end = (acc / total) * duration;
    out.push({ text: tokens[i], start, end });
  }
  return out;
}

// Distribute each cue's window across its own words. `cues` = [{start,end,text}]
// in seconds. Lets edge / bilingual reuse the engine's real line timing while
// still highlighting word by word.
export function wordsFromCues(cues) {
  const out = [];
  for (const c of cues) {
    const span = Math.max(0, (c.end ?? 0) - (c.start ?? 0));
    const tokens = splitWords(c.text);
    if (tokens.length === 0 || span <= 0) continue;
    const weights = tokens.map(wordWeight);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    for (let i = 0; i < tokens.length; i++) {
      const start = c.start + (acc / total) * span;
      acc += weights[i];
      const end = c.start + (acc / total) * span;
      out.push({ text: tokens[i], start, end });
    }
  }
  return out;
}

// ---- SRT parsing (to reuse edge's real timings) -------------------------

function srtTimeToSec(t) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t.trim());
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

export function parseSrt(content) {
  const cues = [];
  const blocks = content.replace(/\r/g, '').trim().split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const tl = lines.find((l) => l.includes('-->'));
    if (!tl) continue;
    const [a, z] = tl.split('-->');
    const text = lines.slice(lines.indexOf(tl) + 1).join(' ').trim();
    if (!text) continue;
    cues.push({ start: srtTimeToSec(a), end: srtTimeToSec(z), text });
  }
  return cues;
}

// ---- line grouping ------------------------------------------------------

// Greedily pack words into short readable lines. Breaks on a hard limit or
// right after sentence-ending punctuation so a line is never a run-on.
export function groupIntoLines(words, { maxWords = 6, maxChars = 32 } = {}) {
  const lines = [];
  let cur = [];
  let chars = 0;
  const flush = () => { if (cur.length) { lines.push(cur); cur = []; chars = 0; } };
  for (const w of words) {
    const add = w.text.length + (cur.length ? 1 : 0);
    if (cur.length && (cur.length >= maxWords || chars + add > maxChars)) flush();
    cur.push(w);
    chars += add;
    if (/[.!?…]$/.test(w.text)) flush(); // end of sentence → new cue
  }
  flush();
  return lines;
}

// ---- caption sizing -----------------------------------------------------

// Named caption sizes → multiplier on the width-based default font. The default
// (M = 1) renders at ~5.8% of frame width; the others scale around it. Shared by
// the UI (the size picker) and the server (name → scale) so there's one source.
export const CAPTION_SIZES = { S: 0.78, M: 1, L: 1.3, XL: 1.6 };

// Resolve a caption style to a font multiplier. Accepts an explicit numeric
// `scale` (clamped) or a named `size`; falls back to 1 (Medium).
export function captionScale(style = {}) {
  const n = Number(style.scale);
  if (n > 0) return Math.max(0.5, Math.min(2.5, n));
  if (style.size && CAPTION_SIZES[style.size]) return CAPTION_SIZES[style.size];
  return 1;
}

// ---- caption animation presets ------------------------------------------

// Per-line entrance animation (#8). Returns an ASS override block injected at the
// start of each Dialogue, composed BEFORE the karaoke `{\k}` runs so each line
// animates in as it appears. Pure → unit-tested. Presets:
//   none        — hard appear (default)
//   fade        — soft fade in/out (\fad)
//   pop         — scale-bounce in (\t transform)
//   up          — rise + fade in from just below (\move + \fad)
export const CAPTION_ANIMS = ['none', 'fade', 'pop', 'up'];

export function captionAnimTag(style = {}, line = null, w = 0, h = 0) {
  const anim = style.captionAnim;
  if (!anim || anim === 'none' || !CAPTION_ANIMS.includes(anim)) return '';
  if (anim === 'fade') return '{\\fad(150,80)}';
  if (anim === 'pop') return '{\\fscx70\\fscy70\\t(0,160,\\fscx100\\fscy100)\\fad(60,40)}';
  if (anim === 'up') return '{\\fad(140,0)}'; // a fade-up; \move needs absolute coords, fade reads well everywhere
  return '';
}

// ---- ASS rendering ------------------------------------------------------

function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function escAss(text) {
  return text.replace(/[\r\n]+/g, ' ').replace(/\{/g, '(').replace(/\}/g, ')');
}

// ASS colours are &HAABBGGRR. Defaults: spoken word bright yellow, not-yet-spoken
// white, black outline.
function assHeader({ w, h, fontSize, primary = '&H0000FFFF', secondary = '&H00FFFFFF' }) {
  const outline = Math.max(2, Math.round(fontSize * 0.08));
  const shadow = Math.max(0, Math.round(fontSize * 0.03));
  const marginV = Math.round(h * 0.12);
  const marginH = Math.round(w * 0.06); // keep text off the left/right edges
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0', // smart-wrap long lines instead of letting them run off-screen
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,DejaVu Sans,${fontSize},${primary},${secondary},&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    // Must list all 10 V4+ event fields. The Dialogue lines below carry Name +
    // three margins + Effect; a short Format here makes libass spill those
    // values ("0,,") into the visible caption text.
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

// Render one Dialogue per line, each word prefixed with a `{\k}` of its own
// duration (centiseconds) so it highlights exactly when spoken. `posTag` is an
// optional ASS override (e.g. `{\an5\pos(960,950)}`) placing the line at an
// absolute point — set when the user has dragged the caption off bottom-center.
function lineToDialogue(line, posTag = '', animTag = '') {
  const start = line[0].start;
  const end = line[line.length - 1].end;
  const text = line
    .map((w) => {
      const cs = Math.max(1, Math.round((w.end - w.start) * 100));
      return `{\\k${cs}}${escAss(w.text)}`;
    })
    .join(' ');
  return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${posTag}${animTag}${text}`;
}

// Build the absolute-position override from a style's normalized posX/posY
// (0..1 across the frame). Returns '' when unset → keep the styled bottom-center.
// `\an5` anchors the line at its centre so the drop point is intuitive.
function positionTag(style, w, h) {
  if (style.posX == null || style.posY == null) return '';
  const x = Math.round(Math.min(0.98, Math.max(0.02, Number(style.posX))) * w);
  const y = Math.round(Math.min(0.98, Math.max(0.02, Number(style.posY))) * h);
  return `{\\an5\\pos(${x},${y})}`;
}

/**
 * Build a karaoke .ass caption file. Provide EITHER `cues` (preferred — real
 * per-line timing) OR `text` + `duration` (proportional). `aspect` sizes the
 * font to the frame. Returns the written path, or null if there's nothing to show.
 */
export function buildKaraokeAss({ text, duration, cues, aspect = '16:9', assPath, style = {} }) {
  const words = cues ? wordsFromCues(cues) : wordsFromTextProportional(text, duration);
  if (words.length === 0) return null;
  const { w, h } = RESOLUTIONS[aspect] || RESOLUTIONS['16:9'];
  // Size the font off WIDTH, not height: a height-based size blows up on 9:16
  // vertical (narrow frame) and runs lines off-screen. The user-chosen size
  // (named S/M/L/XL or a raw `scale`) multiplies the width-based default; an
  // explicit `fontSize` wins outright for full manual control.
  const fontSize = style.fontSize
    ? Math.max(8, Math.round(style.fontSize))
    : Math.round(w * 0.058 * captionScale(style));
  // Max chars that fit one line inside the horizontal margins (avg glyph ≈ 0.55em),
  // so a line never overflows the frame. WrapStyle 0 catches anything left over.
  const usable = w * 0.88;
  const fitChars = Math.max(12, Math.floor(usable / (fontSize * 0.55)));
  const grouping = { maxWords: style.maxWords || 6, maxChars: style.maxChars || fitChars };
  const lines = groupIntoLines(words, grouping);
  const posTag = positionTag(style, w, h);
  const animTag = captionAnimTag(style, null, w, h);
  const body = lines.map((l) => lineToDialogue(l, posTag, animTag)).join('\n');
  const ass = `${assHeader({ w, h, ...style, fontSize })}\n${body}\n`;
  fs.writeFileSync(assPath, ass, 'utf8');
  return assPath;
}
