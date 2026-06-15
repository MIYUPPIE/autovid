#!/usr/bin/env python3
"""Transcribe an audio/video file to JSON segments using faster-whisper.

Usage: python3 transcribe.py <media_path> [model] [language]
Emits JSON on stdout: { "language", "duration", "segments": [{start,end,text}] }.
Kept tiny and deterministic (greedy decode) so the Node side can shell out to it.
"""
import json
import os
import sys


def load_model(model_name):
    """Load a WhisperModel, preferring CPU. device="auto" picks CUDA whenever a
    GPU is *present* even if its runtime libs (libcublas/libcudnn) can't load —
    which throws at model-load time and killed every dub/shorts job on CUDA-less
    boxes. Try GPU only when explicitly asked (WHISPER_DEVICE=cuda) and always
    fall back to CPU int8, which is fast enough for base/small."""
    from faster_whisper import WhisperModel

    want_gpu = os.environ.get("WHISPER_DEVICE", "").lower() in ("cuda", "gpu", "auto")
    attempts = ([("cuda", "float16")] if want_gpu else []) + [("cpu", "int8")]
    last_err = None
    for device, compute in attempts:
        try:
            return WhisperModel(model_name, device=device, compute_type=compute)
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise last_err or RuntimeError("no whisper device available")


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "media path required"}))
        return 1
    media = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

    try:
        import faster_whisper  # noqa: F401
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"faster_whisper not available: {e}"}))
        return 2

    try:
        model = load_model(model_name)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"could not load whisper model: {e}"}))
        return 2

    try:
        segments, info = model.transcribe(
            media, language=language, beam_size=1, vad_filter=True,
        )
        segs = [
            {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
            for s in segments if s.text and s.text.strip()
        ]
        out = {
            "language": info.language,
            "duration": round(getattr(info, "duration", 0.0) or 0.0, 3),
            "segments": segs,
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}))
        return 3


if __name__ == "__main__":
    sys.exit(main())
