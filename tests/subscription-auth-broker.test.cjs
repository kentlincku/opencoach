const test = require('node:test');
const assert = require('node:assert/strict');
const { SubscriptionAuthBroker } = require('../apps/desktop/subscription-auth-broker.cjs');

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function memoryStore() {
  const values = new Map();
  return {
    available: () => true,
    has: async id => ({ hasCredential: values.has(id) }),
    get: async id => { if (!values.has(id)) throw new Error('CREDENTIAL_REQUIRED'); return values.get(id); },
    set: async (id, value) => { values.set(id, value); return { stored: true }; },
    clear: async id => { values.delete(id); return { cleared: true }; },
    values,
  };
}

test('advertises only subscription providers with a product-owned client ID and secure storage', () => {
  const store = memoryStore();
  const none = new SubscriptionAuthBroker({ credentialStore: store, clientIds: {}, fetchImpl: async () => { throw new Error('unused'); } });
  assert.deepEqual(none.capabilities(), { providers: [] });

  const chatgpt = new SubscriptionAuthBroker({
    credentialStore: store,
    clientIds: { chatgpt: 'voice-practice-chatgpt-client' },
    fetchImpl: async () => { throw new Error('unused'); },
  });
  assert.deepEqual(chatgpt.capabilities(), { providers: ['chatgpt-subscription'] });

  const grokWithoutRegisteredScope = new SubscriptionAuthBroker({
    credentialStore: store, clientIds: { grok: 'voice-practice-grok-client' },
    fetchImpl: async () => { throw new Error('unused'); },
  });
  assert.deepEqual(grokWithoutRegisteredScope.capabilities(), { providers: [] });
});

test('ChatGPT begin login keeps device authorization secrets in Main memory', async () => {
  const requests = [];
  const broker = new SubscriptionAuthBroker({
    credentialStore: memoryStore(),
    clientIds: { chatgpt: 'voice-practice-chatgpt-client' },
    randomId: () => 'login-id',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ user_code: 'ABCD-EFGH', device_auth_id: 'main-only-secret', interval: 5 });
    },
  });

  const result = await broker.beginLogin({ providerId: 'chatgpt-subscription' });
  assert.deepEqual(result, {
    state: 'authorizing', loginId: 'login-id',
    verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', intervalSeconds: 5,
  });
  assert.equal(JSON.stringify(result).includes('main-only-secret'), false);
  assert.equal(requests[0].url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
  assert.deepEqual(JSON.parse(requests[0].options.body), { client_id: 'voice-practice-chatgpt-client' });
});

test('rejects login when the provider client ID is not configured', async () => {
  const broker = new SubscriptionAuthBroker({ credentialStore: memoryStore(), clientIds: {}, fetchImpl: async () => { throw new Error('unused'); } });
  await assert.rejects(broker.beginLogin({ providerId: 'grok-subscription' }), /SUBSCRIPTION_PROVIDER_UNAVAILABLE/);
});

test('Grok begin login uses the fixed xAI device endpoint and returns only public verification data', async () => {
  const requests = [];
  const broker = new SubscriptionAuthBroker({
    credentialStore: memoryStore(),
    clientIds: { grok: 'voice-practice-grok-client' },
    grokScope: 'openid offline_access voice-practice:access',
    randomId: () => 'grok-login',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        device_code: 'main-only-device-code', user_code: 'GROK-CODE',
        verification_uri: 'https://auth.x.ai/device',
        verification_uri_complete: 'https://auth.x.ai/device?user_code=GROK-CODE',
        expires_in: 600, interval: 7,
      });
    },
  });

  const result = await broker.beginLogin({ providerId: 'grok-subscription' });
  assert.deepEqual(result, {
    state: 'authorizing', loginId: 'grok-login',
    verificationUri: 'https://auth.x.ai/device?user_code=GROK-CODE',
    userCode: 'GROK-CODE', intervalSeconds: 7,
  });
  assert.equal(JSON.stringify(result).includes('main-only-device-code'), false);
  assert.equal(requests[0].url, 'https://auth.x.ai/oauth2/device/code');
  assert.equal(requests[0].options.body, 'client_id=voice-practice-grok-client&scope=openid+offline_access+voice-practice%3Aaccess');
});

