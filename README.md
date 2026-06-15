# GriotVid — AI Video Studio

*A griot is a West African storyteller. GriotVid turns an idea into a finished, narrated video — in your language.*


AI writes the script and scene plan **in your chosen language** → free stock footage is pulled from **Pexels + Pixabay** → a neural voiceover is generated as **one continuous narration** (Edge-TTS for English/African languages, **YarnGPT** for Yoruba/Igbo/Hausa) → royalty-free **background music auto-picked from Jamendo** by mood → **FFmpeg** fits footage to the narration with **Ken Burns motion**, burns **word-by-word karaoke captions**, ducks the music, and renders a final MP4 on the **GPU (NVENC)**. Driven from a web UI.

## What you control per video
- **Input mode**:
  - **Give an idea** — AIwrites the script from your topic.
  - **My script** — paste your own script; it is narrated **word-for-word** (AI only picks the footage and a title, never rewrites your words). Video length follows the script.
- **Topic + tone** (engaging, documentary, energetic, calm, inspirational)
- **Audience context**: Africa or Non-Africa (changes script framing *and* footage queries)
- **Format**: 16:9, 9:16, or 1:1
- **Length**: 15–180s
- **Language / voice**:
  - **Native languages** — Yorùbá, Igbo, Hausa (YarnGPT, male/female speakers), plus Swahili, Zulu, Amharic, Afrikaans, Somali (Edge neural). Grok writes the whole script natively in that language; stock queries stay English.
  - **African-accented English** (Nigerian, Kenyan, South African, Tanzanian) and **Global** (US/UK/AU/IN).
  - **Bilingual** — turn on the bilingual toggle and pick a second voice/language: every line is spoken first in language A, then in language B (e.g. Yorùbá then English), with captions timed to each read.
- **Captions**: on/off (burned-in, **word-by-word karaoke** — each word lights up as it is spoken). Timing is anchored to real audio windows: edge uses its word-timed SRT; YarnGPT uses each synthesized chunk's measured duration, with words distributed inside that window by syllable weight. Font is sized to the frame width and lines wrap so nothing runs off-screen. **Caption size** is adjustable (Small / Medium / Large / X-Large) before rendering, and again on the result screen after — resizing re-runs only the final mux (seconds), since the size lives in the editable project doc, not baked into the timeline.
- **Motion (Ken Burns)**: on/off — slow zoom/pan on each clip so static footage feels alive
- **Background music**: on/off — **Auto** (royalty-free from Jamendo, mood-matched to tone) or **Upload**; auto-looped and ducked under the voice
- **Fades**: on/off

One continuous voiceover is synthesized for the whole video (not sentence-by-sentence), so the narration flows as a single read with no choppy seams.

## Requirements (Linux VPS)
- Node.js 18+ (you have 22)
- FFmpeg + ffprobe: `sudo apt install -y ffmpeg`. For GPU encoding, an NVIDIA GPU + an ffmpeg built with `h264_nvenc` (the pipeline auto-detects it; falls back to libx264).
- edge-tts (free, Microsoft neural voices):
  ```bash
  sudo apt install -y python3-pip
  pip install edge-tts          # or: pipx install edge-tts
  ```
  Verify: `edge-tts --list-voices | head`
