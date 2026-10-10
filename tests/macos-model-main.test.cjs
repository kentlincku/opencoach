'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const mainPath = path.resolve(__dirname, '../apps/desktop/main.cjs');
const realRequire = createRequire(mainPath);
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plain = value => JSON.parse(JSON.stringify(value));

// Actual Main with Electron/dialog/manager boundaries doubled. No real child,
// model download, renderer or native authority is claimed by these unit tests.
function harness(options = {}) {
  const handlers = new Map(), dialogs = [], installs = [], cancellations = [], statusCalls = [];
  const trace = { prepared: 0, hybrid: 0, legacy: 0, clients: [], catalogReads: 0, catalogHosts: [] };
  const nativeRuntime = Object.freeze({ command: '/fixture/App/voice-assets/runtime/bin/voice-runtime' });
  const lease = { command: nativeRuntime.command, tempRoot: '/fixture/private/temp', cacheRoot: '/fixture/private/cache',
    trustedVoice: { VOICE_TTS_BACKEND: 'kokoro-onnx', VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu',
      ...(options.platform === 'win32' ? { VOICE_STT_BACKEND: 'faster-whisper', VOICE_FASTER_WHISPER_DEVICE: 'cpu',
        VOICE_FASTER_WHISPER_COMPUTE_TYPE: 'int8', VOICE_ACCELERATOR: 'cpu', VOICE_FASTER_WHISPER_MODEL: '/fixture/private/models/whisper' }
        : { VOICE_STT_BACKEND: 'mlx-whisper', VOICE_MLX_WHISPER_MODEL: '/fixture/private/models/whisper' }), VOICE_KOKORO_ONNX_MODEL: '/fixture/private/models/model.onnx', VOICE_KOKORO_ONNX_VOICES: '/fixture/private/models/voices.bin' },
    work: Promise.resolve(), cancel() {}, verify: async () => true, release: async () => {} };
  class MemoryClient {
    constructor(config) { this.config = config; this.clientId = 'memory-client'; trace.clients.push(this); }
    async start() { await this.config.beforeSpawn?.(); }
    async cancel() {}
  }
  const id = 'fixture-whisper';
  const model = { name: 'Fixture Whisper', purpose: 'STT fixture', license: { spdx: 'MIT', url: 'https://example.com/license' },
    artifacts: { 'darwin-arm64': { bytes: 100, provenance: { license: { spdx: 'MIT' } } } } };
  const models = {
    options: { platform: 'darwin', arch: 'arm64' },
    manifest: { release: 'fixture-1', models: { [id]: model } },
    list: () => [{ id, name: model.name, purpose: model.purpose, license: model.license }],
    status: async modelId => { statusCalls.push(modelId); return { state: 'unavailable' }; },
    install: (modelId, onProgress) => {
      const completion = gate(), entered = { modelId, onProgress, completion };
      installs.push(entered); options.entered?.resolve(entered);
      return completion.promise;
    },
    cancel: modelId => cancellations.push(modelId),
  };
  const runtime = { status: async () => ({ state: 'unavailable' }), manifest: { release: 'unpublished', artifacts: {} } };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), getPath: () => options.userData || path.dirname(mainPath),
    getAppPath: () => path.resolve(__dirname, '..'), quit() {},
  });
  class MemoryMenu {
    constructor(items = []) { this.items = items.map(item => ({ ...item })); }
    append(item) { this.items.push(item); }
    static buildFromTemplate(items) { return new MemoryMenu(items); }
    static getApplicationMenu() { return this.current || null; }
    static setApplicationMenu(menu) { this.current = menu; }
  }
  const electron = { app, BrowserWindow: class {}, Menu: MemoryMenu, MenuItem: class { constructor(value) { Object.assign(this, value); } },
    ipcMain: { handle: (key, handler) => handlers.set(key, handler) }, safeStorage: {}, shell: {},
    dialog: { showMessageBox: config => { dialogs.push(config); return options.consent ? options.consent(config) : Promise.resolve({ response: 1 }); }, showErrorBox() {} },
  };
  const trust = options.trust === undefined ? { schemaVersion: 2, mode: 'runtime-only', runtimeProfile: 'macos-mlx-kokoro-v1',
    modelBindings: { sttRoot: {modelId:id}, onnxModel: {modelId:id}, onnxVoices: {modelId:id} } } : options.trust;
  const context = vm.createContext({
    require: name => name === 'electron' ? electron
      : options.bootstrap && name === './runtime-manager.cjs' ? { RuntimeManager: class { constructor() { return runtime; } } }
      : options.bootstrap && name === './model-manager.cjs' ? { ModelManager: class { constructor() { return models; } } }
      : options.bootstrap && name === './macos-model-catalog.cjs' ? { parseNativeModelCatalogFor: (host, input, root, manifest) => { trace.catalogHosts.push(host); assert.equal(root, trust); assert.equal(manifest, models.manifest); trace.catalogReads++; return input; } }
      : name === './bundled-voice-assets.cjs' ? { ...realRequire(name), loadTrust: () => trust,
        ...(options.hybrid ? { prepareBundledRuntimeAssets: async () => { trace.prepared++; return nativeRuntime; }, authenticatedBundledRuntimeSource: source => source === nativeRuntime ? { authority: 'COMPILED_ROOT' } : null } : {}) }
      : options.hybrid && name === './managed-asset-lease.cjs' ? { ...realRequire(name),
        prepareHybridVoiceAssets: (source, manager) => { assert.equal(source, nativeRuntime); assert.equal(manager, models); trace.hybrid++; return lease; },
        bindClientAssets: () => ({ beforeSpawn: async () => true, retire() {}, release: async () => {} }) }
      : options.hybrid && name === './sidecar-client.cjs' ? { SidecarClient: MemoryClient }
      : name === './speech-model-selection.cjs' ? {
        ...realRequire(name),
        // JSON wire inputs are ordinary objects in production's single realm.
        selectSpeechModel: (caps, opts) => realRequire(name).selectSpeechModel(plain(caps), plain(opts)),
      } : realRequire(name),
    __dirname: path.dirname(mainPath), Buffer, URL, JSON, AbortController, setTimeout, clearTimeout,
    process: { argv: ['node'], env: {}, platform: options.platform || 'darwin', arch: options.platform === 'win32' ? 'x64' : 'arm64', pid: process.pid, resourcesPath: path.dirname(mainPath) },
    console: { log() {}, error() {}, warn() {} },
  });
  const source = fs.readFileSync(mainPath, 'utf8') + `\nglobalThis.api = {
    hasOverview: () => typeof nativeModelOverview === 'function',
    overview: () => nativeModelOverview(),
    refresh: () => refreshNativeModelStates(),
    install: id => requestInstallation('model', {modelId:id}),
    cancelAction: payload => cancelNativeModelInstallAction(payload),
    setManagers(r,m) { runtimeManager=r; modelManager=m; },
    setCatalog(c) { nativeModelCatalog=c; },
    setNativeSource(s) { hybridRuntimeSource=s; },
    cache(id,value) { nativeModelStates.set(id,value); },
    activate(id) { hybridActiveModelIds.add(id); hybridBoundModelIds.add(id); },
    bindOnly(id) { hybridBoundModelIds.add(id); },
    setupMenu() { applicationStartupComplete=true; setupInstallationMenu(); return installationMenu.items; },
    initializeAssetManagers,
    overrideReaders(manifestReader,jsonReader) { readBundledAssetManifest=manifestReader; readBundledAssetJson=jsonReader; },
    launchPackagedRuntime,
    overrideLegacy(fn) { launchBundledRuntime=fn; },
    registerIpc,
    selectStt: payload => selectSttModel(payload),
    removeModel: payload => removeNativeModel(payload),
    setInstalling(value) { installationAction = value; },
  };`;
  vm.runInContext(source, context);
  const api = context.api;
  api.setManagers(runtime, models);
  const capabilities = { schemaVersion: 1, platformKey: 'darwin-arm64', runtimeProfile: 'macos-mlx-kokoro-v1', enabledLanguages: ['en'], models: [
    { id, kind: 'stt', backend: 'mlx-whisper', format: 'mlx', languages: ['en'], runtimeProfiles: ['darwin-arm64'] },
  ] };
  api.setCatalog(capabilities);
  return { api, id, models, runtime, capabilities, installs, cancellations, dialogs, statusCalls, handlers, trace, nativeRuntime };
}

