# Local AI video (free, on your GPU)

Generates video clips locally with **LTX-Video** instead of paying a hosted API.
$0 per render. The clips are silent — GriotVid lays your normal voiceover +
karaoke captions on top, so it reuses the whole existing pipeline (editor,
brand, music). Only the footage source changes.

This is the cheap answer to "the AI is too expensive": the priciest part was the
hosted video API. Here the pixels come from your own GPU.

## Reality check (read this)

Tuned by default for a **6GB card (RTX 2060)**: small clips + CPU offload + VAE
tiling. That keeps it inside 6GB but makes it **slow — minutes per clip**. A
60s video is many short clips, so it can take a long time. Keep these videos
**short (15-30s)** unless you have a bigger GPU. More VRAM → raise the size knobs
below for faster, sharper output.

## One-time setup

```bash
conda activate tf_gpu                 # your GPU python env (torch already installed)
pip install -r services/localvid/requirements.txt
```

If `import diffusers` fails with `libcudart.so.NN`, your `torchaudio` was built
for a different CUDA than `torch`. Reinstall it to match (see requirements.txt).

Verify the whole stack:

```bash
npm run check        # shows "Local AI video" → python + torch + CUDA + diffusers
```

Then generate one tiny clip (this triggers the one-time model download, several GB):

```bash
python services/localvid/selftest.py
```

When that writes `selftest_out.mp4`, the app will show the **🖥️ Local AI video**
toggle. Flip it, pick a voice, keep the length short, and Generate.

## How it works

- `ltx_generate.py` is a persistent worker: it loads the model once, then reads
  one JSON scene job per line on stdin and writes a silent mp4 per job. The JS
  side (`src/local-video.js`) spawns it once per render so the slow model load is
  paid once, not per scene.
- `src/local-video-pipeline.js` plans the script, records your voiceover, asks
  the worker for one clip per shot, then stitches + captions + finalizes exactly
  like the stock pipeline.

## Tuning (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `LOCALVID_PYTHON` | conda `tf_gpu` python | Python that has torch+diffusers |
| `LTX_MODEL` | `Lightricks/LTX-Video` | Hugging Face model id |
| `LOCALVID_BASE` | `384` | Short-side gen resolution (÷32). Lower if you OOM |
| `LOCALVID_FRAMES` | `49` | Frames per clip (≈2s @24fps). Lower if you OOM |
| `LOCALVID_STEPS` | `30` | Denoising steps. Fewer = faster, rougher |
| `LOCALVID_SCENE_SECONDS` | `4` | Seconds one clip covers (near clip length = less freeze) |
| `LOCALVID_FPS` | `24` | Output fps of generated clips |
| `LOCALVID_READY_TIMEOUT_MS` | `900000` | Model-load timeout (first run downloads) |
| `LOCALVID_JOB_TIMEOUT_MS` | `900000` | Per-clip timeout |

**Out of memory?** Lower `LOCALVID_BASE` (e.g. 320 or 256) and/or `LOCALVID_FRAMES`
(e.g. 33 or 25). The worker's OOM error says the same.
