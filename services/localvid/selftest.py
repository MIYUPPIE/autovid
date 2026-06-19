#!/usr/bin/env python3
"""One-clip self-test for the local LTX-Video path. Run it to confirm your GPU can
actually generate (and to trigger the one-time model download) BEFORE wiring it
into a full render.

  conda activate tf_gpu
  python services/localvid/selftest.py

It generates a tiny clip at the same 6GB-friendly settings the worker uses and
writes it next to this script. First run downloads several GB from Hugging Face;
later runs reuse the cache. On a 6GB RTX 2060 expect a few minutes even for this
tiny clip. If you OOM, lower LTX_WIDTH/LTX_HEIGHT/LTX_FRAMES below.
"""
import os
import sys
import time

W = int(os.environ.get("LTX_WIDTH", 320))
H = int(os.environ.get("LTX_HEIGHT", 576))
FRAMES = int(os.environ.get("LTX_FRAMES", 25))   # %8==1
STEPS = int(os.environ.get("LTX_STEPS", 20))
MODEL = os.environ.get("LTX_MODEL", "Lightricks/LTX-Video")
OUT = os.path.join(os.path.dirname(__file__), "selftest_out.mp4")

try:
    import torch
    from diffusers import LTXPipeline
    from diffusers.utils import export_to_video
except Exception as e:  # noqa: BLE001
    print(f"FAIL: missing deps ({e}). Run: pip install -r services/localvid/requirements.txt")
    sys.exit(1)

if not torch.cuda.is_available():
    print("FAIL: CUDA not available in this python env")
    sys.exit(1)

print(f"GPU: {torch.cuda.get_device_name(0)}  ({torch.cuda.get_device_properties(0).total_memory // (1024**2)} MiB)")
dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
print(f"loading {MODEL} ({dtype})… first run downloads the model")
t0 = time.time()
pipe = LTXPipeline.from_pretrained(MODEL, torch_dtype=dtype)
pipe.enable_model_cpu_offload()
try:
    pipe.vae.enable_tiling()
    pipe.vae.enable_slicing()
except Exception:  # noqa: BLE001
    pass
print(f"model ready in {time.time() - t0:.0f}s — generating {W}x{H} {FRAMES}f @ {STEPS} steps…")

t1 = time.time()
with torch.inference_mode():
    frames = pipe(
        prompt="aerial city sunrise, cinematic, photorealistic, smooth camera motion, highly detailed",
        negative_prompt="worst quality, blurry, distorted, watermark, text",
        width=W, height=H, num_frames=FRAMES, num_inference_steps=STEPS,
    ).frames[0]
export_to_video(frames, OUT, fps=24)
print(f"OK: {len(frames)} frames in {time.time() - t1:.0f}s -> {OUT}")
print("If this played, local AI video works. Flip the 🖥️ Local AI video toggle in the app.")
