const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TTS_MODES,
  normalizeTtsMode,
  shouldUseModelTts,
  shouldLoadBrowserKokoro,
  shouldRetryKokoroInitialization,
  classifySuccessfulKokoroWarmup,
  createModeEpoch,
  resolveBrowserTtsMode,
} = require('../apps/web/runtime/tts-preference.js');

test('normalizes persisted TTS mode safely', () => {
  assert.equal(normalizeTtsMode('auto'), TTS_MODES.AUTO);
  assert.equal(normalizeTtsMode('system'), TTS_MODES.SYSTEM);
  assert.equal(normalizeTtsMode('kokoro'), TTS_MODES.KOKORO);
  assert.equal(normalizeTtsMode('unknown'), TTS_MODES.AUTO);
  assert.equal(normalizeTtsMode(null), TTS_MODES.AUTO);
});

test('system mode always bypasses model TTS', () => {
  assert.equal(shouldUseModelTts({ mode: 'system', runtimeKind: 'electron' }), false);
  assert.equal(shouldUseModelTts({ mode: 'system', runtimeKind: 'browser' }), false);
});

test('kokoro mode selects model TTS on desktop and browser', () => {
  assert.equal(shouldUseModelTts({ mode: 'kokoro', runtimeKind: 'electron' }), true);
  assert.equal(shouldUseModelTts({ mode: 'kokoro', runtimeKind: 'browser' }), true);
  assert.equal(shouldLoadBrowserKokoro({ mode: 'kokoro', runtimeKind: 'browser' }), true);
  assert.equal(shouldLoadBrowserKokoro({ mode: 'kokoro', runtimeKind: 'electron' }), false);
});

test('auto mode prefers native desktop and Android TTS but browser system speech', () => {
  assert.equal(shouldUseModelTts({ mode: 'auto', runtimeKind: 'electron' }), true);
  assert.equal(shouldUseModelTts({ mode: 'auto', runtimeKind: 'android' }), true);
  assert.equal(shouldUseModelTts({ mode: 'auto', runtimeKind: 'browser' }), false);
  assert.equal(shouldLoadBrowserKokoro({ mode: 'auto', runtimeKind: 'browser' }), false);
});

test('iOS browser degrades an explicit Kokoro choice to local system voice', () => {
  assert.equal(resolveBrowserTtsMode({ storedMode: 'kokoro', isIosBrowser: true }), TTS_MODES.SYSTEM);
  assert.equal(resolveBrowserTtsMode({ storedMode: 'kokoro', isIosBrowser: false }), TTS_MODES.KOKORO);
  assert.equal(resolveBrowserTtsMode({ storedMode: 'auto', isIosBrowser: true }), TTS_MODES.AUTO);
});

test('mode epoch invalidates delayed Kokoro initialization', () => {
  const epoch = createModeEpoch();
  const first = epoch.begin();
  assert.equal(epoch.isCurrent(first), true);
  epoch.cancel();
  assert.equal(epoch.isCurrent(first), false);
  const second = epoch.begin();
  assert.equal(epoch.isCurrent(second), true);
  assert.equal(epoch.isCurrent(first), false);
});

test('slow successful Kokoro warmup remains usable', () => {
  assert.deepEqual(classifySuccessfulKokoroWarmup(25000), {
    usable: true,
    slow: true,
    elapsedMs: 25000,
  });
  assert.deepEqual(classifySuccessfulKokoroWarmup(500), {
    usable: true,
    slow: false,
    elapsedMs: 500,
  });
});

test('stale Kokoro load retries only when the current mode still wants it', () => {
  assert.equal(shouldRetryKokoroInitialization({
    generationIsCurrent: false,
    wantsBrowserKokoro: true,
    timerPending: false,
    instanceReady: false,
  }), true);
  assert.equal(shouldRetryKokoroInitialization({
    generationIsCurrent: true,
    wantsBrowserKokoro: true,
    timerPending: false,
    instanceReady: false,
  }), false);
  assert.equal(shouldRetryKokoroInitialization({
    generationIsCurrent: false,
    wantsBrowserKokoro: false,
    timerPending: false,
    instanceReady: false,
  }), false);
  assert.equal(shouldRetryKokoroInitialization({
    generationIsCurrent: false,
    wantsBrowserKokoro: true,
    timerPending: true,
    instanceReady: false,
  }), false);
  assert.equal(shouldRetryKokoroInitialization({
    generationIsCurrent: false,
    wantsBrowserKokoro: true,
    timerPending: false,
    instanceReady: true,
  }), false);
});
