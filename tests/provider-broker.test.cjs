const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderBroker } = require('../apps/desktop/provider-broker.cjs');

function responseJson(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extraHeaders } });
}

function brokerFixture(fetchImpl, stored = new Set()) {
  const reads = [];
  const credentialStore = {
    get: async provider => { reads.push(provider); return `key-for-${provider}`; },
    has: async provider => ({ hasCredential: stored.has(provider) }),
  };
  return { broker: new ProviderBroker({ credentialStore, fetchImpl }), reads };
}

test('model list uses fixed provider endpoint and main-process bearer credential', async () => {
  let request;
  const { broker, reads } = brokerFixture(async (url, options) => {
    request = { url, options };
    return responseJson({ data: [{ id: 'gpt-4o-mini' }] });
  });
  const result = await broker.operation({ operation: 'models', providerId: 'openai' });
  assert.deepEqual(result, { models: ['gpt-4o-mini'] });
  assert.equal(request.url, 'https://api.openai.com/v1/models');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer key-for-openai');
  assert.deepEqual(reads, ['openai']);
  assert.doesNotMatch(JSON.stringify(result), /key-for/);
});

test('anthropic chat injects x-api-key and returns only normalized text', async () => {
  let request;
  const { broker } = brokerFixture(async (url, options) => {
    request = { url, options };
    return responseJson({ content: [{ type: 'text', text: 'Hello' }] });
  });
  const result = await broker.operation({
    operation: 'chat', providerId: 'claude', model: 'claude-haiku-4-5', maxTokens: 20,
    messages: [{ role: 'user', content: 'Hi' }],
  });
  assert.deepEqual(result, { text: 'Hello' });
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.options.headers['x-api-key'], 'key-for-claude');
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
});

test('rejects unknown fields, custom providers, and renderer supplied URLs', async () => {
  const { broker } = brokerFixture(async () => { throw new Error('must not fetch'); });
  await assert.rejects(broker.operation({ operation: 'models', providerId: 'openai', baseUrl: 'http://169.254.169.254' }), /INVALID_PROVIDER_OPERATION/);
  await assert.rejects(broker.operation({ operation: 'models', providerId: 'nope' }), /PROVIDER_NOT_ALLOWED/);
  await assert.rejects(broker.operation({ operation: 'models', providerId: 'custom' }), /INVALID_PROVIDER_ENDPOINT/);
  for (const baseUrl of ['file:///etc/passwd', 'http://u:p@host/v1', 'not a url', 42])
    await assert.rejects(broker.operation({ operation: 'models', providerId: 'custom', baseUrl }), /INVALID_PROVIDER_ENDPOINT/);
  await assert.rejects(broker.operation({ operation: 'chat', providerId: 'openai', model: 'x', messages: [], method: 'DELETE' }), /INVALID_PROVIDER_OPERATION/);
});

test('local providers never read secrets and use only fixed loopback endpoints', async () => {
  const requests = [];
  const { broker, reads } = brokerFixture(async url => {
    requests.push(url);
    return responseJson({ data: [{ id: 'local-model' }] });
  });
  for (const [providerId, endpoint] of [
    ['llamacpp', 'http://127.0.0.1:8080/v1/models'],
    ['ollama', 'http://127.0.0.1:11434/v1/models'],
    ['lmstudio', 'http://127.0.0.1:1234/v1/models'],
    ['omlx', 'http://127.0.0.1:8000/v1/models'],
  ]) {
    assert.deepEqual(await broker.operation({ operation: 'models', providerId }), { models: ['local-model'] });
    assert.equal(requests.at(-1), endpoint);
  }
  assert.deepEqual(reads, []);
});