- **Native-language TTS (Yoruba/Igbo/Hausa)** — a [YarnGPT](https://yarngpt.ai) API key in `YARN_API_KEY`. No local GPU/model needed; the request is hosted. Verify: `npm run eval:yarn`.
- **Auto music** — a free Jamendo client id in `JAMENDO_CLIENT_ID` (see API keys).

## Setup
```bash
npm install
cp .env.example .env      # then paste your 3 API keys
npm run check             # verifies ffmpeg / edge-tts / keys
npm start                 # → http://localhost:3000
```

## Testing
Two lanes:
```bash
npm test      # gate tests — offline, deterministic, free, <1s. No network/LLM/ffmpeg.
npm run eval  # quality eval — real Grok calls, measures plan quality (needs XAI_API_KEY)
```
`npm test` exercises voice/engine routing, stock ranking (incl. the size/duration penalties that keep downloads fast), the flowing-narration helpers (script folding, proportional durations + SRT), Jamendo tone→tag mapping, footage-fallback resilience, the HTTP contract, and regression guards (string `jobId`; a bad download skipping to the next candidate). `npm run eval` scores Grok's scene plans across topics/contexts/languages (incl. a Yorùbá case verifying native script with English queries) against an 85% pass threshold.

## LLM provider (scriptwriting / planning)
Grok is only the creative brain — it writes the script + scene plan and the English footage queries, nothing else. It's plain chat-completions returning JSON, so it's swappable. Set `LLM_PROVIDER` in `.env`:
- `xai` (default) — Grok via `XAI_API_KEY`.
- `openrouter` — any model on OpenRouter (Claude/GPT/Llama/DeepSeek/…). Set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` (e.g. `anthropic/claude-3.5-sonnet`).
- `claude-code` — a local `claude` CLI (free, no API key). Set `CLAUDE_BIN` if it's not on PATH.

The active provider shows in `/api/health` and the UI header.

## API keys (.env)
- `API_KEY` 
- `PEXELS_API_KEY` — from https://www.pexels.com/api
- `PIXABAY_API_KEY` — from https://pixabay.com/api/docs
- `JAMENDO_CLIENT_ID` — from https://devportal.jamendo.com (free, ~2-min signup) — enables auto background music. Without it, auto-music is skipped (upload still works).
- `YARN_API_KEY` — from https://yarngpt.ai — enables the Yoruba/Igbo/Hausa voices. Only needed if you use those languages.

## YouTube footage (no key)
Install `yt-dlp` (`pip install yt-dlp`) and the app gains a third footage source — no API key. When detected:
- **Create form** shows a "▶️ Use YouTube footage too" toggle. On → the auto-pipeline can pull scene footage from YouTube as well as Pexels/Pixabay (stock is still preferred; YouTube is the opt-in extra).
- **Editor → Replace footage → "⛶ Browse all clips"** opens a full-size gallery with **Pexels / Pixabay / YouTube** tabs so you can see every searched clip and click one to swap it onto the selected scene.

Only a short opening section of each YouTube video is downloaded (`YOUTUBE_SECTION_SECONDS`, default 30s) and trimmed to the scene, so a 30-minute source is a ~2MB pull. Mind copyright/licensing on whatever you reuse.

## How it fits together
```
 Topic ─► xai.js (Grok) ─► scene plan {narration (in language), query (English), duration}
            │
            ├─► voice.js  ─► ONE continuous narration audio (+ timing)
            │     edge-tts (English / Swahili / Zulu / …)  → mp3 + word-timed SRT
            │     YarnGPT  (Yoruba / Igbo / Hausa)         → mp3 (duration only)
            │   captions.js ─► word-by-word karaoke .ass (from SRT or audio duration)
            │
            ├─► stock.js (Pexels/Pixabay) ─► per-scene clip, ranked + size-capped, resilient
            ├─► music.js  (Jamendo) ─► mood-matched royalty-free track
            └─► ffmpeg.js  (NVENC / libx264)
                  normalizeClip   scale+crop to frame, loop, Ken Burns motion (silent)
                  concatSilent    stream-copy join of the silent scenes (fast)
                  finalizeVideo   ONE pass: narration + ducked music + subs + fades
                                  ─► assets/output/<id>_final.mp4
```
Scene visual durations are derived from the single narration (proportional to text), so
the picture tracks the voice with no per-scene seams. Footage is downloaded with bounded
concurrency; oversized/slow clips are skipped for the next candidate so one bad download
can't stall or kill the render.

## Editable projects (edit after creation)

A rendered `.mp4` can't be edited — captions are burned into pixels and audio is mixed into one track. So every render also writes an **editable project document**: the timeline recipe behind the video. Edit that, re-render, and only the stages your edit touched are redone.

- `project.js` — the timeline doc (scenes, source + normalized clip paths, durations, caption cues, music, effects), validation, save/load, and `planRender` (decides which stages are stale — pure, fully unit-tested).
- `render.js` — `renderProject()` re-renders incrementally using the cache recorded on `project.render`.

What an edit costs:

| Edit | Re-renders | Cost |
|------|-----------|------|
| caption text/style, music volume, fades | final mux only | cheapest re-encode |
| trim / reorder / delete scenes | concat (stream-copy) + final | fast |
| swap a scene's footage | that one scene + concat + final | one GPU encode |

API:
```
GET  /api/projects                       list saved projects
GET  /api/project/:id                    load the timeline doc
GET  /api/project/:id/preview            media bundle for the live player (scene/voice/music URLs + geometry)
GET  /api/project/:id/thumbs/:index?n=6  filmstrip frames for a scene (cached)
GET  /api/project/:id/waveform?buckets=  narration waveform peaks (cached JSON)
PUT  /api/project/:id                    save edits (validated, timeline relayed out)
POST /api/project/:id/render             incremental re-render → poll /api/job/:id
POST /api/project/:id/scene/:i/source    swap a scene's footage to a stock/url clip (downloads it)
GET  /api/stock/search?q=&aspect=        in-editor stock search → candidate clips
POST /api/clip?ext=mp4                   upload replacement footage for a scene → { path }
/media/{raw,work,audio,output}/<file>    static asset serving (range-capable, for <video> scrubbing)
```
`npm run eval:render` proves the render cache end-to-end with real ffmpeg; `npm run eval:edit` proves the editor's thumbnail + waveform helpers against real ffmpeg.

### The browser timeline editor (NLE)
A real, vanilla timeline editor is built into the UI — no separate app, no framework. After a render hit **✎ Edit this video**, or open any past video from **🗂️ My projects**; `/#edit=<projectId>` deep-links straight in. **What you see is what renders** — the preview plays the actual footage, voice, music and a live karaoke caption overlay before you spend a single GPU second.

- **Live preview + transport** — play/pause (space), scrub, frame-step (←/→). Captions are drawn as a word-by-word karaoke overlay (spoken vs upcoming colours), Ken Burns motion is previewed, and the voice + music play in sync.
- **Timeline** — a ruler, a **scene track with filmstrip thumbnails**, the **narration waveform**, and a **caption-cue track**. Drag a scene to **reorder**; drag the **boundary handle** between two scenes to move the cut (total locked to the voice); a dashed marker shows where the narration ends. Zoom in/out.
- **Captions** — drag cue blocks to retime, drag the edges to resize, click to edit text; **drag the caption anywhere on the frame** to place it (or use the 3×3 anchor grid / reset to bottom); style globally (S/M/L/XL or exact px, spoken/upcoming colours, words-per-line). Split a scene or add a cue at the playhead. Position is stored as normalized `posX/posY` and burned in at render via an ASS `\pos` override.
- **Footage** — per scene: trim in/out, Ken Burns on/off, **Replace footage** by upload, or **search stock right in the inspector** and click a hover-preview to swap it in.
- **Audio & effects** — music volume (live), add/remove a track, fades.

**Save** PUTs the doc (server re-validates + relays out the timeline); **Re-render** saves then runs the incremental render, streaming SSE progress and hot-swapping the new MP4. Every edit only re-runs the stale stages per the cost table above (verified live: caption edit → final only; reorder → concat + final; footage swap / duration change → that scene + concat + final).

> Next phase: swap the hand-rolled preview for `@remotion/player` so the on-screen preview is byte-identical to the export. The project doc already maps 1:1 to a Remotion composition; export stays on this nvenc pipeline.

## Share to any platform
Every finished video gets a **📤 Share** button (under the result, and in the editor head). It opens a share sheet with two honest paths to "any platform" — no cloud upload, no third-party host:

- **Share to an app…** — uses the browser's native **Web Share API** (level 2). On a phone (and supporting desktops) it hands the actual MP4 to the OS share sheet, which routes to *every* installed app: Instagram, TikTok, WhatsApp, Messages, Drive. This is the real cross-platform path. Falls back to sharing link + caption where file-share isn't supported.
- **Post to** — pre-filled web composers for **X, WhatsApp, Facebook, Telegram, LinkedIn, Reddit, and email**. Each opens that network's own dialog seeded with a tailored caption + the video link.
- **Caption + hashtags** — auto-built from the title and aspect ratio (vertical → `#Shorts #Reels #TikTok`, landscape → `#YouTube`), editable in place, with one-click **Copy caption** / **Copy link** / **Download MP4**. The X caption is trimmed to fit the 280-char limit (including the 23-char link cost).
- **Open on your phone** — shows the LAN URL (`http://<your-ip>:3000/...`) so a desktop user can open the app on their phone (same Wi-Fi) and post natively from there.

The link a post carries is the address you reached the app on. Set `SHARE_BASE_URL` in `.env` when you serve through a tunnel or domain so the links resolve for other people. Contract: `GET /api/project/:id/share` → `{ fileUrl, lanFileUrl, hashtags, captions:{long,short}, platforms:[…] }` (404 unknown, 409 if not rendered yet). Logic lives in `src/share.js` (pure, deterministic, gate-tested).

> Future: a one-click cloud upload (S3/R2 + public URL) would make the per-network link buttons resolve for anyone, not just the same network. That's a hosting/credential choice, not built here.

## Notes
- Stock licenses: Pexels & Pixabay are free for commercial use, no attribution required. Keep records if your platform needs them.
- If a scene query returns nothing, Grok is asked for alternative queries automatically.
- Jobs are in-memory. For production scale, back `jobs` in `pipeline.js` with Redis and move outputs to object storage.
- To deploy: run behind `pm2` or systemd, put nginx in front, point a domain at port 3000.

## Production hardening checklist (next steps)
- [ ] Redis-backed job queue (BullMQ) so renders survive restarts
- [ ] Per-clip caching by query hash to cut API calls
- [ ] Upload finished MP4s to S3/R2 instead of local disk
- [ ] Auth on the render endpoint
- [ ] Rate-limit Pexels/Pixabay (they have quotas)
