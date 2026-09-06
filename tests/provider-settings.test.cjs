const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const llmProviderContract = require('../apps/web/runtime/llm-provider-contract.js');
const directApiPresets = require('../apps/web/runtime/direct-api-presets.js');
const localEndpointPolicy = require('../apps/web/runtime/local-endpoint-policy.js');

const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
const stopPreviewSource = html.slice(
  html.indexOf('function stopNativeSpeechPreview('),
  html.indexOf('function playFallbackWebSpeech('),
);
const transcriptionSource = html.slice(
  html.indexOf('async function transcribeBrowserAudio'),
  html.indexOf('async function handleLLMResponse'),
);
const settingsSource = html.slice(
  html.indexOf('const DIRECT_API_PROVIDER_ID'),
  html.indexOf('// App Init (Clean, AI Model Focused)'),
);
const migrationSource = html.slice(
  html.indexOf('async function migrateDesktopProviderCredentials'),
  html.indexOf('async function initApp'),
);

class Storage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  key(index) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

class SelectElement {
  constructor(value = '') { this.options = []; this._value = value; this.style = {}; }
  replaceChildren() { this.options = []; this._value = ''; }
  appendChild(option) {
    this.options.push(option);
    if (option.selected || this.options.length === 1) this._value = option.value;
  }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  set selectedIndex(index) { this._value = this.options[index]?.value || ''; }
  get selectedIndex() { return this.options.findIndex(option => option.value === this._value); }
}

function createHarness({ storage = {}, fetchImpl = async () => { throw new Error('offline'); }, electronAPI, voiceNativeBridge, googleOAuth2, gisLoadOutcomes = [], timerImpl = setTimeout, clearTimerImpl = clearTimeout, callbackUrl = 'http://127.0.0.1:8765/' } = {}) {
  const providerSelect = new SelectElement('openai-compatible');
  providerSelect.options = llmProviderContract.listProviderDefinitions()
    .filter(provider => provider.id !== llmProviderContract.PROVIDER_IDS.APPLE_FOUNDATION_MODELS)
    .map(provider => ({ value: provider.id, disabled: false, dataset: {} }));
  const elements = {
    providerSelect,
    modelSelect: new SelectElement(),
    apiBaseUrl: { value: 'https://api.example/v1', style: {} },
    apiKey: { value: '', style: {} },
    apiModel: { value: '', style: {} },
    apiKeyHint: { textContent: '', style: {} },
    apiBaseUrlGroup: { style: {} },
    apiKeyGroup: { style: {} },
    modelGroup: { style: {} },
    appleIntelligenceStatus: { textContent: '', style: {} },
    hermesOAuthBtn: { textContent: '', style: {} },
    googleGeminiClientId: { value: '', style: {} },
    googleGeminiProjectId: { value: '', style: {} },
    googleGeminiOrigin: { value: '', style: {} },
    directApiPreset: new SelectElement('custom'),
    directApiPresetGroup: { style: {} },
    googleGeminiStatus: { textContent: '', style: {} },
    googleGeminiLoginBtn: { disabled: false, style: {} },
    googleGeminiOAuthGroup: { style: {} },
    modelDetectNotice: { textContent: '', style: {} },
    localEndpointNotice: { textContent: '', style: {} },
    activeLanHttpWarning: { textContent: '', style: { display: 'none' } },
    migrationNotice: { textContent: '', style: {} },
    ttsModeSelect: { value: 'auto', style: {} },
    settingsModal: { style: {} },
    testConnResult: { textContent: '', style: {} },
  };
  const localStorage = new Storage(storage);
  const sessionStorage = new Storage();
  let fetchCalls = 0;
  const fetchRequests = [];
  let replacedUrl = '';
  const warnings = [];
  const parsedLocation = new URL(callbackUrl);
  const windowObject = {
    VoiceLlmProviderContract: llmProviderContract,
    VoiceDirectApiPresets: directApiPresets,
    VoiceLocalEndpointPolicy: localEndpointPolicy,
    location: { href: parsedLocation.href, search: parsedLocation.search, origin: parsedLocation.origin },
    history: { replaceState(_state, _title, url) { replacedUrl = String(url); } },
    ...(googleOAuth2 ? { google: { accounts: { oauth2: googleOAuth2 } } } : {}),
    ...(electronAPI ? { electronAPI } : {}),
    ...(voiceNativeBridge ? { voiceNativeBridge } : {}),
  };
  const createdScripts = [];
  const context = vm.createContext({
    AbortController,
    clearTimeout: clearTimerImpl,
    console: { warn: (...args) => warnings.push(args), error() {}, log() {} },
    document: {
      addEventListener() {},
      createElement: tag => {
        if (tag === 'script') {
          const script = { remove() { script.removed = true; } };
          createdScripts.push(script);
          return script;
        }
        return { value: '', textContent: '', selected: false };
      },
      head: {
        appendChild(script) {
          const outcome = gisLoadOutcomes.shift();
          queueMicrotask(() => {
            if (outcome) windowObject.google = { accounts: { oauth2: outcome } };
            script.onload();
          });
        },
      },
      getElementById: id => elements[id] || (elements[id] = { value: '', textContent: '', style: {} }),
    },
    fetch: async (...args) => { fetchCalls += 1; fetchRequests.push(args); return fetchImpl(...args); },
    isIosBrowserEnvironment: () => false,
    getTtsMode: () => 'auto',
    refreshNativeSpeechSettings() { elements.nativeSpeechRefreshed = true; },
    nativeSpeechPreviewToken: null,
    voicePlaybackToken: 1,
    updateCoachUI(state) { elements.coachState = state; },
    stopCurrentVoicePlayback() { elements.nativeSpeechStopped = true; },
    localStorage,
    sessionStorage,
    URL,
    URLSearchParams,
    setTimeout: timerImpl,
    window: windowObject,
  });
  vm.runInContext(`${stopPreviewSource}\n${transcriptionSource}\n${settingsSource}\n${migrationSource}\nthis.__settings = { removeRetiredOAuthState, migrateLegacyDirectProviderSettings, migrateDesktopProviderCredentials, migrateProviderSettingsForEnvironment: typeof migrateProviderSettingsForEnvironment === 'function' ? migrateProviderSettingsForEnvironment : null, applyLlmProviderCapabilities: typeof applyLlmProviderCapabilities === 'function' ? applyLlmProviderCapabilities : null, refreshLlmProviderCapabilities: typeof refreshLlmProviderCapabilities === 'function' ? refreshLlmProviderCapabilities : null, beginSubscriptionLogin: typeof beginSubscriptionLogin === 'function' ? beginSubscriptionLogin : null, pollSubscriptionLogin: typeof pollSubscriptionLogin === 'function' ? pollSubscriptionLogin : null, logoutSubscription: typeof logoutSubscription === 'function' ? logoutSubscription : null, populateModelSelect, applyDirectApiPreset, directApiPresetIdForBaseUrl, onApiBaseUrlInput, updateActiveLanHttpWarning, fetchModelsFromProvider, debouncedFetchModels, openSettingsModal, closeSettingsModal, onProviderSelectChange, onManualModelInput, requestProviderChat, transcribeBrowserAudio, getProviderModel, getProviderApiKey, setProviderApiKey };`, context);
  return { api: context.__settings, elements, localStorage, sessionStorage, warnings, fetchRequests, get fetchCalls() { return fetchCalls; }, get replacedUrl() { return replacedUrl; } };
}

