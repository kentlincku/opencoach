const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('Apple packaging scripts generate icons and fail closed on missing runtime', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:icons'], 'node scripts/build-icons.mjs');
  assert.equal(pkg.scripts['prepack:mac'], 'node scripts/check-macos-runtime.mjs');
  assert.equal(pkg.scripts['verify:mac:voice'], 'node scripts/verify-macos-packaged-voice.mjs --app "dist/mac-arm64/Voice Practice.app"');
  assert.equal(pkg.scripts['verify:mac:voice:app'], 'node scripts/macos-packaged-voice-e2e.cjs --app "dist/mac-arm64/Voice Practice.app"');
});

test('public macOS workflow validates a source-built runtime without publishing binaries', () => {
  const workflow = read('.github/workflows/desktop-beta.yml');
  const build = workflow.indexOf('bash scripts/build-macos-runtime.sh');
  const check = workflow.indexOf('test -x dist/voice-runtime/voice-runtime');
  const pack = workflow.indexOf('npm run pack:mac');
  const packagedCheck = workflow.indexOf('node scripts/check-macos-runtime.mjs --app "dist/mac-arm64/Voice Practice.app"');
  assert.ok(build >= 0, 'macOS workflow must build its embedded runtime');
  assert.ok(check > build, 'runtime presence check must run after runtime build');
  assert.ok(pack > check, 'packaging must run only after runtime preflight');
  assert.ok(packagedCheck > pack, 'workflow must validate the embedded runtime after packaging');
  assert.doesNotMatch(workflow, /upload-artifact/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test('desktop shutdown clears sidecar only after observed stop completes', () => {
  const main = read('apps/desktop/main.cjs');
  const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"));
  const awaitStop = beforeQuit.indexOf('await sc.stop()');
  const clearSidecar = beforeQuit.indexOf('sidecar = null');
  assert.ok(awaitStop >= 0, 'before-quit must await sidecar termination');
  assert.ok(clearSidecar > awaitStop, 'sidecar reference must remain until stop completes');
});

test('voice cancellation confirms success only after sidecar termination', () => {
  const main = read('apps/desktop/main.cjs');
  const start = main.indexOf("trustedHandle('voice:cancel'");
  const end = main.indexOf("trustedHandle('voice:tts'", start);
  const handler = main.slice(start, end);
  assert.match(handler, /async/);
  assert.match(handler, /controller\.abort\(\)[\s\S]*await requireSidecar\(\)\.stop\(\)[\s\S]*cancelled: true/);
});

test('packaged embedded runtime is synchronously revalidated immediately before spawn', () => {
  const main = read('apps/desktop/main.cjs');
  assert.match(main, /beforeSpawn:\s*validateBeforeSpawn/);
  assert.match(main, /validateEmbeddedRuntimeDirectory\([\s\S]*requireTree:\s*true/);
  assert.match(main, /requiredFiles:\s*REQUIRED_MACOS_RUNTIME_FILES/);
});

test('packaged verifier requires cancellation error and visible-only oMLX controls', () => {
  const driver = read('scripts/macos-packaged-voice-e2e.cjs');
  const cancelBlock = driver.slice(driver.indexOf('if (verifyCancel)'), driver.indexOf('// Visible-renderer oMLX'));
  assert.match(cancelBlock, /pendingResult\.errorObserved/);

  const omlxBlock = driver.slice(driver.indexOf('if (verifyOmlx)'), driver.indexOf('result = { ...result'));
  assert.doesNotMatch(omlxBlock, /\bapplyDirectApiPreset\s*\(/);
  assert.doesNotMatch(omlxBlock, /\bfetchModelsFromProvider\s*\(/);
  assert.doesNotMatch(omlxBlock, /\bonModelDropdownChange\s*\(/);
  assert.doesNotMatch(omlxBlock, /\bsaveSettings\s*\(/);
  assert.doesNotMatch(omlxBlock, /\bsendManualText\s*\(/);
  assert.match(omlxBlock, /MISSING_VISIBLE_SETTINGS_TRIGGER/);
  assert.match(omlxBlock, /OMLX_TURN1_UNEXPECTED_REPLY/);
  assert.match(omlxBlock, /OMLX_TURN2_UNEXPECTED_REPLY/);
});

test('macOS packaged voice driver exercises preload IPC and process cleanup', () => {
  const driver = read('scripts/macos-packaged-voice-e2e.cjs');
  assert.match(driver, /window\.electronAPI\.runtimeHealth\(\)/);
  assert.match(driver, /window\.electronAPI\.synthKokoro\(/);
  assert.match(driver, /window\.electronAPI\.transcribeAudio\(/);
  assert.match(driver, /NATIVE_HEALTH_NOT_READY/);
  assert.match(driver, /health\.fake === true/);
  assert.match(driver, /TTS_RESULT_INVALID/);
  assert.match(driver, /TTS_PCM_INVALID/);
  assert.match(driver, /STT_RESULT_EMPTY/);
  assert.match(driver, /STT_TRANSCRIPT_MISMATCH/);
  assert.match(driver, /UNTRUSTED_PACKAGED_RENDERER_TARGET/);
  assert.match(driver, /Contents', 'Resources', 'app\.asar/);
  assert.match(driver, /EMBEDDED_RUNTIME_PROCESS_NOT_OBSERVED/);
  assert.match(driver, /PACKAGED_APP_EMBEDDED_RUNTIME_OK/);
  assert.match(driver, /assertExactProcessExited/);
  assert.match(driver, /RUNTIME_PROCESS_DID_NOT_EXIT/);
  assert.match(driver, /buildPackagedRuntimeEnvironment/);
  assert.match(driver, /offline:\s*true/);
  assert.doesNotMatch(driver, /allow-model-download/);
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
