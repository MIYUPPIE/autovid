// Editor support: map absolute asset paths to browser URLs and back.
//
// The project doc stores absolute filesystem paths (source clips, voice track,
// music). The live-preview editor needs to load those over HTTP, so each asset
// dir is mounted static under a stable /media/<dir> prefix and this module is
// the single, pure, testable translation between a path and its URL. Keeping it
// here (no fs, no express) means the contract is unit-tested offline and both
// the static mounts and the preview endpoint agree on the scheme.

import path from 'path';
import fs from 'fs';
import { config } from './config.js';

// dir-key → absolute asset dir. The URL prefix is /media/<key>.
export const MEDIA_DIRS = {
  raw: config.dirs.raw,
  work: config.dirs.work,
  audio: config.dirs.audio,
  output: config.dirs.output,
};

// Absolute asset path → "/media/<key>/<basename>", or null if the path is not
// inside one of the known asset dirs (the guard that keeps /media from leaking
// arbitrary files).
export function assetToUrl(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  const resolved = path.resolve(absPath);
  for (const [key, dir] of Object.entries(MEDIA_DIRS)) {
    const root = path.resolve(dir) + path.sep;
    if (resolved.startsWith(root)) {
      return `/media/${key}/${encodeURIComponent(path.basename(resolved))}`;
    }
  }
  return null;
}

// True if an absolute path sits inside an allowed asset dir. Used to guard any
// endpoint that streams a path the client supplied.
export function isAllowedAsset(absPath) {
  return assetToUrl(absPath) !== null;
}

/**
 * Resolve a stored asset path to a real file under the current asset roots.
 * Project docs store absolute paths from render time; if the project dir was
 * later moved/renamed/copied (so the stored prefix no longer matches), fall back
 * to the same basename inside each media dir. Returns an existing path under a
 * media root, or null. This is what lets the editor open projects rendered
 * elsewhere as long as their assets were carried along.
 */
export function resolveAssetPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  // Already a real file under a known root → use it as-is.
  if (assetToUrl(absPath) && fs.existsSync(absPath)) return path.resolve(absPath);
  const name = path.basename(absPath);
  for (const dir of Object.values(MEDIA_DIRS)) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Resolve a stored asset path to its browser URL (with the moved-dir fallback).
export function assetUrlFor(absPath) {
  return assetToUrl(resolveAssetPath(absPath));
}

/**
 * Project doc → the media bundle the live preview needs: per-scene source URLs,
 * the voice track URL, music URL, and the timeline geometry. Pure: it only reads
 * the doc and maps paths. Scenes with a missing/foreign source get sourceUrl:null
 * (the UI shows a placeholder and offers a footage swap).
 */
export function previewBundle(project) {
  return {
    id: project.id,
    aspect: project.aspect,
    fps: project.fps || 30,
    duration: project.duration || 0,
    title: project.title || '',
    voiceUrl: assetUrlFor(project.audio?.voiceTrack?.path),
    voiceDuration: project.audio?.voiceTrack?.duration || 0,
    music: project.audio?.music
      ? { url: assetUrlFor(project.audio.music.path), volume: project.audio.music.volume, meta: project.audio.music.meta || null }
      : null,
    captions: {
      enabled: project.captions?.enabled !== false && (project.captions?.cues?.length > 0),
      cues: project.captions?.cues || [],
      style: project.captions?.style || {},
    },
    effects: project.effects || {},
    scenes: (project.scenes || []).map((s) => ({
      index: s.index,
      narration: s.narration || '',
      query: s.usedQuery || s.query || '',
      start: s.start,
      duration: s.duration,
      motion: s.motion !== false,
      trim: s.trim || null,
      sourceUrl: assetUrlFor(s.source?.path),
      hasSource: Boolean(resolveAssetPath(s.source?.path)),
    })),
  };
}
