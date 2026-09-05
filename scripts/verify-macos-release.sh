#!/usr/bin/env bash
set -euo pipefail

app_path="${1:-dist/mac-arm64/Voice Practice.app}"
[[ -d "$app_path" ]] || { printf 'App not found: %s\n' "$app_path" >&2; exit 1; }

codesign --verify --deep --strict --verbose=2 "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"
xcrun stapler validate "$app_path"
"$app_path/Contents/MacOS/Voice Practice" --smoke-test
