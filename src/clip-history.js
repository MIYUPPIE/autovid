import fs from 'fs';
import path from 'path';
import { config } from './config.js';

// Recently-used clip keys are remembered between renders so the footage selector
// can float them to the back and pull fresh clips instead. The file lives in the
// work cache dir (gitignored) — it's only a hint, safe to delete at any time.
//
// Resolved per-call (not cached at import) so a test can point config.dirs.work at
// a temp folder before exercising it.
function historyFile() {
  return path.join(config.dirs.work, 'clip-history.json');
}

// How many recent clip keys to remember. Big enough to span several renders, small
// enough that a niche topic with few clips eventually frees them for reuse.
export const MAX_HISTORY = 240;

function readKeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(raw) ? raw.filter((k) => typeof k === 'string' && k) : [];
  } catch {
    return []; // missing/corrupt → start empty
  }
}

// Clip keys used by recent renders, as a Set for O(1) lookup during ranking.
export function loadRecentClips() {
  return new Set(readKeys());
}

/**
 * Append the clips a render actually used. Newest wins (moved to the end), the
 * list is de-duped and capped to MAX_HISTORY (oldest dropped first). Best-effort:
 * a write failure must never break a render, so errors are swallowed.
 */
export function recordUsedClips(keys) {
  const fresh = [...new Set((keys || []).filter((k) => typeof k === 'string' && k))];
  if (!fresh.length) return;
  const kept = readKeys().filter((k) => !fresh.includes(k));
  const merged = [...kept, ...fresh].slice(-MAX_HISTORY);
  try {
    fs.mkdirSync(config.dirs.work, { recursive: true });
    fs.writeFileSync(historyFile(), JSON.stringify(merged));
  } catch {
    /* a history write must never fail a render */
  }
}

// Forget every remembered clip (test/maintenance helper).
export function clearClipHistory() {
  try { fs.unlinkSync(historyFile()); } catch { /* already gone */ }
}