test('an embedded runtime is not presented as a missing downloadable runtime in the native menu', () => {
  for (const trust of [{ schemaVersion: 1 }, { schemaVersion: 2, mode: 'runtime-only' }]) {
    const h = harness({ trust });
    const items = h.api.setupMenu(), runtime = items.find(item => item.id === 'asset-runtime');
    assert.match(runtime.label, /內建/, 'the App-owned runtime must not request a separate download');
    assert.equal(runtime.enabled, false);
    assert.doesNotMatch(items.find(item => item.id === 'asset-status').label, /尚未安裝/);
  }
  const legacy = harness({ trust: null }).api.setupMenu().find(item => item.id === 'asset-runtime');
  assert.match(legacy.label, /安裝原生執行環境/);
});

test('runtime-only initialization verifies the capability catalog and checks installed state once', async () => {
  const h = harness({ bootstrap: true });
  h.api.setCatalog(null);
  const requested = [];
  h.api.overrideReaders(async name => name === 'runtime-manifest.json' ? h.runtime.manifest : h.models.manifest,
    async name => { requested.push(name); return h.capabilities; });
  await h.api.initializeAssetManagers();
  assert.deepEqual(requested, ['speech-model-capabilities.json']);
  assert.equal(h.trace.catalogReads, 1);
  assert.deepEqual(h.statusCalls, [h.id]);
  assert.equal(h.api.overview().models.length, 1);
  assert.equal(h.installs.length, 0);
});

