const test = require('node:test');
const assert = require('node:assert/strict');
const { DesktopVoiceWorkScope } = require('../apps/web/runtime/desktop-voice-work-scope.js');
const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
const { encodePcmWav } = require('../apps/web/runtime/native-audio.js');
const pcm = () => encodePcmWav(new Float32Array([0, 0.5]));
const tick = () => new Promise(setImmediate);
function gate() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function bridge() {
  const batches = [], retired = new Set();
  return { batches,
    voiceOperationRevoke: async ({ requestIds }) => {
      batches.push([...requestIds]); requestIds.forEach(id => retired.add(id));
      return { version: 1, type: 'revoked', requestIds };
    },
    voiceOperationState: async ({ requestId }) => ({ version: 1, type: 'state', requestId,
      knowledge: retired.has(requestId) ? 'retired' : 'unknown' }),
  };
}
function failure(requestId) {
  const binding = { clientId: 'original', intentId: 'intent', generation: 1 };
  return { version: 1, type: 'failure', requestId, code: 'backend-error', message: 'backend failed', binding,
    completion: { version: 1, type: 'state', requestId, knowledge: 'known', revision: 3,
      logical: 'settled', revocation: 'live', receipt: { status: 'completed', binding }, cleanup: 'released',
      failure: { code: 'backend-error', message: 'backend failed' } } };
}

test('bridge-wide 32-slot limit cannot be bypassed by adapter replacement', async () => {
  const api = bridge(), first = new DesktopVoiceWorkScope(api), second = new DesktopVoiceWorkScope(api);
  for (let i = 0; i < 16; i++) { first.begin(false); second.begin(false); }
  assert.throws(() => new DesktopVoiceWorkScope(api).begin(false), /VOICE_CLEANUP_UNCERTAIN/);
  await assert.rejects(first.stop(), /VOICE_CLEANUP_UNCERTAIN/);
  await assert.rejects(second.stop(), /VOICE_CLEANUP_UNCERTAIN/);
});

test('pre-admission revoke overtakes held Blob; late resolution dispatches no original IPC', async () => {
  const held = gate(), api = bridge(); let native = 0;
  api.transcribeAudio = async () => { native++; return { text: 'forbidden' }; };
  const runtime = new ElectronRuntime({ api, capabilities: { ready: true, selectedStt: 'mlx-whisper' } });
  const work = runtime.transcribe({ audioBlob: { arrayBuffer: () => held.promise } }).catch(e => e);
  await tick();
  const original = [...runtime._scope.records][0].requestId;
  const stop = runtime.cancel(); await tick();
  assert.deepEqual(api.batches, [[original]]);
  assert.equal(runtime._scope.records.size, 1);
  held.resolve(new ArrayBuffer(1)); await stop;
  assert.match((await work).message, /RUNTIME_CANCELLED/);
  assert.equal(native, 0);
});

for (const mode of ['partial-ack', 'unknown', 'bad-state', 'transport', 'revision']) test(`${mode} cannot confirm Stop`, async () => {
  const api = bridge(), scope = new DesktopVoiceWorkScope(api), record = scope.begin(true);
  scope.begin(true);
  if (mode === 'partial-ack') api.voiceOperationRevoke = async ({ requestIds }) => ({ version: 1, type: 'revoked', requestIds: requestIds.slice(0, 1) });
  if (mode === 'transport') api.voiceOperationRevoke = async () => { throw new Error('transport'); };
  if (mode === 'unknown' || mode === 'bad-state') api.voiceOperationState = async ({ requestId }) =>
    mode === 'unknown' ? { version: 1, type: 'state', requestId, knowledge: 'unknown' } : {};
  if (mode === 'revision') {
    record.revision = 9;
    api.voiceOperationState = async ({ requestId }) => ({ ...failure(requestId).completion, revocation: 'revoked', revision: 8 });
  }
  await assert.rejects(scope.stop(), /VOICE_CLEANUP_UNCERTAIN/);
  assert.equal(scope.records.size, 2);
});

