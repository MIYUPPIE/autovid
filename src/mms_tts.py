#!/usr/bin/env python3
"""Local neural TTS for languages edge-tts lacks (Yoruba, Igbo, Hausa, ...).

Uses Meta's MMS-TTS (facebook/mms-tts-<lang>) via transformers VITS. Reads the
full narration from a file, synthesizes it sentence-by-sentence on the GPU, and
writes one continuous 16 kHz WAV. Chunking keeps memory bounded on a 6 GB card
and inserts a short, natural pause between sentences.

Usage:
  python mms_tts.py --lang yor --text-file in.txt --out out.wav
Prints one JSON line: {"ok": true, "duration": <sec>, "sampling_rate": 16000}
"""
import argparse
import json
import os
import re
import sys
import unicodedata

import numpy as np
import torch
import scipy.io.wavfile as wav
from transformers import VitsModel, AutoTokenizer

# Cache models per-process so a multi-sentence run loads weights once.
_CACHE = {}

# VITS stochastic-duration noise. Lower than the 0.667 default = steadier, cleaner
# delivery (fewer artifacts) at the cost of a little expressiveness. Tunable.
NOISE_SCALE = float(os.environ.get("MMS_NOISE_SCALE", "0.6"))
NOISE_SCALE_DURATION = float(os.environ.get("MMS_NOISE_SCALE_DURATION", "0.7"))

# Characters MMS doesn't speak well — normalize to plain equivalents.
_PUNCT = {
    "“": '"', "”": '"', "‘": "'", "’": "'",
    "–": "-", "—": "-", "…": ".", " ": " ",
}


def clean_text(text):
    # Compose diacritics (Yoruba tone marks) and normalize punctuation/whitespace.
    text = unicodedata.normalize("NFC", text)
    for bad, good in _PUNCT.items():
        text = text.replace(bad, good)
    # Drop symbols/emoji the tokenizer can't voice, keep letters/marks/basic punct.
    text = "".join(
        ch for ch in text
        if ch.isalnum() or ch.isspace() or ch in ".,!?;:'\"-()"
        or unicodedata.category(ch).startswith("M")  # combining marks
    )
    return re.sub(r"\s+", " ", text).strip()


def load(lang):
    if lang not in _CACHE:
        name = f"facebook/mms-tts-{lang}"
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        model = VitsModel.from_pretrained(name).to(dev)
        model.eval()
        # Steady the delivery for cleaner native-language output.
        model.noise_scale = NOISE_SCALE
        model.noise_scale_duration = NOISE_SCALE_DURATION
        tok = AutoTokenizer.from_pretrained(name)
        _CACHE[lang] = (model, tok, dev)
    return _CACHE[lang]


def split_sentences(text):
    # Split on sentence enders but keep chunks non-empty and not absurdly long.
    parts = re.split(r"(?<=[.!?…])\s+", text.strip())
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # Hard-wrap very long sentences on commas to stay memory-safe.
        if len(p) > 220:
            out.extend([c.strip() for c in re.split(r",\s*", p) if c.strip()])
        else:
            out.append(p)
    return out or [text.strip()]


def synth(lang, text):
    model, tok, dev = load(lang)
    sr = model.config.sampling_rate
    gap = np.zeros(int(sr * 0.16), dtype=np.float32)  # ~160ms between sentences
    chunks = []
    for sent in split_sentences(clean_text(text)):
        inp = tok(sent, return_tensors="pt").to(dev)
        with torch.no_grad():
            wave = model(**inp).waveform.squeeze().detach().cpu().numpy().astype(np.float32)
        chunks.append(wave)
        chunks.append(gap)
    audio = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    # Normalize to avoid clipping, leave headroom.
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = (audio / peak) * 0.95
    return sr, audio


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True, help="MMS language code, e.g. yor, ibo, hau")
    ap.add_argument("--text-file", help="single-utterance mode: file with the text")
    ap.add_argument("--out", help="single-utterance mode: output wav path")
    ap.add_argument("--batch-file", help="batch mode: JSON [{id, text}] (model loads once)")
    ap.add_argument("--out-dir", help="batch mode: directory for <id>.wav files")
    args = ap.parse_args()

    try:
        if args.batch_file:  # many lines, one model load
            with open(args.batch_file, "r", encoding="utf-8") as fh:
                items = json.load(fh)
            results = []
            for it in items:
                sr, audio = synth(args.lang, it["text"])
                outp = os.path.join(args.out_dir, f"{it['id']}.wav")
                wav.write(outp, sr, (audio * 32767).astype(np.int16))
                results.append({"id": it["id"], "duration": len(audio) / sr})
            print(json.dumps({"ok": True, "results": results, "sampling_rate": sr}))
        else:
            with open(args.text_file, "r", encoding="utf-8") as fh:
                text = fh.read()
            sr, audio = synth(args.lang, text)
            wav.write(args.out, sr, (audio * 32767).astype(np.int16))
            print(json.dumps({"ok": True, "duration": len(audio) / sr, "sampling_rate": sr}))
    except Exception as e:  # surface a clean error to the Node side
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
