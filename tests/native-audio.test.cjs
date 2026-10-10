const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helperPath = path.resolve(__dirname, '../apps/web/runtime/native-audio.js');
const audio = fs.existsSync(helperPath) ? require(helperPath) : {};

// WebAudio boundary double only: production normalization/encoding runs unchanged.
function decoded(channels = [[1, -1], [-1, 1]], overrides = {}) {
  return { sampleRate: 16000, length: channels[0].length, numberOfChannels: channels.length,
    getChannelData: i => new Float32Array(channels[i]), ...overrides };
}

test('local WebAudio normalization copies view bounds, downmixes and always closes without playback', async () => {
  assert.equal(typeof audio.normalizeNativeAudio, 'function');
  const backing = new Uint8Array([99, 1, 2, 3, 88]);
  let closes = 0;
  let decodes = 0;
  const context = {
    async decodeAudioData(buffer) {
      decodes++;
      assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3]);
      new Uint8Array(buffer).fill(0); // Browser may detach/mutate decoder input.
      return decoded([[1, -1, 0.5], [1, -1, -0.5]]);
    },
    async close() { closes++; },
    resume() { assert.fail('normalization must not resume playback'); },
  };
  const bytes = await audio.normalizeNativeAudio(new DataView(backing.buffer, 1, 3), { audioContextFactory: () => context });
  assert.deepEqual([...backing], [99, 1, 2, 3, 88]);
  assert.equal(decodes, 1);
  assert.equal(closes, 1);
  assert.deepEqual([...new Int16Array(bytes.buffer, 44)], [32767, -32768, 0]);
  for (const bad of [decoded([[NaN]]), decoded([[Infinity]]), decoded([[0]], { sampleRate: 48000 }),
    decoded([[0]], { length: 0 }), decoded([[0]], { length: 1.5 }),
    decoded([[0]], { length: (25 * 1024 * 1024 - 44) / 2 + 1 }),
    decoded([[0]], { numberOfChannels: 0 }), decoded([[0]], { numberOfChannels: 33 }),
    decoded([[0]], { numberOfChannels: 1.5 }), decoded([[0]], { length: 2 })]) {
    let closed = 0;
    await assert.rejects(audio.normalizeNativeAudio(backing, { audioContextFactory: () => ({
      decodeAudioData: async () => bad, close: async () => { closed++; },
    }) }), /INVALID_DECODED_AUDIO/);
    assert.equal(closed, 1);
  }
  for (const failure of ['decode', 'close']) {
    let closed = 0;
    await assert.rejects(audio.normalizeNativeAudio(backing, { audioContextFactory: () => ({
      decodeAudioData: async () => { if (failure === 'decode') throw new Error('decode failed'); return decoded(); },
      close: async () => { closed++; if (failure === 'close') throw new Error('close failed'); },
    }) }), new RegExp(`${failure} failed`));
    assert.equal(closed, 1);
  }
  for (const input of [new Uint8Array(), new Uint8Array(25 * 1024 * 1024 + 1), 'bytes']) {
    await assert.rejects(audio.normalizeNativeAudio(input, { audioContextFactory: () => assert.fail('invalid input must not allocate context') }), /AUDIO_PAYLOAD_TOO_LARGE|INVALID_AUDIO_BUFFER/);
  }
  const saved = global.AudioContext;
  try {
    global.AudioContext = class {
      constructor(options) { assert.deepEqual(options, { sampleRate: 16000 }); }
      decodeAudioData() { return Promise.resolve(decoded()); }
      close() { return Promise.resolve(); }
      resume() { assert.fail('no resume'); }
    };
    await audio.normalizeNativeAudio(backing);
    delete global.AudioContext;
    await assert.rejects(audio.normalizeNativeAudio(backing), /AUDIO_DECODER_UNAVAILABLE/);
  } finally { if (saved) global.AudioContext = saved; else delete global.AudioContext; }
});

test('strict mono WAV fast path copies bounded bytes and never forwards malformed fmt/RIFF', async () => {
  assert.equal(typeof audio.isNativePcmWav, 'function');
  const wav = audio.encodePcmWav(new Float32Array([-1, 0, 1]));
  const noContext = { audioContextFactory: () => assert.fail('valid PCM needs no codec') };
  const padded = new Uint8Array(wav.length + 10);
  padded.set(wav, 5);
  const copy = await audio.normalizeNativeAudio(padded.subarray(5, -5), noContext);
  assert.deepEqual(copy, wav);
  assert.notEqual(copy.buffer, padded.buffer);
  const extended = size => {
    const bytes = new Uint8Array(wav.length + size - 16);
    bytes.set(wav.subarray(0, 36));
    bytes.set(wav.subarray(36), 20 + size);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.length - 8, true);
    view.setUint32(16, size, true);
    return bytes;
  };
  assert.deepEqual(await audio.normalizeNativeAudio(extended(18), noContext), extended(18));
  const mutations = [
    b => new DataView(b.buffer).setUint32(4, b.length - 9, true),
    b => new DataView(b.buffer).setUint16(20, 3, true),
    b => new DataView(b.buffer).setUint16(22, 2, true),
    b => new DataView(b.buffer).setUint32(24, 48000, true),
    b => new DataView(b.buffer).setUint32(28, 1, true),
    b => new DataView(b.buffer).setUint16(32, 1, true),
    b => new DataView(b.buffer).setUint16(34, 8, true),
    b => new DataView(b.buffer).setUint32(40, 5, true),
    b => b.set(Buffer.from('data'), 12),
    b => b.set(Buffer.from('fmt '), 36),
  ];
  const badExtension = extended(18);
  badExtension[36] = 1;
  const malformed = [extended(20), badExtension, wav.subarray(0, -1), ...mutations.map(mutate => {
    const bytes = wav.slice(); mutate(bytes); return bytes;
  })];
  for (const bytes of malformed) {
    assert.equal(audio.isNativePcmWav(bytes), false);
    let closes = 0;
    await assert.rejects(audio.normalizeNativeAudio(bytes, { audioContextFactory: () => ({
      decodeAudioData: async () => { throw new Error('codec rejected malformed WAV'); },
      close: async () => { closes++; },
    }) }), /codec rejected/);
    assert.equal(closes, 1);
  }
  assert.equal(audio.isNativePcmWav(new Uint8Array(25 * 1024 * 1024 + 1)), false);
});

test('PCM encoder writes bounded finite mono 16kHz PCM16 with clamped extrema', () => {
  assert.equal(typeof audio.encodePcmWav, 'function');
  const bytes = audio.encodePcmWav(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(Buffer.from(bytes.subarray(8, 16)).toString(), 'WAVEfmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(Buffer.from(bytes.subarray(36, 40)).toString(), 'data');
  assert.equal(view.getUint32(40, true), 14);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => audio.encodePcmWav(new Float32Array([value])), /INVALID_DECODED_AUDIO_SAMPLE/);
  }
  for (const samples of [[], new Float32Array(), new Float32Array((25 * 1024 * 1024 - 44) / 2 + 1)]) {
    assert.throws(() => audio.encodePcmWav(samples), /INVALID_DECODED_AUDIO_LENGTH/);
  }
  assert.equal(audio.encodePcmWav(new Float32Array((25 * 1024 * 1024 - 44) / 2)).length, 25 * 1024 * 1024);
});