test('provider broker rejects every STT request so audio never leaves the device', async () => {
  let fetches = 0;
  const { broker } = brokerFixture(async () => {
    fetches += 1;
    return responseJson({ text: 'must-not-be-used' });
  });
  await assert.rejects(
    broker.operation({ operation: 'stt', providerId: 'groq', audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm', language: 'en' }),
    /INVALID_PROVIDER_OPERATION/,
  );
  assert.equal(fetches, 0);
});

test('provider HTTP errors do not expose response bodies to the renderer', async () => {
  const marker = 'provider-private-diagnostic';
  const { broker } = brokerFixture(async () => responseJson({ error: marker }, 401));

  await assert.rejects(
    broker.operation({ operation: 'models', providerId: 'openai' }),
    error => error.message === 'PROVIDER_HTTP_401' && !error.message.includes(marker),
  );
});

test('caps provider response bytes before parsing', async () => {
  const { broker } = brokerFixture(async () => responseJson({ data: [] }, 200, { 'content-length': String(2 * 1024 * 1024) }));
  await assert.rejects(broker.operation({ operation: 'models', providerId: 'openai' }), /PROVIDER_RESPONSE_TOO_LARGE/);
});

test('oMLX models and chat route only to fixed 127.0.0.1:8000 without secrets and reject redirects', async () => {
  const requests = [];
  const { broker, reads } = brokerFixture(async (url, options) => {
    requests.push({ url, options });
    if (options.redirect !== 'error') throw new Error('REDIRECT_POLICY_MUST_BE_ERROR');
    if (url === 'http://127.0.0.1:8000/v1/models') {
      return responseJson({ data: [{ id: 'mlx-community/Qwen2.5-7B-Instruct-4bit' }] });
    }
    if (url === 'http://127.0.0.1:8000/v1/chat/completions') {
      return responseJson({ choices: [{ message: { content: 'local omlx reply' } }] });
    }
    throw new Error(`UNEXPECTED_URL:${url}`);
  });

  const modelsResult = await broker.operation({ operation: 'models', providerId: 'omlx' });
  assert.deepEqual(modelsResult, { models: ['mlx-community/Qwen2.5-7B-Instruct-4bit'] });
  assert.equal(requests[0].url, 'http://127.0.0.1:8000/v1/models');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, undefined);

  const chatResult = await broker.operation({
    operation: 'chat',
    providerId: 'omlx',
    model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 50,
  });
  assert.deepEqual(chatResult, { text: 'local omlx reply' });
  assert.equal(requests[1].url, 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.deepEqual(reads, []);

  // Reject renderer URL or header override attempts
  await assert.rejects(
    broker.operation({ operation: 'models', providerId: 'omlx', baseUrl: 'http://127.0.0.1:9000/v1' }),
    /INVALID_PROVIDER_OPERATION/,
  );
  await assert.rejects(
    broker.operation({ operation: 'chat', providerId: 'omlx', model: 'test', messages: [{ role: 'user', content: 'x' }], headers: { Authorization: 'Bearer evil' } }),
    /INVALID_PROVIDER_OPERATION/,
  );
});

test('oMLX connection refused produces clean PROVIDER_CONNECTION_REFUSED error', async () => {
  const { broker } = brokerFixture(async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  });

  await assert.rejects(
    broker.operation({ operation: 'models', providerId: 'omlx' }),
    /PROVIDER_CONNECTION_REFUSED/,
  );
});

test('custom endpoint: user-set URL (any host/port), key optional and not URL-bound', async () => {
  const calls = [];
  const { broker } = brokerFixture(async (url, options) => { calls.push({ url, options });
    return url.endsWith('/models') ? responseJson({ data: [{ id: 'ornith-9b' }] }) : responseJson({ choices: [{ message: { content: 'Hi' } }] }); });
  assert.deepEqual(await broker.operation({ operation: 'models', providerId: 'custom', baseUrl: 'http://127.0.0.1:8080/v1/' }), { models: ['ornith-9b'] });
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/models');
  assert.equal(calls[0].options.headers.Authorization, undefined, 'no stored key -> no Authorization header');
  await broker.operation({ operation: 'chat', providerId: 'custom', baseUrl: 'https://llm.example.com:9443/v1', model: 'm', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(calls[1].url, 'https://llm.example.com:9443/v1/chat/completions');
  await assert.rejects(broker.operation({ operation: 'models', providerId: 'openai', baseUrl: 'http://127.0.0.1:8080/v1' }), /INVALID_PROVIDER_OPERATION/);
});

test('custom endpoint sends the stored custom key when one is set', async () => {
  let headers;
  const { broker } = brokerFixture(async (url, options) => { headers = options.headers; return responseJson({ data: [{ id: 'm' }] }); }, new Set(['custom']));
  await broker.operation({ operation: 'models', providerId: 'custom', baseUrl: 'https://my-gateway.example/v1' });
  assert.equal(headers.Authorization, 'Bearer key-for-custom');
});
