'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SubscriptionAuth, codexAccountHeaders } = require('../apps/desktop/subscription-auth.cjs');
const { ProviderBroker, parseSse } = require('../apps/desktop/provider-broker.cjs');

function memoryStore() {
  const map = new Map();
  return {
    map,
    has: async id => ({ hasCredential: map.has(id) }),
    set: async (id, value) => { map.set(id, value); return { stored: true }; },
    get: async id => { if (!map.has(id)) throw new Error('CREDENTIAL_REQUIRED'); return map.get(id); },
    clear: async id => { map.delete(id); return { cleared: true }; },
  };
}

function reply(status, body, text) {
  return { status, ok: status >= 200 && status < 300, headers: new Map(),
    text: async () => text ?? JSON.stringify(body), json: async () => body };
}

function jwt(claims) {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
}

test('codex device login exchanges code and stores tokens only in Main store', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/deviceauth/usercode')) return reply(200, { user_code: 'ABCD-1234', device_auth_id: 'dev1', interval: 3 });
    if (url.endsWith('/deviceauth/token')) return ++polls === 1 ? reply(403, {}) : reply(200, { authorization_code: 'ac', code_verifier: 'cv' });
    if (url === 'https://auth.openai.com/oauth/token') return reply(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    throw new Error(`unexpected ${url}`);
  };
  const store = memoryStore();
  const auth = new SubscriptionAuth({ credentialStore: store, fetchImpl });
  const login = await auth.beginLogin('chatgpt-subscription');
  assert.equal(login.userCode, 'ABCD-1234');
  assert.equal(new URL(login.verificationUrl).hostname, 'auth.openai.com');
  assert.deepEqual(await auth.pollLogin(login.loginId), { state: 'pending' });
  assert.deepEqual(await auth.pollLogin(login.loginId), { state: 'complete' });
  const exchange = calls.find(c => c.url === 'https://auth.openai.com/oauth/token');
  assert.match(exchange.options.body, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/);
  assert.equal(JSON.parse(store.map.get('chatgpt-subscription')).refreshToken, 'RT');
  assert.deepEqual(await auth.status('chatgpt-subscription'), { providerId: 'chatgpt-subscription', loggedIn: true, canRefresh: true });
  await assert.rejects(auth.pollLogin(login.loginId), /LOGIN_NOT_FOUND/);
});

test('claude PKCE login rejects state mismatch and refresh is single-flight with rotation', async () => {
  let refreshCalls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers['User-Agent'], 'axios/1.7.9');
    const body = JSON.parse(options.body);
    if (body.grant_type === 'authorization_code') return reply(200, { access_token: 'A1', refresh_token: 'R1', expires_in: 1 });
    if (body.grant_type === 'refresh_token') {
      refreshCalls++;
      assert.equal(body.refresh_token, 'R1');
      return reply(200, { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 });
    }
    throw new Error('unexpected');
  };
  const store = memoryStore();
  const auth = new SubscriptionAuth({ credentialStore: store, fetchImpl });
  const login = await auth.beginLogin('claude-subscription');
  assert.equal(login.mode, 'paste');
  const url = new URL(login.verificationUrl);
  assert.equal(url.hostname, 'claude.ai');
  assert.equal(url.searchParams.get('client_id'), '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  await assert.rejects(auth.completeLogin(login.loginId, 'code#wrong'), /AUTH_STATE_MISMATCH/);
  await auth.completeLogin(login.loginId, `code#${url.searchParams.get('state')}`);
  const [a, b] = await Promise.all([auth.accessToken('claude-subscription'), auth.accessToken('claude-subscription')]);
  assert.equal(a, 'A2'); assert.equal(b, 'A2');
  assert.equal(refreshCalls, 1);
  assert.equal(JSON.parse(store.map.get('claude-subscription')).refreshToken, 'R2');
});

