(function exposeElectronRuntime(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceElectronRuntime = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createElectronRuntimeModule() {
  'use strict';

  class ElectronRuntime {
    constructor({ api, capabilities, fallback }) {
      if (!api || typeof api !== 'object') throw new TypeError('ELECTRON_API_REQUIRED');
      if (!capabilities || typeof capabilities !== 'object') throw new TypeError('CAPABILITIES_REQUIRED');
      this.kind = 'electron';
      this._api = api;
      this._capabilities = capabilities;
      this._fallback = fallback;
      this._disposed = false;
      this._operationVersion = 0;
      this._activeRequestId = null;
      this._cancellationBarrier = null;
    }

    async capabilities() {
      return this._capabilities;
    }

    async transcribe(payload) {
      if (this._disposed) throw new Error('RUNTIME_DISPOSED');
      if (this._cancellationBarrier) await this._cancellationBarrier;
      if (this._disposed) throw new Error('RUNTIME_DISPOSED');
      const version = ++this._operationVersion;
      const nativeReady = this._capabilities.ready
        && this._capabilities.selectedStt
        && typeof this._api.transcribeAudio === 'function';
      if (nativeReady) {
        const requestId = 'stt_' + version;
        this._activeRequestId = requestId;
        try {
          const buffer = payload?.buffer || (payload?.audioBlob && await payload.audioBlob.arrayBuffer());
          const result = await this._api.transcribeAudio({
            buffer,
            mimeType: String(payload?.mimeType || payload?.audioBlob?.type || 'audio/webm'),
            language: String(payload?.language || 'en'),
            requestId,
          });
          if (version !== this._operationVersion) throw new Error('RUNTIME_CANCELLED');
          if (typeof result?.text === 'string' && result.text.trim()) return result;
        } catch (error) {
          if (version !== this._operationVersion) throw new Error('RUNTIME_CANCELLED');
          if (String(error?.message || error).includes('RUNTIME_CANCELLED')) throw error;
          if (!this._fallback?.transcribe) throw error;
        } finally {
          if (this._activeRequestId === requestId) this._activeRequestId = null;
        }
      }
      if (!this._fallback?.transcribe) throw new Error('STT_BACKEND_UNAVAILABLE');
      const result = await this._fallback.transcribe(payload);
      if (version !== this._operationVersion) throw new Error('RUNTIME_CANCELLED');
      return result;
    }

    async synthesize(payload) {
      if (this._disposed) throw new Error('RUNTIME_DISPOSED');
      if (this._cancellationBarrier) await this._cancellationBarrier;
      if (this._disposed) throw new Error('RUNTIME_DISPOSED');
      const version = ++this._operationVersion;
      const isWindows = this._capabilities?.platform === 'windows' || this._capabilities?.platform === 'win32';
      const nativeReady = this._capabilities.ready
        && this._capabilities.selectedTts
        && typeof this._api.synthKokoro === 'function';
      if (nativeReady) {
        const requestId = 'tts_' + version;
        this._activeRequestId = requestId;
        try {
          const result = await this._api.synthKokoro({ ...payload, requestId });
          if (version !== this._operationVersion) throw new Error('RUNTIME_CANCELLED');
          if (typeof result?.audio === 'string' && result.audio) return result;
        } catch (error) {
          if (version !== this._operationVersion) throw new Error('RUNTIME_CANCELLED');
          if (String(error?.message || error).includes('RUNTIME_CANCELLED')) throw error;
          if (isWindows) return { useSystemSpeech: true, backend: 'system-speech', reason: 'native-synthesis-failed' };
          if (!this._fallback?.synthesize) throw error;
        } finally {
          if (this._activeRequestId === requestId) this._activeRequestId = null;
        }
      }
      if (isWindows) return { useSystemSpeech: true, backend: 'system-speech', reason: 'native-unavailable' };
      if (!this._fallback?.synthesize) return { useSystemSpeech: true, backend: 'system-speech' };
      const result = await this._fallback.synthesize(payload);
      if (version !== this._operationVersion) throw new Error('RUNTIME_CANCELLED');
      return result;
    }

    async cancel() {
      this._operationVersion++;
      let cancellationPromise = Promise.resolve({ cancelled: false });
      if (this._activeRequestId && typeof this._api.cancelVoiceOperation === 'function') {
        const requestId = this._activeRequestId;
        this._activeRequestId = null;
        cancellationPromise = Promise.resolve(this._api.cancelVoiceOperation({ requestId }));
      }
      if (typeof this._fallback?.cancel === 'function') this._fallback.cancel();
      const barrier = cancellationPromise.catch(() => {});
      this._cancellationBarrier = barrier;
      void barrier.then(() => {
        if (this._cancellationBarrier === barrier) this._cancellationBarrier = null;
      });
      return cancellationPromise;
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      void this.cancel().catch(() => {});
      if (typeof this._fallback?.dispose === 'function') this._fallback.dispose();
    }
  }

  return Object.freeze({ ElectronRuntime });
}));