test('runtime-only Main launch selects hybrid model preparation and the embedded executable', async () => {
  const h = harness({ hybrid: true });
  h.api.overrideLegacy(async () => { h.trace.legacy++; });
  h.api.cache(h.id, { state: 'installed' });
  await h.api.launchPackagedRuntime();
  assert.equal(h.trace.legacy, 0, 'runtime-only mode must not enter the legacy full-bundle path');
  assert.equal(h.trace.prepared, 1);
  assert.equal(h.trace.hybrid, 1);
  assert.equal(h.trace.clients.length, 1);
  assert.equal(h.trace.clients[0].config.command, h.nativeRuntime.command);
  assert.equal(h.trace.clients[0].config.nativeRuntime, h.nativeRuntime);
  assert.equal(h.trace.clients[0].config.lifetimePurpose, 'hybrid-speech');
  assert.equal(h.api.overview().models[0].state, 'active');
});

test('missing models do not spawn a speech process or start an implicit download', async () => {
  const h = harness({ hybrid: true });
  h.api.overrideLegacy(async () => { h.trace.legacy++; });
  await assert.rejects(h.api.launchPackagedRuntime(), /NATIVE_MODELS_NOT_INSTALLED/);
  assert.equal(h.trace.clients.length, 0);
  assert.equal(h.trace.hybrid, 0);
  assert.equal(h.installs.length, 0);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.api.overview().runtime.state, 'embedded');
});

test('Main registers model overview and action-specific cancellation through trusted IPC', () => {
  const h = harness();
  h.api.registerIpc();
  assert.equal(h.handlers.has('models:overview'), true, 'model overview must be a trusted Main IPC handler');
  assert.equal(h.handlers.has('models:cancel-action'), true);
});

test('Main model overview reads cached projections without implicit download or repeated hashing', async () => {
  const h = harness();
  assert.equal(h.api.hasOverview(), true, 'Main must expose a cached native model overview');
  h.api.setNativeSource({ command: '/fixture/runtime/bin/voice-runtime' });
  await h.api.refresh();
  const first = plain(h.api.overview());
  assert.equal(first.version, 1);
  assert.equal(first.mode, 'runtime-only');
  assert.equal(first.runtime.state, 'embedded');
  assert.equal(first.models[0].kind, 'stt');
  assert.equal(first.models[0].state, 'missing');
  assert.equal(first.models[0].bytes, 100);
  assert.equal(first.models[0].canRemove, false);
  h.api.overview(); h.api.overview();
  assert.deepEqual(h.statusCalls, [h.id], 'polling never re-hashes model files');
  assert.equal(h.installs.length, 0);
  assert.equal(h.dialogs.length, 0);
  assert.equal(JSON.stringify(first).includes('/fixture'), false, 'projection does not expose local paths');
});

