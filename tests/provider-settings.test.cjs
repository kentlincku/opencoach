const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const directApiPresets = require('../apps/web/runtime/direct-api-presets.js');
const localEndpointPolicy = require('../apps/web/runtime/local-endpoint-policy.js');
const llmProviderContract = require('../apps/web/runtime/llm-provider-contract.js');

const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
// Settings now joins the actual voice Stop; only idle device boundaries are doubled.
const conversationSource = html.slice(
  html.indexOf('// Conversation Control Loop'),
  html.indexOf('\nlet mediaRecorder = null;'),
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
const initSource = html.slice(html.indexOf('async function initApp'), html.indexOf('window.addEventListener("beforeunload"'));

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

function createHarness({ storage = {}, fetchImpl = async () => { throw new Error('offline'); }, electronAPI, timerImpl = setTimeout, clearTimerImpl = clearTimeout, callbackUrl = 'http://127.0.0.1:8765/' } = {}) {
  const providerSelect = new SelectElement('openai-compatible');
  providerSelect.options = llmProviderContract.listProviderDefinitions()
    .filter(provider => provider.id !== 'apple-foundation-models')
    .map(provider => ({ value: provider.id, disabled: false, dataset: {} }));
  const elements = {
    providerSelect,
    modelSelect: new SelectElement(),
    apiBaseUrl: { value: 'https://api.example/v1', style: {} },
    apiKey: { value: '', style: {} },
    apiModel: { value: '', style: {} },
    apiKeyHint: { textContent: '', style: {} },
    directApiPreset: new SelectElement('custom'),
    directApiPresetGroup: { style: {} },
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
    VoiceDirectApiPresets: directApiPresets,
    VoiceLocalEndpointPolicy: localEndpointPolicy,
    VoiceLlmProviderContract: llmProviderContract,
    VoiceTtsPreference: require("../apps/web/runtime/tts-preference.js"),
    location: { href: parsedLocation.href, search: parsedLocation.search, origin: parsedLocation.origin },
    history: { replaceState(_state, _title, url) { replacedUrl = String(url); } },
    ...(electronAPI ? { electronAPI } : {}),
  };
  const context = vm.createContext({
    AbortController,
    voiceRuntime: null, isRunning: false, isMediaRecording: false, voicePlaybackToken: 0,
    stopCurrentVoicePlayback() {}, updateCoachUI() {},
    alert() {}, cancelPendingKokoroInitialization() {}, setTTSEngineStatus() {},
    formatProviderError: error => error.message,
    clearTimeout: clearTimerImpl,
    console: { warn: (...args) => warnings.push(args), error() {}, log() {} },
    document: {
      addEventListener() {},
      querySelector: () => elements.conversationStart || (elements.conversationStart = { disabled: false, style: {} }),
      createElement: () => ({ value: '', textContent: '', selected: false, dataset: {} }),
      getElementById: id => elements[id] || (elements[id] = { value: '', textContent: '', style: {} }),
    },
    fetch: async (...args) => { fetchCalls += 1; fetchRequests.push(args); return fetchImpl(...args); },
    isIosBrowserEnvironment: () => false,
    getTtsMode: () => 'auto',
    localStorage,
    sessionStorage,
    URL,
    URLSearchParams,
    setTimeout: timerImpl,
    window: windowObject,
  });
  const browserOwnerSource = html.slice(html.indexOf('function browserVoiceOwner('), html.indexOf('async function transcribeWithWebAssembly('));
  vm.runInContext(`${browserOwnerSource}\n${conversationSource}\n${transcriptionSource}\n${settingsSource}\n${migrationSource}\nthis.__settings = { removeRetiredOAuthState, migrateLegacyDirectProviderSettings, migrateDesktopProviderCredentials, migrateProviderSettingsForEnvironment: typeof migrateProviderSettingsForEnvironment === 'function' ? migrateProviderSettingsForEnvironment : null, applyLlmProviderCapabilities: typeof applyLlmProviderCapabilities === 'function' ? applyLlmProviderCapabilities : null, populateModelSelect, applyDirectApiPreset, directApiPresetIdForBaseUrl, onApiBaseUrlInput, updateActiveLanHttpWarning, fetchModelsFromProvider, debouncedFetchModels, openSettingsModal, closeSettingsModal, onProviderSelectChange, onManualModelInput, requestProviderChat, transcribeBrowserAudio, getProviderModel, getProviderApiKey, setProviderApiKey };`, context);
  // Run production startup unchanged; replace only offline/voice/header environment dependencies.
  vm.runInContext(`${initSource}
    initializeLocalFirstWeb = async () => {};
    // Keep the actual badge renderer: D4 observes its late/reentrant writes.
    this.updateCoachUI = () => {};
    this.createVoiceRuntime = async () => { voiceRuntime = { kind: 'browser', capabilities: async () => ({}), cancel: async () => {}, dispose: async () => {} }; };
    this.scheduleBrowserKokoroInitialization = () => {};
    Object.assign(this.__settings, { initApp, saveSettings, saveCurrentProviderForm, testApiConnection, getCurrentProviderState });`, context);
  const dispatch = (id, event = 'input') => {
    const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];
    const handler = tag?.match(new RegExp(`on${event}="([^"]+)"`))?.[1];
    assert.ok(handler, `${id} has a production ${event} handler`);
    return vm.runInContext(handler, context);
  };
  return { api: context.__settings, dispatch, elements, localStorage, sessionStorage, warnings, fetchRequests, get fetchCalls() { return fetchCalls; }, get replacedUrl() { return replacedUrl; } };
}

function deferredResponse(models) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {
    promise,
    resolve: () => resolve({ ok: true, json: async () => ({ data: models.map(id => ({ id })) }) }),
  };
}

function json(storage, key) { return JSON.parse(storage.getItem(key) || '{}'); }

function credentialLifecycleHarness(storage, desktop, writes = [], operations = []) {
  return createHarness({ storage, ...(desktop ? { electronAPI: {
    providerCredentialSet: async (profile, credential) => { writes.push({ profile, credential }); },
    providerCredentialHas: async () => ({ hasCredential: writes.length > 0 }),
    providerOperation: async payload => { operations.push(payload); return { models: ['selected-model'] }; },
  } } : {}) });
}

const legacyDirectIds = ['omlx', 'claude', 'openai', 'gemini', 'groq', 'ollama', 'lmstudio', 'deepseek', 'custom'];

