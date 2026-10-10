const test = require('node:test');
const assert = require('node:assert/strict');
const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
const { encodePcmWav, isNativePcmWav } = require('../apps/web/runtime/native-audio.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(setImmediate);
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
function backendFailure({ requestId }) {
  const binding = { clientId: 'original-client', intentId: 'original-intent', generation: 1 };
  return { version: 1, type: 'failure', requestId, code: 'backend-error', message: 'native error', binding,
    completion: { version: 1, type: 'state', requestId, knowledge: 'known', revision: 3, logical: 'settled',
      revocation: 'live', receipt: { status: 'completed', binding }, cleanup: 'released',
      failure: { code: 'backend-error', message: 'native error' } } };
}
const decodedAudio = () => ({ sampleRate: 16000, length: 1, numberOfChannels: 1,
  getChannelData: () => new Float32Array([0.5]) });

test('mlx-whisper normalizes compressed views to owned PCM before typed IPC', async t => {
  const codec = installCodec(t);
  const { runtime, ipc, fallback } = fixture({ selectedStt: 'mlx-whisper', platform: 'darwin' });
  const source = new Uint8Array([99, 1, 2, 3, 88]);
  assert.equal((await runtime.transcribe({ buffer: source.subarray(1, 4), mimeType: 'audio/mp4' })).text, 'native');
  assert.equal(ipc[0].mimeType, 'audio/wav');
  assert.equal(isNativePcmWav(ipc[0].buffer), true);
  assert.deepEqual([...new Int16Array(ipc[0].buffer.buffer, 44)], [-32768, 0, 32767]);
  assert.deepEqual([...source], [99, 1, 2, 3, 88]);
  assert.equal(codec.decodes, 1); assert.equal(codec.closes, 1);
  assert.equal(fallback.length, 0);
  const wav = encodePcmWav(new Float32Array([0.5]));
  await runtime.transcribe({ buffer: wav });
  assert.notEqual(ipc[1].buffer, wav);
  assert.deepEqual(ipc[1].buffer, wav);
  assert.equal(codec.decodes, 1);
});

for (const selectedStt of ['faster-whisper', 'mlx-whisper']) {
for (const action of ['cancel', 'dispose']) {
  for (const phase of ['blob', 'decode', 'close']) {
    for (const outcome of ['resolve', 'reject']) {
      test(`${selectedStt} ${action} while awaiting ${phase}/${outcome} prevents late IPC/fallback and releases codec`, async t => {
        const gate = deferred(), entered = deferred();
        const { runtime, ipc, fallback } = fixture({ selectedStt });
        const codec = installCodec(t, {
          decode: () => {
            if (phase === 'decode') { entered.resolve(); return gate.promise; }
            return decodedAudio();
          },
          close: () => { if (phase === 'close') { entered.resolve(); return gate.promise; } },
        });
        const payload = phase === 'blob' ? { audioBlob: { arrayBuffer() { entered.resolve(); return gate.promise; } } }
          : { buffer: new Uint8Array([1, 2, 3]) };
        const pending = runtime.transcribe(payload);
        const settled = pending.then(value => ({ value }), error => ({ error }));
        await entered.promise;
        const stopped = runtime[action]();
        const stopResult = stopped.then(() => null, error => error);
        await tick();
        const closesBeforeSettlement = codec.closes;
        if (outcome === 'reject') gate.reject(new Error('late boundary failure'));
        else gate.resolve(phase === 'blob' ? new Uint8Array([1, 2, 3]).buffer : decodedAudio());
        const result = await settled;
        assert.match(result.error?.message || 'unexpected success', /RUNTIME_CANCELLED/);
        assert.equal(ipc.length, 0);
        assert.equal(fallback.length, 0);
        assert.equal(codec.closes, phase === 'blob' ? 0 : 1);
        if (phase === 'decode') assert.equal(closesBeforeSettlement, 1, 'abort closes even an unsettled codec');
        const stopError = await stopResult;
        if (phase === 'close' && outcome === 'reject') {
          assert.match(stopError?.message || '', /VOICE_CLEANUP_UNCERTAIN/);
          await assert.rejects(runtime.transcribe({}), /VOICE_CLEANUP_UNCERTAIN/);
        } else if (action === 'cancel') {
          assert.equal(stopError, null);
          assert.equal((await runtime.transcribe({ buffer: encodePcmWav(new Float32Array([0])) })).text, 'native');
          assert.equal(ipc.length, 1);
        } else await assert.rejects(runtime.transcribe({}), /RUNTIME_DISPOSED/);
      });
    }
  }
}

for (const phase of ['blob', 'construct', 'decode', 'close']) {
  test(`${selectedStt} conversion owns cancellation before synchronous ${phase} callback reentry; fresh work survives`, async t => {
    const { runtime, ipc, fallback } = fixture({ selectedStt });
    let fresh;
    const reenter = () => {
      const stop = runtime.cancel();
      // C6 closes admission until confirmation; only explicit work AFTER that barrier is fresh.
      fresh = stop.then(() => runtime.transcribe({ buffer: encodePcmWav(new Float32Array([0])) }));
    };
    const codec = installCodec(t, {
      construct: () => { if (phase === 'construct') reenter(); },
      decode: () => { if (phase === 'decode') reenter(); return decodedAudio(); },
      close: () => { if (phase === 'close') reenter(); },
    });
    const payload = phase === 'blob' ? { audioBlob: { arrayBuffer() {
      reenter(); return Promise.resolve(new Uint8Array([1, 2, 3]).buffer);
    } } } : { buffer: new Uint8Array([1, 2, 3]) };
    await assert.rejects(runtime.transcribe(payload), /RUNTIME_CANCELLED/);
    assert.equal((await fresh).text, 'native');
    assert.equal(ipc.length, 1);
    assert.equal(fallback.length, 0);
    assert.equal(codec.closes, phase === 'blob' ? 0 : 1);
  });
}

}

test('direct helper rejects pre-abort and abort during close, with one resource release', async () => {
  const { normalizeNativeAudio } = require('../apps/web/runtime/native-audio.js');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(normalizeNativeAudio(encodePcmWav(new Float32Array([0])), {
    signal: controller.signal, audioContextFactory: () => assert.fail('pre-abort creates no context'),
  }), /RUNTIME_CANCELLED/);
  const duringClose = new AbortController();
  let closes = 0;
  await assert.rejects(normalizeNativeAudio(new Uint8Array([1]), {
    signal: duringClose.signal, audioContextFactory: () => ({
      decodeAudioData: async () => decodedAudio(),
      close: async () => { closes++; duringClose.abort(); },
    }),
  }), /RUNTIME_CANCELLED/);
  assert.equal(closes, 1);
});

function fixture(overrides = {}) {
  const ipc = [], fallback = [];
  const runtime = new ElectronRuntime({
    capabilities: { ready: true, selectedStt: 'faster-whisper', ...overrides },
    api: { ...typedApi(), transcribeAudio: async payload => { ipc.push(payload); return { text: 'native' }; } },
    fallback: { transcribe: async payload => { fallback.push(payload); return { text: 'fallback' }; } },
  });
  return { runtime, ipc, fallback };
}

// Only the browser codec boundary is doubled; use the actual helper and adapter.
function installCodec(t, options = {}) {
  const previous = global.AudioContext;
  const state = { closes: 0, decodes: 0 };
  global.AudioContext = class {
    constructor(config) { assert.deepEqual(config, { sampleRate: 16000 }); options.construct?.(); }
    async decodeAudioData(bytes) {
      state.decodes++;
      if (options.decode) return options.decode(bytes);
      assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3]);
      return { sampleRate: 16000, length: 3, numberOfChannels: 1,
        getChannelData: () => new Float32Array([-1, 0, 1]) };
    }
    async close() { state.closes++; return options.close?.(); }
    resume() { assert.fail('no playback resume'); }
  };
  t.after(() => { if (previous) global.AudioContext = previous; else delete global.AudioContext; });
  return state;
}

