const assert = require('node:assert/strict');
const test = require('node:test');

const policy = require('../apps/web/runtime/language-policy.js');

test('detects CJK characters in a coach reply', () => {
  assert.equal(policy.containsCjk('Hello, how are you?'), false);
  assert.equal(policy.containsCjk('你好, how are you?'), true);
  assert.equal(policy.containsCjk('日本語'), true);
  assert.equal(policy.containsCjk('한국어'), true);
});

test('sanitizes CJK text before speech synthesis', () => {
  assert.equal(
    policy.sanitizeEnglishSpeechText('Hello 你好，how are you？'),
    'Hello, how are you?'
  );
  assert.equal(policy.sanitizeEnglishSpeechText('這是一段中文。'), '');
});

test('rejects empty or CJK coach replies', () => {
  assert.equal(policy.isEnglishOnlyReply('Keep going!'), true);
  assert.equal(policy.isEnglishOnlyReply('很好！ Keep going!'), false);
  assert.equal(policy.isEnglishOnlyReply('   '), false);
});