test('provider options are capability-driven and preserve unsupported selection until explicit user choice', async () => {
  const harness = createHarness({ storage: {
    vp_provider: 'chatgpt-subscription',
    vp_verified_provider: 'chatgpt-subscription',
  } });
  assert.equal(typeof harness.api.applyLlmProviderCapabilities, 'function');
  harness.api.applyLlmProviderCapabilities();
  const options = Object.fromEntries(harness.elements.providerSelect.options.map(option => [option.value, option]));
  assert.deepEqual(Object.keys(options), ['openai-compatible', 'chatgpt-subscription', 'grok-subscription', 'claude-subscription']);
  assert.equal(options['chatgpt-subscription'].disabled, true);
  assert.equal(options['claude-subscription'].disabled, true);
  assert.equal(options['grok-subscription'].disabled, true);
  assert.equal(options['openai-compatible'].disabled, false);
  assert.equal(harness.localStorage.getItem('vp_provider'), 'chatgpt-subscription');
  assert.equal(harness.localStorage.getItem('vp_verified_provider'), null);
  await assert.rejects(() => harness.api.requestProviderChat({
    providerId: 'chatgpt-subscription',
    baseUrl: 'cli://openai',
    model: 'auto',
    conversationMessages: [{ role: 'user', content: 'must not leave device' }],
  }), /LLM_PROVIDER_UNAVAILABLE/);
  assert.equal(harness.fetchCalls, 0);
});

test('opening settings for an unknown persisted provider performs no implicit discovery', async () => {
  const harness = createHarness({ storage: {
    vp_provider: 'retired-provider',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
    vp_provider_keys: JSON.stringify({ 'openai-compatible': 'must-not-be-used' }),
    vp_provider_key_bindings: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
  } });
  harness.api.applyLlmProviderCapabilities();
  await harness.api.openSettingsModal();
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
    vp_oauth_pkce_config: JSON.stringify({ authorizationEndpoint: 'https://retired.example/auth' }),
    vp_oauth_pkce_notice: 'old notice',
    vp_google_gemini_config: JSON.stringify({ clientId: 'retired-client', projectId: 'retired-project' }),
    vp_verified_provider: 'oauth-pkce',
  } });
  harness.sessionStorage.setItem('vp_oauth_pkce_transaction', 'old');
  harness.sessionStorage.setItem('vp_oauth_pkce_session_token', 'old-token');
  harness.sessionStorage.setItem('vp_google_gemini_session_token', 'old-google-token');
  harness.api.removeRetiredOAuthState();
  assert.equal(harness.localStorage.getItem('vp_provider'), 'oauth-pkce');
  assert.equal(harness.localStorage.getItem('vp_oauth_pkce_config'), null);
  assert.equal(harness.localStorage.getItem('vp_oauth_pkce_notice'), null);
  assert.equal(harness.localStorage.getItem('vp_google_gemini_config'), null);
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
  assert.equal(harness.sessionStorage.getItem('vp_google_gemini_session_token'), null);
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

test('Gemini API preset uses the shared OpenAI-compatible API-key chat route', async () => {
  const calls = [];
  const harness = createHarness({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Gemini API reply' } }] }) };
  } });

  const reply = await harness.api.requestProviderChat({
    providerId: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: 'gemini-api-key',
    model: 'gemini-2.5-flash',
    conversationMessages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(reply, 'Gemini API reply');
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer gemini-api-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 300,
  });
});

