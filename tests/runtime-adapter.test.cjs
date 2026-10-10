const assert = require('node:assert/strict');
const test = require('node:test');

const { BrowserRuntime } = require('../apps/web/runtime/browser-runtime.js');
const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
const { createRuntime } = require('../apps/web/runtime/create-runtime.js');
const { encodePcmWav } = require('../apps/web/runtime/native-audio.js');
const pcm = () => encodePcmWav(new Float32Array([0, 0.5]));

// MEMORY transport boundary: exact C6 replies, not a substitute for the real-child controls.
function typedApi() {
  const revoked = new Set();
  return {
    voiceOperationRevoke: async ({ requestIds }) => {
      requestIds.forEach(id => revoked.add(id));
      return { version: 1, type: 'revoked', requestIds };
    },
    voiceOperationState: async ({ requestId }) => {
      assert.ok(revoked.has(requestId));
      return { version: 1, type: 'state', requestId, knowledge: 'retired' };
    },
  };
}
function backendFailure(requestId) {
  const binding = { clientId: 'original-client', intentId: 'original-intent', generation: 1 };
  return { version: 1, type: 'failure', requestId, code: 'backend-error', message: 'backend failed', binding,
    completion: { version: 1, type: 'state', requestId, knowledge: 'known', revision: 3,
      logical: 'settled', revocation: 'live', receipt: { status: 'completed', binding }, cleanup: 'released',
      failure: { code: 'backend-error', message: 'backend failed' } } };
}

function nativeCapabilities(overrides = {}) {
  return {
    protocol: 1,
    platform: 'darwin',
    arch: 'arm64',
    sttBackends: ['mlx-whisper'],
    ttsBackends: ['kokoro-python'],
    selectedStt: 'mlx-whisper',
    selectedTts: 'kokoro-python',
    ready: true,
    degradedReason: null,
    ...overrides,
  };
}

test('BrowserRuntime exposes the five-method runtime interface', async () => {
  const calls = [];
  const runtime = new BrowserRuntime({
    transcribe: async payload => ({ text: payload.text }),
    synthesize: async payload => ({ text: payload.text }),
    cancel: () => calls.push('cancel'),
    dispose: () => calls.push('dispose'),
  });

  assert.equal(typeof runtime.capabilities, 'function');
  assert.equal(typeof runtime.transcribe, 'function');
  assert.equal(typeof runtime.synthesize, 'function');
  assert.equal(typeof runtime.cancel, 'function');
  assert.equal(typeof runtime.dispose, 'function');
  assert.equal((await runtime.transcribe({ text: 'hello' })).text, 'hello');
  assert.equal((await runtime.synthesize({ text: 'hello' })).text, 'hello');
  runtime.cancel();
  runtime.dispose();
  assert.deepEqual(calls, ['cancel', 'dispose']);
  assert.equal((await runtime.capabilities()).platform, 'browser');
});

test('ElectronRuntime uses only preload methods for ready native backends', async () => {
  const calls = [];
  const api = {
    ...typedApi(),
    transcribeAudio: async payload => { calls.push(['stt', payload]); return { text: 'native' }; },
    synthKokoro: async payload => { calls.push(['tts', payload]); return { audio: 'wav' }; },
  };
  const fallback = {
    transcribe: async () => { throw new Error('fallback STT must not run'); },
    synthesize: async () => { throw new Error('fallback TTS must not run'); },
    cancel() {},
    dispose() {},
  };
  const runtime = new ElectronRuntime({ api, capabilities: nativeCapabilities(), fallback });

  assert.equal((await runtime.transcribe({ buffer: pcm() })).text, 'native');
  assert.equal((await runtime.synthesize({ text: 'hello' })).audio, 'wav');
  assert.deepEqual(calls.map(([kind]) => kind), ['stt', 'tts']);
});

test('degraded ElectronRuntime falls back without invoking native methods', async () => {
  let nativeCalls = 0;
  const api = {
    transcribeAudio: async () => { nativeCalls++; },
    synthKokoro: async () => { nativeCalls++; },
  };
  const fallback = {
    transcribe: async () => ({ text: 'browser fallback' }),
    synthesize: async () => ({ useSystemSpeech: true }),
    cancel() {},
    dispose() {},
  };
  const runtime = new ElectronRuntime({
    api,
    capabilities: nativeCapabilities({
      sttBackends: [],
      ttsBackends: [],
      selectedStt: null,
      selectedTts: null,
      ready: false,
      degradedReason: 'NATIVE_BACKEND_UNSUPPORTED_PLATFORM',
    }),
    fallback,
  });

  assert.equal((await runtime.transcribe({})).text, 'browser fallback');
  assert.equal((await runtime.synthesize({})).useSystemSpeech, true);
  assert.equal(nativeCalls, 0);
});

