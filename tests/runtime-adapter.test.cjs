const assert = require('node:assert/strict');
const test = require('node:test');

const { BrowserRuntime } = require('../apps/web/runtime/browser-runtime.js');
const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
const { createRuntime } = require('../apps/web/runtime/create-runtime.js');

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

  assert.equal((await runtime.transcribe({ buffer: 'audio' })).text, 'native');
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

test('cancel rejects late Electron results, invokes native cancellation, and gates restart', async () => {
  let resolveNative;
  let releaseCancel;
  const nativeResult = new Promise(resolve => { resolveNative = resolve; });
  const cancelComplete = new Promise(resolve => { releaseCancel = resolve; });
  let cancelCalls = 0;
  const runtime = new ElectronRuntime({
    api: {
      transcribeAudio: async () => nativeResult,
      synthKokoro: async () => ({ audio: 'wav' }),
      cancelVoiceOperation: ({ requestId }) => {
        assert.equal(requestId, 'stt_1');
        cancelCalls++;
        return cancelComplete;
      },
    },
    capabilities: nativeCapabilities(),
    fallback: { cancel() {}, dispose() {} },
  });

  const pending = runtime.transcribe({ buffer: 'audio' });
  runtime.cancel();
  assert.equal(cancelCalls, 1);
  resolveNative({ text: 'too late' });
  await assert.rejects(pending, /RUNTIME_CANCELLED/);

  let secondFinished = false;
  const second = runtime.synthesize({ text: 'after cancel' }).then(result => {
    secondFinished = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondFinished, false);
  releaseCancel();
  assert.equal((await second).audio, 'wav');
});

test('cancelled native failure never starts fallback work', async () => {
  let rejectStt;
  let rejectTts;
  let fallbackCalls = 0;
  const runtime = new ElectronRuntime({
    api: {
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

  const pendingStt = runtime.transcribe({ buffer: 'audio' });
  const pendingTts = runtime.synthesize({ text: 'hello' });
  runtime.cancel();
  rejectStt(new Error('native stt failed late'));
  rejectTts(new Error('native tts failed late'));

  await assert.rejects(pendingStt, /RUNTIME_CANCELLED/);
  await assert.rejects(pendingTts, /RUNTIME_CANCELLED/);
  assert.equal(fallbackCalls, 0);
});

test('empty native results use the configured fallback', async () => {
  const fallback = {
    transcribe: async () => ({ text: 'fallback text' }),
    synthesize: async () => ({ useSystemSpeech: true }),
    cancel() {},
    dispose() {},
  };
  const runtime = new ElectronRuntime({
    api: {
      transcribeAudio: async () => ({ text: '   ' }),
      synthKokoro: async () => ({}),
    },
    capabilities: nativeCapabilities(),
    fallback,
  });

  assert.equal((await runtime.transcribe({ buffer: 'audio' })).text, 'fallback text');
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

test('createRuntime selects browser fallback when Electron native health is unavailable', async () => {
  const browser = await createRuntime({ browser: {} });
  assert.equal(browser.kind, 'browser');

  const degraded = await createRuntime({
    electronAPI: { runtimeHealth: async () => { throw new Error('offline'); } },
    browser: {
      transcribe: async () => ({ text: 'fallback' }),
      synthesize: async () => ({ useSystemSpeech: true }),
    },
  });
  assert.equal(degraded.kind, 'browser');
  assert.equal((await degraded.capabilities()).ready, true);
  assert.equal((await degraded.transcribe({})).text, 'fallback');
});

test('createRuntime selects ElectronRuntime for valid Windows provider health', async () => {
  const runtime = await createRuntime({
    electronAPI: {
      runtimeHealth: async () => nativeCapabilities({
        platform: 'windows',
        arch: 'x64',
        sttBackends: ['faster-whisper'],
        ttsBackends: ['kokoro-onnx'],
        selectedStt: 'faster-whisper',
        selectedTts: 'kokoro-onnx',
        executionProvider: 'CPUExecutionProvider',
      }),
      transcribeAudio: async () => ({ text: 'native' }),
      synthKokoro: async () => ({ audio: 'wav' }),
      voiceCancel: async () => {},
    },
    browser: {},
  });
  assert.equal(runtime.kind, 'electron');
  assert.equal((await runtime.capabilities()).executionProvider, 'CPUExecutionProvider');
});

test('Windows Electron native unavailable returns System Voice fallback without calling fallback synthesize', async () => {
  let fallbackSynthCalls = 0;
  const api = {
    synthKokoro: async () => { throw new Error('sidecar down'); },
  };
  const fallback = {
    synthesize: async () => {
      fallbackSynthCalls++;
      return { audio: 'from-browser-kokoro' };
    },
    cancel() {},
    dispose() {},
  };
  const runtime = new ElectronRuntime({
    api,
    capabilities: {
      protocol: 1,
      platform: 'windows',
      arch: 'x64',
      sttBackends: ['faster-whisper'],
      ttsBackends: [],
      selectedStt: 'faster-whisper',
      selectedTts: null,
      ready: false,
      degradedReason: 'BACKEND_UNAVAILABLE',
    },
    fallback,
  });

  const result = await runtime.synthesize({ text: 'test' });
  assert.equal(result.useSystemSpeech, true);
  assert.equal(fallbackSynthCalls, 0, 'Must NOT invoke renderer/browser Kokoro fallback on Windows Electron');
});
