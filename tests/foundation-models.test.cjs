const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const mainPath = path.resolve(__dirname, '../apps/desktop/main.cjs');
const realRequire = createRequire(mainPath);
async function mainHarness(platform = 'linux', Service) {
  const handlers = new Map(); let window;
  const app = Object.assign(new EventEmitter(), { isPackaged: false, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), getAppPath: () => path.dirname(path.dirname(__dirname)),
    quit() { this.emit('before-quit', { preventDefault() {} }); } });
  class Window extends EventEmitter {
    constructor() { super(); window = this; this.webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, session: { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, setPermissionRequestHandler() {} }, setWindowOpenHandler() {},
    }); }
    async loadFile(file) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href; }
  }
  const context = vm.createContext({ require: name => {
    if (name === 'electron') return { app, BrowserWindow: Window, ipcMain: { handle: (id, fn) => handlers.set(id, fn) }, safeStorage: {}, shell: {} };
    if (name === './runtime-manager.cjs') return { RuntimeManager: class {} };
    if (name === './model-manager.cjs') return { ModelManager: class {} };
    if (name === './foundation-models-service.cjs' && Service) return { FoundationModelsService: Service };
    return realRequire(name);
  }, __dirname: path.dirname(mainPath), Buffer, URL, setTimeout, clearTimeout, console,
  process: { ...process, platform, arch: 'arm64', argv: [], env: {} } });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8') + '\nglobalThis.entry = { createWindow, registerIpc };', context);
  await context.entry.createWindow(); context.entry.registerIpc();
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { handlers, window, app, context, invoke: (id, payload, ev = event()) => handlers.get(id)(ev, payload), event };
}

test('FM02 actual Main → preload → ElectronRuntime → controlled child returns correlated text', async t => {
  const baseline = await mainHarness('darwin');
  assert.equal(typeof baseline.handlers.get('foundation-models:generate'), 'function');
  const { FoundationModelsService } = realRequire('./foundation-models-service.cjs');
  const { FoundationModelsClient } = realRequire('./foundation-models-client.cjs');
  const children = [];
  const client = new FoundationModelsClient({ resolveLaunch: async () => ({ command: process.execPath,
    args: [path.join(__dirname, 'fixtures/foundation-models-child.cjs')], env: {} }),
    spawnImpl: (...args) => { const child = require('node:child_process').spawn(...args); children.push(child); return child; } });
  class Service extends FoundationModelsService { constructor(config) { super({ ...config, client }); } }
  const h = await mainHarness('darwin', Service);
  t.after(async () => { await client.shutdown(); for (const child of children) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }); });
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../apps/desktop/preload.cjs'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
    ipcRenderer: { invoke: (id, value) => Promise.resolve().then(() => h.invoke(id, value)) },
  }) });
  assert.equal(typeof bridge.foundationModelsGenerate, 'function');
  const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
  const runtime = new ElectronRuntime({ api: bridge, capabilities: { ready: false } });
  const cap = await runtime.foundationModelsCapabilities();
  assert.equal(cap.platform, 'macos'); assert.equal(cap.state, 'available');
  const result = await runtime.generate({ messages: [{ role: 'system', content: 'Teach English.' }, { role: 'user', content: 'Hello' }], maxTokens: 32 });
  assert.equal(result.text, 'Controlled English reply.'); assert.equal(children.length, 1);
  assert.equal((await runtime.generate({ messages: [{ role: 'user', content: 'Again' }], maxTokens: 32 })).text, result.text);
});