for (const selectedStt of ['faster-whisper', 'mlx-whisper']) {
test(`${selectedStt} ordinary codec failures release local slots; a real close failure retains the exact resource`, async t => {
  const closeGate = deferred(); let failClose = false;
  const codec = installCodec(t, { decode: () => { throw new Error('ordinary decode'); },
    close: () => failClose ? closeGate.promise : undefined });
  const { runtime, ipc, fallback } = fixture({ selectedStt });
  for (let i = 0; i < 40; i++) {
    await assert.rejects(runtime.transcribe({ audioBlob: { arrayBuffer: async () => new Uint8Array([1]).buffer } }), /ordinary decode/);
    assert.equal(runtime.fault, null); assert.equal(runtime._scope.records.size, 0);
  }
  failClose = true;
  const work = runtime.transcribe({ audioBlob: { arrayBuffer: async () => new Uint8Array([1]).buffer } }).catch(e => e);
  await tick(); const record = [...runtime._scope.records][0];
  assert.equal(typeof record.release, 'function'); assert.equal(record.localPending, true);
  closeGate.reject(new Error('real close failure'));
  assert.match((await work).message, /real close failure/);
  assert.match(runtime.fault.message, /VOICE_CLEANUP_UNCERTAIN/);
  assert.equal(runtime._scope.records.has(record), true);
  assert.equal(typeof record.release, 'function');
  assert.equal(codec.closes, 41); assert.equal(ipc.length, 0); assert.equal(fallback.length, 0);
  await assert.rejects(runtime.cancel(), /VOICE_CLEANUP_UNCERTAIN/);
});

test(`${selectedStt} hung codec close is bounded and retained, not dropped or misclassified as ordinary decode`, async t => {
  const closeGate = deferred();
  installCodec(t, { close: () => closeGate.promise });
  const { runtime, ipc, fallback } = fixture({ selectedStt });
  const work = runtime.transcribe({ buffer: new Uint8Array([1]) }).catch(e => e);
  await tick();
  const record = [...runtime._scope.records][0];
  const stop = runtime.cancel();
  await assert.rejects(stop, /VOICE_CLEANUP_UNCERTAIN/);
  assert.match((await work).message, /RUNTIME_CANCELLED/);
  assert.equal(runtime._scope.records.has(record), true);
  assert.equal(typeof record.release, 'function');
  closeGate.resolve(); await tick();
  assert.equal(runtime._scope.records.has(record), true);
  assert.equal(ipc.length, 0); assert.equal(fallback.length, 0);
});

}