test('iOS speech settings preserve blocked selection and do not connect implicitly', async () => {
  const harness = createHarness({
    storage: { vp_provider: 'chatgpt-subscription' },
    voiceNativeBridge: { appleFoundationModels: true, nativeSpeech: true,
      providerOperation: async () => { throw new Error('must not connect'); } },
  });
  harness.elements.directApiPreset.options = [{ value: 'omlx' }, { value: 'custom' }];
  await harness.api.openSettingsModal();
  assert.equal(harness.localStorage.getItem('vp_provider'), 'chatgpt-subscription');
  assert.equal(harness.elements.providerSelect.value, 'chatgpt-subscription');
  assert.match(harness.elements.modelDetectNotice.textContent, /阻止自動連線/);
  assert.equal(harness.elements.nativeSpeechRefreshed, true);
  assert.equal(harness.elements.kokoroTtsOption.disabled, true);
  assert.equal(harness.elements.directApiPreset.options[0].hidden, true);
  assert.equal(harness.fetchCalls, 0);
  await harness.api.closeSettingsModal();
  assert.equal(harness.elements.nativeSpeechStopped, undefined, 'closing settings without a preview must not stop conversation playback');
});

test('iPhone endpoint help and oMLX preset use actual iOS capabilities', async () => {
  const harness = createHarness({
    storage: { vp_provider: 'openai-compatible', vp_provider_urls: JSON.stringify({ 'openai-compatible': 'http://127.0.0.1:8000/v1' }) },
    voiceNativeBridge: { appleFoundationModels: true, providerOperation: async () => ({ models: ['local-model'] }) },
  });
  await harness.api.openSettingsModal();
  assert.equal(harness.elements.directApiPreset.value, 'custom');
  assert.match(harness.elements.localEndpointNotice.textContent, /iPhone 自己/);
  await harness.api.closeSettingsModal();
});

test('Android bridge does not acquire iPhone-only speech controls or endpoint copy', async () => {
  const harness = createHarness({
    storage: { vp_provider: 'openai-compatible', vp_provider_urls: JSON.stringify({ 'openai-compatible': 'http://127.0.0.1:8000/v1' }) },
    voiceNativeBridge: { providerOperation: async () => ({ models: ['local-model'] }) },
  });
  harness.elements.directApiPreset.options = [{ value: 'omlx' }];
  await harness.api.openSettingsModal();
  assert.equal(harness.elements.nativeSpeechRefreshed, undefined);
  assert.equal(harness.elements.directApiPreset.options[0].hidden, undefined);
  assert.equal(harness.elements.directApiPreset.value, 'omlx');
  assert.doesNotMatch(harness.elements.localEndpointNotice.textContent, /iPhone|Keychain/);
  await harness.api.closeSettingsModal();
  assert.equal(harness.elements.nativeSpeechStopped, undefined);
});

function deferredResponse(models) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {
    promise,
    resolve: () => resolve({ ok: true, json: async () => ({ data: models.map(id => ({ id })) }) }),
  };
}

function json(storage, key) { return JSON.parse(storage.getItem(key) || '{}'); }

const legacyDirectIds = ['omlx', 'claude', 'openai', 'gemini', 'groq', 'ollama', 'lmstudio', 'deepseek', 'custom'];

test('provider options are capability-driven and preserve unsupported selection until explicit user choice', async () => {
  const harness = createHarness({ storage: {
    vp_provider: 'chatgpt-subscription',
    vp_verified_provider: 'chatgpt-subscription',
  } });
  assert.equal(typeof harness.api.applyLlmProviderCapabilities, 'function');
  harness.api.applyLlmProviderCapabilities();
  const options = Object.fromEntries(harness.elements.providerSelect.options.map(option => [option.value, option]));
  assert.deepEqual(Object.keys(options), ['openai-compatible', 'chatgpt-subscription', 'grok-subscription']);
  assert.equal(options['openai-compatible'].disabled, false);
  assert.equal(options['chatgpt-subscription'].disabled, true);
  assert.equal(options['grok-subscription'].disabled, true);
  assert.equal(harness.localStorage.getItem('vp_provider'), 'chatgpt-subscription');
  assert.equal(harness.localStorage.getItem('vp_verified_provider'), null);
  await assert.rejects(() => harness.api.requestProviderChat({
    providerId: 'chatgpt-subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'gpt-5.4',
    conversationMessages: [{ role: 'user', content: 'must not leave device' }],
  }), /LLM_PROVIDER_UNAVAILABLE/);
  assert.equal(harness.fetchCalls, 0);
});

test('Desktop enables only subscription providers advertised by the trusted Main broker', async () => {
  const harness = createHarness({ electronAPI: {
    providerOperation: async () => ({ models: [] }),
    subscriptionCapabilities: async () => ({ providers: ['chatgpt-subscription'] }),
    subscriptionBeginLogin: async () => ({ state: 'authorizing' }),
    subscriptionPollLogin: async () => ({ state: 'authorizing' }),
    subscriptionCancelLogin: async () => ({ state: 'cancelled' }),
    subscriptionStatus: async () => ({ state: 'signed-out' }),
    subscriptionLogout: async () => ({ state: 'signed-out' }),
    subscriptionOperation: async () => ({ models: [] }),
  } });
  assert.equal(typeof harness.api.refreshLlmProviderCapabilities, 'function');
  await harness.api.refreshLlmProviderCapabilities();
  const options = Object.fromEntries(harness.elements.providerSelect.options.map(option => [option.value, option]));
  assert.equal(options['openai-compatible'].disabled, false);
  assert.equal(options['chatgpt-subscription'].disabled, false);
  assert.equal(options['grok-subscription'].disabled, true);
});