test('a legacy full bundle is displayed without requiring model download', () => {
  const h = harness({ trust: { schemaVersion: 1 } });
  assert.equal(h.api.hasOverview(), true);
  const value = plain(h.api.overview());
  assert.equal(value.mode, 'bundled');
  assert.equal(value.runtime.state, 'embedded');
  assert.deepEqual(value.models, []);
  assert.equal(h.installs.length, 0);
});

test('installation progress is bound to its original action and commits require full restart', async () => {
  const entered = gate(), h = harness({ entered });
  assert.equal(h.api.hasOverview(), true);
  const work = h.api.install(h.id);
  const original = await entered.promise;
  assert.equal(typeof original.onProgress, 'function', 'Main binds progress to the original installation action');
  original.onProgress({ modelId: h.id, bytes: 40, total: 100, phase: 'downloading' });
  const action = h.api.overview().installation;
  assert.match(action.actionId, /^[0-9a-f-]{36}$/);
  assert.equal(action.bytes, 40);
  assert.equal(action.phase, 'downloading');
  original.completion.resolve({ state: 'installed', generation: 'fixture-g1', restartRequired: true });
  await work;
  const installed = plain(h.api.overview());
  assert.equal(installed.models[0].state, 'installed');
  assert.equal(installed.restartRequired, true);
  assert.equal(installed.installation.phase, 'installed');
  original.onProgress({ modelId: h.id, bytes: 5, total: 100 });
  assert.equal(h.api.overview().installation.phase, 'installed', 'late progress does not rewrite the committed result');
});

test('action-specific cancellation cannot cancel a successor with the same model ID', async () => {
  const entered = gate(), h = harness({ entered });
  assert.equal(h.api.hasOverview(), true);
  const firstWork = h.api.install(h.id), first = await entered.promise;
  const firstId = h.api.overview().installation.actionId;
  first.completion.resolve({ state: 'installed', generation: 'fixture-g1', restartRequired: true });
  await firstWork;
  const secondEntered = gate();
  const originalInstall = h.models.install;
  h.models.install = (...args) => { const work = originalInstall(...args); secondEntered.resolve(h.installs.at(-1)); return work; };
  const secondWork = h.api.install(h.id), second = await secondEntered.promise;
  const secondId = h.api.overview().installation.actionId;
  assert.notEqual(firstId, secondId);
  assert.deepEqual(plain(h.api.cancelAction({ actionId: firstId })), { cancelled: false });
  assert.equal(h.cancellations.length, 0);
  assert.deepEqual(plain(h.api.cancelAction({ actionId: secondId })), { cancelled: true });
  assert.deepEqual(h.cancellations, [h.id]);
  assert.equal(h.api.overview().installation.phase, 'cancelling');
  assert.throws(() => h.api.cancelAction({ actionId: secondId, modelId: h.id }), /INVALID_MODEL_ACTION/);
  second.completion.resolve({ cancelled: true });
  await secondWork;
  assert.equal(h.api.overview().installation.phase, 'cancelled');
});

// Windows W1 (CPU): same Main paths, Windows tuple. MEMORY doubles only.
function windowsHarness(options = {}) {
  const h = harness({ platform: 'win32', ...options });
  return h;
}

test('Windows runtime-only initialization verifies the catalog through the win32 parser', async () => {
  const h = windowsHarness({ bootstrap: true, trust: { schemaVersion: 2, mode: 'runtime-only', runtimeProfile: 'windows-ct2-kokoro-cpu-v1',
    modelBindings: { sttRoot: { modelId: 'fixture-whisper' }, onnxModel: { modelId: 'fixture-whisper' }, onnxVoices: { modelId: 'fixture-whisper' } } } });
  h.api.setCatalog(null);
  h.api.overrideReaders(async name => name === 'runtime-manifest.json' ? h.runtime.manifest : h.models.manifest, async () => h.capabilities);
  await h.api.initializeAssetManagers();
  assert.deepEqual(h.trace.catalogHosts, ['win32']);
  assert.equal(h.trace.catalogReads, 1);
});