test('oversized Blob is rejected before allocating its bytes or opening a codec', async () => {
  const { runtime, ipc, fallback } = fixture();
  let reads = 0;
  await assert.rejects(runtime.transcribe({ audioBlob: { size: 25 * 1024 * 1024 + 1,
    arrayBuffer() { reads++; return Promise.resolve(new Uint8Array([1]).buffer); },
  } }), /AUDIO_PAYLOAD_TOO_LARGE/);
  assert.equal(reads, 0);
  assert.equal(ipc.length, 0);
  assert.equal(fallback.length, 0);
});

test('page loader and offline shell include lazy native PCM dependency before Electron adapter', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const web = path.resolve(__dirname, '../apps/web');
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^\"]+)"[^>]*><\/script>/g)].map(match => match[1]);
  const helperIndex = scripts.indexOf('./runtime/native-audio.js');
  assert.ok(helperIndex >= 0, 'helper script must be in the page loader');
  assert.ok(helperIndex < scripts.indexOf('./runtime/electron-runtime.js'));
  let contexts = 0;
  // Browser global/codec boundary double; execute the real UMD modules, no require.
  const sandbox = vm.createContext({ Object, Array, ArrayBuffer, Uint8Array, Float32Array, DataView, AbortController,
    crypto: require('node:crypto').webcrypto, setTimeout, clearTimeout,
    AudioContext: class {
      constructor(options) { contexts++; assert.equal(options.sampleRate, 16000); }
      decodeAudioData() { return Promise.resolve(decodedAudio()); }
      close() { return Promise.resolve(); }
    },
    fetch() { assert.fail('normalizer must not use network'); },
  });
  const dependencies = ['./runtime/native-audio.js', './runtime/desktop-voice-operation-contract.js',
    './runtime/desktop-voice-work-scope.js', './runtime/electron-runtime.js'];
  assert.deepEqual(scripts.filter(file => dependencies.includes(file)), dependencies);
  for (const file of dependencies) {
    vm.runInContext(fs.readFileSync(path.join(web, file), 'utf8'), sandbox);
  }
  assert.equal(contexts, 0, 'loading scripts must not allocate an AudioContext');
  let ipc;
  const runtime = new sandbox.VoiceElectronRuntime.ElectronRuntime({
    capabilities: { ready: true, selectedStt: 'faster-whisper' },
    api: { ...typedApi(), transcribeAudio: async payload => { ipc = payload; return { text: 'native' }; } },
  });
  assert.equal((await runtime.transcribe({ buffer: new Uint8Array([1]) })).text, 'native');
  assert.equal(isNativePcmWav(ipc.buffer), true);
  assert.equal(contexts, 1);

  const worker = fs.readFileSync(path.join(web, 'service-worker.js'), 'utf8');
  const events = {};
  const scope = 'https://fixture.invalid/app/';
  const url = new URL('./runtime/native-audio.js', scope).href;
  const cachedHelper = { fixture: 'offline helper response' };
  const workerContext = vm.createContext({ URL, Set, Object,
    self: { registration: { scope }, location: { origin: new URL(scope).origin },
      addEventListener: (name, callback) => { events[name] = callback; } },
    caches: { open: async () => ({ match: async request => request.url === url ? cachedHelper : undefined }) },
    fetch() { assert.fail('cached helper must work offline'); },
  });
  vm.runInContext(worker, workerContext);
  assert.notEqual(vm.runInContext('APP_CACHE', workerContext), 'voice-practice-app-v25-20260907');
  assert.equal(vm.runInContext('CORE_ASSETS.includes("./runtime/native-audio.js")', workerContext), true);
  let response;
  events.fetch({ request: { url, method: 'GET', mode: 'same-origin', headers: new Headers() },
    respondWith(promise) { response = promise; } });
  assert.ok(response, 'helper must be handled by offline allowlist');
  assert.equal(await response, cachedHelper);
});

