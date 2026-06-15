import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { config, RESOLUTIONS } from './config.js';
import { probeDuration } from './voice.js';
import { cardPalette, distillCardText, wrapText, cardWrapWidth } from './cards.js';

const execFileP = promisify(execFile);

// Locate a usable bold TTF for drawtext (the generated-card fallback). Cached.
let _cardFont = null;
function cardFontFile() {
  if (_cardFont !== null) return _cardFont;
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  ];
  _cardFont = candidates.find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || '';
  return _cardFont;
}

async function ffmpeg(args, label = 'ffmpeg') {
  try {
    await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    throw new Error(`${label} failed: ${err.stderr || err.message}`);
  }
}

// Detect the best available H.264 encoder once. nvenc (GPU) is far faster than x264.
let _encoder = null;
async function detectEncoder() {
  if (_encoder) return _encoder;
  if (config.encoder && config.encoder !== 'auto') {
    _encoder = config.encoder;
    return _encoder;
  }
  try {
    const { stdout } = await execFileP('ffmpeg', ['-hide_banner', '-encoders']);
    _encoder = stdout.includes('h264_nvenc') ? 'h264_nvenc' : 'libx264';
  } catch {
    _encoder = 'libx264';
  }
  return _encoder;
}

// Encoder-specific quality/speed flags for a video output.
async function videoCodecArgs() {
  const enc = await detectEncoder();
  if (enc === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21'];
}

/**
 * Build the video filter that fits a clip to the frame, optionally with a slow
 * Ken Burns move (alternating zoom-in / zoom-out by scene index) for life.
 */
function fitFilter({ w, h, fps, motion, index }) {
  const base = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}`;
  if (!motion) return `${base},format=yuv420p`;
  const zoomIn = `z='min(zoom+0.0010,1.15)'`;
  const zoomOut = `z='if(eq(on,0),1.15,max(zoom-0.0010,1.0))'`;
  const z = index % 2 === 0 ? zoomIn : zoomOut;
  const pan = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  return `${base},zoompan=${z}:d=1:${pan}:s=${w}x${h}:fps=${fps},format=yuv420p`;
}

/**
 * Normalize a raw clip to the target frame and exact duration, no audio.
 * Short clips are looped (stock B-roll) OR, when `freeze` is set, played once and
 * held on their last frame (a dub/source video: looping a real shot under one
 * continuous voiceover looks broken). Applies optional Ken Burns motion. Returns
 * the silent file.
 */
export async function normalizeClip({ input, outBase, aspect, targetDur, fps = 30, motion = true, index = 0, trim = null, freeze = false }) {
  const { w, h } = RESOLUTIONS[aspect] || RESOLUTIONS['16:9'];
  const out = path.join(config.dirs.work, `${outBase}_norm.mp4`);
  const srcDur = await probeDuration(input);

  // Optional editor trim: take [in, out] from the source before fitting. After a
  // trim the usable length is (out - in), so that, not the raw file, decides
  // whether we still need to loop/hold to cover targetDur.
  const seek = trim && Number(trim.in) > 0 ? Number(trim.in) : 0;
  const trimLen = trim && Number(trim.out) > seek ? Number(trim.out) - seek : (srcDur ? srcDur - seek : null);
  const short = trimLen != null && trimLen < targetDur;

  const args = [];
  if (short && !freeze) args.push('-stream_loop', '-1'); // loop short/trimmed stock clips
  if (seek > 0) args.push('-ss', seek.toFixed(3));
  let vf = fitFilter({ w, h, fps, motion, index });
  // freeze: clone the final frame to fill the rest of targetDur instead of
  // looping; `-t` below caps the held tail. Cheap and never restarts the shot.
  if (short && freeze) vf += ',tpad=stop=-1:stop_mode=clone';
  args.push('-i', input, '-t', targetDur.toFixed(3), '-an',
    '-vf', vf,
    ...(await videoCodecArgs()), '-pix_fmt', 'yuv420p', out);

  await ffmpeg(args, 'normalizeClip');
  return out;
}

/** Probe a video's pixel dimensions via ffprobe. Returns { w, h } (0 on failure). */
export async function probeSize(input) {
  try {
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', input]);
    const [w, h] = stdout.trim().split('x').map((n) => parseInt(n, 10));
    return { w: w || 0, h: h || 0 };
  } catch { return { w: 0, h: 0 }; }
}

/** Map raw pixel dimensions to the nearest supported aspect preset. Pure. */
export function nearestAspect(w, h) {
  if (!w || !h) return '16:9';
  const r = w / h;
  if (r < 0.85) return '9:16';
  if (r > 1.2) return '16:9';
  return '1:1';
}

/**
 * Cut one vertical (or any-aspect) SHORT from a long video (#9): trim [start,end],
 * scale/crop to the frame, burn captions, KEEP the original audio. Writes to the
 * output dir. Returns the path. Caption cues must be retimed to the window start
 * (see transcribe.windowCues) since `-ss start -i` resets timestamps to 0.
 */
export async function makeShort({ input, start, end, aspect = '9:16', captions = null, outName }) {
  const { w, h } = RESOLUTIONS[aspect] || RESOLUTIONS['9:16'];
  const out = path.join(config.dirs.output, outName);
  const dur = Math.max(0.5, end - start);
  const vchain = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`, 'setsar=1',
  ];
  if (captions && fs.existsSync(captions)) vchain.push(captionFilter(captions, h));
  vchain.push('format=yuv420p');
  await ffmpeg(['-ss', start.toFixed(3), '-i', input, '-t', dur.toFixed(3),
    '-vf', vchain.join(','), ...(await videoCodecArgs()),
    '-c:a', 'aac', '-b:a', '160k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], 'makeShort');
  return out;
}

/**
 * Pad an audio track with leading/trailing silence (#10 intro/outro bookends), so
 * the branded cards have time to play while the voice timeline stays one piece.
 * Returns the new path (or the input unchanged when no padding is asked).
 */
export async function padAudio({ input, outBase, lead = 0, trail = 0 }) {
  if (lead <= 0 && trail <= 0) return input;
  const out = path.join(config.dirs.audio, `${outBase}_pad.mp3`);
  const chain = [];
  if (lead > 0) chain.push(`adelay=${Math.round(lead * 1000)}:all=1`);
  if (trail > 0) chain.push(`apad=pad_dur=${trail.toFixed(3)}`);
  await ffmpeg(['-i', input, '-af', chain.join(','), '-ac', '2', '-ar', '44100',
    '-c:a', 'libmp3lame', '-q:a', '4', out], 'padAudio');
  return out;
}

/** Extract an audio track (mp3) from a video for transcription. Returns the path. */
export async function extractAudio({ input, outBase }) {
  const out = path.join(config.dirs.audio, `${outBase}_src.mp3`);
  await ffmpeg(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-q:a', '5', out], 'extractAudio');
  return out;
}

/**
 * Render a branded TEXT CARD as a scene clip when no stock footage could be
 * found (#6). Guarantees a render never dies on a single dead query: instead of
 * throwing "no usable footage", the scene becomes a clean gradient card showing
 * a short phrase from the narration. Same output contract as normalizeClip (a
 * silent, frame-sized, exact-duration mp4) so the concat is unchanged.
 */
export async function makeTextCard({
  narration = '', query = '', outBase, aspect, targetDur, fps = 30, index = 0, brand = null,
}) {
  const { w, h } = RESOLUTIONS[aspect] || RESOLUTIONS['16:9'];
  const out = path.join(config.dirs.work, `${outBase}_norm.mp4`);
  const [c0, c1] = cardPalette(index, brand);
  const phrase = wrapText(distillCardText({ narration, query }), cardWrapWidth(aspect));

  // Write the (possibly multi-line, unicode) text to a file so drawtext doesn't
  // need shell-escaping of diacritics, colons, quotes etc.
  const txtFile = path.join(config.dirs.work, `${outBase}_card.txt`);
  fs.writeFileSync(txtFile, phrase, 'utf8');

  const fontSize = Math.round(w * (aspect === '9:16' ? 0.07 : 0.055));
  const font = cardFontFile();
  const fontArg = font ? `fontfile='${escapeFilterPath(font)}'` : 'font=sans';
  const draw =
    `drawtext=${fontArg}:textfile='${escapeFilterPath(txtFile)}':` +
    `fontcolor=white:fontsize=${fontSize}:line_spacing=${Math.round(fontSize * 0.35)}:` +
    'x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.6:shadowx=2:shadowy=2';

  // gradients lavfi gives a soft moving background (cheap, no source clip needed).
  const grad = `gradients=s=${w}x${h}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${w}:y1=${h}:d=${targetDur.toFixed(3)}:speed=0.012`;
  await ffmpeg(['-f', 'lavfi', '-i', grad, '-t', targetDur.toFixed(3), '-an',
    '-vf', `${draw},fps=${fps},format=yuv420p`, ...(await videoCodecArgs()), '-pix_fmt', 'yuv420p', out],
    'makeTextCard');

  try { fs.unlinkSync(txtFile); } catch { /* ignore */ }
  return out;
}

// Supported scene transitions (#8) → the ffmpeg xfade transition name. 'cut' is
// the plain hard-cut concat (no xfade, the fast stream-copy path).
export const TRANSITIONS = {
  cut: null, fade: 'fade', slideleft: 'slideleft', slideright: 'slideright',
  wipeleft: 'wipeleft', wiperight: 'wiperight', circleopen: 'circleopen', dissolve: 'dissolve',
};

/**
 * Build the xfade filter_complex graph that crossfades a sequence of clips whose
 * (already extended) durations are `clipDurs`. Pure so the offset math is unit-
 * tested. Each xfade overlaps its two inputs by `dur`, so the cut lands at the end
 * of the previous clip's intended (un-extended) time. Returns:
 *   { filter, label, totalDur } — label is the final video pad to map.
 * For a single clip there is no transition: filter is '' and label is '[0:v]'.
 */
export function buildXfadeGraph(clipDurs, { transition = 'fade', dur = 0.4 } = {}) {
  const n = clipDurs.length;
  if (n <= 1) return { filter: '', label: '[0:v]', totalDur: clipDurs[0] || 0 };
  const parts = [];
  let prev = '[0:v]';
  let offset = 0;
  for (let i = 1; i < n; i++) {
    // offset_i = offset_{i-1} + clipDurs[i-1] - dur  (offset_1 = clipDurs[0] - dur)
    offset = i === 1 ? clipDurs[0] - dur : offset + clipDurs[i - 1] - dur;
    const out = i === n - 1 ? '[vx]' : `[vx${i}]`;
    parts.push(`${prev}[${i}:v]xfade=transition=${transition}:duration=${dur}:offset=${Math.max(0, offset).toFixed(3)}${out}`);
    prev = out;
  }
  const totalDur = clipDurs.reduce((a, b) => a + b, 0) - dur * (n - 1);
  return { filter: parts.join(';'), label: '[vx]', totalDur };
}

/**
 * Concatenate scene clips with a crossfade transition between each (#8). Re-
 * encodes (xfade can't stream-copy). `clipDurs` are the clips' real durations
 * (each normalized `dur` seconds longer than its scene so the overlap nets out).
 * Falls back to a hard-cut concat for a single clip. Returns the silent file.
 */
export async function concatWithTransitions({ sceneFiles, clipDurs, outBase, transition = 'fade', dur = 0.4 }) {
  const name = TRANSITIONS[transition] || 'fade';
  if (sceneFiles.length <= 1) return concatSilent({ sceneFiles, outBase });
  const graph = buildXfadeGraph(clipDurs, { transition: name, dur });
  const out = path.join(config.dirs.work, `${outBase}_silent.mp4`);
  const inputs = sceneFiles.flatMap((f) => ['-i', f]);
  const fc = `${graph.filter};${graph.label}format=yuv420p[vout]`;
  await ffmpeg([...inputs, '-filter_complex', fc,
    '-map', '[vout]', ...(await videoCodecArgs()), '-pix_fmt', 'yuv420p', '-an', out], 'concatWithTransitions');
  return out;
}

/**
 * Concatenate silent, identically-encoded scene clips. Stream-copy when possible
 * (no re-encode → fast); falls back to re-encode if copy fails. Returns silent file.
 */
export async function concatSilent({ sceneFiles, outBase }) {
  const listPath = path.join(config.dirs.work, `${outBase}_list.txt`);
  fs.writeFileSync(listPath, sceneFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const out = path.join(config.dirs.work, `${outBase}_silent.mp4`);
  try {
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out], 'concatSilent(copy)');
  } catch {
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, ...(await videoCodecArgs()),
      '-pix_fmt', 'yuv420p', out], 'concatSilent(reencode)');
  }
  return out;
}