test('desktop direct API keeps URL and key editable for trusted profile selection', async () => {
  const harness = createHarness({ electronAPI: {
    providerOperation: async () => ({ models: ['model'] }),
    providerCredentialHas: async () => ({ hasCredential: false }),
  } });

  await harness.api.openSettingsModal();

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

test('legacy migration keeps only canonical model metadata and API credential data', () => {
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
  Object.assign(models, { 'openai-compatible': 'unified-model', 'nous-subscription': 'auto' });
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
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['openai-compatible'], 'groq-secret');
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['claude-subscription'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_urls')['chatgpt-subscription'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_models')['nous-subscription'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['apple-foundation-models'], undefined);
  assert.equal(json(harness.localStorage, 'vp_provider_keys')['future-provider'], undefined);
});

test('legacy cleanup keeps a retired selection blocked but removes its stored secrets', () => {
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
      // No persisted selected URL means no credential consent: an init default must not bind this orphan.
      assert.equal(keys['openai-compatible'], undefined);
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

test('opening settings clears a stale migration notice when no new notice exists', async () => {
  const harness = createHarness({ storage: { vp_provider: 'openai-compatible' } });
  harness.elements.migrationNotice.textContent = 'stale Claude warning';

  await harness.api.openSettingsModal();

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

  await harness.api.openSettingsModal();

  assert.match(harness.elements.migrationNotice.textContent, /Anthropic.*OpenAI-compatible/);
  assert.match(harness.elements.modelDetectNotice.textContent, /無法即時取得模型/);
});

test('stale model discovery cannot update the form after changing endpoint', async () => {
  const oldRequest = deferredResponse(['old-endpoint-model']);
  const newRequest = deferredResponse(['new-endpoint-model']);
  const responses = [oldRequest, newRequest];
  const harness = createHarness({ fetchImpl: () => responses.shift().promise });

  const opening = harness.api.openSettingsModal();
  harness.elements.apiBaseUrl.value = 'https://new.example/v1';
  const latestFetch = harness.api.fetchModelsFromProvider();
  oldRequest.resolve();
  await opening;

  assert.equal(harness.elements.modelSelect.options.some(option => option.value === 'old-endpoint-model'), false);
  assert.match(harness.elements.modelDetectNotice.textContent, /正在從 API 端點取得模型清單/);

  newRequest.resolve();
  await latestFetch;
  assert.equal(harness.elements.apiModel.value, 'new-endpoint-model');
});

test('stale model discovery cannot overwrite a model entered while it was pending', async () => {
  const pending = deferredResponse(['discovered-model']);
  const harness = createHarness({ fetchImpl: () => pending.promise });

  const opening = harness.api.openSettingsModal();
  harness.elements.apiModel.value = 'manually-entered-model';
  pending.resolve();
  await opening;

  assert.equal(harness.elements.apiModel.value, 'manually-entered-model');
  assert.equal(harness.elements.modelSelect.options.some(option => option.value === 'discovered-model'), false);
});

test('editing the manual model invalidates discovery and clears its loading notice', async () => {
  const pending = deferredResponse(['discovered-model']);
  const harness = createHarness({ fetchImpl: () => pending.promise });

  const opening = harness.api.openSettingsModal();
  harness.elements.apiModel.value = 'manual-model';
  harness.api.onManualModelInput();

  assert.doesNotMatch(harness.elements.modelDetectNotice.textContent, /正在從 API 端點取得模型清單/);
  pending.resolve();
  await opening;
  assert.equal(harness.elements.apiModel.value, 'manual-model');
  assert.equal(harness.elements.modelSelect.options.some(option => option.value === 'discovered-model'), false);
});

test('changing the API key immediately invalidates an older discovery result', async () => {
  const pending = deferredResponse(['old-key-model']);
  const harness = createHarness({ fetchImpl: () => pending.promise });

  const opening = harness.api.openSettingsModal();
  harness.elements.apiKey.value = 'new-key';
  harness.api.debouncedFetchModels();

  assert.doesNotMatch(harness.elements.modelDetectNotice.textContent, /正在從 API 端點取得模型清單/);
  pending.resolve();
  await opening;
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

  const opening = harness.api.openSettingsModal();
  const latestRequest = harness.api.fetchModelsFromProvider();
  await opening;

  assert.equal(harness.warnings.length, 0);
  assert.match(harness.elements.modelDetectNotice.textContent, /正在從 API 端點取得模型清單/);
  latest.resolve();
  await latestRequest;
  assert.equal(harness.elements.apiModel.value, 'latest-model');
  assert.equal(harness.warnings.length, 0);
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


test('C2 selected unavailable provider cannot silently route chat through API', async () => {
  for (const providerId of ['unknown', 'toString', '__proto__', 'google-gemini-oauth', 'claude-subscription', 'chatgpt-subscription', 'grok-subscription', 'apple-foundation-models']) {
    let ipc = 0;
    const harness = createHarness({ electronAPI: { providerOperation: async () => { ipc++; return { text: 'wrong route' }; } } });
    await assert.rejects(harness.api.requestProviderChat({ providerId,
      baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'test',
      conversationMessages: [{ role: 'user', content: 'hello' }],
    }), /LLM_PROVIDER_UNAVAILABLE|UNKNOWN_LLM_PROVIDER/);
    assert.equal(ipc, 0, providerId);
    assert.equal(harness.fetchCalls, 0, providerId);
  }
});

test('C2 partial recognized native adapter cannot downgrade credential handling', async () => {
  for (const electronAPI of [ { providerCredentialHas: async () => ({}) }, { subscriptionStatus: async () => ({}) }, { providerOperation: 'not-callable' } ]) {
    const harness = createHarness({ electronAPI, storage: {
      vp_provider: 'openai-compatible', vp_provider_keys: JSON.stringify({ 'openai-compatible': 'fixture-key' }),
      vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
    } });
    await harness.api.openSettingsModal();
    assert.equal(harness.api.getProviderApiKey('openai-compatible'), '');
    await assert.rejects(harness.api.requestProviderChat({ providerId: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'test', conversationMessages: [{ role: 'user', content: 'hello' }],
    }), /LLM_PROVIDER_UNAVAILABLE/);
    assert.equal(harness.fetchCalls, 0);
  }
});

test('C2 blocked saved selections open settings without discovery, fetch, auth or IPC', async () => {
  for (const providerId of ['oauth-pkce', 'google-gemini-oauth', 'claude-subscription', 'copilot-subscription', 'xai-subscription', 'nous-subscription', 'unknown', 'toString', '__proto__', 'chatgpt-subscription', 'grok-subscription', 'apple-foundation-models']) {
    let nativeCalls = 0;
    const called = async () => { nativeCalls += 1; return {}; };
    const harness = createHarness({ storage: {
      vp_provider: providerId,
      vp_verified_provider: providerId,
      vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://billable.example/v1' }),
    }, electronAPI: {
      providerOperation: called, providerCredentialHas: called, providerCredentialSet: called,
      providerCredentialClear: called, startNativeOAuth: called, listSubscriptionModels: called,
    } });
    await harness.api.openSettingsModal();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.localStorage.getItem('vp_provider'), providerId, providerId);
    assert.equal(harness.localStorage.getItem('vp_verified_provider'), null, providerId);
    assert.equal(harness.elements.settingsModal.style.display, 'flex', providerId);
    assert.equal(harness.elements.apiBaseUrl.value, '', providerId);
    assert.equal(harness.fetchCalls, 0, providerId);
    assert.equal(nativeCalls, 0, providerId);
  }
});



test('C2 saving unrelated settings preserves blocked selection instead of reactivating API', async () => {
  for (const providerId of ['unknown', 'toString', '__proto__', 'constructor', 'google-gemini-oauth', 'chatgpt-subscription']) {
    const h = createHarness({ storage: { vp_provider: providerId } });
    await h.api.openSettingsModal();
    await h.api.saveSettings();
    assert.equal(h.localStorage.getItem('vp_provider'), providerId);
    assert.equal(h.localStorage.getItem('vp_baseUrl'), null);
    assert.equal(h.fetchCalls, 0);
  }
});

test('C2 valid API settings persist endpoint model and working connection', async () => {
  const h = createHarness({ fetchImpl: async (_url, options) => ({ ok: true,
    json: async () => options.method === 'GET' ? { data: [{ id: 'model-a' }] } : { choices: [{ message: { content: 'Connection OK' } }] },
  }) });
  await h.api.openSettingsModal();
  h.elements.apiBaseUrl.value = 'https://chosen.example/v1';
  h.elements.apiModel.value = 'model-a';
  await h.api.saveSettings();
  assert.equal(h.localStorage.getItem('vp_provider'), 'openai-compatible');
  assert.equal(h.localStorage.getItem('vp_baseUrl'), 'https://chosen.example/v1');
  assert.equal(h.localStorage.getItem('vp_model'), 'model-a');
  await h.api.openSettingsModal(); // Save privately hid its session; Test is a new visible action.
  await h.api.testApiConnection();
  assert.equal(h.localStorage.getItem('vp_verified_provider'), 'openai-compatible');
  assert.equal(h.fetchRequests.at(-1)[0], 'https://chosen.example/v1/chat/completions');
});

test('C2 retired startup migration cannot activate another stored native credential', async () => {
  let ipc = 0;
  const h = createHarness({ storage: {
    vp_provider: 'google-gemini-oauth', vp_apiKey: 'retired-fixture',
    vp_provider_keys: JSON.stringify({ openai: 'other-fixture', 'google-gemini-oauth': 'old-fixture' }),
  }, electronAPI: { providerCredentialSet: async () => { ipc++; } } });
  h.api.removeRetiredOAuthState();
  await h.api.migrateProviderSettingsForEnvironment();
  assert.equal(ipc, 0);
  assert.equal(h.localStorage.getItem('vp_provider'), 'google-gemini-oauth');
  assert.deepEqual(json(h.localStorage, 'vp_provider_keys'), {});
});

for (const selectedFirst of [true, false]) {
  for (const [label, selected] of [
    ['bound', { key: 'selected-fixture', binding: 'https://api.groq.com/openai/v1/' }],
    ['unbound', { key: 'selected-fixture' }],
    ['absent key', {}], ['empty key', { key: '' }], ['invalid key', { key: {} }],
    ['mismatched binding', { key: 'selected-fixture', binding: 'https://other.example/v1' }],
    ['invalid binding', { key: 'selected-fixture', binding: null }],
    ['invalid URL', { key: 'selected-fixture', url: 'not-a-url' }],
    ['changed URL', { key: 'selected-fixture', url: 'https://other.example/v1', binding: 'https://api.groq.com/openai/v1' }],
    ['selected endpoint mapping', { key: 'selected-fixture', url: 'https://api.openai.com/v1', binding: 'https://api.openai.com/v1' }],
  ]) {
    test(`C2 Desktop selected tuple ${label} wins with selected ${selectedFirst ? 'first' : 'last'} insertion`, async () => {
      const endpoint = selected.url ?? 'https://api.groq.com/openai/v1';
      const tuple = {
        keys: { ...(Object.hasOwn(selected, 'key') ? { groq: selected.key } : {}), 'openai-compatible': 'dormant-fixture' },
        urls: { groq: endpoint, 'openai-compatible': 'https://api.groq.com/openai/v1' },
        models: { groq: 'selected-model', 'openai-compatible': 'dormant-model' },
        key_bindings: { ...(Object.hasOwn(selected, 'binding') ? { groq: selected.binding } : {}), 'openai-compatible': 'https://api.groq.com/openai/v1' },
      };
      const storage = { vp_provider: 'groq' };
      for (const [name, values] of Object.entries(tuple)) {
        const entries = Object.entries(values);
        storage[`vp_provider_${name}`] = JSON.stringify(Object.fromEntries(selectedFirst ? entries : entries.reverse()));
      }
      const writes = [];
      const operations = [];
      const h = createHarness({ storage, electronAPI: {
        providerCredentialSet: async (profile, credential) => { writes.push({ profile, credential }); },
        providerCredentialHas: async () => ({ hasCredential: writes.length > 0 }),
        providerOperation: async payload => { operations.push(payload); return { models: ['selected-model'] }; },
      } });
      await h.api.migrateProviderSettingsForEnvironment();
      const valid = ['bound', 'unbound', 'selected endpoint mapping'].includes(label);
      const profile = label === 'selected endpoint mapping' ? 'openai' : 'groq';
      assert.deepEqual(writes, valid ? [{ profile, credential: 'selected-fixture' }] : [], 'IPC must never inherit the dormant credential');
      assert.equal(h.localStorage.getItem('vp_provider'), 'openai-compatible');
      assert.equal(h.localStorage.getItem('vp_baseUrl'), endpoint);
      assert.equal(h.localStorage.getItem('vp_model'), 'selected-model');
      assert.deepEqual(json(h.localStorage, 'vp_provider_keys'), {});
      assert.deepEqual(json(h.localStorage, 'vp_provider_key_bindings'), {});
      await h.api.openSettingsModal();
      assert.equal(h.elements.apiBaseUrl.value, endpoint);
      assert.equal(h.elements.apiModel.value, 'selected-model');
      if (valid) assert.equal(operations.at(-1).providerId, profile);
      h.localStorage.setItem('vp_provider_urls', JSON.stringify({ 'openai-compatible': 'https://api.groq.com/openai/v1' }));
      await h.api.migrateProviderSettingsForEnvironment();
      await h.api.openSettingsModal();
      assert.deepEqual(writes, valid ? [{ profile, credential: 'selected-fixture' }] : [], 'reopening cannot resurrect a deleted credential');
      assert.equal(h.fetchCalls, 0);
    });
  }
}

for (const desktop of [false, true]) {
  for (const [label, binding] of [
    ['mismatched', 'https://api.groq.com/openai/v1'],
    ['empty', ''], ['null', null], ['object', {}], ['malformed', 'not-a-url'],
  ]) {
    test(`C2 ${desktop ? 'Desktop' : 'Browser'} opening settings permanently discards ${label} legacy binding`, async () => {
      const stored = [];
      const h = createHarness({ storage: {
        vp_provider: 'groq', vp_apiKey: 'selected-fixture',
        vp_provider_keys: JSON.stringify({ groq: 'selected-fixture', 'openai-compatible': 'dormant-fixture' }),
        vp_provider_urls: JSON.stringify({ groq: 'https://other.example/v1', 'openai-compatible': 'https://other.example/v1' }),
        vp_provider_key_bindings: JSON.stringify({ groq: binding, 'openai-compatible': 'https://other.example/v1' }),
        vp_provider_models: JSON.stringify({ groq: 'selected-model', 'openai-compatible': 'dormant-model' }),
      }, ...(desktop ? { electronAPI: {
        providerCredentialSet: async (profile, credential) => { stored.push({ profile, credential }); },
        providerCredentialHas: async () => ({ hasCredential: false }),
        providerOperation: async () => ({ models: ['selected-model'] }),
      } } : {}) });

      await h.api.openSettingsModal();
      assert.equal(h.fetchRequests.some(([, options]) => options?.headers?.Authorization), false);
      assert.deepEqual(json(h.localStorage, 'vp_provider_keys'), {});
      assert.deepEqual(json(h.localStorage, 'vp_provider_key_bindings'), {});
      assert.equal(h.localStorage.getItem('vp_apiKey'), null);
      assert.equal(h.elements.apiModel.value, 'selected-model');
      await h.api.migrateProviderSettingsForEnvironment();
      h.localStorage.setItem('vp_provider_urls', JSON.stringify({ 'openai-compatible': 'https://api.groq.com/openai/v1' }));
      h.localStorage.setItem('vp_baseUrl', 'https://api.groq.com/openai/v1');
      await h.api.openSettingsModal();
      await h.api.migrateProviderSettingsForEnvironment();
      assert.equal(h.api.getProviderApiKey('openai-compatible'), '');
      assert.deepEqual(json(h.localStorage, 'vp_provider_keys'), {});
      assert.deepEqual(json(h.localStorage, 'vp_provider_key_bindings'), {});
      assert.deepEqual(stored, [], 'neither selected nor dormant key reaches native storage after reverting');
      assert.equal(h.fetchRequests.some(([, options]) => options?.headers?.Authorization), false);
      if (desktop) assert.equal(h.fetchCalls, 0);
    });
  }
}

for (const [label, bindings] of [
  ['historically unbound', {}],
  ['validly bound', { groq: 'https://api.groq.com/openai/v1/' }],
]) {
  test(`C2 Browser migrates a ${label} selected legacy credential without using dormant data`, async () => {
    const h = createHarness({ storage: {
      vp_provider: 'groq',
      vp_provider_keys: JSON.stringify({ groq: 'selected-fixture', 'openai-compatible': 'dormant-fixture' }),
      vp_provider_urls: JSON.stringify({ groq: 'https://api.groq.com/openai/v1', 'openai-compatible': 'https://other.example/v1' }),
      vp_provider_key_bindings: JSON.stringify(bindings),
    } });
    await h.api.openSettingsModal();
    assert.equal(h.api.getProviderApiKey('openai-compatible'), 'selected-fixture');
    assert.equal(json(h.localStorage, 'vp_provider_key_bindings')['openai-compatible'], 'https://api.groq.com/openai/v1');
    assert.equal(h.fetchRequests[0][0], 'https://api.groq.com/openai/v1/models');
    assert.equal(h.fetchRequests[0][1].headers.Authorization, 'Bearer selected-fixture');
  });
}

for (const desktop of [false, true]) {
  for (const source of ['scalar', 'map']) {
    test(`C2 cycle2 ${desktop ? 'Desktop' : 'Browser'} init discards ${source} orphan before default URL injection`, async () => {
      const writes = [];
      const h = createHarness({ storage: {
        vp_provider: 'openai-compatible',
        ...(source === 'scalar' ? { vp_apiKey: 'orphan-fixture' }
          : { vp_provider_keys: JSON.stringify({ 'openai-compatible': 'orphan-fixture' }) }),
      }, ...(desktop ? { electronAPI: {
        providerCredentialSet: async (...args) => { writes.push(args); },
        providerCredentialHas: async () => ({ hasCredential: false }),
        providerOperation: async () => ({ models: [] }),
      } } : {}) });
      await h.api.initApp();
      await h.api.openSettingsModal();
      assert.equal(h.localStorage.getItem('vp_baseUrl'), 'http://localhost:8000/v1');
      assert.equal(h.fetchRequests.some(([, options]) => options?.headers?.Authorization), false);
      assert.deepEqual(json(h.localStorage, 'vp_provider_keys'), {});
      assert.deepEqual(json(h.localStorage, 'vp_provider_key_bindings'), {});
      assert.equal(h.localStorage.getItem('vp_apiKey'), null);
      assert.deepEqual(writes, []);
      const reload = createHarness({ storage: Object.fromEntries(h.localStorage.values) });
      await reload.api.initApp();
      await reload.api.openSettingsModal();
      assert.equal(reload.fetchRequests.some(([, options]) => options?.headers?.Authorization), false);
      if (desktop) assert.equal(h.fetchCalls, 0);
    });
  }
}

for (const desktop of [false, true]) {
  for (const provider of ['groq', 'openai-compatible']) {
    for (const raw of ['null', '[]', '{malformed']) {
      for (const entry of ['init', 'settings', 'migration']) {
        test(`C2 cycle2 ${desktop ? 'Desktop' : 'Browser'} ${provider} ${entry} rejects raw binding container ${raw}`, async () => {
          const writes = [];
          const h = credentialLifecycleHarness({
            vp_provider: provider, vp_apiKey: 'selected-scalar-fixture',
            vp_provider_keys: JSON.stringify({ [provider]: 'selected-fixture', openai: 'dormant-fixture' }),
            vp_provider_urls: JSON.stringify({ [provider]: 'https://other.example/v1', openai: 'https://api.openai.com/v1' }),
            vp_provider_key_bindings: raw,
          }, desktop, writes);
          if (entry === 'init') await h.api.initApp();
          if (entry === 'migration') await h.api.migrateProviderSettingsForEnvironment();
          await h.api.openSettingsModal();
          assert.equal(h.fetchRequests.some(([, options]) => options?.headers?.Authorization), false);
          assert.deepEqual(writes, [], 'invalid container must invalidate dormant as well as selected credentials');
          assert.deepEqual(json(h.localStorage, 'vp_provider_keys'), {});
          assert.deepEqual(json(h.localStorage, 'vp_provider_key_bindings'), {});
          assert.equal(h.localStorage.getItem('vp_apiKey'), null);
          // Revert the public endpoint and reload the actual app in a fresh JS context.
          h.localStorage.setItem('vp_provider_urls', JSON.stringify({ 'openai-compatible': 'https://api.groq.com/openai/v1' }));
          h.localStorage.setItem('vp_baseUrl', 'https://api.groq.com/openai/v1');
          const reload = credentialLifecycleHarness(Object.fromEntries(h.localStorage.values), desktop, writes);
          await reload.api.initApp();
          await reload.api.openSettingsModal();
          await reload.api.migrateProviderSettingsForEnvironment();
          assert.equal(reload.fetchRequests.some(([, options]) => options?.headers?.Authorization), false);
          assert.deepEqual(writes, [], 'reversion and later migration cannot reauthorize cleared credentials');
          assert.deepEqual(json(reload.localStorage, 'vp_provider_keys'), {});
          assert.deepEqual(json(reload.localStorage, 'vp_provider_key_bindings'), {});
          assert.equal(reload.localStorage.getItem('vp_apiKey'), null);
          if (desktop) assert.equal(h.fetchCalls + reload.fetchCalls, 0);
        });
      }
    }
    for (const source of ['scalar', 'map']) {
      test(`C2 cycle2 ${desktop ? 'Desktop' : 'Browser'} ${provider} init migrates truly missing binding with persisted ${source} URL`, async () => {
        const endpoint = 'https://api.groq.com/openai/v1';
        const writes = [];
        const h = credentialLifecycleHarness({
          vp_provider: provider,
          ...(source === 'scalar' ? { vp_apiKey: 'selected-fixture', vp_baseUrl: endpoint }
            : { vp_provider_keys: JSON.stringify({ [provider]: 'selected-fixture' }),
                vp_provider_urls: JSON.stringify({ [provider]: endpoint }) }),
        }, desktop, writes);
        await h.api.initApp();
        await h.api.openSettingsModal();
        if (desktop) {
          assert.deepEqual(writes, [{ profile: 'groq', credential: 'selected-fixture' }]);
          assert.equal(h.fetchCalls, 0);
          assert.deepEqual(json(h.localStorage, 'vp_provider_keys'), {});
        } else {
          assert.equal(h.fetchRequests[0][0], `${endpoint}/models`);
          assert.equal(h.fetchRequests[0][1].headers.Authorization, 'Bearer selected-fixture');
          assert.equal(h.api.getProviderApiKey('openai-compatible'), 'selected-fixture');
        }
      });
    }
  }
}

for (const dormant of ['openai', 'openai-compatible']) {
  for (const selectedFirst of [true, false]) {
    for (const endpoint of [
      'https://API.GROQ.COM/openai/v1',
      'https://api.groq.com:443/openai/v1',
      'https://api.groq.com/openai/v1/',
      'https://api.groq.com/openai/v1#settings',
      'https://API.GROQ.COM:443/openai/v1/#settings',
      'not-a-url', 'https://user:pass@api.groq.com/openai/v1',
      'https://api.groq.com/openai/v1?route=other', 'https://custom.example/v1', {}, '',
    ]) {
      for (const [label, selected] of [
        ['absent', {}], ['empty', { key: '' }], ['object', { key: {} }],
        ['mismatch', { key: 'selected-fixture', binding: 'https://other.example/v1' }],
        ['invalid binding', { key: 'selected-fixture', binding: null }],
        ['unbound', { key: 'selected-fixture' }],
        ['bound', { key: 'selected-fixture', binding: 'https://api.groq.com/openai/v1/' }],
      ]) {
        test(`C2 cycle2 canonical selected ${label} ${JSON.stringify(endpoint)} vs ${dormant} selected ${selectedFirst ? 'first' : 'last'}`, async () => {
          const storage = { vp_provider: 'groq' };
          const tuples = {
            keys: { ...(Object.hasOwn(selected, 'key') ? { groq: selected.key } : {}), [dormant]: 'dormant-fixture' },
            urls: { groq: endpoint, [dormant]: 'https://api.groq.com/openai/v1' },
            models: { groq: 'selected-model', [dormant]: 'dormant-model' },
            key_bindings: { ...(Object.hasOwn(selected, 'binding') ? { groq: selected.binding } : {}),
              [dormant]: 'https://api.groq.com/openai/v1' },
          };
          for (const [name, values] of Object.entries(tuples)) {
            const entries = Object.entries(values);
            storage[`vp_provider_${name}`] = JSON.stringify(Object.fromEntries(selectedFirst ? entries : entries.reverse()));
          }
          const writes = [];
          const operations = [];
          const h = credentialLifecycleHarness(storage, true, writes, operations);
          const validEndpoint = typeof endpoint === 'string' && /^https:\/\/api\.groq\.com(?::443)?\/openai\/v1\/?(?:#settings)?$/i.test(endpoint);
          // Any other well-formed http(s) endpoint is the user's own "custom" endpoint.
          const customEndpoint = !validEndpoint && typeof endpoint === 'string' && /^https:\/\/(?!user:)[^\s]+$/.test(endpoint);
          const expected = validEndpoint && ['bound', 'unbound'].includes(label)
            ? [{ profile: 'groq', credential: 'selected-fixture' }]
            : customEndpoint && label === 'unbound' ? [{ profile: 'custom', credential: 'selected-fixture' }] : [];
          await h.api.initApp();
          await h.api.openSettingsModal();
          assert.deepEqual(writes, expected, 'only the validated selected tuple may fill its reserved canonical profile');
          if (expected.length) assert.equal(operations.at(-1)?.providerId, expected[0].profile, 'settings must use the same native profile');
          assert.deepEqual(json(h.localStorage, 'vp_provider_keys'), {});
          assert.deepEqual(json(h.localStorage, 'vp_provider_key_bindings'), {});
          assert.equal(h.localStorage.getItem('vp_apiKey'), null);
          h.localStorage.setItem('vp_provider_urls', JSON.stringify({ 'openai-compatible': 'https://api.groq.com/openai/v1' }));
          h.localStorage.setItem('vp_baseUrl', 'https://api.groq.com/openai/v1');
          const reload = credentialLifecycleHarness(Object.fromEntries(h.localStorage.values), true, writes);
          await reload.api.initApp();
          await reload.api.openSettingsModal();
          assert.deepEqual(writes, expected, 'fresh startup after reverting cannot resurrect a competing tuple');
          assert.equal(h.fetchCalls + reload.fetchCalls, 0);
        });
      }
    }
  }
}

test('v3 Save credential completion cannot commit or hide a reopened same-provider session', async () => {
  let release, entered = false;
  const pending = new Promise(resolve => { release = resolve; });
  const h = createHarness({ storage: {
    vp_provider: 'openai-compatible', vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
  }, electronAPI: {
    providerOperation: async () => ({ models: ['original-model'] }),
    providerCredentialHas: async () => ({ hasCredential: false }),
    providerCredentialSet: async () => { entered = true; await pending; },
  } });
  await h.api.openSettingsModal();
  h.elements.apiKey.value = '[REDACTED]'; h.elements.apiModel.value = 'saved-model';
  h.elements.ttsModeSelect.value = 'system';
  const save = h.api.saveSettings();
  await new Promise(setImmediate); assert.equal(entered, true);
  const reopened = h.api.openSettingsModal();
  h.elements.apiKey.value = '[REDACTED]';
  release(); await Promise.all([save, reopened]);
  assert.equal(await save, false);
  assert.equal(h.elements.settingsModal.style.display, 'flex');
  assert.equal(h.elements.apiKey.value, '[REDACTED]');
  assert.equal(h.localStorage.getItem('vp_ttsMode'), null);
});

// The shipping select has only one AVAILABLE route, even on Apple: no Apple option
// is rendered. A selectable API -> different selectable target credential hold is
// NOT_REACHABLE in this source. Do not invent an option or change same-route Save.
for (const caller of ['testApiConnection']) test('v3 ' + caller + ' stops after stale credential helper and keeps original profile snapshot', async () => {
  let release, entered = 0, chats = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const h = createHarness({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }) },
    electronAPI: { providerCredentialHas: async () => ({}),
      providerCredentialSet: async () => { entered++; await pending; },
      providerOperation: async payload => { if (payload.operation !== 'models') chats++; return { models: ['original'], text: 'Connection OK' }; }
    } });
  await h.api.openSettingsModal();
  h.elements.apiKey.value = '[REDACTED]'; h.elements.apiModel.value = 'original';
  const action = h.api[caller](); await new Promise(setImmediate);
  const admitted = entered;
  const reopened = h.api.openSettingsModal();
  h.elements.apiKey.value = '[REDACTED]';
  release(); await Promise.all([action, reopened]);
  assert.equal(admitted, 1, 'each caller must join the real snapshot helper');
  assert.equal(chats, 0); assert.equal(h.localStorage.getItem('vp_verified_provider'), null);
  assert.equal(h.elements.testConnResult.textContent, '', 'STALE is not permission to publish a connection result');
  assert.equal(h.elements.apiKey.value, '[REDACTED]');
  assert.equal(h.elements.settingsModal.style.display, 'flex');
});

function settingsDeferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const [id, event, value] of [
  ['apiKey', 'input', 'new-fixture'], ['apiBaseUrl', 'input', 'https://api.groq.com/openai/v1'],
  ['apiModel', 'input', 'new-model'], ['modelSelect', 'change', 'new-model'],
  ['ttsModeSelect', 'change', 'system'], ['directApiPreset', 'change', 'custom'],
  ['providerSelect', 'change', 'openai-compatible'],
]) test(`v3 edit ${id} revokes held Save without cancelling accepted credential`, async () => {
  const credential = settingsDeferred(); let writes = 0;
  const h = createHarness({ timerImpl: () => 1, clearTimerImpl() {}, storage: {
    vp_provider: 'openai-compatible', vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }),
  }, electronAPI: { providerCredentialHas: async () => ({}),
    providerCredentialSet: async () => { writes++; await credential.promise; },
    providerOperation: async () => ({ models: ['original'] }),
  } });
  await h.api.openSettingsModal();
  h.elements.apiKey.value = 'accepted-fixture';
  const save = h.api.saveSettings(); await new Promise(setImmediate);
  h.elements[id].value = value;
  let edit;
  try { edit = h.dispatch(id, event); } finally { credential.resolve(); }
  await edit;
  assert.equal(await save, false);
  assert.equal(writes, 1);
  assert.equal(h.localStorage.getItem('vp_ttsMode'), null);
  assert.equal(h.elements.settingsModal.style.display, 'flex');
});