test('Grok polling handles authorization_pending and then stores an authorized token', async () => {
  const calls = [];
  const responses = [
    jsonResponse({ device_code: 'secret-device', user_code: 'WXYZ', verification_uri: 'https://auth.x.ai/activate', expires_in: 600, interval: 2 }),
    { ok: false, status: 400, text: async () => JSON.stringify({ error: 'authorization_pending' }) },
    jsonResponse({ access_token: 'xai-access', refresh_token: 'xai-refresh', expires_in: 3600 }),
  ];
  const credentials = memoryStore();
  let now = 10_000;
  const broker = new SubscriptionAuthBroker({
    credentialStore: credentials,
    clientIds: { grok: 'voice-grok-client' },
    grokScope: 'openid offline_access voice-practice:access',
    fetchImpl: async (...args) => { calls.push(args); return responses.shift(); },
    now: () => now,
  });
  const login = await broker.beginLogin({ providerId: 'grok-subscription' });
  assert.deepEqual(await broker.pollLogin({ providerId: 'grok-subscription', loginId: login.loginId }), { state: 'authorizing', retryAfterSeconds: 3 });
  assert.equal(calls.length, 1);
  now += 3_000;
  assert.deepEqual(await broker.pollLogin({ providerId: 'grok-subscription', loginId: login.loginId }), { state: 'authorizing', retryAfterSeconds: 3 });
  assert.equal(calls.length, 2);
  now += 3_000;
  assert.deepEqual(await broker.pollLogin({ providerId: 'grok-subscription', loginId: login.loginId }), { state: 'authorized' });
  assert.equal(JSON.parse(credentials.values.get('grok-subscription')).accessToken, 'xai-access');
  assert.equal(calls[1][0], 'https://auth.x.ai/oauth2/token');
});

test('Grok slow_down increases and enforces the polling interval', async () => {
  let now = 5_000;
  let calls = 0;
  const broker = new SubscriptionAuthBroker({
    credentialStore: memoryStore(), clientIds: { grok: 'voice-grok' }, grokScope: 'approved',
    randomId: () => 'slow-login', now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://auth.x.ai/device', interval: 3 });
      return jsonResponse({ error: 'slow_down' }, 400);
    },
  });
  const login = await broker.beginLogin({ providerId: 'grok-subscription' });
  assert.deepEqual(await broker.pollLogin({ providerId: 'grok-subscription', loginId: login.loginId }), { state: 'authorizing', retryAfterSeconds: 3 });
  assert.equal(calls, 1);
  now += 3_000;
  assert.deepEqual(await broker.pollLogin({ providerId: 'grok-subscription', loginId: login.loginId }), { state: 'authorizing', retryAfterSeconds: 8 });
  assert.deepEqual(await broker.pollLogin({ providerId: 'grok-subscription', loginId: login.loginId }), { state: 'authorizing', retryAfterSeconds: 8 });
  assert.equal(calls, 2);
  now += 1_000;
  assert.deepEqual(await broker.pollLogin({ providerId: 'grok-subscription', loginId: login.loginId }), { state: 'authorizing', retryAfterSeconds: 7 });
  assert.equal(calls, 2);
});

test('cancelLogin removes only the matching in-memory authorization transaction', async () => {
  const broker = new SubscriptionAuthBroker({
    credentialStore: memoryStore(), clientIds: { chatgpt: 'voice-client' },
    fetchImpl: async () => jsonResponse({ device_auth_id: 'device-id', user_code: 'ABCD' }),
  });
  const login = await broker.beginLogin({ providerId: 'chatgpt-subscription' });
  assert.deepEqual(await broker.cancelLogin({ providerId: 'chatgpt-subscription', loginId: login.loginId }), { state: 'cancelled' });
  await assert.rejects(() => broker.pollLogin({ providerId: 'chatgpt-subscription', loginId: login.loginId }), /AUTH_TRANSACTION_EXPIRED/);
});

