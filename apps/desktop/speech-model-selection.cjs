'use strict';

/**
 * Pure metadata policy: no filesystem, network, environment or model loading.
 * Main must authenticate its catalog before supplying capabilities, and own the
 * reviewed enabledLanguages allowlist (initial rollout: ['en']). Parsing is not
 * authentication; compatibility is not installation, readiness or language QA.
 * Never derive targetLanguage or enabledLanguages from the UI locale.
 *
 * Capability: { id, kind: 'stt'|'tts', backend, format, languages,
 *   runtimeProfiles, voices?: [{ id, languages }] }
 * Records accept only exact own enumerable data fields on ordinary/null
 * prototypes; arrays must be ordinary, dense and undecorated. No proxies or
 * accessors. Opaque IDs/backend/format/profile tokens are lowercase ASCII
 * [a-z0-9][a-z0-9._-]*, at most 128 characters, with no coercion or trimming.
 * Limits: 256 models, 256 voices/model, 64 locales/list, 32 profiles/model.
 * Model IDs are globally unique; voice IDs are unique within each TTS model.
 * Voice locales must be a subset of model locales. Empty catalogs are valid;
 * language/profile and present voice lists are nonempty. Output is detached/frozen.
 *
 * canonicalLanguageTag(string): strict Intl BCP47 canonicalization preserving
 * the full tag. Invalid input throws TypeError('INVALID_LANGUAGE_TAG').
 * parseSpeechModelCapabilities(array): validates the complete catalog projection;
 * invalid input throws TypeError('INVALID_SPEECH_MODEL_CAPABILITIES').
 * selectSpeechModel(capabilities, { kind, targetLanguage, runtimeProfile,
 *   enabledLanguages, modelId? }): revalidates capabilities and exact options.
 * Invalid options throw TypeError('INVALID_SPEECH_MODEL_SELECTION'); [] enabled
 * locales disables selection. All matching uses full canonical-tag equality.
 *
 * Result: { state: 'compatible', modelId, kind, backend, format, targetLanguage,
 *   runtimeProfile, voiceIds? }, or { state: 'unavailable', reason }.
 * Reasons: LANGUAGE_NOT_SUPPORTED (disabled, or no locale candidate),
 * UNKNOWN_MODEL (explicit unknown ID after the language gate),
 * MODEL_NOT_COMPATIBLE (known ID mismatch, runtime/format/kind/voice mismatch),
 * AMBIGUOUS_MODEL (multiple compatible packs without an explicit ID).
 * There is no English, prefix, cloud or first-match fallback. voiceIds lists
 * compatible voices in catalog order; it never chooses a voice. Omitted voices
 * metadata makes no voice-specific claim. Future locales require independent
 * Main-owned review even for an upstream multilingual model.
 */
const { types: { isProxy } } = require('node:util');

// Explicit App runtime contracts, not upstream model or device-readiness claims.
const RUNTIME_FORMATS = freezeTree({
  'darwin-arm64': {
    stt: { backend: 'mlx-whisper', format: 'mlx' },
    tts: { backend: 'kokoro-onnx', format: 'onnx' },
  },
  'win32-x64-cpu': {
    stt: { backend: 'faster-whisper', format: 'ctranslate2' },
    tts: { backend: 'kokoro-onnx', format: 'onnx' },
  },
  'win32-x64-cuda': {
    stt: { backend: 'faster-whisper', format: 'ctranslate2' },
    tts: { backend: 'kokoro-onnx', format: 'onnx' },
  },
});

function canonicalLanguageTag(value) {
  if (typeof value !== 'string') throw new TypeError('INVALID_LANGUAGE_TAG');
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    throw new TypeError('INVALID_LANGUAGE_TAG');
  }
}

function exactRecord(value, fields, optional = []) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (!fields.every(key => Object.hasOwn(value, key))
    || keys.some(key => !fields.includes(key) && !optional.includes(key))) throw new TypeError();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
  }
  return value;
}

function exactArray(value, maxLength = 256) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
  if (value.length > maxLength || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
  }
  return value;
}

function token(value) {
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value
    || !/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new TypeError();
  return value;
}

function speechKind(value) {
  if (value !== 'stt' && value !== 'tts') throw new TypeError();
  return value;
}

function uniqueList(value, parseValue, maxLength = 64, allowEmpty = false) {
  const values = exactArray(value, maxLength).map(parseValue);
  if ((!allowEmpty && !values.length) || new Set(values).size !== values.length) throw new TypeError();
  return values;
}

