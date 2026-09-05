const test = require('node:test');
const assert = require('node:assert/strict');

function wavBase64({ dataBytes = 4800, nonZero = true } = {}) {
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  if (nonZero && dataBytes >= 2) wav.writeInt16LE(1000, 44);
  return wav.toString('base64');
}

function nativeHealth(overrides = {}) {
  return {
    protocol: 1,
    fake: false,
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

test('packaged voice verifier accepts native Mac health, nonzero WAV and matching STT', async () => {
  const { validateMacNativeHealth, validateTtsResult, validateSttResult } = await import('../scripts/verify-macos-packaged-voice.mjs');
  assert.equal(validateMacNativeHealth(nativeHealth()).platform, 'darwin');
  const audio = validateTtsResult({ audio: wavBase64(), format: 'audio/wav', sampleRate: 24000 });
  assert.equal(audio.length, 4844);
  assert.ok(validateSttResult({ text: 'The quick brown fox jumps over the lazy dog.' }) > 0);
});

test('packaged voice verifier rejects fake/wrong platform health and fabricated outputs', async () => {
  const { validateMacNativeHealth, validateTtsResult, validateSttResult } = await import('../scripts/verify-macos-packaged-voice.mjs');
  assert.throws(() => validateMacNativeHealth(nativeHealth({ fake: true })), /PACKAGED_RUNTIME_HEALTH_INVALID/);
  assert.throws(() => validateMacNativeHealth(nativeHealth({ platform: 'linux' })), /PACKAGED_RUNTIME_HEALTH_INVALID/);
  assert.throws(() => validateMacNativeHealth(nativeHealth({ selectedStt: 'fake', sttBackends: ['fake'] })), /PACKAGED_RUNTIME_HEALTH_INVALID/);
  assert.throws(() => validateTtsResult({ audio: Buffer.from('not wav').toString('base64'), format: 'audio/wav', sampleRate: 24000 }), /INVALID_TTS_WAV/);
  assert.throws(() => validateTtsResult({ audio: wavBase64({ nonZero: false }), format: 'audio/wav', sampleRate: 24000 }), /INVALID_TTS_PCM/);
  assert.throws(() => validateTtsResult({ audio: wavBase64({ dataBytes: 0 }), format: 'audio/wav', sampleRate: 24000 }), /INVALID_TTS_PCM/);
  assert.throws(() => validateTtsResult({ audio: wavBase64(), format: 'audio/mp3', sampleRate: 24000 }), /INVALID_TTS_RESULT/);
  assert.throws(() => validateSttResult({ text: 'unrelated hallucination' }), /STT_TRANSCRIPT_MISMATCH/);
  assert.throws(() => validateSttResult({ text: '  ' }), /EMPTY_STT_RESULT/);
});
