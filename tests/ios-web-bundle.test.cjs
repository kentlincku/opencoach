'use strict';
// iOS bundles only the shared web UI; speech goes through the native bridge, so the browser
// model runtimes (vendor/, voices/) are not copied into the iOS app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'apps/web/index.html'), 'utf8');
const BUILD = fs.readFileSync(path.join(ROOT, 'scripts/build-web.mjs'), 'utf8');

function fn(name) {
  const found = HTML.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `missing function ${name}`);
  return found[0];
}

test('the iOS bundle copies no browser model runtimes and asserts they are unreachable', () => {
  const ios = BUILD.slice(BUILD.indexOf('if (iosExists) {'));
  assert.doesNotMatch(ios, /"vendor"/);
  assert.doesNotMatch(ios, /"voices"/);
  assert.match(ios, /assertIosNeedsNoBrowserModels\(/);
  assert.match(BUILD, /IOS_BROWSER_WHISPER_REACHABLE/);
  assert.match(BUILD, /IOS_BROWSER_KOKORO_REACHABLE/);
});

test('conversation and shadowing use the native recognizer on iOS before any browser Whisper', () => {
  for (const name of ['transcribeBrowserAudio', 'startShadowing']) {
    const body = fn(name);
    const native = body.indexOf('nativeTranscription === true');
    assert.ok(native !== -1, `${name} checks the iOS recognizer`);
    assert.ok(native < body.indexOf('transcribeWithWebAssembly('), `${name} prefers iOS before browser Whisper`);
  }
});

test('browser Kokoro is never selected on iOS', () => {
  const source = fs.readFileSync(path.join(ROOT, 'apps/web/runtime/tts-preference.js'), 'utf8');
  const sandbox = { window: {}, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  const pref = sandbox.window.VoiceTtsPreference || sandbox.VoiceTtsPreference;
  assert.equal(pref.resolveBrowserTtsMode({ storedMode: 'kokoro', isIosBrowser: true }), 'system');
  assert.equal(pref.shouldLoadBrowserKokoro({ mode: 'system', runtimeKind: 'browser' }), false);
});

test('add-voice lives in the coach editor (iOS only); settings has no separate voice section', () => {
  assert.doesNotMatch(HTML, /iosVoiceGroup|iosVoiceSelect|vp_iosVoiceId|showIosVoiceSettings/);
  assert.match(HTML, /id="coachVoiceAddButton"[^>]*hidden onclick="openIosVoiceDownload\(\)"/);
  const open = fn('openIosVoiceDownload');
  assert.match(open, /openSpeechSettings\?\.\(\)/);
  assert.match(open, /steps\.hidden = false;[^]*?return;/, 'the first tap only shows the steps');
  assert.match(fn('openCoachEditor'), /add\.hidden = !ios;/);
  assert.match(HTML, /visibilitychange[^]*?refreshCoachVoiceChoices\(\)/);
  const swift = fs.readFileSync(path.join(ROOT, 'apps/ios/VoicePractice/App/ScriptBridgeHandler.swift'), 'utf8');
  assert.match(swift, /case "speech\.openSettings":[^]*?UIApplication\.openSettingsURLString/);
});

test('review fixes: bridge identifies iOS, stale shadow does not start native STT, call sites pinned', () => {
  assert.match(fn('isIosBrowserEnvironment'), /voiceNativeBridge\?\.platform === "ios"\) return true/);
  const shadow = fn('startShadowing');
  assert.match(shadow, /const audio = await blobToBase64\(audioBlob\);\s*\/\/[^\n]*\n\s*if \(!current\(\)\) return;\s*spoken = String\(\(await ios\.transcribe/);
  assert.doesNotMatch(shadow.slice(shadow.indexOf('nativeTranscription === true ?')), /^$/);
  assert.match(BUILD, /IOS_BROWSER_MODEL_CALL_SITES_CHANGED/);
  assert.equal(HTML.split('transcribeWithWebAssembly(').length - 1, 3);
  assert.equal(HTML.split('initKokoroTTS(').length - 1, 2);
});
