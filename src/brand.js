// Brand kit (#10): one persisted identity — logo, colors, intro/outro — applied
// to every video so a creator's output is consistent without re-choosing it each
// time (CapCut Pro charges for this). Stored as a single JSON beside the projects.
// normalizeBrand is pure (gate-tested); load/save touch disk.

import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const clampSec = (v, def, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};
const hexOr = (v, def) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : def);

export const DEFAULT_BRAND = {
  name: '',
  logoPath: null,                       // absolute path to an uploaded logo image, or null
  primaryColor: '#E8B04B',              // warm gold (GriotVid identity)
  accentColor: '#1A1206',
  cardColors: ['#1A1206', '#3A2A0C'],   // gradient for generated cards (#6)
  captionPrimary: null,                 // spoken-word colour (#RRGGBB) or null = engine default
  captionSecondary: null,               // upcoming-word colour or null
  intro: { enabled: false, text: '', seconds: 2 },
  outro: { enabled: false, text: '', seconds: 2.5 },
};

/** Merge a partial brand over the defaults, validating/ clamping every field. Pure. */
export function normalizeBrand(input = {}) {
  const b = input || {};
  const cc = Array.isArray(b.cardColors) ? b.cardColors : [];
  const intro = b.intro || {};
  const outro = b.outro || {};
  return {
    name: String(b.name || '').slice(0, 60),
    logoPath: b.logoPath ? String(b.logoPath) : null,
    primaryColor: hexOr(b.primaryColor, DEFAULT_BRAND.primaryColor),
    accentColor: hexOr(b.accentColor, DEFAULT_BRAND.accentColor),
    cardColors: [hexOr(cc[0], DEFAULT_BRAND.cardColors[0]), hexOr(cc[1], DEFAULT_BRAND.cardColors[1])],
    captionPrimary: b.captionPrimary ? hexOr(b.captionPrimary, null) : null,
    captionSecondary: b.captionSecondary ? hexOr(b.captionSecondary, null) : null,
    intro: { enabled: Boolean(intro.enabled), text: String(intro.text || '').slice(0, 80), seconds: clampSec(intro.seconds, 2, 0.8, 6) },
    outro: { enabled: Boolean(outro.enabled), text: String(outro.text || '').slice(0, 80), seconds: clampSec(outro.seconds, 2.5, 0.8, 8) },
  };
}

function brandPath() {
  return path.join(config.dirs.projects, '_brand.json');
}

export function loadBrand() {
  try {
    const raw = fs.readFileSync(brandPath(), 'utf8');
    return normalizeBrand(JSON.parse(raw));
  } catch {
    return normalizeBrand({});
  }
}

export function saveBrand(input) {
  const b = normalizeBrand(input);
  fs.mkdirSync(config.dirs.projects, { recursive: true });
  fs.writeFileSync(brandPath(), JSON.stringify(b, null, 2), 'utf8');
  return b;
}

/** True if this brand has anything worth applying (so we can skip work otherwise). */
export function brandActive(b) {
  return Boolean(b && (b.logoPath || b.intro?.enabled || b.outro?.enabled || b.captionPrimary || (b.name && (b.intro?.enabled || b.outro?.enabled))));
}
