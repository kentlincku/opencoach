'use strict';
// Electron navigation/DOM boundary double, not a Mac/Electron run. All product
// Main/preload/initApp/factory/service/client bodies execute; helper is inert Node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { preload, settingsUi } = require('./fixtures/desktop-voice-stop-harness.cjs');
const { FoundationModelsClient } = require('../apps/desktop/foundation-models-client.cjs');
const { FoundationModelsService } = require('../apps/desktop/foundation-models-service.cjs');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function documentHarness(t, platform = 'darwin', options = {}) {
  const file = path.join(__dirname, 'foundation-models.test.cjs');
  const privateRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fm-document-'));
  const loaded = gate(), finish = gate(), children = [], trace = [];
  let service;
  const client = new FoundationModelsClient({ stopMs: 30, ...options,
    resolveLaunch: options.resolveLaunch || (async () => ({ command: process.execPath,
      args: [path.join(__dirname, 'fixtures/foundation-models-child.cjs')], env: {} })),
    spawnImpl: (...args) => { const child = require('node:child_process').spawn(...args); children.push(child); return child; } });
  class Service extends FoundationModelsService { constructor(config) { super({ ...config, client }); service = this; } }
  let source = fs.readFileSync(file, 'utf8').split("test('FM02")[0]
    .replace('safeStorage: {}, shell: {}', 'safeStorage: {}, shell: {}, Menu: { buildFromTemplate: items => ({ items, append() {} }), getApplicationMenu: () => null, setApplicationMenu() {} }, MenuItem: class { constructor(value) { Object.assign(this, value); } }')
    .replace('isPackaged: false', 'isPackaged: true')
    .replace('getAppPath: () =>', 'getPath: () => globalThis.privateRoot, getAppPath: () =>')
    .replace('createWindow, registerIpc };', 'createWindow, registerIpc, startApplication };')
    .replace('async loadFile(file) { this.webContents.mainFrame.url = require(\'node:url\').pathToFileURL(file).href; }',
      'loadFile(file) { this.url = require("node:url").pathToFileURL(file).href; loaded.resolve(this); return finish.promise; }')
    .replace('await context.entry.createWindow(); context.entry.registerIpc();',
      'context.process.resourcesPath = globalThis.privateRoot; const startup = context.entry.startApplication(); await loaded.promise;')
    .replace('return { handlers, window, app, context,', 'return { handlers, window, app, context, startup,');
  const box = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports = mainHarness;', { module: box, require: createRequire(file), __dirname,
    process, Buffer, URL, console: { log() {}, error() {} }, setTimeout, clearTimeout, privateRoot, loaded, finish });
  const main = await box.exports(platform, Service);
  const owner = () => vm.runInContext('voiceDocument', main.context);
  const observe = label => { const o = owner(); trace.push({ event: label, live: o?.live,
    stateClosed: service.owners.get(o)?.closed === true, active: service.active?.owner === o }); };
  let sequence = 0;
  const begin = (url = main.window.url, inPlace = false, isMainFrame = true) => {
    main.window.webContents.emit('did-start-navigation', {}, url, inPlace, isMainFrame); observe('did-start-navigation');
  };
  const commit = (frame = { url: main.window.url, processId: 1, routingId: ++sequence }) => {
    main.window.webContents.mainFrame = frame;
    main.window.webContents.emit('did-frame-navigate', {}, frame.url, -1, '', true, frame.processId, frame.routingId);
    main.window.webContents.emit('did-navigate', {}, frame.url, -1, ''); observe('trusted-commit'); return frame;
  };
  const complete = () => { main.window.webContents.emit('did-finish-load'); observe('did-finish-load'); finish.resolve(); };
  const boot = () => {
    const sender = main.window.webContents;
    const frame = sender.mainFrame;
    const bridge = preload(async (id, payload) => {
      observe('ipc:' + id);
      try { return await main.invoke(id, payload, { sender, senderFrame: frame }); }
      catch (error) { trace.push({ event: 'ipc-error', id, error: error.message }); throw error; }
    });
    const page = settingsUi({ storage: { vp_provider: 'apple-foundation-models' }, electronAPI: bridge });
    const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
    page.context.window.VoiceRuntimeFactory = require('../apps/web/runtime/create-runtime.js');
    page.context.synthesizeBrowserSpeech = () => { throw Error('SPEECH_NOT_REQUESTED'); };
    page.run(html.slice(html.indexOf('async function createVoiceRuntime('), html.indexOf('\nlet availableVoices')));
    main.window.webContents.emit('dom-ready'); observe('dom-ready/bootstrap');
    const initialized = page.api.initApp();
    return { page, bridge, initialized, frame };
  };
  t.after(async () => {
    complete(); await main.startup; await client.shutdown();
    for (const child of children) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    console.log('DOCUMENT_TRACE', JSON.stringify(trace));
    fs.rmSync(privateRoot, { recursive: true, force: true });
  });
  return { main, client, service, children, trace, owner, begin, commit, complete, boot };
}