test('ChatGPT polling exchanges and stores tokens without returning plaintext to renderer', async () => {
  const store = memoryStore();
  let step = 0;
  let now = 1_000;
  const broker = new SubscriptionAuthBroker({
    credentialStore: store,
    clientIds: { chatgpt: 'voice-practice-chatgpt-client' },
    randomId: () => 'login-id',
    now: () => now,
    fetchImpl: async (url, options) => {
      step += 1;
      if (step === 1) return jsonResponse({ user_code: 'ABCD', device_auth_id: 'device-id', interval: 3 });
      if (step === 2) {
        assert.equal(url, 'https://auth.openai.com/api/accounts/deviceauth/token');
        assert.deepEqual(JSON.parse(options.body), { device_auth_id: 'device-id', user_code: 'ABCD' });
        return jsonResponse({ authorization_code: 'authorization-code', code_verifier: 'verifier' });
      }
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      assert.equal(options.body, 'grant_type=authorization_code&code=authorization-code&redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback&client_id=voice-practice-chatgpt-client&code_verifier=verifier');
      return jsonResponse({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
    },
  });
  await broker.beginLogin({ providerId: 'chatgpt-subscription' });
  assert.deepEqual(await broker.pollLogin({ providerId: 'chatgpt-subscription', loginId: 'login-id' }), { state: 'authorizing', retryAfterSeconds: 3 });
  assert.equal(step, 1);
  now += 3_000;
  const result = await broker.pollLogin({ providerId: 'chatgpt-subscription', loginId: 'login-id' });
  assert.deepEqual(result, { state: 'authorized' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const saved = JSON.parse(store.values.get('chatgpt-subscription'));
  assert.equal(saved.accessToken, 'access-secret');
  assert.equal(saved.refreshToken, 'refresh-secret');
  assert.equal(saved.clientId, 'voice-practice-chatgpt-client');
});

test('status and logout expose no token material', async () => {
  const store = memoryStore();
  store.values.set('chatgpt-subscription', JSON.stringify({
    version: 1, accessToken: 'access-secret', refreshToken: 'refresh-secret',
    clientId: 'voice-practice-chatgpt-client', expiresAt: 2_000_000,
  }));
  const broker = new SubscriptionAuthBroker({
    credentialStore: store, clientIds: { chatgpt: 'voice-practice-chatgpt-client' },
    now: () => 1_000, fetchImpl: async () => { throw new Error('unused'); },
  });
  const status = await broker.status({ providerId: 'chatgpt-subscription' });
  assert.deepEqual(status, { state: 'authorized' });
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.deepEqual(await broker.logout({ providerId: 'chatgpt-subscription' }), { state: 'signed-out' });
  assert.equal(store.values.has('chatgpt-subscription'), false);
});

test('ChatGPT models and chat use fixed Codex Responses endpoints and account-bound bearer auth', async () => {
  const store = memoryStore();
  const claims = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
  })).toString('base64url');
  store.values.set('chatgpt-subscription', JSON.stringify({
    version: 1, accessToken: `header.${claims}.signature`, refreshToken: 'refresh-secret',
    clientId: 'voice-practice-chatgpt-client', expiresAt: 2_000_000,
  }));
  const requests = [];
  const broker = new SubscriptionAuthBroker({
    credentialStore: store, clientIds: { chatgpt: 'voice-practice-chatgpt-client' }, now: () => 1_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'gpt-5.4' }] });
      return jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Codex reply' }] }] });
    },
  });
  assert.deepEqual(await broker.operation({ operation: 'models', providerId: 'chatgpt-subscription' }), { models: ['gpt-5.4'] });
  assert.deepEqual(await broker.operation({
    operation: 'chat', providerId: 'chatgpt-subscription', model: 'gpt-5.4', maxTokens: 64,
    messages: [{ role: 'system', content: 'Coach.' }, { role: 'user', content: 'Hello' }],
  }), { text: 'Codex reply' });
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/models');
  assert.equal(requests[1].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.match(requests[0].options.headers.Authorization, /^Bearer header\./);
  assert.equal(requests[0].options.headers['ChatGPT-Account-ID'], 'account-123');
  assert.equal(requests[0].options.headers.originator, undefined);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    model: 'gpt-5.4', instructions: 'Coach.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
    store: false, stream: false, max_output_tokens: 64,
  });
});

