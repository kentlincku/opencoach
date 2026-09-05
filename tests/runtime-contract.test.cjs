const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeRuntimeCapabilities,
} = require('../apps/web/runtime/runtime-contract.js');

test('normalizes a valid runtime capability response', () => {
  const result = normalizeRuntimeCapabilities({
    protocol: 1,
    platform: 'darwin',
    arch: 'arm64',
    sttBackends: ['mlx-whisper'],
    ttsBackends: ['kokoro-python'],
    selectedStt: 'mlx-whisper',
    selectedTts: 'kokoro-python',
    ready: true,
    degradedReason: null,
  });

  assert.equal(result.ready, true);
  assert.equal(result.selectedStt, 'mlx-whisper');
  assert.equal(result.selectedTts, 'kokoro-python');
  assert.equal(result.degradedReason, null);
});

test('normalizes and preserves the actual Windows Kokoro execution provider', () => {
  const result = normalizeRuntimeCapabilities({
    protocol: 1,
    platform: 'windows',
    arch: 'x64',
    sttBackends: ['faster-whisper'],
    ttsBackends: ['kokoro-onnx'],
    selectedStt: 'faster-whisper',
    selectedTts: 'kokoro-onnx',
    executionProvider: 'CPUExecutionProvider',
    ready: true,
    degradedReason: null,
  });
  assert.equal(result.ready, true);
  assert.equal(result.executionProvider, 'CPUExecutionProvider');
});

test('rejects unknown execution provider claims', () => {
  const result = normalizeRuntimeCapabilities({
    protocol: 1,
    platform: 'windows',
    arch: 'x64',
    sttBackends: ['faster-whisper'],
    ttsBackends: ['kokoro-onnx'],
    selectedStt: 'faster-whisper',
    selectedTts: 'kokoro-onnx',
    executionProvider: 'ImaginaryExecutionProvider',
    ready: true,
    degradedReason: null,
  });
  assert.equal(result.ready, false);
  assert.equal(result.degradedReason, 'INVALID_CAPABILITY_RESPONSE');
});

test('unknown selected backend degrades safely', () => {
  const result = normalizeRuntimeCapabilities({
    protocol: 1,
    platform: 'future-os',
    arch: 'future-arch',
    sttBackends: ['future-stt'],
    ttsBackends: ['future-tts'],
    selectedStt: 'future-stt',
    selectedTts: 'future-tts',
    ready: true,
    degradedReason: null,
  });

  assert.equal(result.ready, false);
  assert.equal(result.selectedStt, null);
  assert.equal(result.selectedTts, null);
  assert.match(result.degradedReason, /UNSUPPORTED_BACKEND/);
});

test('selected backend must be advertised as available', () => {
  const result = normalizeRuntimeCapabilities({
    protocol: 1,
    platform: 'darwin',
    arch: 'arm64',
    sttBackends: [],
    ttsBackends: ['kokoro-python'],
    selectedStt: 'mlx-whisper',
    selectedTts: 'kokoro-python',
    ready: true,
    degradedReason: null,
  });

  assert.equal(result.ready, false);
  assert.equal(result.selectedStt, null);
  assert.match(result.degradedReason, /SELECTED_BACKEND_UNAVAILABLE/);
});

test('unknown protocol version degrades safely', () => {
  const result = normalizeRuntimeCapabilities({
    protocol: 2,
    platform: 'darwin',
    arch: 'arm64',
    sttBackends: ['mlx-whisper'],
    ttsBackends: ['kokoro-python'],
    selectedStt: 'mlx-whisper',
    selectedTts: 'kokoro-python',
    ready: true,
    degradedReason: null,
  });

  assert.equal(result.ready, false);
  assert.equal(result.degradedReason, 'UNSUPPORTED_PROTOCOL:2');
});

test('backend lists reject empty or duplicate identifiers', () => {
  for (const sttBackends of [[''], ['mlx-whisper', 'mlx-whisper']]) {
    const result = normalizeRuntimeCapabilities({
      protocol: 1,
      platform: 'darwin',
      arch: 'arm64',
      sttBackends,
      ttsBackends: ['kokoro-python'],
      selectedStt: 'mlx-whisper',
      selectedTts: 'kokoro-python',
      ready: true,
      degradedReason: null,
    });
    assert.equal(result.ready, false);
    assert.equal(result.degradedReason, 'INVALID_CAPABILITY_RESPONSE');
  }
});

test('response with undeclared fields degrades safely', () => {
  const result = normalizeRuntimeCapabilities({
    protocol: 1,
    platform: 'darwin',
    arch: 'arm64',
    sttBackends: ['mlx-whisper'],
    ttsBackends: ['kokoro-python'],
    selectedStt: 'mlx-whisper',
    selectedTts: 'kokoro-python',
    ready: true,
    degradedReason: null,
    unexpected: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.degradedReason, 'INVALID_CAPABILITY_RESPONSE');

  const invalidLegacyField = normalizeRuntimeCapabilities({
    protocol: 1,
    platform: 'darwin',
    arch: 'arm64',
    sttBackends: ['mlx-whisper'],
    ttsBackends: ['kokoro-python'],
    selectedStt: 'mlx-whisper',
    selectedTts: 'kokoro-python',
    ready: true,
    degradedReason: null,
    fake: 'yes',
  });
  assert.equal(invalidLegacyField.ready, false);
  assert.equal(invalidLegacyField.degradedReason, 'INVALID_CAPABILITY_RESPONSE');
});

test('malformed capability response degrades instead of throwing', () => {
  const result = normalizeRuntimeCapabilities(null);

  assert.equal(result.ready, false);
  assert.deepEqual(result.sttBackends, []);
  assert.deepEqual(result.ttsBackends, []);
  assert.equal(result.degradedReason, 'INVALID_CAPABILITY_RESPONSE');
});
