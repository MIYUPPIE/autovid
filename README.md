# AutoVid — AI Video Pipeline

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
- **Captions**: on/off (burned-in, **word-by-word karaoke** — each word lights up as it is spoken). Timing is anchored to real audio windows: edge uses its word-timed SRT; YarnGPT uses each synthesized chunk's measured duration, with words distributed inside that window by syllable weight. Font is sized to the frame width and lines wrap so nothing runs off-screen.
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
GET  /api/projects              list saved projects
GET  /api/project/:id           load the timeline doc
PUT  /api/project/:id           save edits (validated, timeline relayed out)
POST /api/project/:id/render    incremental re-render → poll /api/job/:id
```
`npm run eval:render` proves the cache end-to-end with real ffmpeg (full render, then a caption-only edit that reuses every scene encode).

> Next phase: the browser NLE on Remotion + designcombo. The plan/project doc maps 1:1 to a Remotion composition; `@remotion/player` gives real-time preview, and export stays on this nvenc pipeline.

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