/**
 * Concatenate spoken lines (possibly from different TTS engines / sample rates)
 * into one master voice track, padding each line with a trailing gap. Returns
 * { path, duration, cues } where cues mark each line's speech window for subtitles.
 *
 * `lines`: [{ audioPath, text, gapAfter }] in playback order.
 */
export async function assembleVoiceTrack({ lines, outBase }) {
  const norm = []; // re-encoded, gap-padded, uniform-format pieces
  const cues = [];
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const d = await probeDuration(ln.audioPath);
    const piece = path.join(config.dirs.audio, `${outBase}_part${i}.mp3`);
    // Uniform format + trailing silence so a plain concat is seamless.
    await ffmpeg(['-i', ln.audioPath, '-af', `aresample=44100,apad=pad_dur=${ln.gapAfter}`,
      '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '4', piece], 'assembleVoiceTrack(part)');
    norm.push(piece);
    if (ln.text) cues.push({ start: t, end: t + d, text: ln.text });
    t += d + ln.gapAfter;
  }

  const listPath = path.join(config.dirs.audio, `${outBase}_voicelist.txt`);
  fs.writeFileSync(listPath, norm.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const out = path.join(config.dirs.audio, `${outBase}_voice.mp3`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out], 'assembleVoiceTrack(concat)');

  for (const p of norm) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  const duration = await probeDuration(out);
  return { path: out, duration, cues };
}

// Escape a path for use inside an ffmpeg lavfi filter argument.
function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// Burn captions. ASS files (karaoke, fully self-styled) use the `ass` filter;
// plain SRT falls back to `subtitles` with a readable default style.
function captionFilter(file, h) {
  const escaped = escapeFilterPath(file);
  if (/\.ass$/i.test(file)) return `ass='${escaped}'`;
  const style =
    'FontName=DejaVu Sans,FontSize=18,PrimaryColour=&H00FFFFFF,' +
    'OutlineColour=&H80000000,BorderStyle=1,Outline=2,Shadow=0,' +
    `Alignment=2,MarginV=${Math.round(h * 0.06)}`;
  return `subtitles='${escaped}':force_style='${style}'`;
}

/**
 * Extract `count` evenly-spaced thumbnail frames from `input` across the window
 * [start, start+length] (defaults to the whole clip). Used by the editor's
 * filmstrip + trim handles. Returns the written jpg paths in time order. Cheap:
 * one fast keyframe seek per frame, scaled small. Skips frames already on disk
 * so re-opening a scene is instant.
 */
export async function extractThumbs({ input, outBase, count = 8, start = 0, length = null, height = 96 }) {
  const dur = length || (await probeDuration(input)) || 0;
  const n = Math.max(1, Math.min(24, Math.round(count)));
  const step = n > 1 ? dur / n : 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = start + step * i + step / 2;            // sample the middle of each slice
    const file = path.join(config.dirs.work, `${outBase}_t${i}.jpg`);
    if (!fs.existsSync(file)) {
      // -ss before -i = fast keyframe seek; -frames:v 1 = a single frame.
      await ffmpeg(['-ss', Math.max(0, t).toFixed(3), '-i', input, '-frames:v', '1',
        '-vf', `scale=-2:${height}`, '-q:v', '4', file], 'extractThumbs');
    }
    out.push(file);
  }
  return out;
}