test('FM03 shared settings and actual chat route Apple through runtime, never API alias', async () => {
  const contract = require('../apps/web/runtime/llm-provider-contract.js');
  assert.equal(contract.getProviderState('apple-foundation-models', { platform: 'macos', platformLocalProviders: ['apple-foundation-models'] }), 'AVAILABLE');
  const { settingsUi } = require('./fixtures/desktop-voice-stop-harness.cjs');
  let calls = 0, apiCalls = 0;
  const cap = { protocol: 1, platform: 'macos', state: 'available', reason: 'available', sessionId: 'owned-session' };
  const bridge = { foundationModelsCapabilities: async () => cap, foundationModelsGenerate: async () => {}, foundationModelsCancel: async () => {},
    providerOperation: async () => { apiCalls++; throw Error('API_MUST_NOT_RUN'); } };
  const page = settingsUi({ storage: { vp_provider: 'apple-foundation-models' }, electronAPI: bridge });
  page.context.voiceRuntime = { foundationModelsCapabilities: async () => cap,
    generate: async payload => { calls++; assert.equal(payload.messages[0].content, 'Hi'); return { text: 'Native route.' }; } };
  await page.run('refreshFoundationModelsCapability()');
  await page.api.openSettingsModal();
  assert.equal(page.elements.providerSelect.value, 'apple-foundation-models');
  assert.equal(page.elements.providerSelect.options.find(o => o.value === 'apple-foundation-models').disabled, false);
  assert.equal(page.elements.apiKeyGroup.style.display, 'none');
  assert.equal(page.elements.apiBaseUrl.disabled, true);
  assert.equal(await page.api.requestProviderChat({ providerId: 'apple-foundation-models', conversationMessages: [{ role: 'user', content: 'Hi' }] }), 'Native route.');
  assert.equal(calls, 1); assert.equal(apiCalls, 0); assert.equal(page.fetchCalls, 0);
});

test('FM04 Mac package hook rebuilds the fixed first-party helper; never runs Apple compiler on Linux/Windows', async t => {
  const config = fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8');
  assert.match(config, /beforePack: scripts\/build-foundation-models.cjs/);
  const { buildHelper } = require('../scripts/build-foundation-models.cjs');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fm-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'native/apple'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../native/apple/FoundationModelsHelper.swift'), path.join(root, 'native/apple/FoundationModelsHelper.swift'));
  // Engineering build is now asynchronous and existing-CLT-only. Positive
  // compilation/receipt and preserved failure bytes execute in FE03/FE05;
  // do not resurrect the old untested execFileSync/xcrun replacement seam.
  for (const platform of ['linux', 'win32']) await assert.rejects(buildHelper({ platform, root }), /MAC_BUILD_REQUIRED/);
  await assert.rejects(buildHelper({ platform: 'darwin', arch: 'x64', root }), /FM_UNSUPPORTED_ARCH/);
  await assert.rejects(buildHelper({ platform: 'darwin', arch: 'arm64', root, toolchainRoot: path.join(root, 'missing-clt') }), /FM_EXISTING_TOOLCHAIN_REQUIRED/);
  const hook = require('../scripts/build-foundation-models.cjs');
  for (const platform of ['linux', 'win32']) await hook({ electronPlatformName: platform });
  assert.equal(fs.existsSync(path.join(root, 'build/foundation-models/arm64/manifest.json')), false, 'no tools means no new packable helper');
  const swift = fs.readFileSync(path.join(root, 'native/apple/FoundationModelsHelper.swift'), 'utf8');
  for (const api of ['SystemLanguageModel.default.availability', 'LanguageModelSession(', 'GenerationOptions(sampling: nil, maximumResponseTokens:', 'session.respond(to:', 'task?.cancel()', 'Task.checkCancellation()']) assert.ok(swift.includes(api), api);
});

