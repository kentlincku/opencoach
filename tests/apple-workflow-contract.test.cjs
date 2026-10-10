const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

// v0.3.0: the macOS App is built from pinned public sources by scripts/ci-pack-macos.sh,
// carries no speech model weights, and is ad-hoc sealed (no Developer ID secrets).
// Shutdown/cancel/spawn-revalidation behaviour is covered by the desktop suites
// (main-voice-operations, bundled-voice-assets, runtime-manager tests).

test('Apple packaging scripts generate icons and pack from a receipted stage', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:icons'], 'node scripts/build-icons.mjs');
  const pack = read('scripts/ci-pack-macos.sh');
  const runtime = pack.indexOf('scripts/ci-build-macos-runtime.py');
  const stage = pack.indexOf('scripts/macos-stage-model-packs.py');
  const app = pack.indexOf('scripts/macos-pack-model-packs.cjs');
  const seal = pack.indexOf('scripts/ci-seal-macos.sh');
  assert.ok(runtime >= 0 && stage > runtime && app > stage && seal > app, 'runtime -> stage -> pack -> seal');
  assert.match(pack, /VOICE_PUBLIC_ADHOC_BUILD=1/);
  assert.match(pack, /set -euo pipefail/);
});

test('public macOS workflow builds and verifies the sealed App without publishing binaries', () => {
  const workflow = read('.github/workflows/desktop-beta.yml');
  const build = workflow.indexOf('bash scripts/ci-pack-macos.sh');
  const verify = workflow.indexOf('codesign --verify --deep --strict');
  const ready = workflow.indexOf('"event":"ready"');
  assert.ok(build >= 0, 'macOS workflow must build the App from pinned sources');
  assert.ok(verify > build && ready > verify, 'the sealed App and its runtime are checked after packing');
  assert.doesNotMatch(workflow, /upload-artifact/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test('release workflow publishes only the macOS build, unsigned, without signing secrets', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /bash scripts\/ci-pack-macos\.sh/);
  assert.match(workflow, /needs: \[macos-arm64\]/);
  assert.doesNotMatch(workflow, /windows-x64:/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /--prerelease/);
  assert.match(workflow, /Open Anyway/);
});

test('seal step keeps the pinned voice runtime bytes and never uses a Developer ID', () => {
  const seal = read('scripts/ci-seal-macos.sh');
  assert.match(seal, /--sign -/);
  assert.match(seal, /voice runtime bytes changed while sealing/);
  assert.match(seal, /codesign --verify --deep --strict/);
  const commands = seal.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(commands, /Developer ID|CSC_LINK|notarytool|stapler/);
});

test('the App ships no speech model weights', () => {
  const pack = read('scripts/macos-pack-model-packs.cjs');
  assert.match(pack, /MODEL_PACK_EMBEDDED_SPEECH_MODEL/);
});

test('iOS workflow parses simctl object and handles simulator state safely', () => {
  const workflow = read('.github/workflows/ios-beta.yml');
  assert.match(workflow, /set -euo pipefail/);
  assert.doesNotMatch(workflow, /\|\| true/);
  assert.doesNotMatch(workflow, /generic\/platform=iOS Simulator/);
  assert.match(workflow, /NO_AVAILABLE_IPHONE_SIMULATOR/);
  assert.match(workflow, /\.devices\s*\|\s*to_entries/);
  assert.doesNotMatch(workflow, /\.devices\s*\|\s*type\s*==\s*["']array["']/);
  assert.match(workflow, /SIMULATOR_STATE/);
  assert.match(workflow, /["']Booted["']/);
  assert.match(workflow, /["']Shutdown["']/);
  assert.match(workflow, /xcrun simctl boot "\$DEVICE_ID"/);
  assert.match(workflow, /xcrun simctl bootstatus "\$DEVICE_ID" -b/);
  assert.match(workflow, /xcodebuild[\s\S]*-destination "id=\$DEVICE_ID" test/);
});
