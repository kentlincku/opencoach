'use strict';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 32_000;

const PROVIDERS = Object.freeze({
  claude: { base: 'https://api.anthropic.com/v1', host: 'api.anthropic.com', protocol: 'anthropic', secret: true },
  openai: { base: 'https://api.openai.com/v1', host: 'api.openai.com', protocol: 'openai', secret: true },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', host: 'generativelanguage.googleapis.com', protocol: 'openai', secret: true },
  groq: { base: 'https://api.groq.com/openai/v1', host: 'api.groq.com', protocol: 'openai', secret: true },
  deepseek: { base: 'https://api.deepseek.com/v1', host: 'api.deepseek.com', protocol: 'openai', secret: true },
  omlx: { base: 'http://127.0.0.1:8000/v1', host: '127.0.0.1', protocol: 'openai', secret: false },
  ollama: { base: 'http://127.0.0.1:11434/v1', host: '127.0.0.1', protocol: 'openai', secret: false },
  lmstudio: { base: 'http://127.0.0.1:1234/v1', host: '127.0.0.1', protocol: 'openai', secret: false },
  // Subscription profiles: OAuth tokens from SubscriptionAuth (see docs/SUBSCRIPTION_LOGIN_SPEC.md).
  'chatgpt-subscription': { base: 'https://chatgpt.com/backend-api/codex', host: 'chatgpt.com', protocol: 'codex-responses', secret: 'subscription' },
  'grok-subscription': { base: 'https://api.x.ai/v1', host: 'api.x.ai', protocol: 'openai', secret: 'subscription' },
  'claude-subscription': { base: 'https://api.anthropic.com/v1', host: 'api.anthropic.com', protocol: 'anthropic', secret: 'subscription' },
});

const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20';
const CODEX_FALLBACK_MODELS = Object.freeze(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']);
const CLAUDE_FALLBACK_MODELS = Object.freeze(['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6']);

function parseSse(text) {
  // Collect output_text from a Codex Responses SSE stream.
  let out = '';
  let completed = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') out += event.delta;
    if (event.type === 'response.completed') {
      const items = event.response?.output || [];
      completed = items.flatMap(item => item?.content || []).filter(c => c?.type === 'output_text').map(c => c.text).join('');
    }
    if (event.type === 'response.failed' || event.type === 'error') throw new Error('PROVIDER_STREAM_FAILED');
  }
  return out || completed;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

// 'custom' = any user-configured OpenAI-compatible endpoint (local or remote).
// The user's own setting is authoritative; only the URL shape is checked.
function customEndpoint(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl || baseUrl.length > 2048) throw new Error('INVALID_PROVIDER_ENDPOINT');
  let url;
  try { url = new URL(baseUrl.trim().replace(/\/+$/, '')); } catch { throw new Error('INVALID_PROVIDER_ENDPOINT'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('INVALID_PROVIDER_ENDPOINT');
  url.hash = ''; url.search = '';
  return Object.freeze({ id: 'custom', base: url.href.replace(/\/+$/, ''), host: url.hostname, scheme: url.protocol, protocol: 'openai', secret: 'optional' });
}

function providerFor(providerId, baseUrl) {
  if (providerId === 'custom') return customEndpoint(baseUrl);
  if (typeof providerId !== 'string' || !Object.hasOwn(PROVIDERS, providerId)) throw new Error('PROVIDER_NOT_ALLOWED');
  if (baseUrl !== undefined) throw new Error('INVALID_PROVIDER_OPERATION');
  return PROVIDERS[providerId];
}

function validateEndpoint(config, suffix) {
  const url = new URL(`${config.base}${suffix}`);
  const expectedScheme = config.scheme || (config.secret ? 'https:' : 'http:');
  if (url.protocol !== expectedScheme || url.hostname !== config.host || url.username || url.password) {
    throw new Error('UNSAFE_PROVIDER_ENDPOINT');
  }
  return url.toString();
}

function validateModel(model) {
  if (typeof model !== 'string' || !model || model.length > 256 || /[\x00-\x1f]/.test(model)) throw new Error('INVALID_MODEL');
  return model;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) throw new Error('INVALID_MESSAGES');
  return messages.map(message => {
    if (!exactKeys(message, ['role', 'content']) || !['system', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string' || !message.content || message.content.length > MAX_MESSAGE_CHARS) {
      throw new Error('INVALID_MESSAGES');
    }
    return { role: message.role, content: message.content };
  });
}

async function boundedResponse(response) {
  const announced = Number(response.headers.get('content-length') || 0);
  if (announced > MAX_RESPONSE_BYTES) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader?.();
  let bytes;
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
    bytes = Buffer.concat(chunks, total);
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  }
  const text = bytes.toString('utf8');
  if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error('INVALID_PROVIDER_RESPONSE'); }
}

