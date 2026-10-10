const assert = require('node:assert/strict');
const test = require('node:test');
const contract = require('../apps/web/runtime/runtime-contract.js');
const schema = require('../contracts/voice-runtime.schema.json');
const { normalizeRuntimeCapabilities } = contract;
const capability = () => ({
  protocol: 1, platform: 'win32', arch: 'x64',
  sttBackends: ['faster-whisper'], ttsBackends: ['kokoro-onnx'],
  selectedStt: 'faster-whisper', selectedTts: 'kokoro-onnx',
  ready: true, degradedReason: null,
});
const allowed = ['CPUExecutionProvider', 'DmlExecutionProvider', 'CUDAExecutionProvider', null];

test('execution provider schema is optional and narrowly enumerated', () => {
  assert.deepEqual(schema.properties.executionProvider, {
    type: ['string', 'null'], enum: allowed,
  });
  assert.equal(schema.required.includes('executionProvider'), false);
  assert.equal(schema.additionalProperties, false);
});

for (const value of [...allowed, '', 'cpu', 'dml', 'cuda', 'CudaExecutionProvider', 'TensorrtExecutionProvider', 'UnknownExecutionProvider', 1, true, {}, [], undefined]) {
  test(`execution provider schema/runtime field parity: ${JSON.stringify(value)}`, () => {
    const input = { ...capability(), executionProvider: value };
    const result = normalizeRuntimeCapabilities(input);
    const accepted = allowed.includes(value);
    assert.equal(schema.properties.executionProvider.enum.includes(value), accepted);
    assert.equal(result.ready, accepted);
    assert.equal(result.executionProvider, accepted ? value : null);
    assert.equal(result.degradedReason, accepted ? null : 'INVALID_CAPABILITY_RESPONSE');
    if (!accepted) {
      assert.equal(result.selectedStt, null);
      assert.equal(result.selectedTts, null);
    }
    assert.ok(Object.isFrozen(result));
    assert.equal(input.executionProvider, value);
  });
}

test('legacy payload without executionProvider stays ready and reports unknown placement', () => {
  const result = normalizeRuntimeCapabilities(capability());
  assert.equal(result.ready, true);
  assert.equal(result.executionProvider, null);
});

test('inherited execution provider values are absent metadata, not placement', () => {
  for (const value of ['CPUExecutionProvider', 'UNDECLARED_EXECUTION_PROVIDER']) {
    const input = Object.assign(Object.create({ executionProvider: value }), capability());
    const result = normalizeRuntimeCapabilities(input);
    assert.equal(result.ready, true);
    assert.equal(result.executionProvider, null);
  }
});

test('normalization never reads an inherited execution provider getter', () => {
  let reads = 0;
  const prototype = Object.defineProperty({}, 'executionProvider', {
    get() { reads += 1; return 'DmlExecutionProvider'; },
  });
  const result = normalizeRuntimeCapabilities(Object.assign(Object.create(prototype), capability()));
  assert.equal(reads, 0);
  assert.equal(result.executionProvider, null);
});

test('execution provider validation and output use one owned value snapshot', () => {
  let reads = 0;
  const input = Object.defineProperty(capability(), 'executionProvider', {
    enumerable: true,
    get() { reads += 1; return reads === 1 ? 'CPUExecutionProvider' : 'UNDECLARED_EXECUTION_PROVIDER'; },
  });
  const result = normalizeRuntimeCapabilities(input);
  assert.equal(reads, 1);
  assert.equal(result.ready, true);
  assert.equal(result.executionProvider, 'CPUExecutionProvider');
});

test('unknown metadata still fails closed even alongside a valid provider', () => {
  for (const metadata of [{ providerDevice: 'gpu' }, { protocolVersion: 1 }, { fake: 'yes' }, { whisperModel: {} }, { capabilities: ['tts', 'tts'] }]) {
    const result = normalizeRuntimeCapabilities({ ...capability(), executionProvider: allowed[0], ...metadata });
    assert.equal(result.ready, false);
    assert.equal(result.degradedReason, 'INVALID_CAPABILITY_RESPONSE');
    assert.equal(result.executionProvider, null);
  }
});

test('C5a does not restore retired backend exports or accept new platform backend IDs', () => {
  assert.deepEqual(Object.keys(contract), ['normalizeRuntimeCapabilities']);
  const result = normalizeRuntimeCapabilities({
    ...capability(), sttBackends: ['future-stt'], selectedStt: 'future-stt', executionProvider: allowed[1],
  });
  assert.equal(result.ready, false);
  assert.match(result.degradedReason, /^UNSUPPORTED_BACKEND:/);
  assert.equal(result.executionProvider, null);
});