test('cancel rejects late Browser runtime results', async () => {
  let resolveBrowser;
  const browserResult = new Promise(resolve => { resolveBrowser = resolve; });
  const runtime = new BrowserRuntime({ transcribe: async () => browserResult });

  const pending = runtime.transcribe({});
  runtime.cancel();
  resolveBrowser({ text: 'too late' });
  await assert.rejects(pending, /RUNTIME_CANCELLED/);
});

test('cancel rejects late Electron runtime results', async () => {
  let resolveNative;
  const nativeResult = new Promise(resolve => { resolveNative = resolve; });
  const runtime = new ElectronRuntime({
    api: {
      ...typedApi(),
      transcribeAudio: async () => nativeResult,
      synthKokoro: async () => ({ audio: 'wav' }),
    },
    capabilities: nativeCapabilities(),
    fallback: { cancel() {}, dispose() {} },
  });

  const pending = runtime.transcribe({ buffer: pcm() });
  await new Promise(setImmediate); // Await normalization and actual native dispatch.
  runtime.cancel();
  resolveNative({ text: 'too late' });
  await assert.rejects(pending, /RUNTIME_CANCELLED/);
});

test('cancelled native failure never starts fallback work', async () => {
  let rejectStt;
  let rejectTts;
  let fallbackCalls = 0;
  const runtime = new ElectronRuntime({
    api: {
      ...typedApi(),
      transcribeAudio: () => new Promise((_, reject) => { rejectStt = reject; }),
      synthKokoro: () => new Promise((_, reject) => { rejectTts = reject; }),
    },
    capabilities: nativeCapabilities(),
    fallback: {
      transcribe: async () => { fallbackCalls++; return { text: 'must not run' }; },
      synthesize: async () => { fallbackCalls++; return { useSystemSpeech: true }; },
      cancel() {},
      dispose() {},
    },
  });

  const pendingStt = runtime.transcribe({ buffer: pcm() });
  const pendingTts = runtime.synthesize({ text: 'hello' });
  await new Promise(setImmediate); // Both external promises must exist before Stop.
  runtime.cancel();
  rejectStt(new Error('native stt failed late'));
  rejectTts(new Error('native tts failed late'));

  await assert.rejects(pendingStt, /RUNTIME_CANCELLED/);
  await assert.rejects(pendingTts, /RUNTIME_CANCELLED/);
  assert.equal(fallbackCalls, 0);
});

test('original validated backend completion uses the configured fallback', async () => {
  const fallback = {
    transcribe: async () => ({ text: 'fallback text' }),
    synthesize: async () => ({ useSystemSpeech: true }),
    cancel() {},
    dispose() {},
  };
  const runtime = new ElectronRuntime({
    api: {
      ...typedApi(),
      transcribeAudio: async ({ requestId }) => backendFailure(requestId),
      synthKokoro: async ({ requestId }) => backendFailure(requestId),
    },
    capabilities: nativeCapabilities(),
    fallback,
  });

  assert.equal((await runtime.transcribe({ buffer: pcm() })).text, 'fallback text');
  assert.equal((await runtime.synthesize({ text: 'hello' })).useSystemSpeech, true);
});

test('dispose rejects late runtime results', async () => {
  let resolveBrowser;
  const browserResult = new Promise(resolve => { resolveBrowser = resolve; });
  const runtime = new BrowserRuntime({ transcribe: async () => browserResult });

  const pending = runtime.transcribe({});
  runtime.dispose();
  resolveBrowser({ text: 'too late' });
  await assert.rejects(pending, /RUNTIME_CANCELLED/);
});

test('createRuntime selects browser or electron and degrades failed health safely', async () => {
  const browser = await createRuntime({ browser: {} });
  assert.equal(browser.kind, 'browser');

  const electron = await createRuntime({
    electronAPI: { runtimeHealth: async () => { throw new Error('offline'); } },
    browser: {
      transcribe: async () => ({ text: 'fallback' }),
      synthesize: async () => ({ useSystemSpeech: true }),
    },
  });
  assert.equal(electron.kind, 'electron');
  assert.equal((await electron.capabilities()).ready, false);
  assert.equal((await electron.transcribe({})).text, 'fallback');
});