class ProviderBroker {
  constructor({ credentialStore, subscriptionAuth = null, claudeCodeVersion = () => '2.1.290',
    fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!credentialStore || typeof fetchImpl !== 'function') throw new Error('INVALID_PROVIDER_BROKER_CONFIG');
    this.credentials = credentialStore;
    this.subscriptions = subscriptionAuth;
    this.claudeCodeVersion = claudeCodeVersion;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async operation(payload) {
    if (!exactKeys(payload, ['operation', 'providerId', 'baseUrl', 'model', 'messages', 'maxTokens'])) {
      throw new Error('INVALID_PROVIDER_OPERATION');
    }
    if (payload.operation === 'models') return this.models(payload);
    if (payload.operation === 'chat') return this.chat(payload);
    throw new Error('INVALID_PROVIDER_OPERATION');
  }

  async headers(provider, contentType = 'application/json') {
    const headers = contentType ? { 'Content-Type': contentType } : {};
    if (!provider.secret) return headers;
    if (provider.secret === 'subscription') return this.subscriptionHeaders(provider, headers);
    if (provider.secret === 'optional') {
      // A key for a custom endpoint is optional (local servers usually need none).
      if (!(await this.credentials.has('custom'))?.hasCredential) return headers;
      headers.Authorization = `Bearer ${await this.credentials.get('custom')}`;
      return headers;
    }
    const key = await this.credentials.get(Object.keys(PROVIDERS).find(id => PROVIDERS[id] === provider));
    if (provider.protocol === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${key}`;
    }
    return headers;
  }

  providerId(provider) {
    return Object.keys(PROVIDERS).find(id => PROVIDERS[id] === provider);
  }

  async subscriptionHeaders(provider, headers, force = false) {
    if (!this.subscriptions) throw new Error('PROVIDER_NOT_ALLOWED');
    const { codexAccountHeaders } = require('./subscription-auth.cjs');
    const token = await this.subscriptions.accessToken(this.providerId(provider), { force });
    headers.Authorization = `Bearer ${token}`;
    if (provider.protocol === 'codex-responses') {
      Object.assign(headers, codexAccountHeaders(token), { 'User-Agent': 'codex_cli_rs/0.0.0 (Voice Practice)', originator: 'codex_cli_rs' });
    } else if (provider.protocol === 'anthropic') {
      Object.assign(headers, { 'anthropic-version': '2023-06-01', 'anthropic-beta': CLAUDE_OAUTH_BETAS,
        'User-Agent': `claude-code/${this.claudeCodeVersion()}`, 'x-app': 'cli' });
    }
    return headers;
  }

  // Subscription calls retry once with a forced refresh on 401.
  async authedRequest(provider, url, options, raw = false) {
    const { extraHeaders = {}, ...rest } = options;
    const send = async force => {
      const headers = { ...(force ? await this.subscriptionHeaders(provider, { 'Content-Type': 'application/json' }, true)
        : await this.headers(provider)), ...extraHeaders };
      return raw ? this.requestText(url, { ...rest, headers }) : this.request(url, { ...rest, headers });
    };
    try { return await send(false); } catch (error) {
      // xAI: 402, or 403 personal-team-blocked:spending-limit = no SuperGrok/credits on this account.
      if (provider.secret === 'subscription' && (error?.message === 'PROVIDER_HTTP_402'
        || (error?.message === 'PROVIDER_HTTP_403' && provider.host === 'api.x.ai'))) throw new Error('SUBSCRIPTION_NOT_ENTITLED');
      if (provider.secret === 'subscription' && error?.message === 'PROVIDER_HTTP_401') return send(true);
      throw error;
    }
  }

  async requestText(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 4);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES * 4) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      if (response.status === 402 || (response.status === 403 && text.includes('spending-limit'))) throw new Error('SUBSCRIPTION_NOT_ENTITLED');
      if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
      return text;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('PROVIDER_REQUEST_TIMEOUT');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await boundedResponse(await this.fetch(url, { ...options, signal: controller.signal, redirect: 'error' }));
    } catch (error) {
      if (controller.signal.aborted) throw new Error('PROVIDER_REQUEST_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async models(payload) {
    if (!exactKeys(payload, ['operation', 'providerId', 'baseUrl']) || payload.operation !== 'models') throw new Error('INVALID_PROVIDER_OPERATION');
    const provider = providerFor(payload.providerId, payload.baseUrl);
    if (provider.protocol === 'codex-responses') {
      try {
        const data = await this.authedRequest(provider, validateEndpoint(provider, '/models?client_version=1.0.0'), { method: 'GET' });
        const ids = (data?.models || []).map(m => m?.slug || m?.id).filter(id => typeof id === 'string' && id.length <= 256);
        if (ids.length) return { models: ids.slice(0, 200) };
      } catch (error) { if (error?.message === 'SUBSCRIPTION_LOGIN_REQUIRED') throw error; }
      return { models: [...CODEX_FALLBACK_MODELS] };
    }
    if (provider.secret === 'subscription' && provider.protocol === 'anthropic') {
      try {
        const data = await this.authedRequest(provider, validateEndpoint(provider, '/models'), { method: 'GET' });
        const ids = (data?.data || []).map(m => m?.id).filter(id => typeof id === 'string' && id.length <= 256);
        if (ids.length) return { models: ids.slice(0, 200) };
      } catch (error) { if (error?.message === 'SUBSCRIPTION_LOGIN_REQUIRED') throw error; }
      return { models: [...CLAUDE_FALLBACK_MODELS] };
    }
    if (provider.secret === 'subscription' && provider.host === 'api.x.ai') {
      try {
        const data = await this.authedRequest(provider, validateEndpoint(provider, '/models'), { method: 'GET' });
        const ids = (data?.data || []).map(m => m?.id).filter(id => typeof id === 'string' && id.length <= 256);
        if (ids.length) return { models: ids.slice(0, 200) };
      } catch (error) { if (['SUBSCRIPTION_LOGIN_REQUIRED', 'SUBSCRIPTION_NOT_ENTITLED'].includes(error?.message)) throw error; }
      return { models: ['grok-4.6', 'grok-4.5', 'grok-4.3'] };
    }
    const data = provider.secret === 'subscription'
      ? await this.authedRequest(provider, validateEndpoint(provider, '/models'), { method: 'GET' })
      : await this.request(validateEndpoint(provider, '/models'), { method: 'GET', headers: await this.headers(provider) });
    let models = Array.isArray(data?.data) ? data.data.map(item => item?.id || item?.name) : [];
    if (!models.length && Array.isArray(data?.models)) models = data.models.map(item => item?.id || item?.name || item);
    models = models.filter(id => typeof id === 'string' && id.length <= 256).slice(0, 1000);
    if (!models.length) throw new Error('EMPTY_MODEL_LIST');
    return { models };
  }

  async chat(payload) {
    if (!exactKeys(payload, ['operation', 'providerId', 'baseUrl', 'model', 'messages', 'maxTokens']) || payload.operation !== 'chat') {
      throw new Error('INVALID_PROVIDER_OPERATION');
    }
    const provider = providerFor(payload.providerId, payload.baseUrl);
    const model = validateModel(payload.model);
    const messages = validateMessages(payload.messages);
    const maxTokens = payload.maxTokens === undefined ? 300 : payload.maxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error('INVALID_MAX_TOKENS');
    const systemText = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    const turns = messages.filter(message => message.role !== 'system');
    let text;
    if (provider.protocol === 'codex-responses') {
      const body = JSON.stringify({
        model, instructions: systemText || 'You are a helpful English speaking coach.', store: false, stream: true,
        input: turns.map(m => ({ type: 'message', role: m.role,
          content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }] })),
      });
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error('PROVIDER_REQUEST_TOO_LARGE');
      const sse = await this.authedRequest(provider, validateEndpoint(provider, '/responses'), {
        method: 'POST', body, extraHeaders: { Accept: 'text/event-stream' } }, true);
      text = parseSse(sse);
    } else {
      let body;
      if (provider.protocol === 'anthropic') {
        const system = provider.secret === 'subscription'
          ? [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }, ...(systemText ? [{ type: 'text', text: systemText }] : [])]
          : systemText;
        body = { model, max_tokens: maxTokens, system, messages: turns };
      } else body = { model, messages, max_tokens: maxTokens };
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw new Error('PROVIDER_REQUEST_TOO_LARGE');
      const url = validateEndpoint(provider, provider.protocol === 'anthropic' ? '/messages' : '/chat/completions');
      const data = provider.secret === 'subscription'
        ? await this.authedRequest(provider, url, { method: 'POST', body: serialized })
        : await this.request(url, { method: 'POST', headers: await this.headers(provider), body: serialized });
      text = provider.protocol === 'anthropic'
        ? data?.content?.filter?.(item => item?.type === 'text').map(item => item.text).join('\n')
        : data?.choices?.[0]?.message?.content;
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('INVALID_PROVIDER_RESPONSE');
    return { text: text.trim() };
  }

}

module.exports = { ProviderBroker, PROVIDERS, parseSse };
