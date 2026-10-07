'use strict';
// NON_NATIVE: exact requestProviderChat desktop branch; IPC payload must be structured-clone safe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../apps/web/index.html'), 'utf8');
function section(a, b) { const start = html.indexOf(a), end = html.indexOf(b, start); assert(start >= 0 && end > start); return html.slice(start, end); }

function load(api) {
  const context = vm.createContext({
    window: { electronAPI: api },
    getProviderConfig: () => ({ authMode: 'optional' }), isSubscriptionProvider: id => id === 'sub',
    hasDesktopSubscriptionBroker: () => true,
    desktopProviderProfile: () => 'omlx', desktopProviderTarget: () => ({ providerId: 'omlx' }), desktopCredentialWrites: new Map(),
    APPLE_FOUNDATION_MODEL_PROVIDER_ID: 'apple',
  });
  vm.runInContext(section('// IPC carries plain {role, content} only', 'function populateModelSelect('), context);
  return context;
}

const history = () => {
  const owner = { epoch: 1, cancel() {}, turnId: 't1' };
  return [
    { role: 'system', content: 'coach' },
    { role: 'user', content: 'Hi! I want to practice ordering coffee.', turnId: 't1', owner },
    { role: 'assistant', content: 'Sure!', owner, outcome: Object.freeze({ status: 'success' }) },
  ];
};

for (const [label, providerId, key] of [['provider broker', 'omlx', 'providerOperation'], ['subscription broker', 'sub', 'subscriptionOperation']]) {
  test(`${label} IPC payload carries only {role, content}`, async () => {
    let sent;
    const ctx = load({ [key]: async payload => { sent = payload; structuredClone(payload); return { text: ' Hi there! ' }; } });
    const reply = await ctx.requestProviderChat({ providerId, model: 'm', conversationMessages: history(), maxTokens: 300 });
    assert.equal(reply, 'Hi there!');
    assert.deepEqual(JSON.parse(JSON.stringify(sent.messages)), [
      { role: 'system', content: 'coach' },
      { role: 'user', content: 'Hi! I want to practice ordering coffee.' },
      { role: 'assistant', content: 'Sure!' },
    ]);
  });
}
