(function exposeLlmProviderContract(root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports) module.exports = exports;
  if (root) root.VoiceLlmProviderContract = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createLlmProviderContract() {
  'use strict';

  const PROVIDER_IDS = Object.freeze({
    OPENAI_COMPATIBLE: 'openai-compatible',
    CHATGPT_SUBSCRIPTION: 'chatgpt-subscription',
    GROK_SUBSCRIPTION: 'grok-subscription',
    APPLE_FOUNDATION_MODELS: 'apple-foundation-models',
  });

  const PROVIDER_STATES = Object.freeze({
    AVAILABLE: 'AVAILABLE',
    UNAVAILABLE: 'UNAVAILABLE_ACCURATELY_DISABLED',
  });

  const PROVIDERS = Object.freeze({
    [PROVIDER_IDS.OPENAI_COMPATIBLE]: Object.freeze({
      id: PROVIDER_IDS.OPENAI_COMPATIBLE,
      name: 'OpenAI-compatible API',
      kind: 'api',
      protocol: 'openai',
      authMode: 'optional',
      authProduct: 'api-key-or-none',
      baseUrl: 'http://localhost:8000/v1',
      modelsPath: '/models',
      chatPath: '/chat/completions',
      keyHint: '輸入OpenAI-compatible API端點與選用的Bearer API Key；本機免驗證端點可留空。',
      defaultModels: [],
    }),

    [PROVIDER_IDS.CHATGPT_SUBSCRIPTION]: Object.freeze({
      id: PROVIDER_IDS.CHATGPT_SUBSCRIPTION,
      name: 'ChatGPT / Codex Subscription',
      kind: 'subscription',
      protocol: 'codex-responses',
      authMode: 'provider-oauth',
      authProduct: 'chatgpt-subscription',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      modelsPath: '/models',
      chatPath: '/responses',
      keyHint: '由Desktop受信任程序執行OpenAI device-code登入；Renderer不接觸token。',
      defaultModels: [],
    }),

    [PROVIDER_IDS.GROK_SUBSCRIPTION]: Object.freeze({
      id: PROVIDER_IDS.GROK_SUBSCRIPTION,
      name: 'Grok / SuperGrok Subscription',
      kind: 'subscription',
      protocol: 'openai-responses',
      authMode: 'provider-oauth',
      authProduct: 'grok-subscription',
      baseUrl: 'https://api.x.ai/v1',
      modelsPath: '/models',
      chatPath: '/responses',
      keyHint: '由Desktop受信任程序執行xAI device-code登入；可用模型與額度依帳號entitlement決定。',
      defaultModels: [],
    }),

    [PROVIDER_IDS.APPLE_FOUNDATION_MODELS]: Object.freeze({
      id: PROVIDER_IDS.APPLE_FOUNDATION_MODELS,
      name: 'Apple Intelligence (On-device)',
      kind: 'platform-local',
      protocol: 'native',
      authMode: 'none',
      authProduct: 'none',
      baseUrl: '',
      modelsPath: '',
      chatPath: '',
      keyHint: '僅在受信任的iOS native adapter確認Foundation Models可用時顯示。',
      defaultModels: ['system-default'],
    }),
  });

  const PRODUCT_PLATFORMS = new Set(['browser', 'desktop', 'macos', 'windows', 'ios', 'android']);

  function copyDefinition(definition) {
    return { ...definition, defaultModels: [...definition.defaultModels] };
  }

  function getProviderDefinition(providerId) {
    const definition = PROVIDERS[providerId];
    if (!definition) throw new Error('UNKNOWN_LLM_PROVIDER');
    return copyDefinition(definition);
  }

  function listProviderDefinitions() {
    return Object.values(PROVIDERS).map(copyDefinition);
  }

  function getProviderState(providerId, context) {
    getProviderDefinition(providerId);
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('INVALID_PLATFORM_CONTEXT');
    if (!PRODUCT_PLATFORMS.has(context.platform)) throw new Error('UNKNOWN_PRODUCT_PLATFORM');

    if (providerId === PROVIDER_IDS.OPENAI_COMPATIBLE) {
      if (context.platform !== 'ios' && context.platform !== 'android') return PROVIDER_STATES.AVAILABLE;
      const advertised = Array.isArray(context.availableProviders)
        && context.availableProviders.includes(PROVIDER_IDS.OPENAI_COMPATIBLE);
      return advertised ? PROVIDER_STATES.AVAILABLE : PROVIDER_STATES.UNAVAILABLE;
    }

    if (providerId === PROVIDER_IDS.CHATGPT_SUBSCRIPTION
        || providerId === PROVIDER_IDS.GROK_SUBSCRIPTION) {
      const desktopPlatform = context.platform === 'desktop'
        || context.platform === 'macos' || context.platform === 'windows';
      const advertised = Array.isArray(context.subscriptionProviders)
        && context.subscriptionProviders.includes(providerId);
      return desktopPlatform && advertised ? PROVIDER_STATES.AVAILABLE : PROVIDER_STATES.UNAVAILABLE;
    }

    if (providerId === PROVIDER_IDS.APPLE_FOUNDATION_MODELS) {
      const advertised = Array.isArray(context.platformLocalProviders)
        && context.platformLocalProviders.includes(PROVIDER_IDS.APPLE_FOUNDATION_MODELS);
      return context.platform === 'ios' && advertised ? PROVIDER_STATES.AVAILABLE : PROVIDER_STATES.UNAVAILABLE;
    }
    return PROVIDER_STATES.UNAVAILABLE;
  }

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every(key => keys.includes(key));
  }

  function normalizeLlmCapabilities(value) {
    const platforms = new Set(['browser', 'macos', 'windows', 'ios', 'android']);
    const states = new Set(Object.values(PROVIDER_STATES));
    if (!exactKeys(value, ['protocol', 'platform', 'providers'])
        || value.protocol !== 1 || !platforms.has(value.platform) || !Array.isArray(value.providers)) {
      throw new Error('INVALID_LLM_CAPABILITIES');
    }
    const seen = new Set();
    const providers = value.providers.map(item => {
      if (!exactKeys(item, ['id', 'state', 'authProduct']) || seen.has(item.id)
          || !Object.hasOwn(PROVIDERS, item.id) || !states.has(item.state)
          || item.authProduct !== PROVIDERS[item.id].authProduct) {
        throw new Error('INVALID_LLM_CAPABILITIES');
      }
      seen.add(item.id);
      return { id: item.id, state: item.state, authProduct: item.authProduct };
    });
    return { protocol: 1, platform: value.platform, providers };
  }

  return Object.freeze({
    PROVIDER_IDS,
    PROVIDER_STATES,
    getProviderDefinition,
    getProviderState,
    listProviderDefinitions,
    normalizeLlmCapabilities,
  });
}));
