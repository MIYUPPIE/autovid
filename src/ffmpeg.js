import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { config, RESOLUTIONS } from './config.js';
import { probeDuration } from './voice.js';

const execFileP = promisify(execFile);

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
export async function normalizeClip({ input, outBase, aspect, targetDur, fps = 30, motion = true, index = 0 }) {
  const { w, h } = RESOLUTIONS[aspect] || RESOLUTIONS['16:9'];
  const out = path.join(config.dirs.work, `${outBase}_norm.mp4`);
  const srcDur = await probeDuration(input);

  const args = [];
  if (srcDur && srcDur < targetDur) args.push('-stream_loop', '-1'); // loop short clips
  args.push('-i', input, '-t', targetDur.toFixed(3), '-an',
    '-vf', fitFilter({ w, h, fps, motion, index }),
    ...(await videoCodecArgs()), '-pix_fmt', 'yuv420p', out);

  await ffmpeg(args, 'normalizeClip');
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
