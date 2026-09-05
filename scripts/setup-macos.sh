#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required: https://docs.astral.sh/uv/" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm is required." >&2
  exit 1
fi

uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r native/python/requirements-macos.txt
npm ci --include=dev

echo
echo "Setup complete. Run:"
echo "  export VOICE_RUNTIME_PYTHON=\"$PWD/.venv/bin/python\""
echo "  npm start"