for (const outcome of ['success', 'error']) test(`v3 late Test ${outcome} cannot change reopened result verified or badge`, async () => {
  const chat = settingsDeferred(); const requests = [];
  const h = createHarness({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }) },
    electronAPI: { providerCredentialHas: async () => ({}), providerCredentialSet: async () => {},
      providerOperation: async payload => { requests.push(payload); return payload.operation === 'chat' ? chat.promise : { models: ['original'] }; }
    } });
  await h.api.openSettingsModal();
  const testing = h.api.testApiConnection(); await new Promise(setImmediate);
  assert.equal(requests.filter(x => x.operation === 'chat').length, 1);
  assert.equal(requests.find(x => x.operation === 'chat').model, 'original');
  await h.api.openSettingsModal();
  h.localStorage.setItem('vp_verified_provider', 'new-verification');
  h.elements.testConnResult.textContent = 'new-result';
  outcome === 'success' ? chat.resolve({ text: 'old-reply' }) : chat.reject(new Error('old-error'));
  await testing;
  assert.equal(h.localStorage.getItem('vp_verified_provider'), 'new-verification');
  assert.equal(h.elements.testConnResult.textContent, 'new-result');
});

test('v3 credentialHas is bound to original session and edit', async () => {
  const has = settingsDeferred(); let calls = 0;
  const h = createHarness({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }) },
    electronAPI: { providerCredentialHas: async () => ++calls === 1 ? has.promise : {},
      providerCredentialSet: async () => {}, providerOperation: async () => ({ models: ['original'] }) } });
  await h.api.openSettingsModal(); await h.api.openSettingsModal();
  h.elements.apiKey.placeholder = 'new-session-placeholder';
  has.resolve({ hasCredential: true }); await new Promise(setImmediate);
  assert.equal(h.elements.apiKey.placeholder, 'new-session-placeholder');
});

