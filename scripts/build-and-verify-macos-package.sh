#!/usr/bin/env bash
set -euo pipefail

EXPECTED_CODE_SHA="${1:-}"
[[ "$EXPECTED_CODE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'EXPECTED_CODE_SHA must be a full lowercase commit SHA' >&2; exit 1; }
REPO_ROOT="$(git rev-parse --show-toplevel)"
[[ "$PWD" == "$REPO_ROOT" ]] || { echo 'Fresh package driver must run from repository root' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$EXPECTED_CODE_SHA" ]] || { echo SOURCE_SHA_MISMATCH >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo WORKTREE_NOT_CLEAN >&2; exit 1; }
CANONICAL_DIST="$REPO_ROOT/dist"
if [[ -e "$CANONICAL_DIST" || -L "$CANONICAL_DIST" ]]; then
  [[ -d "$CANONICAL_DIST" && ! -L "$CANONICAL_DIST" ]] || { echo REFUSE_UNSAFE_DIST_DELETE >&2; exit 1; }
  [[ "$(cd "$CANONICAL_DIST/.." && pwd -P)/$(basename "$CANONICAL_DIST")" == "$CANONICAL_DIST" ]] || { echo REFUSE_UNSAFE_DIST_DELETE >&2; exit 1; }
  rm -rf -- "$CANONICAL_DIST"
fi
BUILD_STARTED_NS="$(node -e 'process.stdout.write(String(BigInt(Date.now())*1000000n))')"
bash scripts/build-macos-runtime.sh
node scripts/check-macos-runtime.mjs
npm run pack:mac
printf '%s' "$EXPECTED_CODE_SHA" > "$CANONICAL_DIST/SOURCE_SHA.txt"
node scripts/verify-macos-package.mjs --dist "$CANONICAL_DIST" --expected-code-sha "$EXPECTED_CODE_SHA" --build-started-ns "$BUILD_STARTED_NS"
