'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ProviderBroker, PROVIDERS } = require('../apps/desktop/provider-broker.cjs');
const { PROVIDER_CHECKS } = require('../scripts/verify-windows-local-providers.cjs');

function makeBroker({
  credentialStore = { get: async () => 'test-key' },
  fetchImpl = async () => { throw new Error('fetch not implemented in test'); }
} = {}) {
  return new ProviderBroker({ credentialStore, fetchImpl });
}

function mockJsonResponse({ body = { choices: [{ message: { content: 'hello from local model' } }] }, ok = true, status = 200 } = {}) {
  const textValue = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = Buffer.from(textValue);
  return {
    ok,
    status,
    headers: {
      get: (name) => {
        if (name.toLowerCase() === 'content-length') return String(bytes.length);
        return null;
      },
    },
    text: async () => textValue,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function mockChatResponse({ content = 'hello from local model', ok = true, status = 200 } = {}) {
  const body = { choices: [{ message: { content } }] };
  return mockJsonResponse({ body, ok, status });
}

function mockModelsResponse({ models = ['llama3:latest', 'phi-3:mini'], ok = true, status = 200 } = {}) {
  const body = { data: models.map(id => ({ id })) };
  return mockJsonResponse({ body, ok, status });
}

test('Windows Desktop Lite routes ollama to loopback port 11434', async () => {
  assert.ok(PROVIDERS.ollama, 'ollama provider must be defined');
  assert.equal(PROVIDERS.ollama.base, 'http://127.0.0.1:11434/v1');
  assert.equal(PROVIDERS.ollama.host, '127.0.0.1');
  assert.equal(PROVIDERS.ollama.secret, false);

  const calls = [];
  const broker = makeBroker({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return mockChatResponse();
    }
  });

  const response = await broker.chat({
    operation: 'chat',
    providerId: 'ollama',
    model: 'llama3:latest',
    messages: [{ role: 'user', content: 'test' }],
    maxTokens: 32,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(response.text, 'hello from local model');
});

test('Windows live verifier requires the operator-provided llama.cpp endpoint and model alias', () => {
  const config = PROVIDER_CHECKS.find(item => item.id === 'llamacpp');
  assert.ok(config);
  assert.equal(config.probeUrl, 'http://127.0.0.1:8080/v1/models');
  assert.equal(config.expectedModel, process.env.LLAMACPP_MODEL || 'ornith-9b');
});

test('Windows Desktop Lite routes llama.cpp to loopback port 8080', async () => {
  assert.ok(PROVIDERS.llamacpp, 'llamacpp provider must be defined');
  assert.equal(PROVIDERS.llamacpp.base, 'http://127.0.0.1:8080/v1');
  assert.equal(PROVIDERS.llamacpp.host, '127.0.0.1');
  assert.equal(PROVIDERS.llamacpp.secret, false);

  const calls = [];
  const broker = makeBroker({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return mockChatResponse({ content: 'hello from ornith-9b' });
    }
  });

  const response = await broker.chat({
    operation: 'chat',
    providerId: 'llamacpp',
    model: 'ornith-9b',
    messages: [{ role: 'user', content: 'test' }],
    maxTokens: 32,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(response.text, 'hello from ornith-9b');
});

test('Windows Desktop Lite routes lmstudio to loopback port 1234', async () => {
  assert.ok(PROVIDERS.lmstudio, 'lmstudio provider must be defined');
  assert.equal(PROVIDERS.lmstudio.base, 'http://127.0.0.1:1234/v1');
  assert.equal(PROVIDERS.lmstudio.host, '127.0.0.1');
  assert.equal(PROVIDERS.lmstudio.secret, false);

  const calls = [];
  const broker = makeBroker({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return mockModelsResponse({ models: ['lmstudio-model-1'] });
    }
  });

  const response = await broker.models({
    operation: 'models',
    providerId: 'lmstudio',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/models');
  assert.deepEqual(response.models, ['lmstudio-model-1']);
});

test('local Windows providers never fetch credentials from store', async () => {
  let credentialReads = 0;
  const credentialStore = {
    get: async () => {
      credentialReads += 1;
      return 'secret';
    }
  };

  const broker = makeBroker({
    credentialStore,
    fetchImpl: async (url) => {
      if (url.includes('/models')) return mockModelsResponse();
      return mockChatResponse();
    }
  });

  await broker.chat({
    operation: 'chat',
    providerId: 'ollama',
    model: 'llama3',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 10,
  });

  await broker.models({
    operation: 'models',
    providerId: 'lmstudio',
  });

  await broker.chat({
    operation: 'chat',
    providerId: 'llamacpp',
    model: 'ornith-9b',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 10,
  });

  assert.equal(credentialReads, 0, 'zero credentials should be accessed for local loopback providers');
});

test('broker rejects non-loopback endpoints and invalid operations', async () => {
  const broker = makeBroker();

  await assert.rejects(
    broker.operation({ operation: 'invalid-op', providerId: 'ollama' }),
    { message: 'INVALID_PROVIDER_OPERATION' }
  );

  await assert.rejects(
    broker.chat({ operation: 'chat', providerId: 'unknown-lan-profile', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    { message: 'PROVIDER_NOT_ALLOWED' }
  );
});

test('broker rejects oversize responses to prevent memory exhaustion', async () => {
  const hugeBody = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) });
  const broker = makeBroker({
    fetchImpl: async () => mockJsonResponse({ body: hugeBody })
  });

  await assert.rejects(
    broker.chat({
      operation: 'chat',
      providerId: 'ollama',
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
    }),
    { message: 'PROVIDER_RESPONSE_TOO_LARGE' }
  );
});

test('broker maps HTTP error statuses to descriptive error messages', async () => {
  const broker = makeBroker({
    fetchImpl: async () => mockJsonResponse({ body: 'Not Found', ok: false, status: 404 })
  });

  await assert.rejects(
    broker.models({ operation: 'models', providerId: 'ollama' }),
    { message: 'PROVIDER_HTTP_404' }
  );
});

test('broker rejects invalid message roles or content types', async () => {
  const broker = makeBroker({ fetchImpl: async () => mockJsonResponse() });

  await assert.rejects(
    broker.chat({
      operation: 'chat',
      providerId: 'ollama',
      model: 'm',
      messages: [{ role: 'bad-role', content: 'hi' }],
    }),
    { message: 'INVALID_MESSAGES' }
  );

  await assert.rejects(
    broker.chat({
      operation: 'chat',
      providerId: 'ollama',
      model: 'm',
      messages: [],
    }),
    { message: 'INVALID_MESSAGES' }
  );
});