test('v3 load DOM reentry stops old form writes and discovery', async () => {
  const h = createHarness({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }) } });
  let reopened, value = '', once = true;
  Object.defineProperty(h.elements.apiBaseUrl, 'value', { get: () => value, set(next) {
    value = next;
    if (once) {
      once = false;
      h.localStorage.setItem('vp_provider', 'chatgpt-subscription');
      reopened = h.api.openSettingsModal();
    }
  } });
  await h.api.openSettingsModal(); await reopened;
  assert.equal(h.elements.apiBaseUrl.value, '');
  assert.equal(h.elements.apiModel.value, '');
  assert.match(h.elements.modelDetectNotice.textContent, /阻止自動連線/);
  assert.equal(h.fetchCalls, 0);
});

test('v3 hide abort reentry preserves new discovery controller and session', async () => {
  const requests = []; let reopened;
  const h = createHarness({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://local.example/v1' }) },
    fetchImpl: (_url, options) => {
      const response = settingsDeferred(); const request = { response, signal: options.signal };
      requests.push(request);
      options.signal.addEventListener('abort', () => {
        if (requests.length === 1) reopened = h.api.openSettingsModal();
        response.resolve({ ok: true, json: async () => ({ data: [{ id: 'stale' }] }) });
      });
      return response.promise;
    } });
  const opening = h.api.openSettingsModal();
  await h.api.closeSettingsModal();
  assert.equal(requests.length, 2);
  assert.equal(h.elements.settingsModal.style.display, 'flex');
  const closing = h.api.closeSettingsModal();
  const abortedNew = requests[1].signal.aborted;
  // Settle the owned fake HTTP even on a failing oracle; never leave a waiter.
  requests[1].response.resolve({ ok: true, json: async () => ({ data: [] }) });
  await Promise.all([opening, reopened, closing]);
  assert.equal(abortedNew, true, 'old abort must not erase the new controller slot');
  assert.equal(h.elements.settingsModal.style.display, 'none');
});