test('Desktop subscription login keeps tokens in Main and routes models chat and logout through typed IPC', async () => {
  const calls = [];
  const electronAPI = {
    providerOperation: async () => ({ models: [] }),
    subscriptionCapabilities: async () => ({ providers: ['chatgpt-subscription'] }),
    subscriptionBeginLogin: async providerId => {
      calls.push(['begin', providerId]);
      return { state: 'authorizing', loginId: 'login-id', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD', intervalSeconds: 5 };
    },
    subscriptionPollLogin: async (providerId, loginId) => { calls.push(['poll', providerId, loginId]); return { state: 'authorized' }; },
    subscriptionCancelLogin: async () => ({ state: 'cancelled' }),
    subscriptionStatus: async providerId => { calls.push(['status', providerId]); return { state: 'signed-out' }; },
    subscriptionLogout: async providerId => { calls.push(['logout', providerId]); return { state: 'signed-out' }; },
    subscriptionOperation: async payload => {
      calls.push(['operation', payload]);
      return payload.operation === 'models' ? { models: ['gpt-5.4'] } : { text: 'Subscription reply' };
    },
  };
  const harness = createHarness({ electronAPI });
  await harness.api.refreshLlmProviderCapabilities();
  harness.elements.providerSelect.value = 'chatgpt-subscription';
  await harness.api.onProviderSelectChange();
  assert.equal(harness.fetchCalls, 0);
  await harness.api.beginSubscriptionLogin();
  assert.equal(harness.elements.subscriptionVerificationLink.href, 'https://auth.openai.com/codex/device');
  assert.equal(harness.elements.subscriptionUserCode.textContent, 'ABCD');
  await harness.api.pollSubscriptionLogin();
  const reply = await harness.api.requestProviderChat({
    providerId: 'chatgpt-subscription', model: 'gpt-5.4',
    conversationMessages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(reply, 'Subscription reply');
  await harness.api.logoutSubscription();
  assert.deepEqual(calls.map(call => call[0]), ['status', 'begin', 'poll', 'status', 'operation', 'operation', 'logout', 'status']);
  assert.equal(JSON.stringify(calls).includes('access_token'), false);
});

test('closing settings while begin-login is pending cancels the late Main transaction', async () => {
  let resolveBegin;
  const cancelled = [];
  const harness = createHarness({ electronAPI: {
    providerOperation: async () => ({ models: [] }),
    subscriptionCapabilities: async () => ({ providers: ['chatgpt-subscription'] }),
    subscriptionBeginLogin: async () => new Promise(resolve => { resolveBegin = resolve; }),
    subscriptionPollLogin: async () => ({ state: 'authorizing' }),
    subscriptionCancelLogin: async (providerId, loginId) => { cancelled.push([providerId, loginId]); return { state: 'cancelled' }; },
    subscriptionStatus: async () => ({ state: 'signed-out' }),
    subscriptionLogout: async () => ({ state: 'signed-out' }),
    subscriptionOperation: async () => ({ models: [] }),
  } });
  await harness.api.refreshLlmProviderCapabilities();
  harness.elements.providerSelect.value = 'chatgpt-subscription';
  await harness.api.onProviderSelectChange();
  const beginning = harness.api.beginSubscriptionLogin();
  await harness.api.closeSettingsModal();
  resolveBegin({ state: 'authorizing', loginId: 'late-login', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'LATE' });
  await beginning;
  assert.deepEqual(cancelled, [['chatgpt-subscription', 'late-login']]);
});

test('opening settings for an unknown persisted provider performs no implicit discovery', async () => {
  const harness = createHarness({ storage: {
    vp_provider: 'retired-provider',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
    vp_provider_keys: JSON.stringify({ 'openai-compatible': 'must-not-be-used' }),
    vp_provider_key_bindings: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
  } });
  harness.api.applyLlmProviderCapabilities();
  harness.api.openSettingsModal();
  await Promise.resolve();
  assert.equal(harness.localStorage.getItem('vp_provider'), 'retired-provider');
  assert.equal(harness.fetchCalls, 0);
});


test('retired generic OAuth state is removed during upgrade', () => {
  const harness = createHarness({ storage: {
    vp_provider: 'oauth-pkce',
    vp_baseUrl: 'https://retired.example/v1',
    vp_model: 'retired-model',
    vp_apiKey: 'retired-key',
    vp_provider_keys: JSON.stringify({ 'oauth-pkce': 'retired-key', 'openai-compatible': 'keep-key' }),
    vp_provider_urls: JSON.stringify({ 'oauth-pkce': 'https://retired.example/v1', 'openai-compatible': 'https://keep.example/v1' }),
    vp_provider_models: JSON.stringify({ 'oauth-pkce': 'retired-model', 'openai-compatible': 'keep-model' }),
    vp_oauth_pkce_config: '{"old":true}',
    vp_oauth_pkce_notice: 'old',
    vp_verified_provider: 'oauth-pkce',
  } });
  harness.sessionStorage.setItem('vp_oauth_pkce_transaction', 'old');
  harness.sessionStorage.setItem('vp_oauth_pkce_session_token', 'old-token');
  harness.api.removeRetiredOAuthState();
  assert.equal(harness.localStorage.getItem('vp_provider'), 'openai-compatible');
  assert.equal(harness.localStorage.getItem('vp_oauth_pkce_config'), null);
  assert.equal(harness.localStorage.getItem('vp_oauth_pkce_notice'), null);
  assert.equal(harness.localStorage.getItem('vp_verified_provider'), null);
  assert.equal(harness.localStorage.getItem('vp_baseUrl'), null);
  assert.equal(harness.localStorage.getItem('vp_model'), null);
  assert.equal(harness.localStorage.getItem('vp_apiKey'), null);
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['oauth-pkce'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_urls')['oauth-pkce'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_models')['oauth-pkce'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_models')['openai-compatible'], 'keep-model');
  assert.equal(harness.sessionStorage.getItem('vp_oauth_pkce_transaction'), null);
  assert.equal(harness.sessionStorage.getItem('vp_oauth_pkce_session_token'), null);
});

test('desktop direct API maps an OpenAI-compatible URL to a trusted broker profile', async () => {
  const operations = [];
  const harness = createHarness({
    electronAPI: {
      providerOperation: async payload => { operations.push(payload); return { text: 'Hello' }; },
    },
  });

  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-test',
    conversationMessages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(reply, 'Hello');
  assert.equal(operations[0].providerId, 'openai');
});

test('desktop maps the fixed llama.cpp loopback endpoint to its credential-free broker profile', async () => {
  const operations = [];
  const harness = createHarness({
    electronAPI: {
      providerOperation: async payload => { operations.push(payload); return { text: 'Ornith reply' }; },
    },
  });

  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    model: 'ornith-9b',
    conversationMessages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(reply, 'Ornith reply');
  assert.equal(operations[0].providerId, 'llamacpp');
  assert.equal(operations[0].model, 'ornith-9b');
});

test('browser direct API keeps arbitrary OpenAI-compatible endpoints available', async () => {
  const calls = [];
  const harness = createHarness({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Browser reply' } }] }) };
    },
  });

  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible',
    baseUrl: 'https://custom.example/v1',
    apiKey: 'browser-key',
    model: 'custom-model',
    conversationMessages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(reply, 'Browser reply');
  assert.equal(calls[0].url, 'https://custom.example/v1/chat/completions');
});

test('API preset switch clears the previous provider key before changing endpoint', () => {
  const harness = createHarness({ storage: {
    vp_provider: 'openai-compatible',
    vp_provider_keys: JSON.stringify({ 'openai-compatible': 'old-provider-key' }),
  } });
  harness.elements.directApiPreset.value = 'gemini';
  harness.elements.apiBaseUrl.value = 'https://api.openai.com/v1';
  harness.elements.apiKey.value = 'old-provider-key';

  harness.api.applyDirectApiPreset();

  assert.equal(harness.elements.apiBaseUrl.value, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(harness.elements.apiKey.value, '');
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['openai-compatible'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_urls')['openai-compatible'], 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('editing the Base URL clears a browser key before model discovery can use the new endpoint', async () => {
  const calls = [];
  const harness = createHarness({
    storage: {
      vp_provider: 'openai-compatible',
      vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  harness.elements.providerSelect.value = 'openai-compatible';
  harness.elements.apiBaseUrl.value = 'https://api.openai.com/v1';
  harness.elements.apiKey.value = 'old-provider-key';
  harness.api.setProviderApiKey('openai-compatible', 'old-provider-key', 'https://api.openai.com/v1');

  harness.elements.apiBaseUrl.value = 'https://attacker.example/v1';
  harness.api.onApiBaseUrlInput();
  await Promise.resolve();

  assert.equal(harness.elements.apiKey.value, '');
  assert.equal(harness.api.getProviderApiKey('openai-compatible', 'https://attacker.example/v1'), '');
  assert.equal(calls.some(call => call.options?.headers?.Authorization), false);
});

test('browser credentials fail closed when their normalized Base URL binding does not match', () => {
  const harness = createHarness({ storage: {
    vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
  } });
  harness.api.setProviderApiKey('openai-compatible', 'openai-only-key', 'https://api.openai.com/v1/');
  assert.equal(harness.api.getProviderApiKey('openai-compatible', 'https://api.openai.com/v1'), 'openai-only-key');
  assert.equal(harness.api.getProviderApiKey('openai-compatible', 'https://generativelanguage.googleapis.com/v1beta/openai'), '');
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['openai-compatible'], undefined);
});

test('known cloud preset does not probe the endpoint before an API key is entered', async () => {
  const harness = createHarness({ storage: {
    vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://generativelanguage.googleapis.com/v1beta/openai' }),
  } });
  harness.elements.providerSelect.value = 'openai-compatible';
  harness.elements.apiBaseUrl.value = 'https://generativelanguage.googleapis.com/v1beta/openai';
  harness.elements.apiKey.value = '';

  await harness.api.fetchModelsFromProvider();

  assert.equal(harness.fetchCalls, 0);
  assert.match(harness.elements.modelDetectNotice.textContent, /API Key/);
  assert.equal(harness.elements.modelSelect.value, 'gemini-2.5-flash');
});

test('desktop direct API keeps URL and key editable for trusted profile selection', () => {
  const harness = createHarness({ electronAPI: {
    providerOperation: async () => ({ models: ['model'] }),
    providerCredentialHas: async () => ({ hasCredential: false }),
  } });

  harness.api.openSettingsModal();

  assert.equal(harness.elements.apiBaseUrl.disabled, false);
  assert.equal(harness.elements.apiKey.disabled, false);
});

test('desktop migration stores a legacy credential before generic cleanup', async () => {
  const stored = [];
  const harness = createHarness({
    storage: {
      vp_provider: 'groq',
      vp_provider_keys: JSON.stringify({ groq: 'legacy-map-secret' }),
      vp_provider_urls: JSON.stringify({ groq: 'https://api.groq.com/openai/v1' }),
      vp_provider_models: JSON.stringify({ groq: 'llama-test' }),
    },
    electronAPI: {
      providerCredentialSet: async (providerId, credential) => { stored.push({ providerId, credential }); },
    },
  });

  assert.equal(typeof harness.api.migrateProviderSettingsForEnvironment, 'function');
  await harness.api.migrateProviderSettingsForEnvironment();

  assert.deepEqual(stored, [{ providerId: 'groq', credential: 'legacy-map-secret' }]);
  assert.equal(harness.localStorage.getItem('vp_provider'), 'openai-compatible');
  const remainingKeys = json(harness.localStorage, 'vp_provider_keys');
  assert.equal(remainingKeys.groq, undefined);
  assert.equal(remainingKeys['openai-compatible'] || '', '');
  assert.equal(harness.localStorage.getItem('vp_apiKey'), null);
});

test('desktop migration continues after one profile fails to store', async () => {
  const calls = [];
  const harness = createHarness({
    storage: {
      vp_provider: 'openai',
      vp_provider_keys: JSON.stringify({ openai: 'openai-old', groq: 'groq-old' }),
    },
    electronAPI: {
      providerCredentialSet: async providerId => {
        calls.push(providerId);
        if (providerId === 'openai') throw new Error('SAFE_STORAGE_UNAVAILABLE');
        return { stored: true };
      },
    },
  });

  await harness.api.migrateProviderSettingsForEnvironment();

  assert.deepEqual(calls, ['openai', 'groq']);
  assert.equal(harness.localStorage.getItem('vp_apiKey'), null);
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['openai-compatible'] || '', '');
  assert.match(harness.localStorage.getItem('vp_connection_migration_notice') || '', /重新輸入 API Key/);
});

test('desktop migration reports an unmappable custom endpoint before removing plaintext', async () => {
  const harness = createHarness({
    storage: {
      vp_provider: 'openai-compatible',
      vp_provider_keys: JSON.stringify({ 'openai-compatible': 'custom-endpoint-key' }),
      vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://custom.example/v1' }),
    },
    electronAPI: { providerCredentialSet: async () => { throw new Error('must not be called'); } },
  });

  await harness.api.migrateProviderSettingsForEnvironment();

  assert.equal(json(harness.localStorage, 'vp_provider_keys')['openai-compatible'] || '', '');
  assert.match(harness.localStorage.getItem('vp_connection_migration_notice') || '', /重新輸入 API Key/);
});

test('desktop migration preserves credential failure notice alongside Claude compatibility warning', async () => {
  const harness = createHarness({
    storage: {
      vp_provider: 'claude',
      vp_apiKey: 'legacy-claude-key',
      vp_models: JSON.stringify({ claude: 'claude-model' }),
    },
    electronAPI: { providerCredentialSet: async () => { throw new Error('SAFE_STORAGE_UNAVAILABLE'); } },
  });

  await harness.api.migrateProviderSettingsForEnvironment();

  const notice = harness.localStorage.getItem('vp_connection_migration_notice') || '';
  assert.match(notice, /重新輸入 API Key/);
  assert.match(notice, /Anthropic/);
  assert.equal(harness.localStorage.getItem('vp_apiKey'), null);
});

test('desktop chat waits for the newest overlapping credential write', async () => {
  const resolvers = [];
  const operations = [];
  const electronAPI = {
    providerCredentialSet: () => new Promise(resolve => resolvers.push(resolve)),
    providerOperation: async payload => { operations.push(payload); return { text: 'ready' }; },
  };
  const harness = createHarness({ electronAPI });
  const first = harness.api.setProviderApiKey('openai-compatible', 'first', 'https://api.openai.com/v1');
  const second = harness.api.setProviderApiKey('openai-compatible', 'second', 'https://api.openai.com/v1');

  assert.equal(resolvers.length, 1, 'the second persistent write must wait for the first');
  resolvers[0]({ stored: true });
  await first;
  const chat = harness.api.requestProviderChat({
    providerId: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-test',
    conversationMessages: [{ role: 'user', content: 'hello' }],
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 0);

  resolvers[1]({ stored: true });
  await second;
  assert.equal(await chat, 'ready');
  assert.equal(operations.length, 1);
});

test('desktop credential queue continues after an earlier write fails', async () => {
  const calls = [];
  const harness = createHarness({
    electronAPI: {
      providerCredentialSet: async (_profile, value) => {
        calls.push(value);
        if (value === 'first') throw new Error('SAFE_STORAGE_UNAVAILABLE');
        return { stored: true };
      },
    },
  });

  const first = harness.api.setProviderApiKey('openai-compatible', 'first', 'https://api.openai.com/v1');
  const second = harness.api.setProviderApiKey('openai-compatible', 'second', 'https://api.openai.com/v1');
  await assert.rejects(first, /SAFE_STORAGE_UNAVAILABLE/);
  await second;
  assert.deepEqual(calls, ['first', 'second']);
});

test('desktop STT never uses a cloud provider while credentials are pending', async () => {
  let resolveWrite;
  const operations = [];
  const harness = createHarness({
    storage: {
      vp_provider: 'openai-compatible',
      vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
    },
    electronAPI: {
      providerCredentialSet: () => new Promise(resolve => { resolveWrite = resolve; }),
      providerOperation: async payload => { operations.push(payload); return { text: 'must-not-be-used' }; },
    },
  });
  const write = harness.api.setProviderApiKey('openai-compatible', 'new-key', 'https://api.openai.com/v1');
  const transcription = harness.api.transcribeBrowserAudio({
    audioBlob: { type: 'audio/webm', arrayBuffer: async () => new Uint8Array([1]).buffer }, language: 'en',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 0);

  resolveWrite({ stored: true });
  await write;
  const result = await transcription;
  assert.equal(result.text, '');
  assert.equal(result.localUnavailable, true);
  assert.equal(operations.length, 0);
});

test('legacy migration removes every retired direct-provider entry but preserves unified and subscription data', () => {
  const keys = Object.fromEntries(legacyDirectIds.map(id => [id, `${id}-secret`]));
  const urls = Object.fromEntries(legacyDirectIds.map(id => [id, `https://${id}.invalid/v1`]));
  const models = Object.fromEntries(legacyDirectIds.map(id => [id, `${id}-model`]));
  Object.assign(keys, {
    'openai-compatible': 'unified-secret',
    'claude-subscription': 'subscription-secret',
    'apple-foundation-models': 'platform-metadata',
    'future-provider': 'future-metadata',
  });
  Object.assign(urls, { 'openai-compatible': 'https://unified.example/v1', 'chatgpt-subscription': 'cli://openai-codex' });
  Object.assign(models, {
    'openai-compatible': 'unified-model',
    'chatgpt-subscription': 'gpt-5.4',
    'nous-subscription': 'auto',
  });
  const harness = createHarness({ storage: {
    vp_provider: 'groq',
    vp_provider_keys: JSON.stringify(keys),
    vp_provider_urls: JSON.stringify(urls),
    vp_provider_models: JSON.stringify(models),
  } });

  harness.api.migrateLegacyDirectProviderSettings();

  for (const id of legacyDirectIds) {
    assert.equal(Object.hasOwn(json(harness.localStorage, 'vp_provider_keys'), id), false, `key ${id}`);
    assert.equal(Object.hasOwn(json(harness.localStorage, 'vp_provider_urls'), id), false, `url ${id}`);
    assert.equal(Object.hasOwn(json(harness.localStorage, 'vp_provider_models'), id), false, `model ${id}`);
  }
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['openai-compatible'], 'unified-secret');
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['claude-subscription'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_urls')['chatgpt-subscription'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_models')['chatgpt-subscription'], 'gpt-5.4');
  assert.equal(json(harness.localStorage, 'vp_provider_models')['nous-subscription'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['apple-foundation-models'], 'platform-metadata');
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['future-provider'], 'future-metadata');
});

test('legacy cleanup runs even when the current provider is subscription or already unified', () => {
  for (const currentProvider of ['claude-subscription', 'openai-compatible']) {
    const harness = createHarness({ storage: {
      vp_provider: currentProvider,
      vp_apiKey: currentProvider === 'openai-compatible' ? 'unified-scalar-secret' : 'stale-scalar-secret',
      vp_provider_keys: JSON.stringify({
        openai: 'retired-secret',
        claude: 'retired-claude-secret',
        'claude-subscription': 'subscription-data',
      }),
      vp_provider_urls: JSON.stringify({ openai: 'https://retired.example/v1' }),
      vp_provider_models: JSON.stringify({ openai: 'retired-model' }),
    } });

    harness.api.migrateLegacyDirectProviderSettings();

    const keys = json(harness.localStorage, 'vp_provider_keys');
    assert.equal(harness.localStorage.getItem('vp_provider'), currentProvider);
    assert.equal(Object.hasOwn(keys, 'openai'), false);
    assert.equal(Object.hasOwn(keys, 'claude'), false);
    assert.equal(json(harness.localStorage, 'vp_provider_urls').openai, undefined);
    assert.equal(json(harness.localStorage, 'vp_provider_models').openai, undefined);
    assert.equal(keys['claude-subscription'], undefined);
    assert.equal(harness.localStorage.getItem('vp_apiKey'), null);
    if (currentProvider === 'openai-compatible') {
      assert.equal(keys['openai-compatible'], 'unified-scalar-secret');
    }
  }
});

test('legacy cleanup tolerates non-object and malformed JSON storage values', () => {
  for (const storedValue of ['null', '[]', '"text"', '{broken']) {
    const harness = createHarness({ storage: {
      vp_provider: 'claude-subscription',
      vp_provider_keys: storedValue,
      vp_provider_urls: storedValue,
      vp_provider_models: storedValue,
    } });

    assert.doesNotThrow(() => harness.api.migrateLegacyDirectProviderSettings());
    assert.deepEqual(Object.keys(json(harness.localStorage, 'vp_provider_keys')), []);
    assert.deepEqual(Object.keys(json(harness.localStorage, 'vp_provider_urls')), []);
    assert.deepEqual(Object.keys(json(harness.localStorage, 'vp_provider_models')), []);
  }
});

test('opening settings clears a stale migration notice when no new notice exists', () => {
  const harness = createHarness({ storage: { vp_provider: 'openai-compatible' } });
  harness.elements.migrationNotice.textContent = 'stale Claude warning';

  harness.api.openSettingsModal();

  assert.equal(harness.elements.migrationNotice.textContent, '');
});

test('failed model discovery keeps a migrated or manually entered model', async () => {
  for (const { storedModel, fieldModel } of [
    { storedModel: 'migrated-model', fieldModel: 'migrated-model' },
    { storedModel: '', fieldModel: 'unsaved-manual-model' },
  ]) {
    const models = storedModel ? { 'openai-compatible': storedModel } : {};
    const harness = createHarness({ storage: {
      vp_provider: 'openai-compatible',
      vp_provider_models: JSON.stringify(models),
    } });
    harness.elements.providerSelect.value = 'openai-compatible';
    harness.elements.apiModel.value = fieldModel;

    await harness.api.fetchModelsFromProvider();

    assert.equal(harness.elements.apiModel.value, fieldModel);
    assert.equal(harness.elements.modelSelect.value, fieldModel);
  }
});

test('Claude migration warning survives asynchronous model discovery notice', async () => {
  const harness = createHarness({ storage: {
    vp_provider: 'claude',
    vp_provider_models: JSON.stringify({ claude: 'claude-sonnet-4-5' }),
  } });

  harness.api.openSettingsModal();
  await new Promise(resolve => setImmediate(resolve));

  assert.match(harness.elements.migrationNotice.textContent, /Anthropic.*OpenAI-compatible/);
  assert.match(harness.elements.modelDetectNotice.textContent, /無法即時取得模型/);
});

test('stale model discovery cannot update the form after switching provider', async () => {
  const pending = deferredResponse(['stale-api-model']);
  const electronAPI = {
    subscriptionCapabilities: async () => ({ providers: ['chatgpt-subscription', 'grok-subscription'] }),
    subscriptionBeginLogin: async () => ({ state: 'authorizing' }),
    subscriptionPollLogin: async () => ({ state: 'authorizing' }),
    subscriptionCancelLogin: async () => ({ state: 'cancelled' }),
    subscriptionStatus: async () => ({ state: 'signed-out' }),
    subscriptionLogout: async () => ({ state: 'signed-out' }),
    subscriptionOperation: async () => ({ models: [] }),
  };
  const harness = createHarness({ fetchImpl: () => pending.promise, electronAPI });
  await harness.api.refreshLlmProviderCapabilities();

  await harness.api.openSettingsModal();
  harness.elements.providerSelect.value = 'chatgpt-subscription';
  await harness.api.onProviderSelectChange();
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.elements.apiModel.value, '');
  assert.deepEqual(harness.elements.modelSelect.options.map(option => option.value), []);
  assert.match(harness.elements.modelDetectNotice.textContent, /登入後/);
});

test('stale model discovery cannot update the form after changing endpoint', async () => {
  const oldRequest = deferredResponse(['old-endpoint-model']);
  const newRequest = deferredResponse(['new-endpoint-model']);
  const responses = [oldRequest, newRequest];
  const harness = createHarness({ fetchImpl: () => responses.shift().promise });

  harness.api.openSettingsModal();
  harness.elements.apiBaseUrl.value = 'https://new.example/v1';
  const latestFetch = harness.api.fetchModelsFromProvider();
  oldRequest.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.elements.modelSelect.options.some(option => option.value === 'old-endpoint-model'), false);
  assert.match(harness.elements.modelDetectNotice.textContent, /正在從 API 端點取得模型清單/);

  newRequest.resolve();
  await latestFetch;
  assert.equal(harness.elements.apiModel.value, 'new-endpoint-model');
});

test('stale model discovery cannot overwrite a model entered while it was pending', async () => {
  const pending = deferredResponse(['discovered-model']);
  const harness = createHarness({ fetchImpl: () => pending.promise });

  harness.api.openSettingsModal();
  harness.elements.apiModel.value = 'manually-entered-model';
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.elements.apiModel.value, 'manually-entered-model');
  assert.equal(harness.elements.modelSelect.options.some(option => option.value === 'discovered-model'), false);
});

test('editing the manual model invalidates discovery and clears its loading notice', async () => {
  const pending = deferredResponse(['discovered-model']);
  const harness = createHarness({ fetchImpl: () => pending.promise });

  harness.api.openSettingsModal();
  harness.elements.apiModel.value = 'manual-model';
  harness.api.onManualModelInput();

  assert.doesNotMatch(harness.elements.modelDetectNotice.textContent, /正在從 API 端點取得模型清單/);
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.elements.apiModel.value, 'manual-model');
  assert.equal(harness.elements.modelSelect.options.some(option => option.value === 'discovered-model'), false);
});

test('changing the API key immediately invalidates an older discovery result', async () => {
  const pending = deferredResponse(['old-key-model']);
  const harness = createHarness({ fetchImpl: () => pending.promise });

  harness.api.openSettingsModal();
  harness.elements.apiKey.value = 'new-key';
  harness.api.debouncedFetchModels();

  assert.doesNotMatch(harness.elements.modelDetectNotice.textContent, /正在從 API 端點取得模型清單/);
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.elements.modelSelect.options.some(option => option.value === 'old-key-model'), false);
  harness.api.closeSettingsModal();
});

test('aborting an old discovery for a new request emits no failure notice or warning', async () => {
  const latest = deferredResponse(['latest-model']);
  let requestCount = 0;
  const harness = createHarness({
    fetchImpl: (_url, options) => {
      requestCount += 1;
      if (requestCount > 1) return latest.promise;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  });

  harness.api.openSettingsModal();
  const latestRequest = harness.api.fetchModelsFromProvider();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.warnings.length, 0);
  assert.match(harness.elements.modelDetectNotice.textContent, /正在從 API 端點取得模型清單/);
  latest.resolve();
  await latestRequest;
  assert.equal(harness.elements.apiModel.value, 'latest-model');
  assert.equal(harness.warnings.length, 0);
});

test('subscription model response cannot update models or notice after provider switch', async () => {
  let resolveSubscription;
  const subscriptionResult = new Promise(resolve => { resolveSubscription = resolve; });
  const electronAPI = {
    subscriptionCapabilities: async () => ({ providers: ['chatgpt-subscription', 'grok-subscription'] }),
    subscriptionBeginLogin: async () => ({ state: 'authorizing' }),
    subscriptionPollLogin: async () => ({ state: 'authorizing' }),
    subscriptionCancelLogin: async () => ({ state: 'cancelled' }),
    subscriptionStatus: async () => ({ state: 'signed-out' }),
    subscriptionLogout: async () => ({ state: 'signed-out' }),
    subscriptionOperation: payload => payload.operation === 'models' ? subscriptionResult : Promise.resolve({ text: 'unused' }),
  };
  const harness = createHarness({ electronAPI });
  await harness.api.refreshLlmProviderCapabilities();
  harness.elements.providerSelect.value = 'chatgpt-subscription';
  await harness.api.onProviderSelectChange();
  const staleRequest = harness.api.fetchModelsFromProvider();

  harness.elements.providerSelect.value = 'grok-subscription';
  await harness.api.onProviderSelectChange();
  const expectedNotice = harness.elements.modelDetectNotice.textContent;
  resolveSubscription({ models: ['stale-subscription-model'] });
  await staleRequest;

  assert.equal(harness.elements.modelSelect.options.some(option => option.value === 'stale-subscription-model'), false);
  assert.equal(harness.elements.modelDetectNotice.textContent, expectedNotice);
});

test('direct OpenAI-compatible requests reject missing and auto models before fetch', async () => {
  for (const model of ['', 'auto']) {
    const harness = createHarness();
    await assert.rejects(
      harness.api.requestProviderChat({
        providerId: 'openai-compatible', baseUrl: 'https://api.example/v1', apiKey: String(), model,
        conversationMessages: [{ role: 'user', content: 'hello' }],
      }),
      /MODEL_REQUIRED/,
    );
    assert.equal(harness.fetchCalls, 0);
  }
});

test('hosted HTTPS discovers HTTP loopback models through Local Network Access', async () => {
  const harness = createHarness({
    callbackUrl: 'https://voice-practice.example/',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'local-model' }] }) }),
  });
  harness.elements.apiBaseUrl.value = 'http://127.0.0.1:8000/v1';

  await harness.api.fetchModelsFromProvider();

  assert.equal(harness.fetchCalls, 1);
  assert.equal(harness.fetchRequests[0][1].targetAddressSpace, 'local');
  assert.deepEqual(harness.elements.modelSelect.options.map(option => option.value), ['local-model']);
  assert.match(harness.elements.localEndpointNotice.textContent, /本機網路/);
});