test('original proof retained across retired observation is rechecked AFTER fallback await', async () => {
  const api = bridge(), held = gate(); let calls = 0;
  api.transcribeAudio = async ({ requestId }) => failure(requestId);
  const runtime = new ElectronRuntime({ api, capabilities: { ready: true, selectedStt: 'mlx-whisper' },
    fallback: { transcribe: () => { calls++; return held.promise; } } });
  const work = runtime.transcribe({ buffer: pcm() }).catch(e => e);
  await tick();
  const record = [...runtime._scope.records][0], original = record.proof;
  api.voiceOperationState = async ({ requestId }) => ({ version: 1, type: 'state', requestId, knowledge: 'retired' });
  await runtime._scope.observe(record);
  assert.equal(record.proof, original); assert.equal(calls, 1);
  runtime._scope.fail(); held.resolve({ text: 'late success' });
  assert.match((await work).message, /VOICE_CLEANUP_UNCERTAIN/);
  await assert.rejects(runtime.cancel(), /VOICE_CLEANUP_UNCERTAIN/);
  assert.deepEqual(api.batches, []);
});

test('bounded fallback drain timeout retains ownership and never permits replacement work', async () => {
  const api = bridge(), held = gate();
  const runtime = new ElectronRuntime({ api, capabilities: { ready: false }, fallback: { transcribe: () => held.promise } });
  const work = runtime.transcribe({}).catch(e => e); await tick();
  await assert.rejects(runtime.cancel(), /VOICE_CLEANUP_UNCERTAIN/);
  assert.equal(runtime._scope.records.size, 1);
  assert.throws(() => new DesktopVoiceWorkScope(api).begin(false), /VOICE_CLEANUP_UNCERTAIN/);
  held.resolve({ text: 'too late' }); assert.match((await work).message, /RUNTIME_CANCELLED/);
  assert.equal(runtime._scope.records.size, 1, 'late settlement cannot upgrade failed Stop');
});

test('Stop installs one join before callback reentry and never joins itself', async () => {
  const scope = new DesktopVoiceWorkScope(bridge());
  scope.begin(true);
  let joined;
  const stop = scope.stop(() => { joined = scope.stop(); return joined; });
  assert.equal(stop, joined);
  assert.equal(stop, scope.stop());
  await stop;
  assert.equal(scope.domain.fault, null);
});

test('32 slots include pre-admission work; overflow is sticky but Stop revokes the COMPLETE batch', async () => {
  const api = bridge(), scope = new DesktopVoiceWorkScope(api);
  const records = Array.from({ length: 32 }, () => scope.begin(true));
  assert.throws(() => scope.begin(false), /VOICE_CLEANUP_UNCERTAIN/);
  await assert.rejects(scope.stop(), /VOICE_CLEANUP_UNCERTAIN/);
  assert.deepEqual(api.batches, [records.map(r => r.requestId)]);
  assert.equal(scope.records.size, 32, 'uncertainty retains bounded ownership');
  assert.throws(() => new DesktopVoiceWorkScope(api).begin(false), /VOICE_CLEANUP_UNCERTAIN/);
});

test('all records revoked before abort callback throws/reenters; complete batch still submitted', async () => {
  const api = bridge(), scope = new DesktopVoiceWorkScope(api);
  const records = [scope.begin(true), scope.begin(false), scope.begin(true)];
  let callbacks = 0, joined;
  for (const r of records) r.controller = { abort() {
    assert.ok(records.every(record => record.revoked));
    assert.throws(() => scope.begin(false), /RUNTIME_CANCELLED|VOICE_CLEANUP_UNCERTAIN/);
    joined = scope.stop(); callbacks++;
    if (callbacks === 1) throw new Error('local callback failed');
  } };
  const stop = scope.stop();
  assert.equal(stop, joined);
  await assert.rejects(stop, /VOICE_CLEANUP_UNCERTAIN/);
  assert.equal(callbacks, 3);
  assert.deepEqual(api.batches, [[records[0].requestId, records[2].requestId]]);
});

