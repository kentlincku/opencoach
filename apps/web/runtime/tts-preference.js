(function exposeTtsPreference(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceTtsPreference = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTtsPreferenceModule() {
  'use strict';

  const TTS_MODES = Object.freeze({
    AUTO: 'auto',
    SYSTEM: 'system',
    KOKORO: 'kokoro',
  });
  const VALID_MODES = new Set(Object.values(TTS_MODES));

  function normalizeTtsMode(value) {
    return VALID_MODES.has(value) ? value : TTS_MODES.AUTO;
  }

  function resolveBrowserTtsMode({ storedMode, isIosBrowser = false } = {}) {
    const normalized = normalizeTtsMode(storedMode);
    return isIosBrowser && normalized === TTS_MODES.KOKORO ? TTS_MODES.SYSTEM : normalized;
  }

  function shouldUseModelTts({ mode, runtimeKind } = {}) {
    const normalized = normalizeTtsMode(mode);
    if (normalized === TTS_MODES.SYSTEM) return false;
    if (normalized === TTS_MODES.KOKORO) return true;
    return runtimeKind === 'electron' || runtimeKind === 'android';
  }

  function shouldLoadBrowserKokoro({ mode, runtimeKind } = {}) {
    return normalizeTtsMode(mode) === TTS_MODES.KOKORO && runtimeKind === 'browser';
  }

  function classifySuccessfulKokoroWarmup(elapsedMs, slowThresholdMs = 12000) {
    const normalizedElapsedMs = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0;
    return Object.freeze({
      usable: true,
      slow: normalizedElapsedMs > slowThresholdMs,
      elapsedMs: normalizedElapsedMs,
    });
  }

  function shouldRetryKokoroInitialization({
    generationIsCurrent = false,
    wantsBrowserKokoro = false,
    timerPending = false,
    instanceReady = false,
  } = {}) {
    return !generationIsCurrent && wantsBrowserKokoro && !timerPending && !instanceReady;
  }

  function createModeEpoch() {
    let current = 0;
    return Object.freeze({
      begin() { current += 1; return current; },
      cancel() { current += 1; },
      isCurrent(token) { return token === current; },
    });
  }

  return Object.freeze({
    TTS_MODES,
    normalizeTtsMode,
    resolveBrowserTtsMode,
    shouldUseModelTts,
    shouldLoadBrowserKokoro,
    shouldRetryKokoroInitialization,
    classifySuccessfulKokoroWarmup,
    createModeEpoch,
  });
}));
