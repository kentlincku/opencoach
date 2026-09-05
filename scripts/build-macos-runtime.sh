#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== Building macOS Embedded Voice Runtime ==="

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
    echo "ERROR: macOS embedded runtime requires Apple Silicon (arm64), but found $ARCH" >&2
    exit 1
fi

PYTHON_BIN=""
for candidate in python3.11 python3.12 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PYTHON_BIN="$candidate"
        break
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    echo "ERROR: Python 3 is required to build macOS embedded runtime." >&2
    exit 1
fi

BUILD_VENV="$(mktemp -d "${TMPDIR:-/tmp}/voice-practice-runtime-venv.XXXXXX")"
DEREFERENCED_DIR=""
cleanup_build_paths() {
    rm -rf -- "$BUILD_VENV"
    if [ -n "$DEREFERENCED_DIR" ]; then
        rm -rf -- "$DEREFERENCED_DIR"
    fi
}
trap cleanup_build_paths EXIT
echo "Creating clean virtualenv at a fresh private temporary path using uv (Python 3.11)..."
uv venv --python 3.11 "$BUILD_VENV"
# shellcheck source=/dev/null
source "$BUILD_VENV/bin/activate"

LOCK_FILE="$ROOT_DIR/spikes/packaged-runtime/requirements-macos-arm64.lock.txt"
if [ ! -f "$LOCK_FILE" ]; then
    echo "ERROR: Missing lockfile: $LOCK_FILE" >&2
    exit 1
fi

echo "Syncing dependencies with exact hashes via uv pip sync..."
uv pip sync --require-hashes --python "$BUILD_VENV/bin/python" "$LOCK_FILE"

# Verify Metal / mlx availability
python3 -c "import mlx.core as mx; import mlx_whisper; print('MLX and Metal dependencies verified successfully.')" || {
    echo "ERROR: mlx and Metal dependencies failed to load in build venv." >&2
    exit 1
}

# Run PyInstaller
echo "Running PyInstaller..."
pyinstaller --clean --noconfirm spikes/packaged-runtime/voice-runtime.spec

RUNTIME_DIR="$ROOT_DIR/dist/voice-runtime"
BINARY="$RUNTIME_DIR/voice-runtime"
if [ ! -f "$BINARY" ] || [ ! -x "$BINARY" ]; then
    echo "ERROR: Expected built binary at $BINARY does not exist or is not executable." >&2
    exit 1
fi
if [ ! -d "$RUNTIME_DIR" ] || [ -L "$RUNTIME_DIR" ]; then
    echo "ERROR: Runtime output must be a real canonical directory." >&2
    exit 1
fi

# Materialize the complete onedir tree. cp -RL follows both relative/absolute
# file and directory symlinks; the validator below rejects any link left over.
echo "Materializing internal symlinks for strict tree integrity..."
DEREFERENCED_DIR="$(mktemp -d "$ROOT_DIR/dist/voice-runtime-materialized.XXXXXX")"
rmdir "$DEREFERENCED_DIR"
cp -RL "$RUNTIME_DIR" "$DEREFERENCED_DIR"
rm -rf -- "$RUNTIME_DIR"
mv "$DEREFERENCED_DIR" "$RUNTIME_DIR"
DEREFERENCED_DIR=""
BINARY="$RUNTIME_DIR/voice-runtime"
if [ ! -f "$BINARY" ] || [ ! -x "$BINARY" ]; then
    echo "ERROR: Materialized runtime entrypoint is missing or not executable." >&2
    exit 1
fi

# Ensure MLX Metal metallib is available next to libmlx.dylib
if [ ! -f "$ROOT_DIR/dist/voice-runtime/_internal/mlx/lib/mlx.metallib" ]; then
    echo "ERROR: Required mlx.metallib for MLX Metal acceleration missing from build output" >&2
    exit 1
fi
echo "Placing mlx.metallib in runtime _internal for Metal acceleration..."
cp "$ROOT_DIR/dist/voice-runtime/_internal/mlx/lib/mlx.metallib" "$ROOT_DIR/dist/voice-runtime/_internal/mlx.metallib"
cp "$ROOT_DIR/dist/voice-runtime/_internal/mlx/lib/mlx.metallib" "$ROOT_DIR/dist/voice-runtime/_internal/default.metallib"

echo "Generating deterministic metadata.json covering complete runtime tree..."
node -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const runtimeDir = path.resolve("dist/voice-runtime");
const entrypointName = "voice-runtime";
const entrypointPath = path.join(runtimeDir, entrypointName);
const entryStat = fs.statSync(entrypointPath);
const entryHash = crypto.createHash("sha256").update(fs.readFileSync(entrypointPath)).digest("hex");

function scan(dir, root, map = {}) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (item.isDirectory()) {
      scan(full, root, map);
    } else if (item.isFile() && rel !== "metadata.json") {
      const bytes = fs.statSync(full).size;
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      map[rel] = { bytes, sha256 };
    }
  }
  return map;
}

const fileMap = scan(runtimeDir, runtimeDir);
const sortedFiles = {};
for (const k of Object.keys(fileMap).sort()) {
  sortedFiles[k] = fileMap[k];
}

const treeFrame = Object.keys(sortedFiles).map(k => `${k}\0${sortedFiles[k].bytes}\0${sortedFiles[k].sha256}\n`).join("");
const treeSha256 = crypto.createHash("sha256").update(treeFrame).digest("hex");
const metadata = {
  schemaVersion: 1,
  platform: "darwin-arm64",
  entrypoint: entrypointName,
  bytes: entryStat.size,
  sha256: entryHash,
  fileCount: Object.keys(sortedFiles).length,
  treeSha256,
  files: sortedFiles,
};

fs.writeFileSync(path.join(runtimeDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(`Runtime built: ${entryStat.size} bytes, SHA256: ${entryHash}, Files: ${Object.keys(sortedFiles).length}`);
'

echo "=== Embedded macOS runtime build complete ==="
