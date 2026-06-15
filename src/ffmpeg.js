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
 * Loops short clips, applies optional Ken Burns motion. Returns the silent file.
 */
export async function normalizeClip({ input, outBase, aspect, targetDur, fps = 30, motion = true, index = 0, trim = null }) {
  const { w, h } = RESOLUTIONS[aspect] || RESOLUTIONS['16:9'];
  const out = path.join(config.dirs.work, `${outBase}_norm.mp4`);
  const srcDur = await probeDuration(input);

  // Optional editor trim: take [in, out] from the source before fitting. After a
  // trim the usable length is (out - in), so that, not the raw file, decides
  // whether we still need to loop to cover targetDur.
  const seek = trim && Number(trim.in) > 0 ? Number(trim.in) : 0;
  const trimLen = trim && Number(trim.out) > seek ? Number(trim.out) - seek : (srcDur ? srcDur - seek : null);

  const args = [];
  if (trimLen && trimLen < targetDur) args.push('-stream_loop', '-1'); // loop short/trimmed clips
  else if (!trim && srcDur && srcDur < targetDur) args.push('-stream_loop', '-1');
  if (seek > 0) args.push('-ss', seek.toFixed(3));
  args.push('-i', input, '-t', targetDur.toFixed(3), '-an',
    '-vf', fitFilter({ w, h, fps, motion, index }),
    ...(await videoCodecArgs()), '-pix_fmt', 'yuv420p', out);

  await ffmpeg(args, 'normalizeClip');
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
  aspect, fades = true, outName,
}) {
  const { h } = RESOLUTIONS[aspect] || RESOLUTIONS['16:9'];
  const out = path.join(config.dirs.output, outName);
  const dur = await probeDuration(voiceAudio);

  const inputs = ['-i', silentVideo, '-i', voiceAudio];
  const vChain = [];
  if (captions && fs.existsSync(captions)) vChain.push(captionFilter(captions, h));
  if (fades) {
    vChain.push('fade=t=in:st=0:d=0.6', `fade=t=out:st=${Math.max(0, dur - 0.6).toFixed(2)}:d=0.6`);
  }

  const parts = [];
  parts.push(`[0:v]${vChain.length ? vChain.join(',') : 'copy'}[vout]`);

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

  const args = [...inputs, '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', aMap, '-t', dur.toFixed(3),
    ...(await videoCodecArgs()),
    '-c:a', 'aac', '-b:a', '160k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];

  await ffmpeg(args, 'finalizeVideo');
  return out;
}