for (const invalidate of ['fault', 'epoch', 'stop']) test(`original completion survives retired observation, but current ${invalidate} denies fallback`, async () => {
  const api = bridge(), scope = new DesktopVoiceWorkScope(api), record = scope.begin(true);
  scope.failure(record, failure(record.requestId));
  const original = record.proof;
  api.voiceOperationState = async ({ requestId }) => ({ version: 1, type: 'state', requestId, knowledge: 'retired' });
  await scope.observe(record);
  assert.equal(record.proof, original);
  scope.check(record);
  if (invalidate === 'fault') scope.fail();
  if (invalidate === 'epoch') scope.epoch++;
  if (invalidate === 'stop') await scope.stop();
  assert.throws(() => scope.check(record), /RUNTIME_CANCELLED|VOICE_CLEANUP_UNCERTAIN/);
  assert.deepEqual(api.batches, [], 'original released completion must not be resent');
});

for (const reply of ['empty', 'whitespace', 'raw-error', 'missing-proof']) test(`${reply} cannot manufacture backend fallback proof`, async () => {
  let fallbacks = 0;
  const api = bridge();
  api.transcribeAudio = async ({ requestId }) => {
    if (reply === 'raw-error') throw new Error('backend failed');
    if (reply === 'missing-proof') return { ...failure(requestId), completion: null };
    return reply === 'empty' ? {} : { text: '   ' };
  };
  const runtime = new ElectronRuntime({ api, capabilities: { ready: true, selectedStt: 'mlx-whisper' },
    fallback: { transcribe: () => { fallbacks++; return { text: 'unsafe' }; } } });
  await assert.rejects(runtime.transcribe({ buffer: pcm() }), /VOICE_CLEANUP_UNCERTAIN/);
  assert.equal(fallbacks, 0);
  await assert.rejects(runtime.cancel(), /VOICE_CLEANUP_UNCERTAIN/);
  assert.equal(api.batches[0].length, 1);
});

test('native-unavailable Stop aborts and DRAINS local fallback before releasing ownership', async () => {
  const held = gate(); let signal, cancels = 0;
  const api = bridge();
  const runtime = new ElectronRuntime({ api, capabilities: { ready: false }, fallback: {
    transcribe: payload => { signal = payload.signal; return held.promise; }, cancel: () => { cancels++; },
  } });
  const work = runtime.transcribe({}).catch(error => error);
  await tick();
  const stop = runtime.cancel(); let stopped = false; stop.then(() => { stopped = true; });
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(stopped, false, 'not just abort requested: local fallback must drain');
  assert.equal(runtime._scope.records.size, 1);
  held.resolve({ text: 'stale' });
  assert.match((await work).message, /RUNTIME_CANCELLED/);
  await stop;
  assert.equal(cancels, 1);
  assert.equal(runtime._scope.records.size, 0);
  assert.deepEqual(api.batches, []);
});

test('dispose arriving during held observe is still joined before Stop resolves', async () => {
  const observed = gate(), disposed = gate(), api = bridge(); let entered = false, disposing = false;
  api.voiceOperationState = async ({ requestId }) => { entered = true; await observed.promise;
    return { version: 1, type: 'state', requestId, knowledge: 'retired' }; };
  const runtime = new ElectronRuntime({ api, capabilities: { ready: false }, fallback: {
    dispose: () => { disposing = true; return disposed.promise; },
  } });
  runtime._scope.begin(true);
  const stop = runtime.cancel(); await tick(); assert.equal(entered, true);
  assert.equal(runtime.dispose(), stop); assert.equal(disposing, true);
  let settled = false; stop.then(() => { settled = true; });
  observed.resolve(); await tick();
  assert.equal(settled, false, 'late disposal is a cleanup obligation, not a detached side effect');
  disposed.resolve(); await stop;
});

test('dispose joins Stop and executes owned cleanup even if cancel fails', async () => {
  const disposed = gate(); let calls = 0;
  const runtime = new ElectronRuntime({ api: bridge(), capabilities: { ready: false }, fallback: {
    cancel: () => { throw new Error('cancel failed'); }, dispose: () => { calls++; return disposed.promise; },
  } });
  const stop = runtime.cancel(), dispose = runtime.dispose();
  const outcome = dispose.catch(error => error);
  assert.equal(dispose, stop);
  assert.equal(runtime.dispose(), stop);
  await tick();
  assert.equal(calls, 1);
  disposed.resolve();
  assert.match((await outcome).message, /VOICE_CLEANUP_UNCERTAIN/);
});
