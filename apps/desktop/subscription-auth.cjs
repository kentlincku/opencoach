'use strict';

// Subscription login (ChatGPT/Codex, Claude Pro/Max, Grok) using the official CLIs'
// public OAuth clients. Personal use only; see
// docs/SUBSCRIPTION_LOGIN_SPEC.md. Tokens live only in Main (CredentialStore).

const { createHash, randomBytes, randomUUID } = require('node:crypto');

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const LOGIN_TTL_MS = 15 * 60 * 1000;

const SUBSCRIPTIONS = Object.freeze({
  'chatgpt-subscription': Object.freeze({
    flow: 'codex-device',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    issuer: 'https://auth.openai.com',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    verificationUrl: 'https://auth.openai.com/codex/device',
    refreshSkewMs: 120_000,
  }),
  'grok-subscription': Object.freeze({
    flow: 'device',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    scope: 'openid profile email offline_access grok-cli:access api:access',
    deviceUrl: 'https://auth.x.ai/oauth2/device/code',
    discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
    refreshSkewMs: 3_600_000,
  }),
  'claude-subscription': Object.freeze({
    flow: 'pkce-paste',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scope: 'org:create_api_key user:profile user:inference',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    tokenUrls: ['https://platform.claude.com/v1/oauth/token', 'https://console.anthropic.com/v1/oauth/token'],
    tokenUserAgent: 'axios/1.7.9',
    refreshSkewMs: 300_000,
  }),
});

const ALLOWED_TOKEN_HOSTS = new Set(['auth.openai.com', 'auth.x.ai', 'platform.claude.com', 'console.anthropic.com']);

function subscriptionFor(providerId) {
  if (typeof providerId !== 'string' || !Object.hasOwn(SUBSCRIPTIONS, providerId)) throw new Error('PROVIDER_NOT_ALLOWED');
  return SUBSCRIPTIONS[providerId];
}

function b64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return {}; }
}

function codexAccountHeaders(accessToken) {
  const auth = jwtClaims(accessToken)['https://api.openai.com/auth'] || {};
  const headers = {};
  if (typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id) headers['ChatGPT-Account-ID'] = auth.chatgpt_account_id;
  const residency = auth.chatgpt_data_residency || auth.chatgpt_compute_residency;
  if (typeof residency === 'string' && residency.trim()) headers['x-openai-internal-codex-residency'] = residency.trim();
  return headers;
}

class SubscriptionAuth {
  constructor({ credentialStore, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 15_000 }) {
    if (!credentialStore || typeof fetchImpl !== 'function') throw new Error('INVALID_SUBSCRIPTION_AUTH_CONFIG');
    this.credentials = credentialStore;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.logins = new Map();
    this.refreshing = new Map();
  }