test('loopback Local Web Mode can discover models from an HTTP local endpoint', async () => {
  const harness = createHarness({
    callbackUrl: 'http://127.0.0.1:8765/',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'local-model' }] }) }),
  });
  harness.elements.apiBaseUrl.value = 'http://127.0.0.1:8000/v1';

  await harness.api.fetchModelsFromProvider();

  assert.equal(harness.fetchCalls, 1);
  assert.deepEqual(harness.elements.modelSelect.options.map(option => option.value), ['local-model']);
  assert.match(harness.elements.localEndpointNotice.textContent, /Local Web Mode/);
});

test('partial Electron preload uses browser Local Network Access rather than a missing broker', async () => {
  const harness = createHarness({
    callbackUrl: 'https://voice-practice.example/',
    electronAPI: {},
    fetchImpl: async (_url, options) => ({
      ok: true,
      json: async () => options.method === 'GET'
        ? ({ data: [{ id: 'local-model' }] })
        : ({ choices: [{ message: { content: 'local reply' } }] }),
    }),
  });
  harness.elements.apiBaseUrl.value = 'http://127.0.0.1:8000/v1';

  await harness.api.fetchModelsFromProvider();
  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: String(), model: 'local-model',
    conversationMessages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(reply, 'local reply');
  assert.equal(harness.fetchCalls, 2);
  assert.equal(harness.fetchRequests[0][1].targetAddressSpace, 'local');
  assert.equal(harness.fetchRequests[1][1].targetAddressSpace, 'local');
});