/**
 * Compute a waveform: `buckets` peak amplitudes (0..1) of an audio file, so the
 * editor can draw the narration and align cuts to the voice. Decodes to low-rate
 * mono PCM on stdout and takes the max |sample| per bucket. No temp files.
 */
export async function extractWaveform({ input, buckets = 800 }) {
  const { stdout } = await execFileP('ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { maxBuffer: 1024 * 1024 * 128, encoding: 'buffer' });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const n = Math.max(1, Math.min(4000, Math.round(buckets)));
  const per = Math.max(1, Math.floor(samples.length / n));
  const peaks = new Array(n).fill(0);
  for (let b = 0; b < n; b++) {
    let max = 0;
    const s = b * per, e = Math.min(samples.length, s + per);
    for (let i = s; i < e; i++) { const a = Math.abs(samples[i]); if (a > max) max = a; }
    peaks[b] = Math.round((max / 32768) * 1000) / 1000;
  }
  return peaks;
}

/**
 * Single final pass: lay the ONE continuous narration over the silent video,
 * mix ducked background music, burn subtitles, add fades. Returns final mp4.
 */
export async function finalizeVideo({
  silentVideo, voiceAudio, captions = null, bgMusic = null, musicVolume = 0.12,
  aspect, fades = true, outName, logo = null,
}) {
  const { w, h } = RESOLUTIONS[aspect] || RESOLUTIONS['16:9'];
  const out = path.join(config.dirs.output, outName);
  const dur = await probeDuration(voiceAudio);

  const inputs = ['-i', silentVideo, '-i', voiceAudio];
  const vChain = [];
  if (captions && fs.existsSync(captions)) vChain.push(captionFilter(captions, h));
  if (fades) {
    vChain.push('fade=t=in:st=0:d=0.6', `fade=t=out:st=${Math.max(0, dur - 0.6).toFixed(2)}:d=0.6`);
  }

  const parts = [];
  const hasLogo = logo && fs.existsSync(logo);
  // Build the base video, then (if branded) overlay the logo bottom-right (#10).
  const baseLabel = hasLogo ? '[vbase]' : '[vout]';
  parts.push(`[0:v]${vChain.length ? vChain.join(',') : 'copy'}${baseLabel}`);

  let aMap = '1:a';
  if (bgMusic && fs.existsSync(bgMusic)) {
    inputs.push('-stream_loop', '-1', '-i', bgMusic);
    parts.push(`[2:a]volume=${musicVolume}[bg]`);
    parts.push('[1:a]asplit=2[vc][sc]');
    parts.push('[bg][sc]sidechaincompress=threshold=0.03:ratio=12:attack=20:release=400[bgduck]');
    parts.push('[vc][bgduck]amix=inputs=2:duration=first:dropout_transition=0[amix]');
    aMap = '[amix]';
  }
  if (fades) {
    const src = aMap === '1:a' ? '[1:a]' : aMap;
    parts.push(`${src}afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(0, dur - 0.6).toFixed(2)}:d=0.6[aout]`);
    aMap = '[aout]';
  }

  // Logo watermark (#10): overlay the brand logo, scaled to ~12% width, in the
  // bottom-right with a small margin. Added as the last input so audio indices
  // above are untouched.
  if (hasLogo) {
    const logoIdx = (bgMusic && fs.existsSync(bgMusic)) ? 3 : 2;
    inputs.push('-i', logo);
    const lw = Math.round(w * 0.12);
    const margin = Math.round(w * 0.03);
    parts.push(`[${logoIdx}:v]scale=${lw}:-1[lg]`);
    parts.push(`[vbase][lg]overlay=W-w-${margin}:H-h-${margin}[vout]`);
  }

  const args = [...inputs, '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', aMap, '-t', dur.toFixed(3),
    ...(await videoCodecArgs()),
    '-c:a', 'aac', '-b:a', '160k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];

  await ffmpeg(args, 'finalizeVideo');
  return out;
}
