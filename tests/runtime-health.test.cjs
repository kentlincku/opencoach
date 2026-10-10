const assert = require('node:assert/strict');
const test = require('node:test');
const { isHealthyRuntimeResponse } = require('../apps/desktop/runtime-health.cjs');
const { isCompatibleRuntimeProbe } = require('../apps/desktop/runtime-health.cjs');

test('probe cannot expand trusted artifact platform architecture pairs', () => {
  for (const [expectedPlatform, platform, arch] of [['win32', 'windows', 'arm64'], ['darwin', 'darwin', 'x64']]) {
    assert.equal(isCompatibleRuntimeProbe({probeVersion: 1, protocol: 1, platform, arch, executable: true}, expectedPlatform, arch), false);
  }
});

test('probe validates executable compatibility independently of speech-ready', () => {
  const good = {probeVersion: 1, protocol: 1, platform: 'windows', arch: 'x64', executable: true};
  assert.equal(typeof isCompatibleRuntimeProbe, 'function');
  assert.equal(isCompatibleRuntimeProbe(good, 'win32', 'x64'), true);
  assert.equal(isHealthyRuntimeResponse(good), false);
  assert.equal(isCompatibleRuntimeProbe({...good, platform: 'darwin', arch: 'arm64'}, 'darwin', 'arm64'), true);
  for (const raw of [null, [], {}, true, {...good, ready: false}, {...good, protocolVersion: 1},
    {...good, protocol: '1'}, {...good, probeVersion: 2}, {...good, executable: 1},
    {...good, platform: 'win32'}, {...good, arch: 'amd64'}, {...good, protocol: 2},
    {...good, arch: undefined}, Object.assign(Object.create(good), {})]) {
    assert.equal(isCompatibleRuntimeProbe(raw, 'win32', 'x64'), false);
  }
  assert.equal(isCompatibleRuntimeProbe(good, 'linux', 'x64'), false);
  assert.equal(isCompatibleRuntimeProbe(good, 'windows', 'x64'), false);
});

const capability = () => ({
  protocol: 1, platform: 'win32', arch: 'x64', ready: true, degradedReason: null,
  sttBackends: ['faster-whisper'], ttsBackends: ['kokoro-onnx'],
  selectedStt: 'faster-whisper', selectedTts: 'kokoro-onnx',
});

test('health accepts canonical protocol with optional CPU/DirectML/CUDA/unknown placement', () => {
  assert.equal(isHealthyRuntimeResponse(capability()), true);
  for (const executionProvider of ['CPUExecutionProvider', 'DmlExecutionProvider', 'CUDAExecutionProvider', null]) {
    assert.equal(isHealthyRuntimeResponse({ ...capability(), executionProvider }), true);
  }
});

test('health rejects protocolVersion, incomplete responses and unsupported protocol', () => {
  for (const value of [null, undefined, [], true, {},
    { ...capability(), protocol: undefined, protocolVersion: 1 },
    { ...capability(), protocolVersion: 1 },
    { ...capability(), protocol: 2 },
    { ...capability(), arch: undefined },
  ]) assert.equal(isHealthyRuntimeResponse(value), false);
});

test('health fails closed for unavailable backends, invalid metadata and not-ready state', () => {
  for (const change of [
    { ready: false }, { ready: 'true' }, { selectedStt: 'missing' },
    { selectedTts: 'missing' }, { selectedStt: null }, { selectedTts: null },
    { sttBackends: [] }, { ttsBackends: [] },
    { executionProvider: 'TensorrtExecutionProvider' }, { executionProvider: 'cuda' }, { executionProvider: {} },
    { executionProvider: undefined }, { unknownMetadata: true },
    { capabilities: ['tts', 'tts'] }, { fake: 'yes' }, { whisperModel: 7 },
  ]) assert.equal(isHealthyRuntimeResponse({ ...capability(), ...change }), false);
});