test('hosted HTTPS sends HTTP loopback chat through Local Network Access', async () => {
  const harness = createHarness({
    callbackUrl: 'https://voice-practice.example/',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'local reply' } }] }) }),
  });

  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: String(), model: 'local-model',
    conversationMessages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(reply, 'local reply');
  assert.equal(harness.fetchCalls, 1);
  assert.equal(harness.fetchRequests[0][1].targetAddressSpace, 'local');
});

test('hosted HTTPS discovers LAN HTTP models through Local Network Access with a warning', async () => {
  const harness = createHarness({
    callbackUrl: 'https://voice-practice.example/',
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'lan-model' }] }) }),
  });
  harness.elements.apiBaseUrl.value = 'http://192.168.1.20:8000/v1';
  await harness.api.fetchModelsFromProvider();

  assert.equal(harness.fetchCalls, 1);
  assert.equal(harness.fetchRequests[0][1].targetAddressSpace, 'local');
  assert.match(harness.elements.localEndpointNotice.textContent, /明文/);
  assert.equal(harness.elements.localEndpointNotice.style.fontWeight, '800');
  assert.match(harness.elements.localEndpointNotice.style.border, /2px/);
  assert.deepEqual(harness.elements.modelSelect.options.map(option => option.value), ['lan-model']);
});

