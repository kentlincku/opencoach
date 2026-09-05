'use strict';

const { randomUUID } = require('node:crypto');

const CHATGPT_DEVICE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const CHATGPT_POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHATGPT_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const CHATGPT_VERIFY_URL = 'https://auth.openai.com/codex/device';
const GROK_DEVICE_URL = 'https://auth.x.ai/oauth2/device/code';
const GROK_TOKEN_URL = 'https://auth.x.ai/oauth2/token';

const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const REFRESH_SKEW_MS = 120 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const PROVIDERS = Object.freeze({
  'chatgpt-subscription': Object.freeze({ clientKey: 'chatgpt' }),
  'grok-subscription': Object.freeze({ clientKey: 'grok' }),
});

function exactProviderPayload(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !allowed.includes(key))
      || typeof payload.providerId !== 'string' || !Object.hasOwn(PROVIDERS, payload.providerId)) {
    throw new Error('INVALID_SUBSCRIPTION_REQUEST');
  }
  return payload;
}

async function boundedText(response, maxBytes, tooLargeCode) {
  const announced = Number(response.headers?.get?.('content-length') || 0);
  if (announced > maxBytes) throw new Error(tooLargeCode);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = typeof response.arrayBuffer === 'function'
      ? Buffer.from(await response.arrayBuffer())
      : Buffer.from(await response.text());
    if (bytes.length > maxBytes) throw new Error(tooLargeCode);
    return bytes.toString('utf8');
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(tooLargeCode);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function formBody(values) {
  return new URLSearchParams(values).toString();
}

function trustedVerificationUrl(value, hostname) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== hostname || url.username || url.password) throw new Error('invalid');
    return url.href;
  } catch {
    throw new Error('INVALID_AUTH_RESPONSE');
  }
}

function accountIdFromAccessToken(accessToken) {
  try {
    const parts = String(accessToken || '').split('.');
    if (parts.length < 2) return '';
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof accountId === 'string' ? accountId : '';
  } catch { return ''; }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 100) throw new Error('INVALID_MESSAGES');
  return messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).some(key => !['role', 'content'].includes(key))
        || !['system', 'user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string' || !message.content || message.content.length > 32_000) {
      throw new Error('INVALID_MESSAGES');
    }
    return { role: message.role, content: message.content };
  });
}

class SubscriptionAuthBroker {
  constructor({ credentialStore, clientIds = {}, grokScope = '', fetchImpl = globalThis.fetch, randomId = randomUUID, now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!credentialStore || typeof fetchImpl !== 'function' || typeof randomId !== 'function' || typeof now !== 'function') {
      throw new Error('INVALID_SUBSCRIPTION_BROKER_CONFIG');
    }
    this.credentials = credentialStore;
    this.clientIds = Object.freeze({
      chatgpt: String(clientIds.chatgpt || '').trim(),
      grok: String(clientIds.grok || '').trim(),
    });
    this.fetch = fetchImpl;
    this.grokScope = String(grokScope || '').trim();
    this.randomId = randomId;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.transactions = new Map();
    this.refreshes = new Map();
    this.controllers = new Map();
    this.generations = new Map();
    this.tokenMutations = new Map();
  }

  capabilities() {
    if (this.credentials.available() !== true) return { providers: [] };
    return {
      providers: Object.entries(PROVIDERS)
        .filter(([providerId, config]) => Boolean(this.clientIds[config.clientKey])
          && (providerId !== 'grok-subscription' || Boolean(this.grokScope)))
        .map(([providerId]) => providerId),
    };
  }

  providerConfig(providerId) {
    const config = PROVIDERS[providerId];
    if (!config) throw new Error('INVALID_SUBSCRIPTION_REQUEST');
    const clientId = this.clientIds[config.clientKey];
    if (!clientId || this.credentials.available() !== true
        || (providerId === 'grok-subscription' && !this.grokScope)) throw new Error('SUBSCRIPTION_PROVIDER_UNAVAILABLE');
    return { ...config, clientId };
  }

  generation(providerId) {
    return this.generations.get(providerId) || 0;
  }

  queueTokenMutation(providerId, mutation) {
    const previous = this.tokenMutations.get(providerId) || Promise.resolve();
    const current = previous.catch(() => {}).then(mutation);
    this.tokenMutations.set(providerId, current);
    return current.finally(() => {
      if (this.tokenMutations.get(providerId) === current) this.tokenMutations.delete(providerId);
    });
  }

