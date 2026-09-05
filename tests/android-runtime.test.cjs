const assert = require('node:assert/strict');
const test = require('node:test');

const { AndroidRuntime } = require('../apps/web/runtime/android-runtime.js');
const { createRuntime } = require('../apps/web/runtime/create-runtime.js');

function capabilities(overrides = {}) {
  return {
    protocol: 1,
    platform: 'android',
    arch: 'arm64-v8a',
    sttBackends: ['android-on-device-speech'],
    ttsBackends: ['android-tts-local'],
    selectedStt: 'android-on-device-speech',
    selectedTts: 'android-tts-local',
    ready: true,
    degradedReason: null,
    ...overrides,
  };
}

function bridge(overrides = {}) {
  return {
    voiceHealth: async () => capabilities(),
    voiceTranscribe: async ({ requestId }) => ({ text: 'hello', language: 'en-US', backend: 'android-on-device-speech', requestId }),
    voiceSynthesize: async ({ requestId }) => ({ playback: 'direct', completed: true, backend: 'android-tts-local', requestId }),
    voiceCancel: async () => ({ cancelled: true }),
    voiceDispose: async () => ({ disposed: true }),
    ...overrides,
  };
}

test('AndroidRuntime exposes the five methods and typed direct playback', async () => {
  const runtime = new AndroidRuntime({ bridge: bridge(), capabilities: capabilities(), fallback: null });
  for (const method of ['capabilities', 'transcribe', 'synthesize', 'cancel', 'dispose']) {
    assert.equal(typeof runtime[method], 'function');
  }
  assert.equal((await runtime.transcribe({ language: 'en-US' })).text, 'hello');
  assert.deepEqual(await runtime.synthesize({ text: 'Hello', locale: 'en-US' }), {
    playback: 'direct', completed: true, backend: 'android-tts-local',
  });
});

test('AndroidRuntime keeps concurrent STT and TTS in the same cancellation epoch', async () => {
  let resolveStt;
  let resolveTts;
  const runtime = new AndroidRuntime({
    bridge: bridge({
      voiceTranscribe: () => new Promise(resolve => { resolveStt = resolve; }),
      voiceSynthesize: () => new Promise(resolve => { resolveTts = resolve; }),
    }),
    capabilities: capabilities(),
  });
  const stt = runtime.transcribe({ language: 'en-US' });
  const tts = runtime.synthesize({ text: 'Hello', locale: 'en-US' });
  resolveTts({ playback: 'direct', completed: true, backend: 'android-tts-local' });
  resolveStt({ text: 'hello', language: 'en-US', backend: 'android-on-device-speech' });
  assert.equal((await stt).text, 'hello');
  assert.equal((await tts).playback, 'direct');
});

test('createRuntime selects Android before Electron and keeps unavailable native STT truthful-disabled', async () => {
  const partial = capabilities({
    sttBackends: [], selectedStt: null, ready: false, degradedReason: 'STT_ON_DEVICE_UNAVAILABLE',
  });
  let browserSttCalls = 0;
  const runtime = await createRuntime({
    androidBridge: bridge({ voiceHealth: async () => partial }),
    electronAPI: { runtimeHealth: async () => { throw new Error('must not call Electron'); } },
    browser: {
      transcribe: async () => { browserSttCalls++; return { text: 'must not run' }; },
      synthesize: async () => ({ useSystemSpeech: true }),
    },
  });
  assert.equal(runtime.kind, 'android');
  await assert.rejects(runtime.transcribe({}), /STT_ON_DEVICE_UNAVAILABLE/);
  assert.equal(browserSttCalls, 0);
  assert.equal((await runtime.synthesize({ text: 'hello' })).playback, 'direct');
});

test('Android health failure remains a truthful-disabled Android runtime', async () => {
  let browserSttCalls = 0;
  const runtime = await createRuntime({
    androidBridge: bridge({ voiceHealth: async () => { throw new Error('native unavailable'); } }),
    browser: { transcribe: async () => { browserSttCalls++; return { text: 'must not run' }; } },
  });
  assert.equal(runtime.kind, 'android');
  await assert.rejects(runtime.transcribe({}), /ANDROID_NATIVE_HEALTH_UNAVAILABLE/);
  assert.equal(browserSttCalls, 0);
});

test('Android cancel sends the active typed request id and rejects stale callback', async () => {
  let resolve;
  let cancelled;
  const runtime = new AndroidRuntime({
    bridge: bridge({
      voiceTranscribe: () => new Promise(r => { resolve = r; }),
      voiceCancel: async payload => { cancelled = payload.requestId; return { cancelled: true }; },
    }),
    capabilities: capabilities(),
    fallback: null,
  });
  const pending = runtime.transcribe({ language: 'en-US' });
  runtime.cancel();
  resolve({ text: 'late', language: 'en-US', backend: 'android-on-device-speech' });
  await assert.rejects(pending, /RUNTIME_CANCELLED/);
  assert.match(cancelled, /^android_stt_/);
  assert.ok(cancelled.length <= 128);
});

test('Android disabled operation stays truthful-disabled without browser fallback', async () => {
  let nativeCalls = 0;
  let fallbackCalls = 0;
  const runtime = new AndroidRuntime({
    bridge: bridge({ voiceTranscribe: async () => { nativeCalls++; return {}; } }),
    capabilities: capabilities({ sttBackends: [], selectedStt: null, ready: false, degradedReason: 'STT_REQUIRES_API_31' }),
    fallback: { transcribe: async () => { fallbackCalls++; return { text: 'must not run' }; }, cancel() {}, dispose() {} },
  });
  await assert.rejects(runtime.transcribe({}), /STT_REQUIRES_API_31/);
  assert.equal(nativeCalls, 0);
  assert.equal(fallbackCalls, 0);
});

test('Android native execution errors never start browser fallback', async () => {
  let fallbackCalls = 0;
  const nativeError = Object.assign(new Error('STT_RECOGNITION_FAILED'), { code: 'STT_RECOGNITION_FAILED' });
  const runtime = new AndroidRuntime({
    bridge: bridge({ voiceTranscribe: async () => { throw nativeError; } }),
    capabilities: capabilities(),
    fallback: { transcribe: async () => { fallbackCalls++; return { text: 'must not run' }; } },
  });
  await assert.rejects(runtime.transcribe({}), /STT_RECOGNITION_FAILED/);
  assert.equal(fallbackCalls, 0);
});

test('Android microphone denial remains actionable instead of silently falling back', async () => {
  let fallbackCalls = 0;
  const denied = Object.assign(new Error('MICROPHONE_PERMISSION_DENIED'), { recovery: 'OPEN_APP_SETTINGS' });
  const runtime = new AndroidRuntime({
    bridge: bridge({ voiceTranscribe: async () => { throw denied; } }),
    capabilities: capabilities(),
    fallback: { transcribe: async () => { fallbackCalls++; return { text: 'must not run' }; } },
  });
  await assert.rejects(runtime.transcribe({}), error =>
    error.message === 'MICROPHONE_PERMISSION_DENIED' && error.recovery === 'OPEN_APP_SETTINGS');
  assert.equal(fallbackCalls, 0);
});

test('Android dispose rejects new work and disposes bridge', async () => {
  let disposed = false;
  const runtime = new AndroidRuntime({
    bridge: bridge({ voiceDispose: async () => { disposed = true; return { disposed: true }; } }),
    capabilities: capabilities(),
    fallback: null,
  });
  runtime.dispose();
  await assert.rejects(runtime.transcribe({}), /RUNTIME_DISPOSED/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, true);
});
