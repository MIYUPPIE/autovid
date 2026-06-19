#!/usr/bin/env python3
"""Local LTX-Video generation worker for GriotVid (free, runs on your own GPU).

Loads the model ONCE, then reads one JSON job per line on stdin and writes a
silent mp4 per job. Keeping the process alive across scenes matters: model load
(esp. the T5 text encoder) is the slow part, so a render generates N clips
without paying that cost N times.

Tuned for a 6GB card (RTX 2060): bfloat16 + model CPU offload + VAE tiling keep
the resident VRAM small. It WILL be slow (minutes per clip) and small clips are
generated then upscaled by the JS side's ffmpeg normalize step. If you OOM, lower
LTX_WIDTH/LTX_HEIGHT/LTX_FRAMES (env) — the error message says so too.

Protocol (newline-delimited JSON, stdout):
  worker prints {"event":"ready"} once loaded, or {"event":"fatal","error":..}
  for each stdin job {"id","prompt","width","height","num_frames","fps","steps","out","seed"}
  it prints {"event":"done","id","out","frames"} or {"event":"error","id","error"}
EOF on stdin => clean exit.
"""
import sys
import os
import json
import traceback


def log(event, **kw):
    """Emit one protocol line to stdout (results) and flush."""
    sys.stdout.write(json.dumps({"event": event, **kw}) + "\n")
    sys.stdout.flush()


def diag(msg):
    """Human-readable progress to stderr (never parsed by the JS side)."""
    sys.stderr.write(f"[localvid] {msg}\n")
    sys.stderr.flush()


def round32(n, lo=160):
    """LTX requires spatial dims divisible by 32; keep a sane floor."""
    n = max(lo, int(n))
    return n - (n % 32)


def main():
    model_id = os.environ.get("LTX_MODEL", "Lightricks/LTX-Video")
    try:
        import torch
        from diffusers import LTXPipeline
        from diffusers.utils import export_to_video
    except Exception as e:  # noqa: BLE001
        log("fatal", error=f"missing deps ({e}). Install: pip install "
            "'diffusers>=0.32' transformers accelerate imageio imageio-ffmpeg sentencepiece")
        return 1

    if not torch.cuda.is_available():
        log("fatal", error="CUDA not available in this Python env — local AI video needs a working GPU torch")
        return 1

    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    diag(f"loading {model_id} ({dtype})… first run downloads several GB from Hugging Face")
    try:
        pipe = LTXPipeline.from_pretrained(model_id, torch_dtype=dtype)
        # 6GB survival kit: offload each component to CPU until it's needed, and
        # tile the VAE decode (the big VRAM spike) so it never materializes a full
        # frame batch at once.
        pipe.enable_model_cpu_offload()
        try:
            pipe.vae.enable_tiling()
            pipe.vae.enable_slicing()
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001
        log("fatal", error=f"could not load model: {e}")
        return 1

    log("ready", model=model_id, dtype=str(dtype))
    diag("ready — waiting for jobs")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except Exception as e:  # noqa: BLE001
            log("error", id=None, error=f"bad job json: {e}")
            continue

        jid = job.get("id")
        try:
            width = round32(job.get("width", 480))
            height = round32(job.get("height", 704))
            # LTX wants num_frames % 8 == 1 (e.g. 49, 65). Coerce defensively.
            nf = int(job.get("num_frames", 49))
            nf = max(9, nf - ((nf - 1) % 8))
            fps = int(job.get("fps", 24))
            steps = int(job.get("steps", 30))
            out = job["out"]
            seed = job.get("seed")
            gen = None
            if seed is not None:
                import torch as _t
                gen = _t.Generator(device="cuda").manual_seed(int(seed))

            diag(f"scene {jid}: {width}x{height} {nf}f @ {steps} steps -> {out}")
            import torch as _t
            with _t.inference_mode():
                result = pipe(
                    prompt=job.get("prompt", ""),
                    negative_prompt=job.get("negative_prompt",
                                            "worst quality, blurry, jittery, distorted, watermark, text"),
                    width=width, height=height, num_frames=nf,
                    num_inference_steps=steps, generator=gen,
                )
            frames = result.frames[0]
            export_to_video(frames, out, fps=fps)
            # Free the cached blocks between clips so VRAM doesn't creep up.
            _t.cuda.empty_cache()
            log("done", id=jid, out=out, frames=len(frames))
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "out of memory" in msg.lower():
                msg = ("CUDA out of memory on this clip — lower LTX_WIDTH/LTX_HEIGHT/LTX_FRAMES "
                       "(env) and retry. " + msg)
            diag("error:\n" + traceback.format_exc())
            try:
                import torch as _t
                _t.cuda.empty_cache()
            except Exception:
                pass
            log("error", id=jid, error=msg)

    diag("stdin closed — exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