test('grok device flow uses discovery token endpoint and treats authorization_pending', async () => {
  let polls = 0;
  const fetchImpl = async url => {
    if (url === 'https://auth.x.ai/oauth2/device/code') return reply(200, { device_code: 'dc', user_code: 'UC', verification_uri: 'https://accounts.x.ai/device', interval: 1 });
    if (url.endsWith('openid-configuration')) return reply(200, { token_endpoint: 'https://auth.x.ai/oauth2/token' });
    if (url === 'https://auth.x.ai/oauth2/token') return ++polls === 1 ? reply(400, { error: 'authorization_pending' }) : reply(200, { access_token: 'G', refresh_token: 'GR', expires_in: 21600 });
    throw new Error(`unexpected ${url}`);
  };
  const auth = new SubscriptionAuth({ credentialStore: memoryStore(), fetchImpl });
  const login = await auth.beginLogin('grok-subscription');
  assert.deepEqual(await auth.pollLogin(login.loginId), { state: 'pending' });
  assert.deepEqual(await auth.pollLogin(login.loginId), { state: 'complete' });
  assert.equal(await auth.accessToken('grok-subscription'), 'G');
});

test('auth refuses foreign hosts and unknown providers', async () => {
  const auth = new SubscriptionAuth({ credentialStore: memoryStore(), fetchImpl: async () => reply(200, {}) });
  await assert.rejects(auth.beginLogin('copilot-subscription'), /PROVIDER_NOT_ALLOWED/);
  await assert.rejects(auth.http('https://evil.example/token'), /UNSAFE_AUTH_ENDPOINT/);
  await assert.rejects(auth.accessToken('grok-subscription'), /SUBSCRIPTION_LOGIN_REQUIRED/);
});

test('codex account headers come from the JWT', () => {
  const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_data_residency: 'us' } });
  assert.deepEqual(codexAccountHeaders(token), { 'ChatGPT-Account-ID': 'acct', 'x-openai-internal-codex-residency': 'us' });
  assert.deepEqual(codexAccountHeaders('garbage'), {});
});

test('SSE parser assembles Codex output text', () => {
  const sse = ['data: {"type":"response.output_text.delta","delta":"Hel"}', 'data: {"type":"response.output_text.delta","delta":"lo"}', 'data: [DONE]'].join('\n');
  assert.equal(parseSse(sse), 'Hello');
});

test('broker sends Claude subscription with Claude Code identity and retries 401 with refresh', async () => {
  const seen = [];
  const subscriptionAuth = { accessToken: async (_id, { force }) => (force ? 'fresh' : 'stale') };
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    if (options.headers.Authorization === 'Bearer stale') return { ok: false, status: 401, headers: new Map(), body: null, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'Hi there' }] }));
    return { ok: true, status: 200, headers: new Map(), body: null, arrayBuffer: async () => bytes };
  };
  const broker = new ProviderBroker({ credentialStore: memoryStore(), subscriptionAuth, fetchImpl, claudeCodeVersion: () => '9.9.9' });
  const result = await broker.operation({ operation: 'chat', providerId: 'claude-subscription', model: 'claude-sonnet-4-6',
    messages: [{ role: 'system', content: 'Coach' }, { role: 'user', content: 'Hello' }] });
  assert.equal(result.text, 'Hi there');
  assert.equal(seen.length, 2);
  const last = seen[1];
  assert.equal(last.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(last.options.headers['User-Agent'], 'claude-code/9.9.9');
  assert.match(last.options.headers['anthropic-beta'], /oauth-2025-04-20/);
  const body = JSON.parse(last.options.body);
  assert.match(body.system[0].text, /^You are Claude Code/);
  assert.equal(body.system[1].text, 'Coach');
});

test('broker maps xAI spending-limit 402/403 to SUBSCRIPTION_NOT_ENTITLED', async () => {
  const subscriptionAuth = { accessToken: async () => 'tok' };
  const body = Buffer.from(JSON.stringify({ code: 'personal-team-blocked:spending-limit', error: 'run out of credits' }));
  for (const status of [402, 403]) {
    const fetchImpl = async () => ({ ok: false, status, headers: new Map(), body: null, arrayBuffer: async () => body });
    const broker = new ProviderBroker({ credentialStore: memoryStore(), subscriptionAuth, fetchImpl });
    await assert.rejects(broker.operation({ operation: 'chat', providerId: 'grok-subscription', model: 'grok-4.6',
      messages: [{ role: 'user', content: 'hi' }] }), /SUBSCRIPTION_NOT_ENTITLED/);
    await assert.rejects(broker.operation({ operation: 'models', providerId: 'grok-subscription' }), /SUBSCRIPTION_NOT_ENTITLED/);
  }
});
