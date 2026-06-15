// Pure helpers for the generated-card fallback (#6). When no stock clip can be
// found for a scene, we render a branded text card instead of failing the whole
// render. These functions decide WHAT the card says and how it looks; ffmpeg.js
// turns that into a clip. Deterministic → unit-tested in the offline gate.

// Default gradient palettes (hex pairs, top→bottom). Warm gold/amber to match the
// GriotVid identity, cycled by scene index so consecutive cards differ. A brand
// kit can override c0/c1 (see #10).
export const CARD_PALETTES = [
  ['#1a1206', '#3a2a0c'],
  ['#2a1606', '#5a3a10'],
  ['#0d1a14', '#163a2a'],
  ['#1a0d14', '#3a1630'],
  ['#0d1420', '#16304a'],
];

export function cardPalette(index = 0, brand = null) {
  if (brand && brand.cardColors && brand.cardColors.length >= 2) return [brand.cardColors[0], brand.cardColors[1]];
  const p = CARD_PALETTES[((index % CARD_PALETTES.length) + CARD_PALETTES.length) % CARD_PALETTES.length];
  return [p[0], p[1]];
}

/**
 * The short phrase a fallback card shows. Prefer a trimmed slice of the scene's
 * own narration (so it's in the video's language); fall back to the English
 * query, then a generic mark. Keeps it to a few words — a card is a title, not a
 * paragraph. Pure.
 */
export function distillCardText({ narration = '', query = '', maxWords = 7, fallback = '✦' } = {}) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const fromNarr = clean(narration).replace(/[.!?…]+$/g, '');
  if (fromNarr) {
    const words = fromNarr.split(' ').slice(0, maxWords);
    return words.join(' ');
  }
  const q = clean(query);
  if (q) return q.split(' ').slice(0, maxWords).join(' ');
  return fallback;
}

/**
 * Wrap text into lines of at most `maxChars`, breaking on spaces, so drawtext
 * renders centered multi-line text that fits the frame. Returns the text with
 * embedded newlines. Never splits a word; a single over-long word stays whole.
 * Pure.
 */
export function wrapText(text, maxChars = 22) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return '';
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

// Characters-per-line target by aspect (portrait is narrower → wrap sooner).
export function cardWrapWidth(aspect) {
  if (aspect === '9:16') return 16;
  if (aspect === '1:1') return 20;
  return 26;
}
