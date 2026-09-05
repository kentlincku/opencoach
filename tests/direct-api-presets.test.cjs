const assert = require('node:assert/strict');
const test = require('node:test');

const presets = require('../apps/web/runtime/direct-api-presets.js');

test('OpenAI, Gemini, and oMLX presets use fixed official or local OpenAI-compatible endpoints', () => {
  assert.deepEqual(presets.getDirectApiPreset('omlx'), {
    id: 'omlx',
    name: 'oMLX（本機）',
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: '',
    credentialRequired: false,
  });
  assert.deepEqual(presets.getDirectApiPreset('openai'), {
    id: 'openai',
    name: 'OpenAI API',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
  });
  assert.deepEqual(presets.getDirectApiPreset('gemini'), {
    id: 'gemini',
    name: 'Google Gemini API Key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  });
});

test('unknown direct API preset fails closed', () => {
  assert.throws(() => presets.getDirectApiPreset('attacker'), /UNKNOWN_DIRECT_API_PRESET/);
});

test('local model servers are explicit API endpoint presets without credentials', () => {
  const expected = {
    llamacpp: 'http://127.0.0.1:8080/v1',
    ollama: 'http://127.0.0.1:11434/v1',
    lmstudio: 'http://127.0.0.1:1234/v1',
    omlx: 'http://127.0.0.1:8000/v1',
  };
  for (const [id, baseUrl] of Object.entries(expected)) {
    const preset = presets.getDirectApiPreset(id);
    assert.equal(preset.baseUrl, baseUrl);
    assert.equal(preset.credentialRequired, false);
  }
});