test('Windows runtime-only launch uses the hybrid CPU environment and the embedded .exe', async () => {
  const h = windowsHarness({ hybrid: true });
  h.api.overrideLegacy(async () => { h.trace.legacy++; });
  h.api.cache(h.id, { state: 'installed' });
  await h.api.launchPackagedRuntime();
  assert.equal(h.trace.legacy, 0);
  assert.equal(h.trace.hybrid, 1);
  const env = h.trace.clients[0].config.env;
  assert.equal(env.VOICE_ACCELERATOR, 'cpu');
  assert.equal(env.VOICE_FASTER_WHISPER_DEVICE, 'cpu');
  assert.equal(env.VOICE_FASTER_WHISPER_COMPUTE_TYPE, 'int8');
  assert.equal(h.trace.clients[0].config.lifetimePurpose, 'hybrid-speech');
});

test('Windows overview names its platform; macOS overview stays darwin', async () => {
  const w = windowsHarness();
  w.api.setNativeSource({ command: 'C:\\fixture\\voice-runtime.exe' });
  assert.equal(plain(w.api.overview()).platform, 'win32');
  assert.equal(plain(harness().api.overview()).platform, 'darwin');
  const items = windowsHarness({ trust: { schemaVersion: 2, mode: 'runtime-only' } }).api.setupMenu();
  const runtime = items.find(item => item.id === 'asset-runtime');
  assert.match(runtime.label, /內建/);
  assert.equal(runtime.enabled, false);
});

// ---- STT model choice (Main side) ----
function choiceHarness(t, extra = {}) {
  const os = require('node:os');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-main-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const h = harness({ userData, ...extra });
  const ids = ['w-tiny', 'w-base', 'w-small', 'w-turbo'];
  const sttModel = id => ({ name: id, purpose: 'STT', license: { spdx: 'MIT', url: 'https://example.com/l' },
    artifacts: { 'darwin-arm64': { bytes: 10 } } });
  h.models.manifest.models = { ...Object.fromEntries(ids.map(id => [id, sttModel(id)])),
    kokoro: { ...sttModel('kokoro'), name: 'Kokoro' } };
  const removed = [];
  h.models.active = new Map();
  h.models.remove = async (id, { protectedIds }) => {
    if (protectedIds.includes(id)) throw new Error('MODEL_IN_USE');
    removed.push(id); return { removed: true };
  };
  h.api.setCatalog({ platformKey: 'darwin-arm64', enabledLanguages: ['en'], sttChoices: ids, defaultSttModelId: 'w-turbo',
    models: [...ids.map(id => ({ id, kind: 'stt', languages: ['en'] })), { id: 'kokoro', kind: 'tts', languages: ['en'] }] });
  for (const id of [...ids, 'kokoro']) h.api.cache(id, { state: 'installed', generation: null });
  return { ...h, userData, ids, removed };
}

test('overview exposes four tiers, default selection and a Main-computed recommendation', t => {
  const h = choiceHarness(t);
  const view = h.api.overview();
  // Unset: the device recommendation is the selection (spec), not the catalog default.
  assert.equal(view.stt.source, 'default');
  assert.equal(view.stt.selectedModelId, view.stt.recommendedModelId);
  assert.equal(view.stt.preferenceError, null);
  const stt = view.models.filter(m => m.kind === 'stt');
  assert.deepEqual(stt.map(m => m.tier), ['ultrafast', 'fast', 'balanced', 'accurate']);
  assert.equal(stt.filter(m => m.selected).length, 1);
  assert.ok(stt.find(m => m.selected).recommended);
  assert.equal(stt.filter(m => m.recommended).length, 1);
  assert.equal(typeof view.stt.recommendationReason, 'string');
});

