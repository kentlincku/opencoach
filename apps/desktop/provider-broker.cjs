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
  llamacpp: { base: 'http://127.0.0.1:8080/v1', host: '127.0.0.1', protocol: 'openai', secret: false },
  ollama: { base: 'http://127.0.0.1:11434/v1', host: '127.0.0.1', protocol: 'openai', secret: false },
  llamacpp: { base: 'http://127.0.0.1:8080/v1', host: '127.0.0.1', protocol: 'openai', secret: false },
  lmstudio: { base: 'http://127.0.0.1:1234/v1', host: '127.0.0.1', protocol: 'openai', secret: false },
});

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function providerFor(providerId) {
  if (typeof providerId !== 'string' || !Object.hasOwn(PROVIDERS, providerId)) throw new Error('PROVIDER_NOT_ALLOWED');
  return PROVIDERS[providerId];
}

function validateEndpoint(config, suffix) {
  const url = new URL(`${config.base}${suffix}`);
  const expectedScheme = config.secret ? 'https:' : 'http:';
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
  constructor({ credentialStore, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!credentialStore || typeof fetchImpl !== 'function') throw new Error('INVALID_PROVIDER_BROKER_CONFIG');
    this.credentials = credentialStore;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async operation(payload) {
    if (!exactKeys(payload, ['operation', 'providerId', 'model', 'messages', 'maxTokens'])) {
      throw new Error('INVALID_PROVIDER_OPERATION');
    }
    if (payload.operation === 'models') return this.models(payload);
    if (payload.operation === 'chat') return this.chat(payload);
    throw new Error('INVALID_PROVIDER_OPERATION');
  }

  async headers(provider, contentType = 'application/json') {
    const headers = contentType ? { 'Content-Type': contentType } : {};
    if (!provider.secret) return headers;
    const key = await this.credentials.get(Object.keys(PROVIDERS).find(id => PROVIDERS[id] === provider));
    if (provider.protocol === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${key}`;
    }
    return headers;
  }

  async request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await boundedResponse(await this.fetch(url, { ...options, signal: controller.signal, redirect: 'error' }));
    } catch (error) {
      if (controller.signal.aborted) throw new Error('PROVIDER_REQUEST_TIMEOUT');
      if (error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED') {
        throw new Error('PROVIDER_CONNECTION_REFUSED');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async models(payload) {
    if (!exactKeys(payload, ['operation', 'providerId']) || payload.operation !== 'models') throw new Error('INVALID_PROVIDER_OPERATION');
    const provider = providerFor(payload.providerId);
    const data = await this.request(validateEndpoint(provider, '/models'), { method: 'GET', headers: await this.headers(provider) });
    let models = Array.isArray(data?.data) ? data.data.map(item => item?.id || item?.name) : [];
    if (!models.length && Array.isArray(data?.models)) models = data.models.map(item => item?.id || item?.name || item);
    models = models.filter(id => typeof id === 'string' && id.length <= 256).slice(0, 1000);
    if (!models.length) throw new Error('EMPTY_MODEL_LIST');
    return { models };
  }

  async chat(payload) {
    if (!exactKeys(payload, ['operation', 'providerId', 'model', 'messages', 'maxTokens']) || payload.operation !== 'chat') {
      throw new Error('INVALID_PROVIDER_OPERATION');
    }
    const provider = providerFor(payload.providerId);
    const model = validateModel(payload.model);
    const messages = validateMessages(payload.messages);
    const maxTokens = payload.maxTokens === undefined ? 300 : payload.maxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error('INVALID_MAX_TOKENS');
    let body;
    if (provider.protocol === 'anthropic') {
      body = {
        model, max_tokens: maxTokens,
        system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
        messages: messages.filter(message => message.role !== 'system'),
      };
    } else body = { model, messages, max_tokens: maxTokens };
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw new Error('PROVIDER_REQUEST_TOO_LARGE');
    const data = await this.request(validateEndpoint(provider, provider.protocol === 'anthropic' ? '/messages' : '/chat/completions'), {
      method: 'POST', headers: await this.headers(provider), body: serialized,
    });
    const text = provider.protocol === 'anthropic'
      ? data?.content?.filter?.(item => item?.type === 'text').map(item => item.text).join('\n')
      : data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('INVALID_PROVIDER_RESPONSE');
    return { text: text.trim() };
  }

}

module.exports = { ProviderBroker, PROVIDERS };