const gate = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
async function bounded(promise, label, ms = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${label}: deadline before dispatch/settlement`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitForDispatch(h, work, page) {
  return bounded(Promise.race([h.dispatched.promise, work.then(() => {
    const outcome = page?.run('handleLLMResponse.outcomes?.at(-1)');
    throw Error(`PREDISPATCH_SETTLED:${outcome?.status || 'settled'}:${outcome?.code || 'no-code'}`);
  }, error => { throw Error(`PREDISPATCH_REJECTED:${error.message}`); })]), 'FL dispatch');
}
async function lifecycleHarness(t, options = {}) {
  const { FoundationModelsClient } = realRequire('./foundation-models-client.cjs');
  const { FoundationModelsService } = realRequire('./foundation-models-service.cjs');
  const children = [], dispatched = gate();
  const launch = () => ({ command: process.execPath, args: [path.join(__dirname, 'fixtures/foundation-models-child.cjs'), options.mode || 'normal'], env: {} });
  const client = new FoundationModelsClient({ timeoutMs: 1000, stopMs: 30, ...options,
    resolveLaunch: options.resolveLaunch || (async () => launch()),
    spawnImpl: (command, args, config) => {
      // Test-only observation channel; the product uses three pipes.
      const child = require('node:child_process').spawn(command, args, { ...config, stdio: [...config.stdio, 'ipc'] });
      child.on('message', message => { if (message.event === 'dispatched') dispatched.resolve(message); });
      children.push(child); return child;
    } });
  // Own teardown before any capability, Main construction or generation can fail.
  t.after(async () => { await client.shutdown(); for (const child of children) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }); });
  let service;
  class Service extends FoundationModelsService { constructor(config) { super({ ...config, client }); service = this; } }
  const main = await mainHarness('darwin', Service);
  const { preload } = require('./fixtures/desktop-voice-stop-harness.cjs');
  const bridge = preload((id, value) => main.invoke(id, value));
  const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
  const runtime = new ElectronRuntime({ api: bridge, capabilities: { ready: false } });
  return { main, client, service, runtime, children, launch, bridge, dispatched };
}

test('FL02 actual Stop revokes pending capability preparation and waits without late spawn', async t => {
  const preparation = gate(), entered = gate(); let first = true;
  const h = await lifecycleHarness(t, { resolveLaunch: async () => {
    if (first) { first = false; entered.resolve(); await preparation.promise; } return h.launch();
  } });
  const work = h.runtime.generate({ messages: [{ role: 'user', content: 'Hello' }] });
  const outcome = work.then(() => 'UNEXPECTED_SUCCESS', error => error.message);
  await entered.promise;
  const stop = h.runtime.cancel(); let settled = false; stop.then(() => { settled = true; }, () => {});
  try {
    await tick(); assert.equal(h.client.pending, null, 'Stop must reach Main while capability is still preparing');
    assert.equal(settled, false, 'physical preparation must remain in the Stop drain');
  } finally { preparation.resolve(); await stop; await outcome; }
  assert.equal(await outcome, 'RUNTIME_CANCELLED'); assert.equal(h.children.length, 0);
  assert.equal((await h.runtime.generate({ messages: [{ role: 'user', content: 'New turn' }] })).text, 'Controlled English reply.');
  assert.equal(h.children.length, 1);
  const second = h.runtime.cancel(); assert.notEqual(second, stop); await second; assert.equal(h.client.proc, null);
});

test('FL03 actual UI capability refresh belongs to runtime Stop and cannot publish late readiness', async t => {
  const preparation = gate(), entered = gate();
  const h = await lifecycleHarness(t, { resolveLaunch: async () => { entered.resolve(); await preparation.promise; return h.launch(); } });
  const { settingsUi } = require('./fixtures/desktop-voice-stop-harness.cjs');
  const page = settingsUi({ storage: { vp_provider: 'apple-foundation-models' }, electronAPI: h.bridge });
  page.context.voiceRuntime = h.runtime;
  const refresh = page.run('refreshFoundationModelsCapability()'); await entered.promise;
  const stop = page.run('stopConversation()');
  try { await tick(); assert.equal(h.client.pending, null); }
  finally { preparation.resolve(); await stop; await refresh; }
  assert.equal(page.run('foundationModelsCapability'), null); assert.equal(h.children.length, 0);
  assert.equal(page.localStorage.getItem('vp_provider'), 'apple-foundation-models'); assert.equal(page.fetchCalls, 0);
});

test('FL04 reordered public cancel fences late capability; fresh intent cannot borrow old session', async t => {
  const h = await lifecycleHarness(t);
  const token = { preparationId: 'cancel-before-admission' };
  assert.equal((await h.bridge.foundationModelsCancel(token)).state, 'helper-exited');
  await assert.rejects(h.bridge.foundationModelsCapabilities(token), /FM_CANCELLED/);
  assert.equal(h.children.length, 0);
  const cap = await h.bridge.foundationModelsCapabilities({ preparationId: 'first' });
  await assert.rejects(h.bridge.foundationModelsCapabilities({ preparationId: 'unretired-other' }), /FM_BUSY/);
  await h.bridge.foundationModelsCancel({ preparationId: 'first' });
  const fresh = await h.bridge.foundationModelsCapabilities({ preparationId: 'fresh' });
  assert.notEqual(fresh.sessionId, cap.sessionId);
  await assert.rejects(h.bridge.foundationModelsGenerate({ sessionId: cap.sessionId, requestId: 'old', messages: [{ role: 'user', content: 'Old' }], maxTokens: 32 }), /FM_CANCELLED/);
  assert.equal((await h.bridge.foundationModelsCancel({ preparationId: 'first' })).state, 'helper-exited');
  assert.equal((await h.bridge.foundationModelsGenerate({ sessionId: fresh.sessionId, requestId: 'new', messages: [{ role: 'user', content: 'New' }], maxTokens: 32 })).text, 'Controlled English reply.');
});

test('FL05 actual frame navigation and owner close revoke preparing capability', async t => {
  for (const event of ['did-start-navigation', 'destroyed', 'closed']) {
    const preparation = gate(), entered = gate();
    const h = await lifecycleHarness(t, { resolveLaunch: async () => { entered.resolve(); await preparation.promise; return h.launch(); } });
    const outcome = h.runtime.foundationModelsCapabilities().catch(error => error);
    await entered.promise;
    if (event === 'closed') h.main.window.emit(event);
    else h.main.window.webContents.emit(event, {}, h.main.window.webContents.mainFrame.url, false, true);
    const stop = h.client.stopping; let settled = false; stop?.then(() => { settled = true; });
    try { await tick(); assert.equal(h.client.pending, null); assert.ok(stop); assert.equal(settled, false); }
    finally { preparation.resolve(); await stop; }
    assert.match((await outcome).message, /FM_CLOSED/); assert.equal(h.children.length, 0);
  }
});

test('FL06 actual app Quit owns resolving or rejecting preparation and prohibits restart', async t => {
  for (const reject of [false, true]) {
    const preparation = gate(), entered = gate();
    const h = await lifecycleHarness(t, { resolveLaunch: async () => { entered.resolve(); await preparation.promise; return h.launch(); } });
    const outcome = h.runtime.foundationModelsCapabilities().catch(error => error);
    await entered.promise; h.main.app.quit();
    const quit = vm.runInContext('shutdownPromise', h.main.context);
    try {
      await tick(); assert.equal(h.client.pending, null); assert.equal(h.client.closed, true);
      assert.equal(vm.runInContext('quitAllowed', h.main.context), false);
    } finally { if (reject) preparation.reject(Error('private validator failure')); else preparation.resolve(); await quit; }
    assert.equal(vm.runInContext('quitAllowed', h.main.context), true);
    assert.match((await outcome).message, /FM_CLOSED/); assert.equal(h.children.length, 0);
    await assert.rejects(h.client.request('availability'), /FM_CLOSED/);
  }
});

for (const action of ['Stop', 'leave']) test(`FL07 actual UI ${action} drops real child late success and ordinary error without speech or API fallback`, async t => {
  for (const mode of ['late-success', 'late-error']) {
    const h = await lifecycleHarness(t, { mode, stopMs: 100 });
    const { settingsUi } = require('./fixtures/desktop-voice-stop-harness.cjs');
    const page = settingsUi({ storage: { vp_provider: 'apple-foundation-models' }, electronAPI: h.bridge });
    let speech = 0, display = 0;
    Object.assign(page.context, { voiceRuntime: h.runtime, messages: [], currentMode: 'lesson', currentLessonId: 'one',
      appendChat() { display++; }, speakReply() { speech++; }, renderLessonList() {} });
    page.context.window.VoiceLanguagePolicy = require('../apps/web/runtime/language-policy.js');
    const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
    page.run(html.slice(html.indexOf('async function handleLLMResponse('), html.indexOf('\nfunction getZeroKeyDemoReply(')));
    page.run(html.slice(html.indexOf('// Tabs'), html.indexOf('// Coach Modal')));
    for (const id of ['tabBtnFree', 'tabBtnLesson']) page.context.document.getElementById(id).classList = { toggle() {} };
    await bounded(page.run('refreshFoundationModelsCapability()'), 'FL07 capability');
    const work = page.run('handleLLMResponse("Hello")');
    await waitForDispatch(h, work, page);
    const old = h.client.proc; assert.ok(old); assert.equal(old.exited, false);
    const binding = action === 'Stop' ? html.match(/class="btn btn-stop" onclick="([^"]+)"/)[1] : html.match(/onclick="(returnToLessonList\(\))"/)[1];
    await page.run(binding); await work;
    assert.equal(old.exited, true); assert.equal(h.client.proc, null);
    assert.equal(speech, 0); assert.equal(display, 0); assert.equal(page.fetchCalls, 0);
    assert.equal(page.context.messages.filter(message => message.role === 'assistant').length, 0);
    assert.equal(page.localStorage.getItem('vp_provider'), 'apple-foundation-models');
  }
});

test('FL08 actual generation deadline escalates to reaped child and a new generation can restart', async t => {
  const options = { mode: 'hang', timeoutMs: 1000, stopMs: 25 };
  const h = await lifecycleHarness(t, options);
  await h.runtime.foundationModelsCapabilities(); h.client.timeoutMs = 40;
  const work = h.runtime.generate({ messages: [{ role: 'user', content: 'Hello' }] });
  await h.dispatched.promise;
  await assert.rejects(work, /FM_TIMEOUT/);
  const old = h.client.proc; const stop = h.client.stopping; assert.ok(stop); await stop;
  assert.equal(old.exited, true); assert.throws(() => process.kill(old.child.pid, 0), { code: 'ESRCH' });
  await h.runtime.cancel(); options.mode = 'normal'; h.client.timeoutMs = 1000;
  assert.equal((await h.runtime.generate({ messages: [{ role: 'user', content: 'New' }] })).text, 'Controlled English reply.');
  assert.notEqual(h.client.proc.child.pid, old.child.pid);
});

test('FL09 actual unexpected child close latches failure and refuses a new spawn', async t => {
  const h = await lifecycleHarness(t, { mode: 'exit' });
  await h.runtime.foundationModelsCapabilities();
  await assert.rejects(h.runtime.generate({ messages: [{ role: 'user', content: 'Exit' }] }), /FM_HELPER_EXITED/);
  assert.equal(h.client.proc, null);
  await assert.rejects(h.client.request('availability'), /FM_CLOSED/);
  assert.equal(h.children.length, 1);
});

test('FL10 unconfirmed real-child Stop keeps Main Quit blocked and latches restart denial (MEMORY signal failure)', async t => {
  const h = await lifecycleHarness(t, { mode: 'hang', stopMs: 20 });
  await h.runtime.foundationModelsCapabilities();
  const work = h.runtime.generate({ messages: [{ role: 'user', content: 'Held' }] }).catch(error => error);
  await h.dispatched.promise;
  const child = h.client.proc.child, kill = child.kill.bind(child);
  child.kill = () => true; // MEMORY: reported signal success is not actual exit.
  try {
    await assert.rejects(h.runtime.cancel(), /VOICE_CLEANUP_UNCERTAIN/);
    assert.equal((await work).message, 'RUNTIME_CANCELLED');
    assert.equal(h.client.fault, true); process.kill(child.pid, 0);
    await assert.rejects(h.client.request('availability'), /FM_CLOSED/);
    h.main.app.quit(); await vm.runInContext('shutdownPromise', h.main.context);
    assert.equal(vm.runInContext('quitAllowed', h.main.context), false);
    assert.equal(h.children.length, 1);
  } finally {
    child.kill = kill; const closed = new Promise(ok => child.once('close', ok)); kill('SIGKILL'); await closed;
  }
  await h.client.shutdown(); await assert.rejects(h.client.request('availability'), /FM_CLOSED/);
});

test('FL11 synchronous stdin write failure is transport failure and owns a real exit', async t => {
  const h = await lifecycleHarness(t);
  await h.runtime.foundationModelsCapabilities();
  const record = h.client.proc, write = record.child.stdin.write;
  record.child.stdin.write = function () { this.write = write; throw Error('private write path'); };
  await assert.rejects(h.runtime.generate({ messages: [{ role: 'user', content: 'Write' }] }), /^Error: FM_TRANSPORT_FAILED$/);
  await h.client.stopping; assert.equal(record.exited, true); assert.equal(h.client.pending, null);
});

test('FL12 bounded discarded stderr takes the owned Stop path, without exposing bytes', async t => {
  const h = await lifecycleHarness(t, { mode: 'stderr' });
  await h.runtime.foundationModelsCapabilities(); const record = h.client.proc;
  await assert.rejects(h.runtime.generate({ messages: [{ role: 'user', content: 'Bound' }] }), /^Error: FM_PROTOCOL_ERROR$/);
  await h.client.stopping; assert.equal(record.exited, true); assert.equal(h.client.pending, null);
});

test('FL01 Stop/dispose/reentrant identity owns both drains and fresh disposal', async () => {
  const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
  let releaseSpeech, releaseFm, releaseDispose, reentrant;
  const speech = new Promise(ok => { releaseSpeech = ok; });
  const fm = new Promise(ok => { releaseFm = ok; });
  const disposal = new Promise(ok => { releaseDispose = ok; });
  const api = { foundationModelsCapabilities: async () => ({ protocol: 1, platform: 'macos', state: 'available', reason: 'available', sessionId: 's' }),
    foundationModelsGenerate() {}, foundationModelsCancel: () => fm };
  const runtime = new ElectronRuntime({ api, capabilities: {}, fallback: {
    cancel() { reentrant = runtime.cancel(); return speech; }, dispose: () => disposal,
  } });
  await runtime.foundationModelsCapabilities();
  const stop = runtime.cancel();
  assert.equal(stop, reentrant); assert.equal(stop, runtime.cancel()); assert.equal(stop, runtime.dispose()); assert.equal(stop, runtime.dispose());
  let settled = false; stop.then(() => { settled = true; });
  releaseSpeech(); releaseDispose(); await new Promise(setImmediate); assert.equal(settled, false);
  releaseFm({ state: 'helper-exited' }); await stop;
  const fresh = new ElectronRuntime({ api: {}, capabilities: {}, fallback: { dispose: () => disposal } });
  const old = fresh.cancel(); await old;
  const final = fresh.dispose(); assert.notEqual(final, old); assert.equal(final, fresh.dispose()); await final;
});

test('FM01 actual Main capability rejects forged platform and never advertises Linux/Windows', async () => {
  for (const platform of ['linux', 'win32']) {
    const h = await mainHarness(platform);
    assert.equal(typeof h.handlers.get('foundation-models:capabilities'), 'function');
    const cap = await h.invoke('foundation-models:capabilities');
    assert.equal(cap.state, 'unavailable'); assert.equal(cap.reason, 'unsupported-platform');
    await assert.rejects(async () => h.invoke('foundation-models:capabilities', { platform: 'darwin' }), /INVALID_FM_PAYLOAD/);
    assert.throws(() => h.invoke('foundation-models:capabilities', undefined, { ...h.event(), senderFrame: { url: h.event().senderFrame.url } }), /UNTRUSTED_IPC_SENDER/);
  }
});