test('v3 broker discovery checks original DOM values after credential await', async () => {
  const credential = settingsDeferred(); let models = 0;
  const h = createHarness({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }) },
    electronAPI: { providerCredentialHas: async () => ({}), providerCredentialSet: () => credential.promise,
      providerOperation: async () => { models++; return { models: ['original'] }; } } });
  await h.api.openSettingsModal();
  h.elements.apiKey.value = 'accepted-fixture';
  const discovery = h.api.fetchModelsFromProvider();
  h.elements.apiBaseUrl.value = 'https://api.groq.com/openai/v1';
  h.elements.apiKey.value = 'new-fixture';
  credential.resolve(); await discovery;
  assert.equal(models, 1);
  assert.equal(h.elements.apiKey.value, 'new-fixture');
});

test('v3 Switch captures target before abort reentry and keeps same-provider semantics', async () => {
  const pending = settingsDeferred(); let reentry;
  const h = createHarness({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://local.example/v1' }) },
    fetchImpl: (_url, options) => {
      options.signal.addEventListener('abort', () => {
        h.localStorage.setItem('vp_provider', 'chatgpt-subscription');
        reentry = h.api.openSettingsModal();
        pending.resolve({ ok: true, json: async () => ({ data: [] }) });
      }, { once: true });
      return pending.promise;
    } });
  const opening = h.api.openSettingsModal();
  const switching = h.dispatch('providerSelect', 'change');
  await Promise.all([opening, switching, reentry]);
  assert.equal(h.elements.providerSelect.value, 'chatgpt-subscription');
  assert.match(h.elements.modelDetectNotice.textContent, /阻止自動連線/);
  assert.equal(h.fetchCalls, 1);
});