  async requestJson(url, options, {
    maxBytes = MAX_AUTH_RESPONSE_BYTES,
    tooLargeCode = 'AUTH_RESPONSE_TOO_LARGE',
    invalidCode = 'INVALID_AUTH_RESPONSE',
    httpPrefix = 'AUTH_HTTP',
    allowStatuses = [],
    controller = new AbortController(),
    providerId = '',
  } = {}) {
    let timedOut = false;
    this.controllers.set(controller, providerId);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
      if (controller.signal.aborted) throw new Error('SUBSCRIPTION_REQUEST_CANCELLED');
      const text = await boundedText(response, maxBytes, tooLargeCode);
      if (controller.signal.aborted) throw new Error('SUBSCRIPTION_REQUEST_CANCELLED');
      if (!response.ok && !allowStatuses.includes(response.status)) throw new Error(`${httpPrefix}_${response.status}`);
      let data;
      if (!text && allowStatuses.includes(response.status)) data = {};
      else try { data = JSON.parse(text); } catch { throw new Error(invalidCode); }
      return { status: response.status, data };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(timedOut ? 'SUBSCRIPTION_REQUEST_TIMEOUT' : 'SUBSCRIPTION_REQUEST_CANCELLED');
      throw error;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  async beginLogin(payload) {
    const { providerId } = exactProviderPayload(payload, ['providerId']);
    const config = this.providerConfig(providerId);
    const isChatGpt = providerId === 'chatgpt-subscription';
    const { data } = await this.requestJson(isChatGpt ? CHATGPT_DEVICE_URL : GROK_DEVICE_URL, isChatGpt ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: config.clientId }), redirect: 'error',
    } : {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({ client_id: config.clientId, scope: this.grokScope }), redirect: 'error',
    }, { providerId });
    const userCode = String(data.user_code || '');
    const deviceSecret = String(isChatGpt ? data.device_auth_id : data.device_code || '');
    const intervalSeconds = Math.max(3, Math.min(30, Number(data.interval) || 5));
    if (!userCode || !deviceSecret) throw new Error('INVALID_AUTH_RESPONSE');
    for (const [existingId, existing] of this.transactions) {
      if (existing.providerId === providerId) {
        existing.pollController?.abort();
        this.transactions.delete(existingId);
      }
    }
    const loginId = this.randomId();
    this.transactions.set(loginId, {
      providerId, deviceSecret, userCode, clientId: config.clientId, intervalSeconds,
      generation: this.generation(providerId),
      nextPollAt: this.now() + intervalSeconds * 1000,
      expiresAt: this.now() + Math.max(60, Math.min(3600, Number(data.expires_in) || 900)) * 1000,
    });
    return {
      state: 'authorizing', loginId,
      verificationUri: isChatGpt
        ? CHATGPT_VERIFY_URL
        : trustedVerificationUrl(data.verification_uri_complete || data.verification_uri, 'auth.x.ai'),
      userCode, intervalSeconds,
    };
  }

  async pollLogin(payload) {
    const { providerId, loginId } = exactProviderPayload(payload, ['providerId', 'loginId']);
    if (typeof loginId !== 'string' || !loginId) throw new Error('INVALID_SUBSCRIPTION_REQUEST');
    const transaction = this.transactions.get(loginId);
    if (!transaction || transaction.providerId !== providerId || transaction.generation !== this.generation(providerId)
        || transaction.expiresAt <= this.now()) {
      transaction?.pollController?.abort();
      this.transactions.delete(loginId);
      throw new Error('AUTH_TRANSACTION_EXPIRED');
    }
    if (transaction.pollController) throw new Error('AUTH_POLL_IN_PROGRESS');
    if (transaction.nextPollAt > this.now()) {
      return { state: 'authorizing', retryAfterSeconds: Math.ceil((transaction.nextPollAt - this.now()) / 1000) };
    }
    const controller = new AbortController();
    transaction.pollController = controller;
    try {
    const config = this.providerConfig(providerId);
    if (providerId === 'chatgpt-subscription') {
      const poll = await this.requestJson(CHATGPT_POLL_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ device_auth_id: transaction.deviceSecret, user_code: transaction.userCode }),
        redirect: 'error',
      }, { allowStatuses: [403, 404], controller, providerId });
      if (poll.status === 403 || poll.status === 404) {
        transaction.nextPollAt = this.now() + transaction.intervalSeconds * 1000;
        return { state: 'authorizing', retryAfterSeconds: transaction.intervalSeconds };
      }
      const code = poll.data;
      if (!code.authorization_code || !code.code_verifier) throw new Error('INVALID_AUTH_RESPONSE');
      const { data: tokens } = await this.requestJson(CHATGPT_TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: formBody({
          grant_type: 'authorization_code', code: code.authorization_code,
          redirect_uri: CHATGPT_REDIRECT_URI, client_id: config.clientId, code_verifier: code.code_verifier,
        }), redirect: 'error',
      }, { controller, providerId });
      await this.saveTokens(providerId, config.clientId, tokens, transaction.generation);
      this.transactions.delete(loginId);
      return { state: 'authorized' };
    }
    const tokenResult = await this.requestJson(GROK_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: config.clientId, device_code: transaction.deviceSecret,
      }), redirect: 'error',
    }, { allowStatuses: [400], controller, providerId });
    if (tokenResult.status === 400) {
      const pending = tokenResult.data;
      if (pending.error === 'authorization_pending' || pending.error === 'slow_down') {
        if (pending.error === 'slow_down') transaction.intervalSeconds = Math.min(30, transaction.intervalSeconds + 5);
        transaction.nextPollAt = this.now() + transaction.intervalSeconds * 1000;
        return { state: 'authorizing', retryAfterSeconds: transaction.intervalSeconds };
      }
      throw new Error('AUTH_DEVICE_POLL_FAILED');
    }
    const tokens = tokenResult.data;
    await this.saveTokens(providerId, config.clientId, tokens, transaction.generation);
    this.transactions.delete(loginId);
    return { state: 'authorized' };
    } finally {
      if (transaction.pollController === controller) delete transaction.pollController;
    }
  }

  async cancelLogin(payload) {
    const { providerId, loginId } = exactProviderPayload(payload, ['providerId', 'loginId']);
    if (typeof loginId !== 'string' || !loginId) throw new Error('INVALID_SUBSCRIPTION_REQUEST');
    const transaction = this.transactions.get(loginId);
    if (!transaction || transaction.providerId !== providerId) throw new Error('AUTH_TRANSACTION_EXPIRED');
    transaction.pollController?.abort();
    this.transactions.delete(loginId);
    return { state: 'cancelled' };
  }

  async status(payload) {
    const { providerId } = exactProviderPayload(payload, ['providerId']);
    this.providerConfig(providerId);
    const present = await this.credentials.has(providerId);
    if (!present?.hasCredential) return { state: 'signed-out' };
    try {
      const tokens = await this.loadTokens(providerId);
      return { state: tokens.expiresAt > this.now() ? 'authorized' : 'expired' };
    } catch {
      return { state: 'error' };
    }
  }

  async logout(payload) {
    const { providerId } = exactProviderPayload(payload, ['providerId']);
    this.providerConfig(providerId);
    this.generations.set(providerId, this.generation(providerId) + 1);
    for (const [controller, owner] of this.controllers) {
      if (owner === providerId) controller.abort();
    }
    this.refreshes.delete(providerId);
    for (const [loginId, transaction] of this.transactions) {
      if (transaction.providerId === providerId) {
        transaction.pollController?.abort();
        this.transactions.delete(loginId);
      }
    }
    await this.queueTokenMutation(providerId, () => this.credentials.clear(providerId));
    return { state: 'signed-out' };
  }

  dispose() {
    for (const controller of this.controllers.keys()) controller.abort();
    this.controllers.clear();
    for (const transaction of this.transactions.values()) transaction.pollController?.abort();
    this.transactions.clear();
  }

  async loadTokens(providerId) {
    const config = this.providerConfig(providerId);
    const readGeneration = this.generation(providerId);
    let tokens;
    try { tokens = JSON.parse(await this.credentials.get(providerId)); }
    catch { throw new Error('SUBSCRIPTION_LOGIN_REQUIRED'); }
    if (tokens?.version !== 1 || typeof tokens.accessToken !== 'string' || !tokens.accessToken
        || typeof tokens.refreshToken !== 'string' || !tokens.refreshToken
        || tokens.clientId !== config.clientId || !Number.isFinite(tokens.expiresAt)) {
      await this.queueTokenMutation(providerId, async () => {
        if (readGeneration === this.generation(providerId)) await this.credentials.clear(providerId);
      }).catch(() => {});
      throw new Error('SUBSCRIPTION_CREDENTIAL_INVALID');
    }
    return tokens;
  }

  async currentTokens(providerId) {
    const generation = this.generation(providerId);
    const tokens = await this.loadTokens(providerId);
    if (generation !== this.generation(providerId)) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
    if (tokens.expiresAt > this.now() + REFRESH_SKEW_MS) return tokens;
    if (this.refreshes.has(providerId)) return this.refreshes.get(providerId);
    const refresh = this.refreshTokens(providerId, tokens, generation).finally(() => {
      if (this.refreshes.get(providerId) === refresh) this.refreshes.delete(providerId);
    });
    this.refreshes.set(providerId, refresh);
    return refresh;
  }

  async refreshTokens(providerId, tokens, generation) {
    const config = this.providerConfig(providerId);
    const tokenUrl = providerId === 'chatgpt-subscription' ? CHATGPT_TOKEN_URL : GROK_TOKEN_URL;
    const { data: refreshed } = await this.requestJson(tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: config.clientId }),
      redirect: 'error',
    }, { providerId });
    await this.saveTokens(providerId, config.clientId, {
      ...refreshed, refresh_token: refreshed.refresh_token || tokens.refreshToken,
    }, generation);
    if (generation !== this.generation(providerId)) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
    return this.loadTokens(providerId);
  }

  async operation(payload) {
    const allowed = ['operation', 'providerId', 'model', 'messages', 'maxTokens'];
    const { providerId } = exactProviderPayload(payload, allowed);
    if (payload.operation === 'models' && Object.keys(payload).every(key => ['operation', 'providerId'].includes(key))) {
      return this.models(providerId);
    }
    if (payload.operation !== 'chat') throw new Error('INVALID_SUBSCRIPTION_REQUEST');
    if (typeof payload.model !== 'string' || !payload.model || payload.model.length > 256 || /[\x00-\x1f]/.test(payload.model)) throw new Error('INVALID_MODEL');
    const messages = validateMessages(payload.messages);
    const maxTokens = payload.maxTokens === undefined ? 300 : payload.maxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error('INVALID_MAX_TOKENS');
    return this.chat(providerId, payload.model, messages, maxTokens);
  }

  async providerRequest(providerId, suffix, options = {}) {
    const generation = this.generation(providerId);
    const tokens = await this.currentTokens(providerId);
    if (generation !== this.generation(providerId)) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
    const isChatGpt = providerId === 'chatgpt-subscription';
    const baseUrl = isChatGpt ? 'https://chatgpt.com/backend-api/codex' : 'https://api.x.ai/v1';
    const headers = { Accept: 'application/json', Authorization: `Bearer ${tokens.accessToken}`, ...options.headers };
    if (isChatGpt) {
      headers['User-Agent'] = 'VoicePractice-Desktop/0.2';
      const accountId = accountIdFromAccessToken(tokens.accessToken);
      if (accountId) headers['ChatGPT-Account-ID'] = accountId;
    }
    const { data } = await this.requestJson(`${baseUrl}${suffix}`, { ...options, headers }, {
      maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
      tooLargeCode: 'PROVIDER_RESPONSE_TOO_LARGE',
      invalidCode: 'INVALID_PROVIDER_RESPONSE',
      httpPrefix: 'PROVIDER_HTTP',
      providerId,
    });
    if (generation !== this.generation(providerId)) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
    return data;
  }

  async models(providerId) {
    const data = await this.providerRequest(providerId, '/models', { method: 'GET' });
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map(item => item?.id || item?.name).filter(id => typeof id === 'string' && id.length <= 256).slice(0, 1000);
    if (!models.length) throw new Error('EMPTY_MODEL_LIST');
    return { models };
  }

  async chat(providerId, model, messages, maxTokens) {
    const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    const input = messages.filter(message => message.role !== 'system').map(message => ({
      role: message.role,
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }],
    }));
    const body = JSON.stringify({
      model, instructions, input, store: false, stream: false, max_output_tokens: maxTokens,
    });
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('PROVIDER_REQUEST_TOO_LARGE');
    const data = await this.providerRequest(providerId, '/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const text = data?.output?.flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
      .map(item => item.text).join('\n').trim();
    if (!text) throw new Error('INVALID_PROVIDER_RESPONSE');
    return { text };
  }

  async saveTokens(providerId, clientId, tokens, expectedGeneration = this.generation(providerId)) {
    const accessToken = String(tokens.access_token || '');
    const refreshToken = String(tokens.refresh_token || '');
    if (!accessToken || !refreshToken) throw new Error('INVALID_AUTH_RESPONSE');
    await this.queueTokenMutation(providerId, async () => {
      if (expectedGeneration !== this.generation(providerId)) throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
      await this.credentials.set(providerId, JSON.stringify({
        version: 1, accessToken, refreshToken, clientId,
        expiresAt: this.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000,
      }));
      if (expectedGeneration !== this.generation(providerId)) {
        await this.credentials.clear(providerId);
        throw new Error('SUBSCRIPTION_LOGIN_REQUIRED');
      }
    });
  }
}

module.exports = { SubscriptionAuthBroker };