function parseVoices(input, modelLanguages) {
  const voices = exactArray(input).map(voice => {
    exactRecord(voice, ['id', 'languages']);
    const languages = uniqueList(voice.languages, canonicalLanguageTag);
    if (!languages.every(language => modelLanguages.includes(language))) throw new TypeError();
    return { id: token(voice.id), languages };
  });
  if (!voices.length || new Set(voices.map(voice => voice.id)).size !== voices.length) throw new TypeError();
  return voices;
}

// Only freshly projected, validated data reaches this function, never input.
function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function parseSpeechModelCapabilities(input) {
  try {
    const ids = new Set();
    const models = exactArray(input).map(model => {
      exactRecord(model, ['id', 'kind', 'backend', 'format', 'languages', 'runtimeProfiles'], ['voices']);
      if (Object.hasOwn(model, 'voices') && model.kind !== 'tts') throw new TypeError();
      const id = token(model.id);
      if (ids.has(id)) throw new TypeError();
      ids.add(id);
      const languages = uniqueList(model.languages, canonicalLanguageTag);
      return {
        id, kind: speechKind(model.kind), backend: token(model.backend), format: token(model.format),
        languages, runtimeProfiles: uniqueList(model.runtimeProfiles, token, 32),
        ...(Object.hasOwn(model, 'voices') ? { voices: parseVoices(model.voices, languages) } : {}),
      };
    });
    return freezeTree(models);
  } catch {
    throw new TypeError('INVALID_SPEECH_MODEL_CAPABILITIES');
  }
}

function parseSelectionOptions(options) {
  try {
    exactRecord(options, ['kind', 'targetLanguage', 'runtimeProfile', 'enabledLanguages'], ['modelId']);
    return {
      kind: speechKind(options.kind), targetLanguage: canonicalLanguageTag(options.targetLanguage),
      runtimeProfile: token(options.runtimeProfile),
      enabledLanguages: uniqueList(options.enabledLanguages, canonicalLanguageTag, 64, true),
      ...(Object.hasOwn(options, 'modelId') ? { modelId: token(options.modelId) } : {}),
    };
  } catch {
    throw new TypeError('INVALID_SPEECH_MODEL_SELECTION');
  }
}

function matchesRuntime(model, selection) {
  if (!Object.hasOwn(RUNTIME_FORMATS, selection.runtimeProfile)) return false;
  const expected = RUNTIME_FORMATS[selection.runtimeProfile][selection.kind];
  return model.kind === selection.kind && model.runtimeProfiles.includes(selection.runtimeProfile)
    && model.backend === expected.backend && model.format === expected.format;
}

function unavailable(reason) {
  return Object.freeze({ state: 'unavailable', reason });
}

function selectSpeechModel(capabilities, options) {
  const models = parseSpeechModelCapabilities(capabilities);
  const selection = parseSelectionOptions(options);
  if (!selection.enabledLanguages.includes(selection.targetLanguage)) return unavailable('LANGUAGE_NOT_SUPPORTED');
  const explicit = Object.hasOwn(selection, 'modelId');
  const candidates = explicit ? models.filter(model => model.id === selection.modelId) : models;
  if (explicit && !candidates.length) return unavailable('UNKNOWN_MODEL');
  const languageMatches = candidates.filter(candidate => candidate.languages.includes(selection.targetLanguage));
  if (!languageMatches.length) return unavailable(explicit ? 'MODEL_NOT_COMPATIBLE' : 'LANGUAGE_NOT_SUPPORTED');
  const compatible = languageMatches.filter(candidate => matchesRuntime(candidate, selection)
    && (!Object.hasOwn(candidate, 'voices') || candidate.voices.some(voice => voice.languages.includes(selection.targetLanguage))));
  if (!compatible.length) return unavailable('MODEL_NOT_COMPATIBLE');
  if (compatible.length > 1) return unavailable('AMBIGUOUS_MODEL');
  const model = compatible[0];
  return freezeTree({
    state: 'compatible', modelId: model.id, kind: model.kind, backend: model.backend,
    format: model.format, targetLanguage: selection.targetLanguage,
    runtimeProfile: selection.runtimeProfile,
    ...(Object.hasOwn(model, 'voices') ? { voiceIds: model.voices
      .filter(voice => voice.languages.includes(selection.targetLanguage)).map(voice => voice.id) } : {}),
  });
}

module.exports = { canonicalLanguageTag, parseSpeechModelCapabilities, selectSpeechModel };