test('active LAN HTTP endpoint keeps a prominent warning visible outside settings', () => {
  const lanHarness = createHarness({ storage: {
    vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'http://192.168.1.20:8000/v1' }),
  } });
  lanHarness.api.updateActiveLanHttpWarning();
  assert.equal(lanHarness.elements.activeLanHttpWarning.style.display, 'block');
  assert.match(lanHarness.elements.activeLanHttpWarning.textContent, /192\.168\.1\.20:8000/);
  assert.match(lanHarness.elements.activeLanHttpWarning.textContent, /明文/);

  const secureHarness = createHarness({ storage: {
    vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.example/v1' }),
  } });
  secureHarness.api.updateActiveLanHttpWarning();
  assert.equal(secureHarness.elements.activeLanHttpWarning.style.display, 'none');
  assert.equal(secureHarness.elements.activeLanHttpWarning.textContent, '');
});

test('hosted HTTPS sends LAN HTTP chat through Local Network Access', async () => {
  const harness = createHarness({
    callbackUrl: 'https://voice-practice.example/',
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'lan reply' } }] }) }),
  });

  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible', baseUrl: 'http://192.168.1.20:8000/v1', apiKey: String(), model: 'lan-model',
    conversationMessages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(reply, 'lan reply');
  assert.equal(harness.fetchCalls, 1);
  assert.equal(harness.fetchRequests[0][1].targetAddressSpace, 'local');
  assert.match(harness.elements.localEndpointNotice.textContent, /明文/);
});