test('FD03 prevented external navigation, hash and subframe keep the trusted document', async t => {
  const h = await documentHarness(t); h.begin(); h.commit(); const ui = h.boot(); h.complete(); await ui.initialized;
  const owner = h.owner(), session = ui.page.run('foundationModelsCapability.sessionId');
  h.begin(h.main.window.url + '#settings', true); h.begin('https://example.invalid/frame', false, false);
  h.begin('https://example.invalid/'); let prevented = false;
  h.main.window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.invalid/');
  assert.equal(prevented, true); assert.equal(h.owner(), owner); assert.equal(owner.live, true);
  assert.equal(ui.page.run('foundationModelsCapability.sessionId'), session);
});

test('FD04 stale finish and wrong-frame commit cannot renew or lend old renderer a fresh owner', async t => {
  const h = await documentHarness(t); h.begin(); const frame = h.commit(); const ui = h.boot(); h.complete(); await ui.initialized;
  const oldOwner = h.owner(); h.begin();
  await assert.rejects(ui.bridge.foundationModelsCapabilities({ preparationId: 'before-commit' }), /FM_CLOSED/);
  h.complete(); assert.equal(h.owner(), oldOwner); assert.equal(oldOwner.live, false);
  h.main.window.webContents.emit('did-frame-navigate', {}, frame.url, -1, '', true, frame.processId, frame.routingId + 20);
  h.main.window.webContents.emit('did-frame-navigate', {}, frame.url, -1, '', false, frame.processId, frame.routingId);
  assert.equal(h.owner(), oldOwner);
  h.commit(); const fresh = h.owner(); h.complete(); assert.equal(h.owner(), fresh);
  await assert.rejects(ui.bridge.foundationModelsCapabilities({ preparationId: 'after-commit' }), /UNTRUSTED_IPC_SENDER/);
  const bad = { sender: h.main.window.webContents, senderFrame: { ...h.main.window.webContents.mainFrame } };
  assert.throws(() => h.main.invoke('foundation-models:capabilities', { preparationId: 'subframe' }, bad), /UNTRUSTED_IPC_SENDER/);
});

test('FD05 destroyed window late commit never resurrects document admission', async t => {
  const h = await documentHarness(t); h.begin(); h.commit(); const ui = h.boot(); h.complete(); await ui.initialized;
  const owner = h.owner(); h.main.window.webContents.emit('destroyed');
  h.commit(); h.complete(); assert.equal(h.owner(), owner); assert.equal(owner.live, false);
  h.main.window.emit('closed'); await owner.foundationModelsReady;
  await assert.rejects(ui.bridge.foundationModelsCapabilities({ preparationId: 'closed' }), /UNTRUSTED_IPC_SENDER/);
});

test('FD06 healthy helper reload creates fresh session, rejects old session, generates and Stops', async t => {
  const h = await documentHarness(t); h.begin(); h.commit(); const old = h.boot(); h.complete(); await old.initialized;
  const previous = old.page.run('foundationModelsCapability.sessionId'), oldOwner = h.owner(), oldProc = h.client.proc;
  h.begin(); h.commit(); const fresh = h.boot(); h.complete(); await fresh.initialized;
  assert.equal(oldOwner.live, false); assert.equal(oldProc.exited, true);
  assert.notEqual(fresh.page.run('foundationModelsCapability.sessionId'), previous);
  await assert.rejects(fresh.bridge.foundationModelsGenerate({ sessionId: previous, requestId: 'old-session', messages: [{ role: 'user', content: 'Hello.' }], maxTokens: 32 }), /FM_CANCELLED/);
  assert.equal(await fresh.page.api.requestProviderChat({ providerId: 'apple-foundation-models', conversationMessages: [{ role: 'user', content: 'Hello again.' }] }), 'Controlled English reply.');
  await fresh.page.run('stopConversation()'); assert.equal(h.client.proc, null);
});

for (const platform of ['win32', 'linux']) test(`FD07 ${platform} actual bootstrap stays typed unavailable across reload without helper`, async t => {
  const h = await documentHarness(t, platform);
  for (let i = 0; i < 2; i++) {
    h.begin(); h.commit(); const ui = h.boot(); h.complete(); await ui.initialized;
    assert.equal(ui.page.run('foundationModelsCapability.state'), 'unavailable');
    assert.equal(ui.page.run('foundationModelsCapability.reason'), 'unsupported-platform');
  }
  assert.equal(h.children.length, 0);
});