test('faster-whisper converts compressed Blob/view bytes before IPC regardless of OS', async t => {
  const codec = installCodec(t);
  for (const platform of ['win32', 'linux', 'darwin', undefined]) {
    const { runtime, ipc, fallback } = fixture({ platform });
    const source = new Uint8Array([99, 1, 2, 3, 88]);
    for (const payload of [
      { audioBlob: new Blob([source.subarray(1, 4)], { type: 'audio/webm' }) },
      { buffer: source.subarray(1, 4), mimeType: 'audio/mp4', language: 'en' },
    ]) {
      assert.equal((await runtime.transcribe(payload)).text, 'native');
      assert.equal(ipc.at(-1).mimeType, 'audio/wav');
      assert.equal(ipc.at(-1).language, 'en');
      assert.equal(isNativePcmWav(ipc.at(-1).buffer), true);
      assert.deepEqual([...new Int16Array(ipc.at(-1).buffer.buffer, 44)], [-32768, 0, 32767]);
    }
    assert.deepEqual([...source], [99, 1, 2, 3, 88]);
    assert.equal(fallback.length, 0);
  }
  assert.equal(codec.decodes, 8);
  assert.equal(codec.closes, 8);
});

test('conversion failures surface without fallback; other STT formats and fallback policy stay unchanged', async t => {
  installCodec(t, { decode: () => { throw new Error('codec failure'); } });
  const { runtime, ipc, fallback } = fixture();
  await assert.rejects(runtime.transcribe({ buffer: new Uint8Array([1]), mimeType: 'audio/webm' }), /codec failure/);
  await assert.rejects(runtime.transcribe({ audioBlob: { arrayBuffer: async () => { throw new Error('Blob failure'); } } }), /Blob failure/);
  assert.equal(ipc.length, 0);
  assert.equal(fallback.length, 0);
  for (const selectedStt of ['mlx-whisper', 'whisper.cpp']) {
    const other = fixture({ selectedStt });
    const payload = { buffer: selectedStt === 'mlx-whisper' ? encodePcmWav(new Float32Array([0])) : new Uint8Array([1]), mimeType: 'audio/mp4' };
    assert.equal((await other.runtime.transcribe(payload)).text, 'native');
    if (selectedStt === 'mlx-whisper') {
      assert.notEqual(other.ipc[0].buffer, payload.buffer);
      assert.deepEqual(other.ipc[0].buffer, payload.buffer);
      assert.equal(other.ipc[0].mimeType, 'audio/wav');
    } else {
      assert.equal(other.ipc[0].buffer, payload.buffer);
      assert.equal(other.ipc[0].mimeType, 'audio/mp4');
    }
    other.runtime._api.transcribeAudio = async payload => backendFailure(payload);
    assert.equal((await other.runtime.transcribe(payload)).text, 'fallback');
  }
  // Ordinary post-IPC backend policy remains, but only original C6 completion permits it.
  runtime._api.transcribeAudio = async payload => backendFailure(payload);
  assert.equal((await runtime.transcribe({ buffer: encodePcmWav(new Float32Array([0])) })).text, 'fallback');
});
