#!/usr/bin/env bash
set -e
echo "==> AutoVid setup"

# System deps
if ! command -v ffmpeg >/dev/null; then
  echo "Installing ffmpeg…"; sudo apt-get update && sudo apt-get install -y ffmpeg
fi
if ! command -v edge-tts >/dev/null; then
  echo "Installing edge-tts…"
  sudo apt-get install -y python3-pip || true
  pip install --user edge-tts || pipx install edge-tts
fi

# Node deps
npm install

# Env
if [ ! -f .env ]; then cp .env.example .env; echo "==> Created .env — add your API keys!"; fi

echo "==> Verifying…"
npm run check || true
echo "==> Done. Run:  npm start"
