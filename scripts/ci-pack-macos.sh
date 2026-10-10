#!/usr/bin/env bash
# Public macOS arm64 build: runtime from pinned sources -> ad-hoc stage -> unsigned dmg/zip.
# Usage: scripts/ci-pack-macos.sh /absolute/fresh/work-dir
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$1"
case "$WORK" in /*) ;; *) echo "absolute work dir required" >&2; exit 2;; esac
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd -P)"
cd "$ROOT"
export VOICE_PUBLIC_ADHOC_BUILD=1 R56_SIGN_IDENTITY=- CSC_IDENTITY_AUTO_DISCOVERY=false
unset PYTHONPATH
python3 scripts/ci-build-macos-runtime.py "$WORK/runtime" | tee "$WORK.runtime.log"
BUILD="$(sed -n 's/^RUNTIME_BUILD //p' "$WORK.runtime.log")"
ACQ="$(sed -n 's/^ACQUISITION //p' "$WORK.runtime.log")"
[ -n "$BUILD" ] && [ -n "$ACQ" ] || { echo "runtime build did not report RUNTIME_BUILD/ACQUISITION" >&2; exit 1; }
python3 -I -B scripts/macos-stage-model-packs.py --runtime-build "$BUILD" --acquisition "$ACQ" --output "$WORK/stage" > "$WORK.stage.json"
SHA="$(python3 -c "import json,sys;print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])['receiptSha256'])" "$WORK.stage.json")"
# npm ci may skip the Electron binary download (cache/postinstall); make sure it exists.
[ -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ] || node node_modules/electron/install.js
# esbuild's postinstall hard-links its binary into node_modules/esbuild/bin; the pack step
# refuses multiply-linked files, so give each path its own copy.
find node_modules -type f -links +1 -print0 | while IFS= read -r -d '' f; do cp -p "$f" "$f.unlink" && mv -f "$f.unlink" "$f"; done
node scripts/macos-pack-model-packs.cjs --stage "$WORK/stage" --stage-receipt-sha256 "$SHA" --output "$WORK/pack"
VERSION="$(node -p "require('./package.json').version")"
scripts/ci-seal-macos.sh "$WORK/pack/artifacts/mac-arm64/Voice Practice.app" "$WORK/release" "$VERSION"
echo "RELEASE $WORK/release"
