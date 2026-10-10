(function exposeNativeAudio(root, factory) {
  const exports = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceNativeAudio = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createNativeAudioModule(root) {
  'use strict';

  const SAMPLE_RATE = 16000;
  const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

  function encodePcmWav(samples) {
    if (!(samples instanceof Float32Array) || !samples.length || 44 + samples.length * 2 > MAX_AUDIO_BYTES) {
      throw new Error('INVALID_DECODED_AUDIO_LENGTH');
    }
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const tag = (offset, text) => {
      for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
    };
    tag(0, 'RIFF');
    view.setUint32(4, bytes.length - 8, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i])) throw new Error('INVALID_DECODED_AUDIO_SAMPLE');
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return bytes;
  }

  function copyAudioBytes(input) {
    let source;
    if (input instanceof ArrayBuffer) source = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) source = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new Error('INVALID_AUDIO_BUFFER');
    if (!source.byteLength || source.byteLength > MAX_AUDIO_BYTES) throw new Error('AUDIO_PAYLOAD_TOO_LARGE');
    return source.slice();
  }

  // Fast path is deliberately mono; stereo inputs go through local downmix.
  // Match the Python decoder's full RIFF/chunk and fmt 16/18(cbSize=0) rules.
  function isNativePcmWav(bytes) {
    if (bytes.byteLength < 46 || bytes.byteLength > MAX_AUDIO_BYTES) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) return false;
    let format = false, data = false, offset = 12;
    while (offset < bytes.byteLength) {
      if (offset + 8 > bytes.byteLength) return false;
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + length;
      if (end + (length % 2) > bytes.byteLength) return false;
      if (tag(offset) === 'fmt ') {
        if (format || ![16, 18].includes(length) || view.getUint16(start, true) !== 1
            || view.getUint16(start + 2, true) !== 1 || view.getUint32(start + 4, true) !== SAMPLE_RATE
            || view.getUint32(start + 8, true) !== SAMPLE_RATE * 2
            || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16
            || (length === 18 && view.getUint16(start + 16, true) !== 0)) return false;
        format = true;
      } else if (tag(offset) === 'data') {
        if (!format || data || !length || length % 2) return false;
        data = true;
      }
      offset = end + (length % 2);
    }
    return format && data;
  }

  function createAudioContext() {
    const Context = root.AudioContext || root.webkitAudioContext;
    if (!Context) throw new Error('AUDIO_DECODER_UNAVAILABLE');
    // decodeAudioData resamples to the context rate without resuming playback.
    return new Context({ sampleRate: SAMPLE_RATE });
  }

  async function normalizeNativeAudio(input, { signal, audioContextFactory = createAudioContext, onCleanup } = {}) {
    const checkCancelled = () => { if (signal?.aborted) throw new Error('RUNTIME_CANCELLED'); };
    checkCancelled();
    const bytes = copyAudioBytes(input);
    if (isNativePcmWav(bytes)) return bytes;
    const context = audioContextFactory();
    let closePromise, onAbort, result;
    const closeContext = () => {
      if (!closePromise) closePromise = Promise.resolve().then(() => context.close());
      return closePromise;
    };
    // Keep the original resource reachable by its bounded renderer record until
    // close succeeds; a failed/deadline close is not an ordinary codec error.
    onCleanup?.(closeContext);
    try {
      checkCancelled();
      const cancelled = new Promise((_, reject) => {
        onAbort = () => {
          reject(new Error('RUNTIME_CANCELLED'));
          void closeContext().catch(() => {});
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      // Schedule decoding after the race owns both rejection paths, including
      // synchronous decoder callbacks that reenter cancel().
      const decoded = await Promise.race([
        Promise.resolve().then(() => { checkCancelled(); return context.decodeAudioData(bytes.buffer); }),
        cancelled,
      ]);
      checkCancelled();
      if (decoded.sampleRate !== SAMPLE_RATE || !Number.isSafeInteger(decoded.length) || decoded.length <= 0
          || 44 + decoded.length * 2 > MAX_AUDIO_BYTES || !Number.isSafeInteger(decoded.numberOfChannels)
          || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 32) throw new Error('INVALID_DECODED_AUDIO_FORMAT');
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        if (samples.length !== decoded.length) throw new Error('INVALID_DECODED_AUDIO_LENGTH');
        for (let i = 0; i < mono.length; i++) {
          if (!Number.isFinite(samples[i])) throw new Error('INVALID_DECODED_AUDIO_SAMPLE');
          mono[i] += samples[i] / decoded.numberOfChannels;
        }
      }
      result = encodePcmWav(mono);
    } finally {
      let timer;
      try {
        await Promise.race([closeContext(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('VOICE_AUDIO_CLOSE_TIMEOUT')), 2000);
        })]);
      } catch (cause) {
        const failure = new Error(cause?.message || 'VOICE_AUDIO_CLEANUP_FAILED', { cause });
        failure.code = 'VOICE_AUDIO_CLEANUP_FAILED';
        throw failure;
      }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    }
    checkCancelled();
    return result;
  }

  return Object.freeze({ encodePcmWav, normalizeNativeAudio, isNativePcmWav });
}));
