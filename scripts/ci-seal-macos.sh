#!/usr/bin/env bash
# Seal the unsigned public App with a complete ad-hoc signature, then build the dmg and zip.
# Without a sealed bundle Gatekeeper reports the downloaded App as damaged and moves it to
# the Trash, so users never reach "Open Anyway". The voice runtime keeps its own ad-hoc
# signatures (its bytes are pinned by the bundled trust); only the Electron parts and the
# outer bundle are (re)signed here. No Developer ID, no hardened runtime (ad-hoc code has no
# Team ID, so library validation would refuse Electron's own frameworks).
# Usage: scripts/ci-seal-macos.sh "/abs/Voice Practice.app" /abs/output-dir <version>
set -euo pipefail
APP="$1"; OUT="$2"; VERSION="$3"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENT="$ROOT/build/entitlements.mac.plist"
RUNTIME="$APP/Contents/Resources/voice-assets"
# Digest of every file under voice-assets (paths + bytes), so sealing provably leaves the
# runtime tree the bundled trust pins untouched.
tree() { (cd "$RUNTIME" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | shasum -a 256 | cut -d' ' -f1; }
before="$(tree)"
sign() { /usr/bin/codesign --force --timestamp=none --sign - "$@"; }
# Inner code first: helper apps and frameworks, then loose Mach-O helpers outside voice-assets.
# Fixed order: nested dylibs, then frameworks, then helper apps (each sorted).
FW="$APP/Contents/Frameworks"
find "$FW" -name "*.dylib" -type f -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' item; do sign "$item"; done
find "$FW" -maxdepth 1 -name "*.framework" -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' item; do sign "$item"; done
find "$FW" -maxdepth 1 -name "*.app" -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' item; do sign "$item"; done
FM="$APP/Contents/Resources/foundation-models/voice-foundation-models"
[ -f "$FM" ] && sign "$FM"
sign --entitlements "$ENT" "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"
after="$(tree)"
[ "$before" = "$after" ] || { echo "voice runtime bytes changed while sealing" >&2; exit 1; }
mkdir -p "$OUT"
NAME="Voice-Practice-$VERSION-arm64"
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/Voice Practice.app"
ln -s /Applications "$STAGE/Applications"
for attempt in 1 2 3; do  # hosted runners sometimes report "Resource busy"
  rm -f "$OUT/$NAME.dmg"
  hdiutil create -quiet -volname "Voice Practice $VERSION" -srcfolder "$STAGE" -fs HFS+ -format ULMO "$OUT/$NAME.dmg" && break
  [ "$attempt" = 3 ] && exit 1; sleep 10
done
rm -rf "$STAGE"
hdiutil verify -quiet "$OUT/$NAME.dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$NAME.zip"
echo "SEALED $OUT/$NAME.dmg"