test('hosted HTTPS blocks public HTTP endpoints before fetch', async () => {
  const harness = createHarness({ callbackUrl: 'https://voice-practice.example/' });
  harness.elements.apiBaseUrl.value = 'http://8.8.8.8:8000/v1';
  await harness.api.fetchModelsFromProvider();
  await assert.rejects(
    harness.api.requestProviderChat({
      providerId: 'openai-compatible', baseUrl: 'http://8.8.8.8:8000/v1', apiKey: String(), model: 'local-model',
      conversationMessages: [{ role: 'user', content: 'hello' }],
    }),
    /HOSTED_HTTPS_HTTP_REQUIRES_LOCAL_NETWORK/,
  );
  assert.equal(harness.fetchCalls, 0);
});

test('Electron oMLX path routes through broker with zero renderer fetch calls', async () => {
  const operations = [];
  let browserFetchCalls = 0;
  const harness = createHarness({
    callbackUrl: 'https://voice-practice.example/',
    electronAPI: {
      providerOperation: async payload => {
        operations.push(payload);
        if (payload.operation === 'models') return { models: ['mlx-community/Qwen2.5-7B-Instruct-4bit'] };
        if (payload.operation === 'chat') return { text: 'oMLX reply' };
        throw new Error('UNEXPECTED_OPERATION');
      },
    },
    fetchImpl: async () => {
      browserFetchCalls += 1;
      throw new Error('Renderer fetch must not be called in Electron for oMLX');
    },
  });

  harness.elements.providerSelect.value = 'openai-compatible';
  harness.elements.apiBaseUrl.value = 'http://127.0.0.1:8000/v1';

  await harness.api.fetchModelsFromProvider();

  assert.equal(browserFetchCalls, 0);
  assert.equal(operations.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(operations[0])), { operation: 'models', providerId: 'omlx' });
  assert.deepEqual(harness.elements.modelSelect.options.map(option => option.value), ['mlx-community/Qwen2.5-7B-Instruct-4bit']);

  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: '',
    model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
    conversationMessages: [{ role: 'user', content: 'hello from desktop' }],
  });

  assert.equal(reply, 'oMLX reply');
  assert.equal(browserFetchCalls, 0);
  assert.equal(operations.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(operations[1])), {
    operation: 'chat',
    providerId: 'omlx',
    model: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
    messages: [{ role: 'user', content: 'hello from desktop' }],
    maxTokens: 300,
  });
});

test('Electron oMLX preset applies fixed endpoint and shows broker direct notice', async () => {
  const harness = createHarness({
    callbackUrl: 'https://voice-practice.example/',
    electronAPI: {
      providerOperation: async () => ({ models: ['local-model'] }),
    },
  });

  harness.elements.directApiPreset.value = 'omlx';
  harness.api.applyDirectApiPreset();

  assert.equal(harness.elements.apiBaseUrl.value, 'http://127.0.0.1:8000/v1');
  assert.match(harness.elements.apiKeyHint.textContent, /oMLX/);
  assert.equal(harness.elements.localEndpointNotice.textContent, '由App安全broker直連同機模型');
});

test('Electron oMLX connection refused displays actionable port and binding message', async () => {
  const harness = createHarness({
    callbackUrl: 'https://voice-practice.example/',
    electronAPI: {
      providerOperation: async () => {
        throw new Error('PROVIDER_CONNECTION_REFUSED');
      },
    },
  });

  harness.elements.apiBaseUrl.value = 'http://127.0.0.1:8000/v1';
  await harness.api.fetchModelsFromProvider();
  assert.match(harness.elements.modelDetectNotice.textContent, /確認 oMLX 已啟動、port 8000 且監聽 127\.0\.0\.1/);

  await assert.rejects(
    harness.api.requestProviderChat({
      providerId: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'test-model',
      conversationMessages: [{ role: 'user', content: 'hi' }],
    }),
    /確認 oMLX 已啟動、port 8000 且監聽 127\.0\.0\.1/,
  );
});

