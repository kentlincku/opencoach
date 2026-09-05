'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  PROVIDER_IDS,
  PROVIDER_STATES,
  getProviderDefinition,
  getProviderState,
  listProviderDefinitions,
  normalizeLlmCapabilities,
} = require('../apps/web/runtime/llm-provider-contract.js');

const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(__dirname, '../apps/web/service-worker.js'), 'utf8');

test('defines stable shared provider identities and separates auth products', () => {
  assert.equal(PROVIDER_IDS.OPENAI_COMPATIBLE, 'openai-compatible');
  assert.equal(PROVIDER_IDS.CHATGPT_SUBSCRIPTION, 'chatgpt-subscription');
  assert.equal(PROVIDER_IDS.GROK_SUBSCRIPTION, 'grok-subscription');
  assert.equal(PROVIDER_IDS.APPLE_FOUNDATION_MODELS, 'apple-foundation-models');
  assert.equal(getProviderDefinition('openai-compatible').authProduct, 'api-key-or-none');
  assert.equal(getProviderDefinition('chatgpt-subscription').authProduct, 'chatgpt-subscription');
  assert.equal(getProviderDefinition('grok-subscription').authProduct, 'grok-subscription');
  assert.equal(getProviderDefinition('apple-foundation-models').authProduct, 'none');
  assert.deepEqual(Object.values(PROVIDER_IDS), [
    'openai-compatible',
    'chatgpt-subscription',
    'grok-subscription',
    'apple-foundation-models',
  ]);
});

test('keeps OpenAI-compatible available where an adapter exists and gates pending native mobile adapters', () => {
  for (const platform of ['browser', 'macos', 'windows']) {
    assert.equal(getProviderState('openai-compatible', { platform }), PROVIDER_STATES.AVAILABLE);
  }
  for (const platform of ['ios', 'android']) {
    assert.equal(getProviderState('openai-compatible', { platform }), PROVIDER_STATES.UNAVAILABLE);
    assert.equal(getProviderState('openai-compatible', {
      platform,
      availableProviders: ['openai-compatible'],
    }), PROVIDER_STATES.AVAILABLE);
  }
});

test('subscription providers require an advertised trusted Desktop adapter', () => {
  for (const providerId of ['chatgpt-subscription', 'grok-subscription']) {
    assert.equal(getProviderState(providerId, { platform: 'browser' }), PROVIDER_STATES.UNAVAILABLE);
    assert.equal(getProviderState(providerId, { platform: 'ios' }), PROVIDER_STATES.UNAVAILABLE);
    assert.equal(getProviderState(providerId, { platform: 'android' }), PROVIDER_STATES.UNAVAILABLE);
    assert.equal(getProviderState(providerId, { platform: 'windows' }), PROVIDER_STATES.UNAVAILABLE);
    assert.equal(getProviderState(providerId, {
      platform: 'windows', subscriptionProviders: [providerId],
    }), PROVIDER_STATES.AVAILABLE);
    assert.equal(getProviderState(providerId, {
      platform: 'macos', subscriptionProviders: [providerId],
    }), PROVIDER_STATES.AVAILABLE);
  }
});

test('rejects unsupported account-login provider identities', () => {
  assert.throws(() => getProviderState('google-gemini-oauth', { platform: 'browser' }), /UNKNOWN_LLM_PROVIDER/);
  assert.throws(() => getProviderState('claude-subscription', { platform: 'windows' }), /UNKNOWN_LLM_PROVIDER/);
});

test('exposes Apple Foundation Models only when the trusted iOS adapter advertises it', () => {
  assert.equal(getProviderState('apple-foundation-models', { platform: 'ios' }), PROVIDER_STATES.UNAVAILABLE);
  assert.equal(getProviderState('apple-foundation-models', {
    platform: 'ios',
    platformLocalProviders: ['apple-foundation-models'],
  }), PROVIDER_STATES.AVAILABLE);
  assert.equal(getProviderState('apple-foundation-models', {
    platform: 'windows',
    platformLocalProviders: ['apple-foundation-models'],
  }), PROVIDER_STATES.UNAVAILABLE);
});

test('returns defensive provider metadata and rejects unknown inputs', () => {
  const providers = listProviderDefinitions();
  providers[0].name = 'tampered';
  assert.notEqual(getProviderDefinition(providers[0].id).name, 'tampered');
  assert.throws(() => getProviderDefinition('unknown'), /UNKNOWN_LLM_PROVIDER/);
  assert.throws(() => getProviderState('openai-compatible', { platform: 'linux' }), /UNKNOWN_PRODUCT_PLATFORM/);
  assert.throws(() => getProviderState('openai-compatible', null), /INVALID_PLATFORM_CONTEXT/);
});

test('defines a versioned cross-language LLM capability schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/llm-runtime.schema.json'), 'utf8'));
  assert.deepEqual(schema.required, ['protocol', 'platform', 'providers']);
  assert.deepEqual(schema.properties.protocol, { const: 1 });
  assert.deepEqual(schema.properties.platform.enum, ['browser', 'macos', 'windows', 'ios', 'android']);
  const provider = schema.properties.providers.items;
  assert.deepEqual(provider.required, ['id', 'state', 'authProduct']);
  assert.deepEqual(provider.properties.id.enum, listProviderDefinitions().map(item => item.id));
  assert.deepEqual(provider.properties.state.enum, [
    'AVAILABLE',
    'UNAVAILABLE_ACCURATELY_DISABLED',
  ]);
  assert.deepEqual(provider.properties.authProduct.enum, [
    'api-key-or-none',
    'chatgpt-subscription',
    'grok-subscription',
    'none',
  ]);
});

test('normalizes capability payloads and rejects duplicate or unknown provider identities', () => {
  const valid = normalizeLlmCapabilities({
    protocol: 1,
    platform: 'browser',
    providers: [{ id: 'openai-compatible', state: 'AVAILABLE', authProduct: 'api-key-or-none' }],
  });
  assert.deepEqual(valid, {
    protocol: 1,
    platform: 'browser',
    providers: [{ id: 'openai-compatible', state: 'AVAILABLE', authProduct: 'api-key-or-none' }],
  });
  assert.throws(() => normalizeLlmCapabilities({
    protocol: 1,
    platform: 'ios',
    providers: [
      { id: 'openai-compatible', state: 'AVAILABLE', authProduct: 'api-key-or-none' },
      { id: 'openai-compatible', state: 'UNAVAILABLE_ACCURATELY_DISABLED', authProduct: 'api-key-or-none' },
    ],
  }), /INVALID_LLM_CAPABILITIES/);
  assert.throws(() => normalizeLlmCapabilities({
    protocol: 1,
    platform: 'android',
    providers: [{ id: 'unknown-provider', state: 'AVAILABLE', authProduct: 'none' }],
  }), /INVALID_LLM_CAPABILITIES/);
});

test('loads and precaches the shared LLM provider contract before application code', () => {
  const script = 'src="./runtime/llm-provider-contract.js"';
  assert.ok(html.includes(script));
  assert.ok(html.indexOf(script) < html.indexOf('const DIRECT_API_PROVIDER_ID'));
  assert.ok(serviceWorker.includes('./runtime/llm-provider-contract.js'));
  assert.match(serviceWorker, /voice-practice-app-v25-20260903/);
});

test('derives UI provider IDs and metadata from the shared registry', () => {
  assert.match(html, /VoiceLlmProviderContract\.PROVIDER_IDS/);
  assert.match(html, /VoiceLlmProviderContract\.getProviderDefinition/);
  assert.doesNotMatch(html, /const PROVIDERS_CONFIG = \{/);
});