test('selecting a tier persists per language in userData, requires restart, and rejects unlisted ids', t => {
  const h = choiceHarness(t);
  h.api.activate('w-turbo'); // sidecar currently runs w-turbo
  const view = h.api.selectStt({ modelId: 'w-base' });
  assert.equal(view.stt.selectedModelId, 'w-base');
  assert.equal(view.stt.source, 'preference');
  assert.equal(view.restartRequired, true);
  const saved = JSON.parse(fs.readFileSync(path.join(h.userData, 'stt-model-preference.json'), 'utf8'));
  assert.deepEqual(saved, { schemaVersion: 1, stt: { en: 'w-base' } });
  assert.equal(h.api.selectStt({ modelId: 'w-turbo' }).restartRequired, false, 'choosing the running model clears the selection restart');
  assert.throws(() => h.api.selectStt({ modelId: 'kokoro' }), /STT_MODEL_NOT_ALLOWED/);
  assert.throws(() => h.api.selectStt({ modelId: 'evil' }), /STT_MODEL_NOT_ALLOWED/);
  assert.throws(() => h.api.selectStt({ modelId: 'w-base', extra: 1 }), /INVALID_MODEL_REQUEST/);
  assert.throws(() => h.api.selectStt('w-base'), /INVALID_MODEL_REQUEST/);
});

test('a choice made while the runtime is still starting is compared with what this launch bound', t => {
  const h = choiceHarness(t);
  h.api.bindOnly('w-small'); // launch bound w-small; sidecar not ready yet (nothing active)
  assert.equal(h.api.selectStt({ modelId: 'w-tiny' }).restartRequired, true);
  assert.equal(h.api.selectStt({ modelId: 'w-small' }).restartRequired, false);
});

test('with no runtime launched, any explicit choice needs a full relaunch', t => {
  const h = choiceHarness(t);
  assert.equal(h.api.selectStt({ modelId: 'w-tiny' }).restartRequired, true);
});

test('an invalid preference file is reported in the overview and repaired only by an explicit choice', t => {
  const h = choiceHarness(t);
  fs.writeFileSync(path.join(h.userData, 'stt-model-preference.json'), '{broken');
  const view = h.api.overview();
  assert.equal(view.stt.preferenceError, 'STT_PREFERENCE_INVALID');
  assert.equal(view.stt.selectedModelId, null);
  assert.equal(h.api.selectStt({ modelId: 'w-small' }).stt.selectedModelId, 'w-small');
});

test('remove: only installed, unselected, inactive STT tiers; TTS and selected or active models are protected', async t => {
  const h = choiceHarness(t);
  h.api.selectStt({ modelId: 'w-base' });
  h.api.activate('w-turbo');
  const view = h.api.overview();
  const can = Object.fromEntries(view.models.map(m => [m.modelId, m.canRemove]));
  assert.deepEqual(can, { 'w-tiny': true, 'w-base': false, 'w-small': true, 'w-turbo': false, kokoro: false });
  for (const id of ['w-base', 'w-turbo', 'kokoro']) await assert.rejects(h.api.removeModel({ modelId: id }), /MODEL_IN_USE/);
  const result = await h.api.removeModel({ modelId: 'w-tiny' });
  assert.equal(result.removed, true);
  assert.deepEqual(h.removed, ['w-tiny']);
  assert.equal(result.overview.models.find(m => m.modelId === 'w-tiny').state, 'missing');
  await assert.rejects(h.api.removeModel({ modelId: 'unknown' }), /UNKNOWN_MODEL/);
  h.api.setInstalling({ kind: 'model' });
  assert.equal(h.api.overview().models.every(m => m.canRemove === false), true, 'no removal while installing');
  await assert.rejects(h.api.removeModel({ modelId: 'w-small' }), /INSTALL_ALREADY_RUNNING/);
});

test('Main registers select-stt and remove through trusted IPC', () => {
  const h = harness();
  h.api.registerIpc();
  assert.ok(h.handlers.has('models:select-stt'));
  assert.ok(h.handlers.has('models:remove'));
});

test('a removal that fails part-way re-reads model state instead of keeping a stale installed view', async t => {
  const h = choiceHarness(t);
  h.models.remove = async () => { throw new Error('CLEANUP_UNSAFE_PATH'); };
  let reads = 0;
  h.models.status = async () => { reads++; return { state: 'unavailable' }; };
  await assert.rejects(h.api.removeModel({ modelId: 'w-tiny' }), /CLEANUP_UNSAFE_PATH/);
  assert.ok(reads > 0);
  assert.equal(h.api.overview().models.find(m => m.modelId === 'w-tiny').state, 'missing');
});
