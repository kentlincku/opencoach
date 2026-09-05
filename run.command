#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause_on_error() {
  local code=$?
  echo
  echo "Voice Practice could not start (exit $code)." >&2
  if [ -t 0 ]; then read -r -p "Press Enter to close..." _; fi
  exit "$code"
}
trap pause_on_error ERR

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm is required. Install Node.js, then double-click run.command again." >&2
  exit 1
fi

if [ ! -x "$ROOT/.venv/bin/python" ] || [ ! -x "$ROOT/node_modules/.bin/electron" ]; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "uv is required for first-time setup. Install it from https://docs.astral.sh/uv/ and run again." >&2
    exit 1
  fi
  echo "Preparing Voice Practice Desktop for first use..."
  bash "$ROOT/scripts/setup-macos.sh"
fi

export VOICE_RUNTIME_PYTHON="$ROOT/.venv/bin/python"
export VOICE_STT_BACKEND="${VOICE_STT_BACKEND:-auto}"
export VOICE_TTS_BACKEND="${VOICE_TTS_BACKEND:-auto}"
export VOICE_MLX_WHISPER_MODEL="${VOICE_MLX_WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}"

echo "Starting Voice Practice Desktop..."
npm start
