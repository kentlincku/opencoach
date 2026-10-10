(function exposeElectronRuntime(root, factory) {
  const common = typeof module === 'object' && module.exports;
  const exports = factory(common ? require('./native-audio.js') : root.VoiceNativeAudio,
    common ? require('./desktop-voice-work-scope.js') : root.DesktopVoiceWorkScope,
    common ? require('./llm-provider-contract.js') : root.VoiceLlmProviderContract);
  if (common) module.exports = exports;
  if (root) root.VoiceElectronRuntime = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nativeAudio, scopeModule, llmContract) {
  'use strict';
  const { DesktopVoiceWorkScope } = scopeModule;
  class ElectronRuntime {
    constructor({ api, capabilities, fallback }) {
      if (!api || typeof api !== 'object') throw new TypeError('ELECTRON_API_REQUIRED');
      if (!capabilities || typeof capabilities !== 'object') throw new TypeError('CAPABILITIES_REQUIRED');
      this.kind = 'electron';
      this._api = api;
      this._capabilities = capabilities;
      this._fallback = fallback;
      this._scope = new DesktopVoiceWorkScope(api);
      this._fmEpoch = 0;
    }
    get fault() { return this._scope.domain.fault; }
    async capabilities() { return this._capabilities; }
    async foundationModelsCapabilities() {
      if (this._disposeStarted) throw new Error('RUNTIME_DISPOSED');
      if (!['foundationModelsCapabilities', 'foundationModelsGenerate', 'foundationModelsCancel'].every(key => typeof this._api[key] === 'function')) throw new Error('FM_UNAVAILABLE');
      if (this._fmStop || (this._scope.stopPromise && !this._scope.stopSettled)) throw new Error('RUNTIME_CANCELLED');
      if (this._fmCapability) return { ...this._fmCapability };
      if (this._fmPreparing) return this._fmPreparing;
      const epoch = this._fmEpoch;
      const preparationId = this._fmPreparationId = globalThis.crypto.randomUUID();
      const work = Promise.resolve().then(async () => {
        const capability = llmContract.normalizeFoundationModelsCapability(await this._api.foundationModelsCapabilities({ preparationId }));
        if (epoch !== this._fmEpoch || this._disposeStarted) throw new Error('RUNTIME_CANCELLED');
        this._fmCapability = capability;
        return { ...capability };
      });
      this._fmPreparing = work;
      try { return await work; }
      finally { if (this._fmPreparing === work) this._fmPreparing = null; }
    }
    async generate({ messages, maxTokens = 300 }, observe) {
      if (this._disposeStarted) throw new Error('RUNTIME_DISPOSED');
      if (this._fmPending || this._fmStop) throw new Error('FM_BUSY');
      const epoch = this._fmEpoch;
      const requestId = globalThis.crypto.randomUUID();
      this._fmPending = requestId;
      const check = () => { if (epoch !== this._fmEpoch || this._disposeStarted) throw new Error('RUNTIME_CANCELLED'); };
      // Passive renderer correlation only; never changes the strict IPC payload or
      // borrows a caller's ID as native authority. Observation cannot break work.
      const notify = stage => {
        try { observe?.(Object.freeze(stage === 'dispatch'
          ? { stage, runtimeRequestId: requestId, sessionId: this._fmCapability.sessionId }
          : { stage })); } catch (_) { /* passive observer */ }
        check();
      };
      try {
        notify('capability');
        const cap = this._fmCapability || await this.foundationModelsCapabilities();
        check(); if (cap.state !== 'available' || cap.platform !== 'macos') throw new Error('FM_UNAVAILABLE');
        notify('validation');
        const payload = llmContract.normalizeFoundationModelsRequest({ sessionId: cap.sessionId, requestId, messages, maxTokens });
        notify('dispatch');
        const result = await this._api.foundationModelsGenerate(payload);
        check();
        if (!result || result.requestId !== requestId || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 8192) throw new Error('FM_PROTOCOL_ERROR');
        return { requestId, text: result.text };
      } catch (error) { check(); throw error; }
      finally { if (this._fmPending === requestId) this._fmPending = null; }
    }
    cancelGeneration() {
      this._fmEpoch++;
      if (this._fmStop) return this._fmStop;
      const preparationId = this._fmPreparationId;
      this._fmCapability = null;
      this._fmPreparationId = null;
      if (!preparationId) return Promise.resolve();
      this._fmStop = Promise.resolve().then(() => this._api.foundationModelsCancel({ preparationId })).then(result => {
        if (!result || result.state !== 'helper-exited') throw new Error('FM_EXIT_UNCONFIRMED');
      }).finally(() => { this._fmStop = null; });
      return this._fmStop;
    }
    async transcribe(payload) { return this._run('transcribe', payload); }
    async synthesize(payload) { return this._run('synthesize', payload); }
    async _run(kind, payload) {
      const stt = kind === 'transcribe';
      const native = !!(this._capabilities.ready && (stt ? this._capabilities.selectedStt : this._capabilities.selectedTts)
        && typeof this._api[stt ? 'transcribeAudio' : 'synthKokoro'] === 'function');
      const scope = this._scope, record = scope.begin(native);
      try {
        if (native) {
          // Missing typed cancellation support is not permission to send no ID.
          if (typeof this._api.voiceOperationState !== 'function' || typeof this._api.voiceOperationRevoke !== 'function') throw scope.fail();
          let input = payload;
          if (stt) {
            const needsPcm = ['faster-whisper', 'mlx-whisper'].includes(this._capabilities.selectedStt);
            if (!payload?.buffer && payload?.audioBlob?.size > 25 * 1024 * 1024) throw new Error('AUDIO_PAYLOAD_TOO_LARGE');
            let buffer = payload?.buffer || (payload?.audioBlob && await scope.local(record, () => payload.audioBlob.arrayBuffer()));
            scope.check(record);
            if (needsPcm) {
              buffer = await scope.local(record, () => nativeAudio.normalizeNativeAudio(buffer, {
                signal: record.controller.signal, onCleanup: release => { record.release = release; },
              }));
              scope.check(record);
              record.release = null;
            }
            input = { buffer, mimeType: needsPcm ? 'audio/wav' : String(payload?.mimeType || payload?.audioBlob?.type || 'audio/webm'),
              language: String(payload?.language || 'en') };
          }
          scope.check(record);
          let result;
          try {
            record.dispatched = true;
            result = await this._api[stt ? 'transcribeAudio' : 'synthKokoro']({ ...input, requestId: record.requestId });
          } catch (_) {
            if (record.revoked) throw new Error('RUNTIME_CANCELLED');
            record.uncertain = true;
            throw scope.fail();
          }
          scope.check(record);
          if (result?.type === 'failure') scope.failure(record, result);
          else {
            if (!(stt ? typeof result?.text === 'string' && result.text.trim() : typeof result?.audio === 'string' && result.audio)) throw scope.fail();
            record.nativeDone = true;
            return result;
          }
        }
        scope.check(record);
        if (!this._fallback?.[kind]) {
          if (stt) throw new Error('STT_BACKEND_UNAVAILABLE');
          return { useSystemSpeech: true, backend: 'system-speech' };
        }
        const result = await scope.local(record, () => this._fallback[kind]({ ...payload, signal: record.controller.signal }));
        scope.check(record); // Re-evaluate the original proof with CURRENT gates.
        return result;
      } catch (failure) {
        if (failure?.code === 'VOICE_AUDIO_CLEANUP_FAILED') scope.fail();
        if (record.revoked || scope.disposed || record.epoch !== scope.epoch) throw new Error('RUNTIME_CANCELLED');
        throw failure;
      } finally { scope.finish(record); }
    }
    cancel() {
      if (this._scope.stopSettled && this._fmPreparationId) this._scope.stopPromise = null;
      // The speech scope registers its stable join before invoking callbacks.
      // Add the independent text drain to that same join, not a Promise.all wrapper.
      return this._scope.stop(() => {
        this._scope.addStopCleanup(() => this.cancelGeneration());
        return this._fallback?.cancel?.();
      });
    }
    dispose() {
      if (this._disposeStarted) return this._scope.stopPromise;
      this._disposeStarted = true;
      this._scope.disposed = true;
      // A previously SETTLED Stop cannot represent a newly requested disposal.
      // In-flight Stop/dispose/reentrant callbacks always share the exact join.
      if (this._scope.stopSettled) this._scope.stopPromise = null;
      const stop = this.cancel();
      this._scope.addStopCleanup(() => this._fallback?.dispose?.());
      return stop;
    }
  }
  return Object.freeze({ ElectronRuntime });
}));