  async http(url, { method = 'POST', headers = {}, body } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ALLOWED_TOKEN_HOSTS.has(parsed.hostname)) throw new Error('UNSAFE_AUTH_ENDPOINT');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
      const text = await response.text();
      if (text.length > 256 * 1024) throw new Error('AUTH_RESPONSE_TOO_LARGE');
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      return { status: response.status, data };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('AUTH_REQUEST_TIMEOUT');
      throw error;
    } finally { clearTimeout(timer); }
  }

  // ---- login ----

  async beginLogin(providerId) {
    const sub = subscriptionFor(providerId);
    for (const [id, login] of this.logins) if (login.providerId === providerId) this.logins.delete(id);
    const loginId = randomUUID();
    const base = { loginId, providerId, expiresAt: this.now() + LOGIN_TTL_MS };
    if (sub.flow === 'codex-device') {
      const { status, data } = await this.http(`${sub.issuer}/api/accounts/deviceauth/usercode`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: sub.clientId }),
      });
      if (status === 429) throw new Error('AUTH_RATE_LIMITED');
      if (status !== 200 || !data.user_code || !data.device_auth_id) throw new Error('AUTH_DEVICE_CODE_FAILED');
      this.logins.set(loginId, { ...base, deviceAuthId: data.device_auth_id, userCode: data.user_code,
        interval: Math.max(3, Number(data.interval) || 5) });
      return { loginId, mode: 'device', userCode: data.user_code, verificationUrl: sub.verificationUrl,
        interval: Math.max(3, Number(data.interval) || 5) };
    }
    if (sub.flow === 'device') {
      const { status, data } = await this.http(sub.deviceUrl, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: sub.clientId, scope: sub.scope }).toString(),
      });
      if (status !== 200 || !data.device_code || !data.user_code || !data.verification_uri) throw new Error('AUTH_DEVICE_CODE_FAILED');
      const verificationUrl = data.verification_uri_complete || data.verification_uri;
      if (new URL(verificationUrl).hostname !== 'accounts.x.ai' && new URL(verificationUrl).hostname !== 'auth.x.ai') {
        throw new Error('UNSAFE_AUTH_ENDPOINT');
      }
      this.logins.set(loginId, { ...base, deviceCode: data.device_code, interval: Math.max(1, Number(data.interval) || 5) });
      return { loginId, mode: 'device', userCode: data.user_code, verificationUrl, interval: Math.max(1, Number(data.interval) || 5) };
    }
    // Claude: PKCE, user pastes "code#state" back.
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(32));
    const params = new URLSearchParams({ code: 'true', client_id: sub.clientId, response_type: 'code',
      redirect_uri: sub.redirectUri, scope: sub.scope, code_challenge: challenge, code_challenge_method: 'S256', state });
    this.logins.set(loginId, { ...base, verifier, state });
    return { loginId, mode: 'paste', verificationUrl: `${sub.authorizeUrl}?${params}` };
  }

  takeLogin(loginId) {
    const login = this.logins.get(loginId);
    if (!login) throw new Error('LOGIN_NOT_FOUND');
    if (this.now() > login.expiresAt) { this.logins.delete(loginId); throw new Error('LOGIN_EXPIRED'); }
    return login;
  }

  async pollLogin(loginId) {
    const login = this.takeLogin(loginId);
    const sub = subscriptionFor(login.providerId);
    let tokens;
    if (sub.flow === 'codex-device') {
      const poll = await this.http(`${sub.issuer}/api/accounts/deviceauth/token`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }),
      });
      if (poll.status === 403 || poll.status === 404) return { state: 'pending' };
      if (poll.status !== 200 || !poll.data.authorization_code || !poll.data.code_verifier) throw new Error('AUTH_POLL_FAILED');
      const exchange = await this.http(sub.tokenUrl, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: poll.data.authorization_code,
          redirect_uri: `${sub.issuer}/deviceauth/callback`, client_id: sub.clientId, code_verifier: poll.data.code_verifier }).toString(),
      });
      if (exchange.status !== 200 || !exchange.data.access_token) throw new Error('AUTH_TOKEN_EXCHANGE_FAILED');
      tokens = exchange.data;
    } else if (sub.flow === 'device') {
      const tokenUrl = await this.xaiTokenEndpoint(sub);
      const poll = await this.http(tokenUrl, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: DEVICE_GRANT, client_id: sub.clientId, device_code: login.deviceCode }).toString(),
      });
      const error = poll.data?.error;
      if (error === 'authorization_pending' || error === 'slow_down') return { state: 'pending' };
      if (poll.status !== 200 || !poll.data.access_token) throw new Error(error === 'access_denied' ? 'AUTH_DENIED' : 'AUTH_POLL_FAILED');
      tokens = poll.data;
    } else {
      throw new Error('LOGIN_REQUIRES_CODE');
    }
    this.logins.delete(loginId);
    await this.save(login.providerId, tokens);
    return { state: 'complete' };
  }

  async completeLogin(loginId, pasted) {
    const login = this.takeLogin(loginId);
    const sub = subscriptionFor(login.providerId);
    if (sub.flow !== 'pkce-paste') throw new Error('LOGIN_DOES_NOT_ACCEPT_CODE');
    if (typeof pasted !== 'string' || !pasted.trim() || pasted.length > 2048) throw new Error('INVALID_AUTH_CODE');
    const [code, receivedState = ''] = pasted.trim().split('#');
    if (receivedState !== login.state) throw new Error('AUTH_STATE_MISMATCH');
    const tokens = await this.claudeToken({ grant_type: 'authorization_code', client_id: sub.clientId, code,
      state: receivedState, redirect_uri: sub.redirectUri, code_verifier: login.verifier });
    this.logins.delete(loginId);
    await this.save(login.providerId, tokens);
    return { state: 'complete' };
  }

  cancelLogin(loginId) {
    this.logins.delete(loginId);
    return { cancelled: true };
  }

  async xaiTokenEndpoint(sub) {
    if (this.xaiTokenUrl) return this.xaiTokenUrl;
    const { status, data } = await this.http(sub.discoveryUrl, { method: 'GET', headers: { Accept: 'application/json' } });
    if (status !== 200 || typeof data.token_endpoint !== 'string') throw new Error('AUTH_DISCOVERY_FAILED');
    if (new URL(data.token_endpoint).hostname !== 'auth.x.ai') throw new Error('UNSAFE_AUTH_ENDPOINT');
    this.xaiTokenUrl = data.token_endpoint;
    return this.xaiTokenUrl;
  }

  async claudeToken(payload) {
    const sub = SUBSCRIPTIONS['claude-subscription'];
    let last = 'AUTH_TOKEN_EXCHANGE_FAILED';
    for (const url of sub.tokenUrls) {
      const { status, data } = await this.http(url, {
        headers: { 'Content-Type': 'application/json', 'User-Agent': sub.tokenUserAgent }, body: JSON.stringify(payload),
      });
      if (status === 200 && data.access_token) return data;
      if (status === 429) last = 'AUTH_RATE_LIMITED';
    }
    throw new Error(last);
  }

  // ---- storage / refresh ----

  async save(providerId, tokens, previous = {}) {
    const record = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || previous.refreshToken || null,
      expiresAt: Number.isFinite(Number(tokens.expires_in)) ? this.now() + Number(tokens.expires_in) * 1000
        : (jwtClaims(tokens.access_token).exp ? jwtClaims(tokens.access_token).exp * 1000 : this.now() + 3_600_000),
    };
    await this.credentials.set(providerId, JSON.stringify(record));
    return record;
  }

  async load(providerId) {
    subscriptionFor(providerId);
    let raw;
    try { raw = await this.credentials.get(providerId); } catch (error) {
      if (error?.message === 'CREDENTIAL_REQUIRED') throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
      throw error;
    }
    try { return JSON.parse(raw); } catch { throw new Error('CREDENTIAL_STORE_CORRUPT'); }
  }

  async status(providerId) {
    subscriptionFor(providerId);
    const has = await this.credentials.has(providerId);
    if (!has?.hasCredential) return { providerId, loggedIn: false, unavailable: Boolean(has?.unavailable) };
    const record = await this.load(providerId).catch(() => null);
    return { providerId, loggedIn: Boolean(record?.accessToken), canRefresh: Boolean(record?.refreshToken) };
  }

  async logout(providerId) {
    subscriptionFor(providerId);
    return this.credentials.clear(providerId);
  }

  async accessToken(providerId, { force = false } = {}) {
    const sub = subscriptionFor(providerId);
    const record = await this.load(providerId);
    if (!force && record.expiresAt - sub.refreshSkewMs > this.now()) return record.accessToken;
    if (!record.refreshToken) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
    // Single-flight: Claude refresh tokens rotate and are single-use.
    if (!this.refreshing.has(providerId)) {
      this.refreshing.set(providerId, this.refresh(providerId, sub, record).finally(() => this.refreshing.delete(providerId)));
    }
    return (await this.refreshing.get(providerId)).accessToken;
  }

  async refresh(providerId, sub, record) {
    let tokens;
    if (sub.flow === 'pkce-paste') {
      tokens = await this.claudeToken({ grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: sub.clientId });
    } else {
      const url = sub.flow === 'device' ? await this.xaiTokenEndpoint(sub) : sub.tokenUrl;
      const { status, data } = await this.http(url, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: record.refreshToken, client_id: sub.clientId }).toString(),
      });
      if (status !== 200 || !data.access_token) {
        if (status === 400 || status === 401) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
        throw new Error('AUTH_REFRESH_FAILED');
      }
      tokens = data;
    }
    return this.save(providerId, tokens, record);
  }
}

module.exports = { SubscriptionAuth, SUBSCRIPTIONS, codexAccountHeaders, jwtClaims };
