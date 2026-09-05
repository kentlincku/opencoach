(function exposeDirectApiPresets(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceDirectApiPresets = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createDirectApiPresets() {
  'use strict';

  const PRESETS = Object.freeze({
    openai: Object.freeze({ id: 'openai', name: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', defaultModel: '' }),
    gemini: Object.freeze({ id: 'gemini', name: 'Google Gemini API Key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash' }),
    llamacpp: Object.freeze({ id: 'llamacpp', name: 'llama.cpp（本機）', baseUrl: 'http://127.0.0.1:8080/v1', defaultModel: '', credentialRequired: false }),
    ollama: Object.freeze({ id: 'ollama', name: 'Ollama（本機）', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: '', credentialRequired: false }),
    lmstudio: Object.freeze({ id: 'lmstudio', name: 'LM Studio（本機）', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: '', credentialRequired: false }),
    omlx: Object.freeze({ id: 'omlx', name: 'oMLX（本機）', baseUrl: 'http://127.0.0.1:8000/v1', defaultModel: '', credentialRequired: false }),
  });

  function getDirectApiPreset(id) {
    const preset = PRESETS[id];
    if (!preset) throw new Error('UNKNOWN_DIRECT_API_PRESET');
    return { ...preset };
  }

  return Object.freeze({ getDirectApiPreset });
}));