test('iOS voiceNativeBridge routes LAN provider requests with full baseUrl and zero renderer fetch', async () => {
  const operations = [];
  const credentialCalls = [];
  let fetchCount = 0;

  const harness = createHarness({
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error('RENDERER_FETCH_FORBIDDEN');
    },
    voiceNativeBridge: {
      providerOperation: async payload => {
        operations.push(payload);
        if (payload.operation === 'models') {
          return { models: ['qwen3.8-27b-4bit'] };
        }
        if (payload.operation === 'chat') {
          return { text: 'Hello from iPhone native bridge' };
        }
        throw new Error('UNKNOWN_OPERATION');
      },
      credentialHas: async (providerId, baseUrl) => {
        credentialCalls.push({ action: 'has', providerId, baseUrl });
        return { hasCredential: true };
      },
      credentialSet: async (providerId, baseUrl, credential) => {
        credentialCalls.push({ action: 'set', providerId, baseUrl, credential });
      },
      credentialClear: async (providerId, baseUrl) => {
        credentialCalls.push({ action: 'clear', providerId, baseUrl });
      },
    },
  });

  const lanUrl = 'http://192.168.1.50:8000/v1';
  harness.elements.apiBaseUrl.value = lanUrl;
  harness.elements.providerSelect.value = 'openai-compatible';
  harness.api.onApiBaseUrlInput();

  // 1. Model discovery
  await harness.api.fetchModelsFromProvider();
  assert.equal(fetchCount, 0, 'Renderer must not call fetch');
  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation, 'models');
  assert.equal(operations[0].providerId, 'openai-compatible');
  assert.equal(operations[0].baseUrl, lanUrl);

  // 2. Chat completion
  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible',
    baseUrl: lanUrl,
    apiKey: '',
    model: 'qwen3.8-27b-4bit',
    conversationMessages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 50,
  });
  assert.equal(fetchCount, 0, 'Renderer must not call fetch during chat');
  assert.equal(reply, 'Hello from iPhone native bridge');
  assert.equal(operations.length, 2);
  assert.equal(operations[1].operation, 'chat');
  assert.equal(operations[1].providerId, 'openai-compatible');
  assert.equal(operations[1].baseUrl, lanUrl);
  assert.equal(operations[1].model, 'qwen3.8-27b-4bit');
  assert.equal(operations[1].maxTokens, 50);
  assert.deepEqual(operations[1].messages, [{ role: 'user', content: 'Hello' }]);

  // 3. Credential set
  await harness.api.setProviderApiKey('openai-compatible', 'my-lan-key', lanUrl);
  const setCall = credentialCalls.find(c => c.action === 'set');
  assert.ok(setCall, 'credentialSet should be called');
  assert.equal(setCall.providerId, 'openai-compatible');
  assert.equal(setCall.baseUrl, lanUrl);
  assert.equal(setCall.credential, 'my-lan-key');

  // 4. Modal render checks credentialHas with baseUrl
  harness.api.openSettingsModal();
  await new Promise(resolve => setTimeout(resolve, 10));
  // console.log('DEBUG credentialCalls:', credentialCalls);
  const hasCall = credentialCalls.find(c => c.action === 'has');
  assert.ok(hasCall, 'credentialHas should be called');
  assert.equal(hasCall.providerId, 'openai-compatible');
  assert.equal(hasCall.baseUrl, harness.elements.apiBaseUrl.value);
});

test('Apple Foundation Models chat uses only the typed native bridge payload', async () => {
  const operations = [];
  const harness = createHarness({
    fetchImpl: async () => { throw new Error('RENDERER_FETCH_FORBIDDEN'); },
    voiceNativeBridge: {
      appleFoundationModels: true,
      providerOperation: async payload => {
        operations.push(payload);
        return { text: 'Local Apple reply', contextVersion: 1 };
      },
    },
  });
  const longHistory = Array.from({ length: 14 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `turn-${index}`,
  }));
  longHistory[13].role = 'user';

  const reply = await harness.api.requestProviderChat({
    providerId: 'apple-foundation-models',
    baseUrl: 'https://must-not-leak.example/v1',
    apiKey: 'test-placeholder-key',
    model: 'must-not-leak',
    conversationMessages: longHistory,
    maxTokens: 2000,
  });

  assert.equal(reply, 'Local Apple reply');
  assert.equal(harness.fetchCalls, 0);
  assert.equal(operations.length, 1);
  assert.deepEqual(Object.keys(operations[0]).sort(), ['locale', 'maxTokens', 'messages', 'operation', 'providerId']);
  assert.equal(operations[0].operation, 'apple.chat');
  assert.equal(operations[0].providerId, 'apple-foundation-models');
  assert.equal(operations[0].messages.length, 12);
  assert.equal(operations[0].maxTokens, 1024);
});

test('Browser and Electron never attempt Apple Foundation Models or silently fallback', async () => {
  for (const options of [{}, { electronAPI: { providerOperation: async () => { throw new Error('must not call'); } } }]) {
    const harness = createHarness({ ...options, storage: { vp_provider: 'apple-foundation-models' } });
    harness.api.openSettingsModal();
    assert.equal(harness.localStorage.getItem('vp_provider'), 'apple-foundation-models');
    assert.equal(harness.elements.appleIntelligenceProviderOption.hidden, true);
    assert.equal(harness.elements.appleIntelligenceProviderOption.disabled, true);
    assert.match(harness.elements.appleIntelligenceStatus.textContent, /只可在支援的 iOS 原生 App 使用/);
    await assert.rejects(() => harness.api.requestProviderChat({
      providerId: 'apple-foundation-models',
      baseUrl: '',
      apiKey: 'test-placeholder-key',
      model: '',
      conversationMessages: [{ role: 'user', content: 'Hello' }],
    }), /APPLE_MODEL_NATIVE_BRIDGE_REQUIRED/);
    assert.equal(harness.fetchCalls, 0);
  }
});

test('Apple provider form hides URL key model fields and shows typed availability', async () => {
  const operations = [];
  const harness = createHarness({
    storage: { vp_provider: 'apple-foundation-models' },
    voiceNativeBridge: {
      appleFoundationModels: true,
      providerOperation: async payload => {
        operations.push(payload);
        return { available: false, availability: 'APPLE_MODEL_NOT_READY', contextVersion: 1 };
      },
    },
  });

  harness.api.openSettingsModal();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.elements.apiBaseUrlGroup.style.display, 'none');
  assert.equal(harness.elements.apiKeyGroup.style.display, 'none');
  assert.equal(harness.elements.modelGroup.style.display, 'none');
  assert.equal(harness.elements.appleIntelligenceStatus.style.display, 'block');
  assert.match(harness.elements.appleIntelligenceStatus.textContent, /模型尚未就緒/);
  assert.deepEqual(JSON.parse(JSON.stringify(operations[0])), {
    operation: 'apple.status',
    providerId: 'apple-foundation-models',
    locale: 'en-US',
  });
  assert.equal(harness.localStorage.getItem('vp_provider'), 'apple-foundation-models');
});
