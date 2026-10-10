(function exposeDirectApiPresets(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceDirectApiPresets = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createDirectApiPresets() {
  'use strict';

  const PRESETS = Object.freeze({
    openai: Object.freeze({ id: 'openai', name: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', defaultModel: '' }),
    gemini: Object.freeze({ id: 'gemini', name: 'Google Gemini API Key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash' }),
  });

  function getDirectApiPreset(id) {
    const preset = PRESETS[id];
    if (!preset) throw new Error('UNKNOWN_DIRECT_API_PRESET');
    return { ...preset };
  }

  return Object.freeze({ getDirectApiPreset });
}));
