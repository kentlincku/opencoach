#!/usr/bin/env bash
# Local development setup for Apple Silicon (not the packaged/engineering build path).
# Creates .venv with the pinned dev speech stack, installs Node deps, and
# materializes the Whisper model as regular files. Kokoro weights/voices come
# from the official hexgrad/Kokoro-82M Hugging Face repo on first use unless cached.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || { echo "Apple Silicon macOS required" >&2; exit 1; }
command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/" >&2; exit 1; }
command -v npm >/dev/null || { echo "Node.js/npm is required." >&2; exit 1; }

[ -x .venv/bin/python ] || uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r native/python/requirements-macos-dev.txt
[ -x node_modules/.bin/electron ] || npm ci --include=dev
bash scripts/provision-local-models-macos.sh

if [ ! -d "${HF_HOME:-$HOME/.cache/huggingface}/hub/models--hexgrad--Kokoro-82M" ]; then
  echo "Kokoro-82M (~330 MB, Apache-2.0, huggingface.co/hexgrad/Kokoro-82M) is not cached. Download now? [y/N]"
  read -r answer
  if [ "$answer" = "y" ]; then
    .venv/bin/python -c "from kokoro import KPipeline; p=KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M'); list(p('ready', voice='af_heart'))"
  fi
fi
echo "Setup complete. Start with: ./run.command  (or scripts/run-local-macos.sh)"
