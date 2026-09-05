(function exposeRuntimeContract(root, factory) {
  const contract = factory();
  if (typeof module === 'object' && module.exports) module.exports = contract;
  if (root) root.VoiceRuntimeContract = Object.freeze(contract);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntimeContract() {
  'use strict';

  const SUPPORTED_STT_BACKENDS = new Set(['fake', 'mlx-whisper', 'faster-whisper', 'android-on-device-speech']);
  const SUPPORTED_TTS_BACKENDS = new Set(['fake', 'kokoro-python', 'kokoro-onnx', 'android-tts-local']);
  const SUPPORTED_EXECUTION_PROVIDERS = new Set(['CPUExecutionProvider', 'DmlExecutionProvider']);
  const CAPABILITY_FIELDS = new Set([
    'protocol', 'platform', 'arch', 'sttBackends', 'ttsBackends',
    'selectedStt', 'selectedTts', 'ready', 'degradedReason',
    'fake', 'capabilities', 'whisperModel', 'executionProvider',
  ]);

  function isValidBackendList(value) {
    return Array.isArray(value)
      && value.every(item => typeof item === 'string' && item.length > 0)
      && new Set(value).size === value.length;
  }

  function degradedCapabilities(reason, source = {}) {
    return Object.freeze({
      protocol: Number.isInteger(source.protocol) ? source.protocol : 1,
      platform: typeof source.platform === 'string' && source.platform ? source.platform : 'unknown',
      arch: typeof source.arch === 'string' && source.arch ? source.arch : 'unknown',
      sttBackends: Object.freeze(Array.isArray(source.sttBackends) ? [...source.sttBackends] : []),
      ttsBackends: Object.freeze(Array.isArray(source.ttsBackends) ? [...source.ttsBackends] : []),
      selectedStt: null,
      selectedTts: null,
      ready: false,
      degradedReason: reason,
      executionProvider: null,
    });
  }

  function normalizeRuntimeCapabilities(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return degradedCapabilities('INVALID_CAPABILITY_RESPONSE');
    }

    const requiredShapeIsValid = Object.keys(raw).every(key => CAPABILITY_FIELDS.has(key))
      && Number.isInteger(raw.protocol)
      && typeof raw.platform === 'string' && raw.platform.length > 0
      && typeof raw.arch === 'string' && raw.arch.length > 0
      && isValidBackendList(raw.sttBackends)
      && isValidBackendList(raw.ttsBackends)
      && (typeof raw.selectedStt === 'string' || raw.selectedStt === null)
      && (typeof raw.selectedTts === 'string' || raw.selectedTts === null)
      && typeof raw.ready === 'boolean'
      && (typeof raw.degradedReason === 'string' || raw.degradedReason === null)
      && (!Object.hasOwn(raw, 'fake') || typeof raw.fake === 'boolean')
      && (!Object.hasOwn(raw, 'capabilities') || isValidBackendList(raw.capabilities))
      && (!Object.hasOwn(raw, 'whisperModel') || typeof raw.whisperModel === 'string')
      && (!Object.hasOwn(raw, 'executionProvider') || raw.executionProvider === null
        || SUPPORTED_EXECUTION_PROVIDERS.has(raw.executionProvider));

    if (!requiredShapeIsValid) {
      return degradedCapabilities('INVALID_CAPABILITY_RESPONSE', raw);
    }
    if (raw.protocol !== 1) {
      return degradedCapabilities(`UNSUPPORTED_PROTOCOL:${raw.protocol}`, raw);
    }

    const unsupported = [];
    if (raw.selectedStt && !SUPPORTED_STT_BACKENDS.has(raw.selectedStt)) unsupported.push(`stt:${raw.selectedStt}`);
    if (raw.selectedTts && !SUPPORTED_TTS_BACKENDS.has(raw.selectedTts)) unsupported.push(`tts:${raw.selectedTts}`);
    if (unsupported.length) {
      return degradedCapabilities(`UNSUPPORTED_BACKEND:${unsupported.join(',')}`, raw);
    }

    const unavailable = [];
    if (raw.selectedStt && !raw.sttBackends.includes(raw.selectedStt)) unavailable.push(`stt:${raw.selectedStt}`);
    if (raw.selectedTts && !raw.ttsBackends.includes(raw.selectedTts)) unavailable.push(`tts:${raw.selectedTts}`);
    if (unavailable.length) {
      return degradedCapabilities(`SELECTED_BACKEND_UNAVAILABLE:${unavailable.join(',')}`, raw);
    }

    const selectionMissing = raw.ready && (!raw.selectedStt || !raw.selectedTts);
    if (selectionMissing) {
      return degradedCapabilities('MISSING_SELECTED_BACKEND', raw);
    }

    return Object.freeze({
      protocol: raw.protocol,
      platform: raw.platform,
      arch: raw.arch,
      sttBackends: Object.freeze([...raw.sttBackends]),
      ttsBackends: Object.freeze([...raw.ttsBackends]),
      selectedStt: raw.selectedStt,
      selectedTts: raw.selectedTts,
      ready: raw.ready,
      degradedReason: raw.degradedReason,
      executionProvider: raw.executionProvider ?? null,
    });
  }

  return Object.freeze({
    normalizeRuntimeCapabilities,
    supportedSttBackends: Object.freeze([...SUPPORTED_STT_BACKENDS]),
    supportedTtsBackends: Object.freeze([...SUPPORTED_TTS_BACKENDS]),
  });
}));
