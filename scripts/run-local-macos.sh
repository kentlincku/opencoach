#!/usr/bin/env bash
# Local development launcher for this Mac (not a packaged/release path).
# Uses locally provisioned models only; never downloads at runtime.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODEL_DIR="${VOICE_MLX_WHISPER_MODEL:-$HOME/.local/share/voice-practice/models/whisper-large-v3-turbo}"
PYTHON_BIN="${VOICE_RUNTIME_PYTHON:-$ROOT/.venv/bin/python}"

fail() { echo "run-local-macos: $*" >&2; exit 1; }
[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || fail "Apple Silicon macOS required"
[ -x "$PYTHON_BIN" ] || fail "Python runtime not found: $PYTHON_BIN (set VOICE_RUNTIME_PYTHON)"
[ -x "$ROOT/node_modules/.bin/electron" ] || fail "node_modules missing; run npm ci"
# The MLX backend admits only an absolute local directory of regular files
# (no HF cache symlinks). Provision with: scripts/provision-local-models-macos.sh
[ -f "$MODEL_DIR/config.json" ] && [ -f "$MODEL_DIR/weights.safetensors" ] \
  || fail "Whisper model not provisioned at $MODEL_DIR (run scripts/provision-local-models-macos.sh)"
"$PYTHON_BIN" -c "import mlx_whisper, kokoro" 2>/dev/null || fail "mlx_whisper/kokoro not importable in $PYTHON_BIN"

export VOICE_RUNTIME_PYTHON="$PYTHON_BIN"
export VOICE_MLX_WHISPER_MODEL="$MODEL_DIR"
export VOICE_STT_BACKEND="${VOICE_STT_BACKEND:-auto}"
export VOICE_TTS_BACKEND="${VOICE_TTS_BACKEND:-auto}"
export HF_HUB_OFFLINE=1
npm run build:web >/dev/null
exec "$ROOT/node_modules/.bin/electron" . "$@"