test('Grok refreshes an expiring token and uses fixed xAI Responses endpoint', async () => {
  const store = memoryStore();
  store.values.set('grok-subscription', JSON.stringify({
    version: 1, accessToken: 'old-access', refreshToken: 'old-refresh',
    clientId: 'voice-practice-grok-client', expiresAt: 1_050,
  }));
  const requests = [];
  const broker = new SubscriptionAuthBroker({
    credentialStore: store, clientIds: { grok: 'voice-practice-grok-client' },
    grokScope: 'openid offline_access voice-practice:access', now: () => 1_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url === 'https://auth.x.ai/oauth2/token') {
        return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
      }
      return jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Grok reply' }] }] });
    },
  });
  assert.deepEqual(await broker.operation({
    operation: 'chat', providerId: 'grok-subscription', model: 'grok-4',
    messages: [{ role: 'user', content: 'Hello' }],
  }), { text: 'Grok reply' });
  assert.equal(requests[0].options.body, 'grant_type=refresh_token&refresh_token=old-refresh&client_id=voice-practice-grok-client');
  assert.equal(requests[1].url, 'https://api.x.ai/v1/responses');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer new-access');
  assert.equal(JSON.parse(store.values.get('grok-subscription')).refreshToken, 'new-refresh');
});

test('auth response limit rejects an oversized unknown-length stream while reading', async () => {
  const broker = new SubscriptionAuthBroker({
    credentialStore: memoryStore(), clientIds: { chatgpt: 'voice-client' },
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(70 * 1024)); controller.close(); },
    })),
  });
  await assert.rejects(broker.beginLogin({ providerId: 'chatgpt-subscription' }), /AUTH_RESPONSE_TOO_LARGE/);
});

