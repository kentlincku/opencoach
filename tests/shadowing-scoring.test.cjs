'use strict';
// NON_NATIVE: exact shadowing helpers from index.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../apps/web/index.html'), 'utf8');
const start = html.indexOf('function evaluateShadowingTranscript(');
const end = html.indexOf('function renderShadowingResult(', start);
assert(start >= 0 && end > start);
const ctx = vm.createContext({});
vm.runInContext(html.slice(start, end), ctx);

test('shadow target is the first sentence of a multi-sentence reply', () => {
  assert.equal(ctx.shadowingTargetSentence("Sure! What size would you like? We have three."), 'Sure!');
  assert.equal(ctx.shadowingTargetSentence('Could I get a medium latte, please? Thanks.'), 'Could I get a medium latte, please?');
  assert.equal(ctx.shadowingTargetSentence('No punctuation here'), 'No punctuation here');
});

test('scoring ignores punctuation and case on both sides', () => {
  const r = ctx.evaluateShadowingTranscript('Could I get a medium latte, please?', 'could i get a medium latte please');
  assert.equal(r.score, 100);
  const partial = ctx.evaluateShadowingTranscript("I'd like a latte.", "I'd like tea");
  assert.deepEqual(Array.from(partial.hits), [true, true, false, false]);
  assert.equal(partial.score, 50);
});