test('v3 open abort reentry does not resume an obsolete open', async () => {
  const response = settingsDeferred(); let reopened;
  const h = createHarness({ fetchImpl: (_url, options) => {
    options.signal.addEventListener('abort', () => {
      h.localStorage.setItem('vp_provider', 'chatgpt-subscription');
      reopened = h.api.openSettingsModal();
      h.elements.modelDetectNotice.textContent = 'new-open: 阻止自動連線';
      response.resolve({ ok: true, json: async () => ({ data: [] }) });
    });
    return response.promise;
  } });
  const first = h.api.openSettingsModal();
  const second = h.api.openSettingsModal();
  await Promise.all([first, second, reopened]);
  assert.equal(h.elements.modelDetectNotice.textContent, 'new-open: 阻止自動連線');
  assert.equal(h.fetchCalls, 1);
  assert.equal(await h.api.saveSettings(), true, 'the reentrant session remains usable');
});

test('v3 discovery model DOM reentry leaves new session model and notice untouched', async () => {
  const response = settingsDeferred(); let reopened;
  const h = createHarness({ fetchImpl: () => response.promise });
  const opening = h.api.openSettingsModal();
  const replace = h.elements.modelSelect.replaceChildren.bind(h.elements.modelSelect);
  let once = true;
  h.elements.modelSelect.replaceChildren = () => {
    replace();
    if (once) { once = false; h.localStorage.setItem('vp_provider', 'chatgpt-subscription'); reopened = h.api.openSettingsModal(); }
  };
  response.resolve({ ok: true, json: async () => ({ data: [{ id: 'old-model' }] }) });
  await opening; await reopened;
  assert.equal(h.elements.apiModel.value, '');
  assert.equal(h.elements.modelSelect.options.length, 0);
  assert.match(h.elements.modelDetectNotice.textContent, /阻止自動連線/);
});

