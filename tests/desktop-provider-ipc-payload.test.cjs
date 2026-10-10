'use strict';
// NON_NATIVE: exact requestProviderChat desktop branch; IPC payload must be structured-clone safe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../apps/web/index.html'), 'utf8');
function section(a, b) { const start = html.indexOf(a), end = html.indexOf(b, start); assert(start >= 0 && end > start); return html.slice(start, end); }

function load(providerOperation) {
  const context = vm.createContext({
    window: { electronAPI: { providerOperation } },
    voiceSessionEpoch: 1, voiceUnloading: false, voiceRuntime: null,
    assertProviderSelectable() {}, getProviderConfig: () => ({ authMode: 'optional' }),
    desktopProviderProfile: () => 'omlx', desktopProviderTarget: () => ({ providerId: 'omlx' }), desktopCredentialWrites: new Map(),
  });
  vm.runInContext(section('async function requestProviderChat(', 'function populateModelSelect('), context);
  return context;
}

test('desktop chat IPC payload carries only {role, content} even when UI history holds turn owners', async () => {
  let sent;
  const ctx = load(async payload => { sent = payload; structuredClone(payload); return { text: ' Hi there! ' }; });
  const owner = { epoch: 1, cancel() {}, turnId: 't1' };
  const history = [
    { role: 'system', content: 'coach' },
    { role: 'user', content: 'Hi! I want to practice ordering coffee.', turnId: 't1', ownerId: 't1', owner },
    { role: 'assistant', content: 'Sure!', turnId: 't0', ownerId: 't0', owner, outcome: Object.freeze({ status: 'success' }), terminal: true },
  ];
  ctx.history = history;
  const text = await vm.runInContext(`requestProviderChat({ requestId: 'r1', providerId: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', apiKey: '', model: 'm', conversationMessages: history, maxTokens: 300 })`, ctx);
  assert.equal(text, 'Hi there!');
  assert.deepEqual(Object.keys(sent).sort(), ['maxTokens', 'messages', 'model', 'operation', 'providerId']);
  assert.equal(sent.messages.length, 3);
  for (const message of sent.messages) assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
  assert.equal(sent.messages[1].content, 'Hi! I want to practice ordering coffee.');
  assert.ok(history[1].owner, 'UI history itself is not mutated');
});

test('malformed history still reaches the broker for its own strict refusal', async () => {
  let sent;
  const ctx = load(async payload => { sent = payload; throw new Error('INVALID_MESSAGES'); });
  await assert.rejects(vm.runInContext(`requestProviderChat({ requestId: 'r2', providerId: 'openai-compatible', baseUrl: 'x', apiKey: '', model: 'm', conversationMessages: [{ role: 'tool', content: 1 }] })`, ctx), /INVALID_MESSAGES/);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.messages)), [{ role: 'tool', content: 1 }]);
});
