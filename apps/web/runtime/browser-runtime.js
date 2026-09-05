(function exposeBrowserRuntime(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceBrowserRuntime = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createBrowserRuntimeModule() {
  'use strict';

  const DEFAULT_CAPABILITIES = Object.freeze({
    protocol: 1,
    platform: 'browser',
    arch: 'unknown',
    sttBackends: Object.freeze(['browser-fallback']),
    ttsBackends: Object.freeze(['browser-fallback']),
    selectedStt: 'browser-fallback',
    selectedTts: 'browser-fallback',
    ready: true,
    degradedReason: null,
  });

  class BrowserRuntime {
    constructor(handlers = {}) {
      this.kind = 'browser';
      this._handlers = handlers;
      this._disposed = false;
      this._operationVersion = 0;
    }

    async capabilities() {
      const value = typeof this._handlers.capabilities === 'function'
        ? await this._handlers.capabilities()
        : DEFAULT_CAPABILITIES;
      return value;
    }

    async transcribe(payload) {
      if (this._disposed) throw new Error('RUNTIME_DISPOSED');
      if (typeof this._handlers.transcribe !== 'function') throw new Error('BROWSER_TRANSCRIBE_UNAVAILABLE');
      const version = this._operationVersion;
      const result = await this._handlers.transcribe(payload);
      if (version !== this._operationVersion) throw new Error('RUNTIME_CANCELLED');
      return result;
    }

    async synthesize(payload) {
      if (this._disposed) throw new Error('RUNTIME_DISPOSED');
      if (typeof this._handlers.synthesize !== 'function') return { useSystemSpeech: true, backend: 'system-speech' };
      const version = this._operationVersion;
      const result = await this._handlers.synthesize(payload);
      if (version !== this._operationVersion) throw new Error('RUNTIME_CANCELLED');
      return result;
    }

    cancel() {
      this._operationVersion++;
      if (typeof this._handlers.cancel === 'function') this._handlers.cancel();
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      this._operationVersion++;
      if (typeof this._handlers.dispose === 'function') this._handlers.dispose();
    }
  }

  return Object.freeze({ BrowserRuntime });
}));
