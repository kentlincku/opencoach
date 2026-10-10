const assert = require('node:assert/strict');
const test = require('node:test');

const presets = require('../apps/web/runtime/direct-api-presets.js');

test('OpenAI and Gemini API-key presets use fixed official OpenAI-compatible endpoints', () => {
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