test('FD08 old window late close cannot revoke its replacement or bypass the old helper drain', async t => {
  const h = await documentHarness(t); h.begin(); h.commit(); const old = h.boot(); h.complete(); await old.initialized;
  const oldWindow = h.main.window, oldOwner = h.owner(), oldProc = h.client.proc;
  oldWindow.emit('closed');
  await h.main.context.entry.createWindow();
  h.main.window = vm.runInContext('mainWindow', h.main.context);
  h.begin(); h.commit(); const fresh = h.boot(); h.complete(); await fresh.initialized;
  assert.equal(fresh.page.run('foundationModelsCapability')?.state, 'available');
  const freshOwner = h.owner(); assert.notEqual(oldOwner, freshOwner); assert.equal(oldProc.exited, true);
  oldWindow.webContents.emit('did-finish-load'); oldWindow.webContents.emit('destroyed'); oldWindow.emit('closed');
  assert.equal(h.owner(), freshOwner); assert.equal(freshOwner.live, true);
  await assert.rejects(old.bridge.foundationModelsCapabilities({ preparationId: 'old-window' }), /UNTRUSTED_IPC_SENDER/);
});

test('FD02 same-URL reload waits for revoked preparation drain, old owner never revives', async t => {
  const entered = gate(), release = gate(); let first = true;
  const h = await documentHarness(t, 'darwin', { resolveLaunch: async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return { command: process.execPath, args: [path.join(__dirname, 'fixtures/foundation-models-child.cjs')], env: {} };
  } });
  t.after(() => release.resolve());
  h.begin(); h.commit(); const old = h.boot(); await entered.promise;
  const oldOwner = h.owner(); h.begin(); assert.equal(oldOwner.live, false);
  h.commit(); const freshOwner = h.owner(); const fresh = h.boot();
  assert.notEqual(freshOwner, oldOwner);
  try {
    for (let n = 0; n < 30 && h.trace.filter(x => x.event === 'ipc:foundation-models:capabilities').length < 2; n++) await new Promise(setImmediate);
    assert.equal(h.trace.filter(x => x.event === 'ipc:foundation-models:capabilities').length, 2);
    h.complete();
  } finally { release.resolve(); }
  await Promise.all([old.initialized, fresh.initialized]);
  assert.equal(old.page.run('foundationModelsCapability'), null);
  assert.equal(fresh.page.run('foundationModelsCapability')?.state, 'available');
  assert.equal(oldOwner.live, false); assert.equal(h.service.owners.get(oldOwner).closed, true);
  await assert.rejects(old.bridge.foundationModelsCapabilities({ preparationId: 'late-old' }), /UNTRUSTED_IPC_SENDER/);
  await assert.rejects(h.service.capabilities(oldOwner, { preparationId: 'old-owner' }), /FM_CLOSED/);
  assert.equal(h.children.length, 1, 'revoked preparation never spawns');
});

test('FD01 first load bootstrap IPC before finish reaches real capability and Settings generation', async t => {
  const h = await documentHarness(t);
  const initial = h.owner(); h.begin();
  assert.equal(initial.live, false, 'ledger already revokes live; no duplicate live=false fix');
  h.commit(); const ui = h.boot();
  // This is a controlled pre-load IPC turn, not blocking did-finish-load on UI.
  // Wait only for dispatch/error observation then deliver finish independently.
  for (let n = 0; n < 30 && !h.trace.some(x => x.event === 'ipc:foundation-models:capabilities'); n++) await new Promise(setImmediate);
  assert.ok(h.trace.some(x => x.event === 'ipc:foundation-models:capabilities'));
  h.complete(); await ui.initialized; await h.main.startup;
  const capability = ui.page.run('foundationModelsCapability');
  console.log('BOOTSTRAP_RESULT', JSON.stringify({ capability, errors: h.trace.filter(x => x.error) }));
  assert.equal(capability?.state, 'available', 'early FM_CLOSED is swallowed into null and finish does not retry');
  assert.notEqual(h.owner(), initial);
  await ui.page.api.openSettingsModal();
  assert.equal(ui.page.elements.providerSelect.options.find(x => x.value === 'apple-foundation-models').disabled, false);
  assert.equal(await ui.page.api.requestProviderChat({ providerId: 'apple-foundation-models', conversationMessages: [{ role: 'user', content: 'Hello.' }] }), 'Controlled English reply.');
  assert.equal(ui.page.fetchCalls, 0);
  await ui.page.run('stopConversation()'); assert.equal(h.client.proc, null);
});