test('v3 Test result DOM reentry cannot publish into the new session', async () => {
  const h = createHarness({ fetchImpl: async (_url, options) => ({ ok: true,
    json: async () => options.method === 'GET' ? { data: [{ id: 'original' }] } : { choices: [{ message: { content: 'ok' } }] },
  }) });
  await h.api.openSettingsModal();
  let reopened, display, once = true;
  Object.defineProperty(h.elements.testConnResult.style, 'display', { get: () => display, set(value) {
    display = value;
    if (once) { once = false; reopened = h.api.openSettingsModal(); h.elements.testConnResult.textContent = 'new-result'; }
  } });
  await h.api.testApiConnection(); await reopened;
  assert.equal(h.elements.testConnResult.textContent, 'new-result');
  assert.equal(h.fetchRequests.filter(([, o]) => o.method === 'POST').length, 0);
});

test('v3 Save storage reentry stops later selection writes without rollback', async () => {
  const h = createHarness(); await h.api.openSettingsModal();
  const set = h.localStorage.setItem.bind(h.localStorage); let reopened, once = true;
  h.localStorage.setItem = (key, value) => {
    set(key, value);
    if (key === 'vp_provider' && once) { once = false; reopened = h.api.openSettingsModal(); }
  };
  h.elements.ttsModeSelect.value = 'system';
  assert.equal(await h.api.saveSettings(), false); await reopened;
  assert.equal(h.localStorage.getItem('vp_provider'), 'openai-compatible');
  assert.equal(h.localStorage.getItem('vp_ttsMode'), null);
  assert.equal(h.elements.settingsModal.style.display, 'flex');
});

test('v3 queued credential acceptance survives dismissal before its bridge call', async () => {
  const first = settingsDeferred(); const writes = [];
  const h = createHarness({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }) },
    electronAPI: { providerCredentialHas: async () => ({}),
      providerCredentialSet: async (profile, key) => { writes.push([profile, key]); if (writes.length === 1) await first.promise; },
      providerOperation: async () => ({ models: ['original'] }) } });
  await h.api.openSettingsModal();
  const predecessor = h.api.setProviderApiKey('openai-compatible', 'first-fixture', 'https://api.openai.com/v1');
  h.elements.apiKey.value = 'queued-fixture'; h.elements.apiModel.value = 'must-not-commit';
  const save = h.api.saveSettings(); await new Promise(setImmediate);
  assert.deepEqual(writes, [['openai', 'first-fixture']], 'Save is accepted but not yet bridged');
  await h.api.closeSettingsModal();
  const reopened = h.api.openSettingsModal(); h.elements.apiKey.value = 'new-session-fixture';
  first.resolve(); await Promise.all([predecessor, save, reopened]);
  assert.equal(await save, false);
  assert.deepEqual(writes, [['openai', 'first-fixture'], ['openai', 'queued-fixture']]);
  assert.equal(h.elements.apiKey.value, 'new-session-fixture');
  assert.notEqual(h.api.getProviderModel('openai-compatible'), 'must-not-commit');
});

test('v3 no session is STALE and actual blocked to selectable Switch preserves policy', async () => {
  const h = createHarness({ storage: { vp_provider: 'chatgpt-subscription' } });
  assert.equal(await h.api.saveCurrentProviderForm(), 'STALE');
  await h.api.openSettingsModal();
  assert.equal(await h.api.saveCurrentProviderForm(), 'SKIPPED_UNSELECTABLE');
  await h.api.testApiConnection(); assert.equal(h.fetchCalls, 0);
  h.elements.providerSelect.value = 'openai-compatible';
  await h.dispatch('providerSelect', 'change');
  assert.equal(await h.api.saveCurrentProviderForm(), 'SAVED');
  assert.equal(h.localStorage.getItem('vp_provider'), 'chatgpt-subscription', 'Switch does not commit selection');
});

for (const [id, value] of [['directApiPreset', 'gemini'], ['modelSelect', 'stale-model']])
test(`v3 edit abort ${id} does not write after reopen`, async () => {
  const response = settingsDeferred(); let reopened;
  const h = createHarness({ fetchImpl: (_url, options) => {
    options.signal.addEventListener('abort', () => {
      h.localStorage.setItem('vp_provider', 'chatgpt-subscription');
      reopened = h.api.openSettingsModal();
      response.resolve({ ok: true, json: async () => ({ data: [] }) });
    }); return response.promise;
  } });
  const opening = h.api.openSettingsModal(); h.elements[id].value = value;
  await h.dispatch(id, 'change'); await Promise.all([opening, reopened]);
  assert.equal(h.elements.apiBaseUrl.value, '');
  assert.equal(h.elements.apiModel.value, '');
  assert.match(h.elements.modelDetectNotice.textContent, /阻止自動連線/);
});

test('v3 Save badge reentry keeps new badge and visible session', async () => {
  const h = createHarness(); await h.api.openSettingsModal();
  // Ensure nodes exist without replacing the actual product badge body.
  h.elements.headerConnText = { style: {}, textContent: '' };
  h.elements.headerConnDot = { style: { background: '' } };
  let reopened, text = '', once = true;
  Object.defineProperty(h.elements.headerConnText, 'textContent', { get: () => text, set(value) {
    text = value;
    if (once) { once = false; reopened = h.api.openSettingsModal(); h.elements.headerConnDot.style.background = 'new-badge'; }
  } });
  await h.api.saveSettings(); await reopened;
  assert.equal(h.elements.headerConnDot.style.background, 'new-badge');
  assert.equal(h.elements.settingsModal.style.display, 'flex');
});

test('C2 legacy selected API route cannot be replaced by dormant unified endpoint', () => {
  const h = createHarness({ storage: {
    vp_provider: 'groq',
    vp_provider_keys: JSON.stringify({ groq: 'selected-fixture', 'openai-compatible': 'dormant-fixture' }),
    vp_provider_urls: JSON.stringify({ groq: 'https://api.groq.com/openai/v1', 'openai-compatible': 'https://unselected.example/v1' }),
    vp_provider_models: JSON.stringify({ groq: 'selected-model', 'openai-compatible': 'dormant-model' }),
  } });
  h.api.migrateLegacyDirectProviderSettings();
  assert.equal(h.localStorage.getItem('vp_baseUrl'), 'https://api.groq.com/openai/v1');
  assert.equal(h.localStorage.getItem('vp_model'), 'selected-model');
  assert.equal(h.api.getProviderApiKey('openai-compatible'), 'selected-fixture');
});
