const test = require('node:test');
const assert = require('node:assert/strict');
const { isHealthyRuntimeResponse } = require('../apps/desktop/runtime-health.cjs');

test('runtime health validator accepts the canonical protocol field', () => {
  const valid = {
    protocol: 1,
    platform: 'darwin',
    arch: 'arm64',
    ready: true,
    degradedReason: null,
    sttBackends: ['mlx-whisper'],
    ttsBackends: ['kokoro-python'],
    selectedStt: 'mlx-whisper',
    selectedTts: 'kokoro-python',
  };
  assert.equal(isHealthyRuntimeResponse(valid), true);
});

test('runtime health validator rejects protocolVersion and incomplete capabilities', () => {
  const valid = {
    protocol: 1,
    platform: 'darwin',
    arch: 'arm64',
    ready: true,
    degradedReason: null,
    sttBackends: ['mlx-whisper'],
    ttsBackends: ['kokoro-python'],
    selectedStt: 'mlx-whisper',
    selectedTts: 'kokoro-python',
  };
  assert.equal(isHealthyRuntimeResponse({ ...valid, protocol: undefined, protocolVersion: 1 }), false);
  assert.equal(isHealthyRuntimeResponse({ ...valid, ready: false }), false);
  assert.equal(isHealthyRuntimeResponse({ ...valid, selectedStt: 'missing' }), false);
  assert.equal(isHealthyRuntimeResponse({ ...valid, selectedTts: 'missing' }), false);
});
