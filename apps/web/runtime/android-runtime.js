(function exposeAndroidRuntime(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceAndroidRuntime = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createAndroidRuntimeModule() {
  'use strict';

  const MAX_REQUEST_ID_LENGTH = 128;
  let requestSequence = 0;

  function createRequestId(operation) {
    requestSequence = (requestSequence + 1) % 1_000_000_000;
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
      || Math.random().toString(36).slice(2, 14);
    const id = `android_${operation}_${requestSequence}_${random}`;
    if (id.length > MAX_REQUEST_ID_LENGTH) throw new Error('REQUEST_ID_TOO_LARGE');
    return id;
  }

  class AndroidRuntime {
    constructor({ bridge, capabilities }) {
      if (!bridge || typeof bridge !== 'object') throw new TypeError('ANDROID_BRIDGE_REQUIRED');
      if (!capabilities || typeof capabilities !== 'object') throw new TypeError('CAPABILITIES_REQUIRED');
      this.kind = 'android';
      this._bridge = bridge;
      this._capabilities = capabilities;
      this._disposed = false;
      this._generation = 0;
      this._active = new Set();
    }

    async capabilities() { return this._capabilities; }

    async transcribe(payload = {}) {
      this._assertActive();
      const generation = this._generation;
      if (!this._capabilities.selectedStt || typeof this._bridge.voiceTranscribe !== 'function') {
        throw this._unavailableError(this._capabilities.degradedReason || 'STT_BACKEND_UNAVAILABLE');
      }
      return this._nativeOperation('stt', generation, requestId => this._bridge.voiceTranscribe({
        requestId,
        language: String(payload.language || 'en-US'),
      }), result => typeof result?.text === 'string' ? {
        text: result.text,
        language: String(result.language || payload.language || 'en-US'),
        backend: String(result.backend || 'android-on-device-speech'),
      } : null, 'STT_INVALID_NATIVE_RESPONSE');
    }

    async synthesize(payload = {}) {
      this._assertActive();
      const generation = this._generation;
      if (!this._capabilities.selectedTts || typeof this._bridge.voiceSynthesize !== 'function') {
        throw this._unavailableError(this._capabilities.degradedReason || 'TTS_BACKEND_UNAVAILABLE');
      }
      return this._nativeOperation('tts', generation, requestId => this._bridge.voiceSynthesize({
        requestId,
        text: String(payload.text || ''),
        locale: String(payload.locale || 'en-US'),
        rate: Number.isFinite(payload.speed) ? payload.speed : 1,
        pitch: Number.isFinite(payload.pitch) ? payload.pitch : 1,
      }), result => result?.playback === 'direct' && result.completed === true ? {
        playback: 'direct', completed: true, backend: String(result.backend || 'android-tts-local'),
      } : null, 'TTS_INVALID_NATIVE_RESPONSE');
    }

    async _nativeOperation(kind, generation, invoke, normalize, invalidCode) {
      const requestId = createRequestId(kind);
      this._active.add(requestId);
      try {
        const result = await invoke(requestId);
        this._assertGeneration(generation);
        const normalized = normalize(result);
        if (!normalized) throw this._unavailableError(invalidCode);
        return normalized;
      } catch (error) {
        this._assertGeneration(generation);
        throw error;
      } finally {
        this._active.delete(requestId);
      }
    }

    _unavailableError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    }

    cancel() {
      this._generation++;
      for (const requestId of this._active) {
        if (typeof this._bridge.voiceCancel === 'function') {
          Promise.resolve(this._bridge.voiceCancel({ requestId })).catch(() => {});
        }
      }
      this._active.clear();
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      this.cancel();
      if (typeof this._bridge.voiceDispose === 'function') {
        Promise.resolve(this._bridge.voiceDispose()).catch(() => {});
      }
    }

    _assertActive() {
      if (this._disposed) throw new Error('RUNTIME_DISPOSED');
    }

    _assertGeneration(generation) {
      if (generation !== this._generation) throw new Error('RUNTIME_CANCELLED');
    }
  }

  return Object.freeze({ AndroidRuntime });
}));