test('network requests time out and in-flight polling can be cancelled', async () => {
  const timeoutBroker = new SubscriptionAuthBroker({
    credentialStore: memoryStore(), clientIds: { chatgpt: 'voice-client' }, timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  await assert.rejects(timeoutBroker.beginLogin({ providerId: 'chatgpt-subscription' }), /SUBSCRIPTION_REQUEST_TIMEOUT/);

  let step = 0;
  let now = 1_000;
  const cancelBroker = new SubscriptionAuthBroker({
    credentialStore: memoryStore(), clientIds: { chatgpt: 'voice-client' }, randomId: () => 'cancel-me',
    now: () => now,
    fetchImpl: async (_url, options) => {
      if (step++ === 0) return jsonResponse({ device_auth_id: 'device', user_code: 'CODE', interval: 3 });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const login = await cancelBroker.beginLogin({ providerId: 'chatgpt-subscription' });
  now += 3_000;
  const polling = cancelBroker.pollLogin({ providerId: 'chatgpt-subscription', loginId: login.loginId });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await cancelBroker.cancelLogin({ providerId: 'chatgpt-subscription', loginId: login.loginId }), { state: 'cancelled' });
  await assert.rejects(polling, /SUBSCRIPTION_REQUEST_CANCELLED/);
});

test('concurrent operations share one rotating refresh and reject control characters in models', async () => {
  const store = memoryStore();
  store.values.set('grok-subscription', JSON.stringify({
    version: 1, accessToken: 'old', refreshToken: 'rotating', clientId: 'voice-grok', expiresAt: 1,
  }));
  let refreshes = 0;
  const broker = new SubscriptionAuthBroker({
    credentialStore: store, clientIds: { grok: 'voice-grok' }, grokScope: 'approved', now: () => 1_000,
    fetchImpl: async url => {
      if (url === 'https://auth.x.ai/oauth2/token') {
        refreshes += 1;
        await new Promise(resolve => setImmediate(resolve));
        return jsonResponse({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
      }
      return jsonResponse({ data: [{ id: 'grok-entitled' }] });
    },
  });
  const [first, second] = await Promise.all([
    broker.operation({ operation: 'models', providerId: 'grok-subscription' }),
    broker.operation({ operation: 'models', providerId: 'grok-subscription' }),
  ]);
  assert.deepEqual(first, second);
  assert.equal(refreshes, 1);
  await assert.rejects(broker.operation({
    operation: 'chat', providerId: 'grok-subscription', model: 'bad\nmodel',
    messages: [{ role: 'user', content: 'Hello' }],
  }), /INVALID_MODEL/);
});

test('logout aborts provider work and cannot resurrect an in-flight refresh token', async () => {
  const store = memoryStore();
  store.values.set('grok-subscription', JSON.stringify({
    version: 1, accessToken: 'old', refreshToken: 'rotating', clientId: 'voice-grok', expiresAt: 1,
  }));
  let releaseRefresh;
  const broker = new SubscriptionAuthBroker({
    credentialStore: store, clientIds: { grok: 'voice-grok' }, grokScope: 'approved', now: () => 1_000,
    fetchImpl: async url => {
      if (url !== 'https://auth.x.ai/oauth2/token') throw new Error('provider request must not continue after logout');
      return new Promise(resolve => { releaseRefresh = () => resolve(jsonResponse({ access_token: 'resurrected', refresh_token: 'rotated', expires_in: 3600 })); });
    },
  });
  const operation = broker.operation({ operation: 'models', providerId: 'grok-subscription' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await broker.logout({ providerId: 'grok-subscription' }), { state: 'signed-out' });
  releaseRefresh();
  await assert.rejects(operation, /SUBSCRIPTION_REQUEST_CANCELLED|SUBSCRIPTION_LOGIN_REQUIRED/);
  assert.equal(store.values.has('grok-subscription'), false);
});

test('stale invalid credential reads cannot clear a token saved by a newer logout generation', async () => {
  const store = memoryStore();
  let releaseGet;
  let firstGet = true;
  store.get = async providerId => {
    if (firstGet) {
      firstGet = false;
      return new Promise(resolve => { releaseGet = () => resolve('{"version":0}'); });
    }
    return store.values.get(providerId) || '';
  };
  const broker = new SubscriptionAuthBroker({
    credentialStore: store, clientIds: { grok: 'voice-grok' }, grokScope: 'approved', now: () => 1_000,
    fetchImpl: async () => { throw new Error('provider request must not start'); },
  });
  const staleOperation = broker.operation({ operation: 'models', providerId: 'grok-subscription' });
  await new Promise(resolve => setImmediate(resolve));
  await broker.logout({ providerId: 'grok-subscription' });
  await broker.saveTokens('grok-subscription', 'voice-grok', {
    access_token: 'fresh', refresh_token: 'fresh-refresh', expires_in: 3600,
  });
  releaseGet();
  await assert.rejects(staleOperation, /SUBSCRIPTION_CREDENTIAL_INVALID/);
  assert.equal(JSON.parse(store.values.get('grok-subscription')).accessToken, 'fresh');
});

test('logout serializes behind an in-progress token write and leaves no resurrected token', async () => {
  const store = memoryStore();
  let releaseSet;
  let markSetStarted;
  const setStarted = new Promise(resolve => { markSetStarted = resolve; });
  store.set = async (providerId, value) => {
    markSetStarted();
    await new Promise(resolve => { releaseSet = resolve; });
    store.values.set(providerId, value);
  };
  const broker = new SubscriptionAuthBroker({
    credentialStore: store, clientIds: { grok: 'voice-grok' }, grokScope: 'approved', now: () => 1_000,
    fetchImpl: async () => { throw new Error('unused'); },
  });
  const staleSave = broker.saveTokens('grok-subscription', 'voice-grok', {
    access_token: 'stale', refresh_token: 'stale-refresh', expires_in: 3600,
  });
  const staleSaveRejected = assert.rejects(staleSave, /SUBSCRIPTION_LOGIN_REQUIRED/);
  await setStarted;
  const logout = broker.logout({ providerId: 'grok-subscription' });
  releaseSet();
  await staleSaveRejected;
  assert.deepEqual(await logout, { state: 'signed-out' });
  assert.equal(store.values.has('grok-subscription'), false);
});
