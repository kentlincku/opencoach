'use strict';
// NON_NATIVE: exact cleanTextForTTS from index.html; Kokoro reads emoji names aloud
// ("hot beverage", "smiling face with smiling eyes"), so none may reach TTS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
const start = html.indexOf('function cleanTextForTTS(');
const end = html.indexOf('function playAudioSource(', start);
assert(start >= 0 && end > start);
const context = vm.createContext({ window: { VoiceLanguagePolicy: require('../apps/web/runtime/language-policy.js') } });
vm.runInContext(html.slice(start, end), context);
const clean = text => context.cleanTextForTTS(text);

test('emoji, skin tones, ZWJ sequences, keycaps and flags never reach TTS', () => {
  const cases = {
    'Great choice! ☕': 'Great choice!',
    'Of course! 😊 Coming up.': 'Of course! Coming up.',
    'Sure 👍🏽 ok': 'Sure ok',
    'Hi 🧑‍🍳 there': 'Hi there',
    'Done ✅ and ⭐ great': 'Done and great',
    'Step 1️⃣ first': 'Step 1 first',
    'Welcome 🇺🇸 friend ❤️': 'Welcome friend',
  };
  for (const [input, expected] of Object.entries(cases)) {
    const out = clean(input);
    assert.equal(out, expected, input);
    assert.doesNotMatch(out, /\p{Extended_Pictographic}|[\u200D\uFE0F\u20E3]/u, input);
  }
});

test('plain English text, digits and punctuation are preserved', () => {
  assert.equal(clean("It's 3 o'clock — let's order 2 lattes, please!"), "It's 3 o'clock — let's order 2 lattes, please!");
  assert.equal(clean('Price #1 *bold* [note] ok'), 'Price 1 ok');
});
