'use strict';
// Browser UMD/DOM/API controls, not real Electron, Apple inference or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadRuntimeScripts } = require('./fixtures/browser-runtime-scripts.cjs');
const root = path.resolve(__dirname, '..');
function browser(legacyOrder = false) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController, URL, TextEncoder, TextDecoder });
  loadRuntimeScripts(context, fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8'), root, { legacyOrder });
  vm.runInContext(`globalThis.calls = 0; globalThis.generations = 0;
    globalThis.api = {
      runtimeHealth: async () => { throw Error('SPEECH_NOT_RUN_SCOPE'); },
      foundationModelsCapabilities: async () => { calls++; return { protocol: 1, platform: 'macos', state: 'available', reason: 'available', sessionId: 'browser-order-control' }; },
      foundationModelsGenerate: () => { generations++; throw Error('GENERATION_FORBIDDEN'); },
      foundationModelsCancel: async () => ({ state: 'helper-exited' })
    };`, context);
  return { context, run: code => vm.runInContext(code, context) };
}
test('BO01 actual HTML script order reaches FM API through browser UMD factory', async () => {
  const page = browser();
  const capability = await page.run('(async () => { globalThis.runtime = await VoiceRuntimeFactory.createRuntime({ electronAPI: api }); return runtime.foundationModelsCapabilities(); })()');
  assert.equal(capability.state, 'available');
  assert.equal(page.context.calls, 1);
  assert.equal(page.context.generations, 0);
  assert.equal(page.run('runtime.kind'), 'electron');
  assert.equal(page.run('window === globalThis && typeof require === "undefined" && typeof module === "undefined"'), true);
});
test('BO02 restoring original order fails before IPC despite eventual global contract', async () => {
  const page = browser(true);
  await assert.rejects(page.run('(async () => { globalThis.runtime = await VoiceRuntimeFactory.createRuntime({ electronAPI: api }); return runtime.foundationModelsCapabilities(); })()'),
    error => error.name === 'TypeError' && /normalizeFoundationModelsCapability/.test(error.message));
  assert.equal(page.context.calls, 0);
  assert.equal(page.context.generations, 0);
  assert.equal(page.run('!!runtime._fmPreparing'), false);
  assert.equal(page.run('typeof VoiceLlmProviderContract.normalizeFoundationModelsCapability'), 'function');
});
test('BO03 browser-only factory does not expose the native FM capability API', async () => {
  const page = browser();
  const runtime = await page.run('VoiceRuntimeFactory.createRuntime()');
  assert.equal(runtime.kind, 'browser');
  assert.equal(typeof runtime.foundationModelsCapabilities, 'undefined');
  assert.equal(page.context.calls, 0);
});
test('BO04 UMD runtime discards capability response arriving after cancellation', async () => {
  const page = browser();
  await page.run(`(async () => {
    api.foundationModelsCapabilities = () => { calls++; return new Promise(resolve => { globalThis.releaseCapability = resolve; }); };
    globalThis.runtime = await VoiceRuntimeFactory.createRuntime({ electronAPI: api });
  })()`);
  const pending = page.run('runtime.foundationModelsCapabilities()');
  const rejected = assert.rejects(pending, /RUNTIME_CANCELLED/);
  await new Promise(setImmediate);
  assert.equal(page.context.calls, 1);
  await page.run('runtime.cancelGeneration()');
  page.run('releaseCapability({ protocol: 1, platform: "macos", state: "available", reason: "available", sessionId: "late-control" })');
  await rejected;
  assert.equal(page.run('!!runtime._fmCapability'), false);
  assert.equal(page.context.generations, 0);
});
test('BO05 real Main preload initApp uses HTML UMD globals and owns helper retirement', async () => {
  const result = await require('./fm-ui-diagnostic-fixture.cjs').runFixture({ root, browserGlobals: true });
  assert.equal(result.rendererMode, 'HTML_ORDER_BROWSER_GLOBALS');
  assert.equal(result.capability, 'available');
  assert.equal(result.capture.events.filter(e => e.event === 'capability-entry').length, 1);
  assert.equal(result.capture.events.filter(e => e.event === 'helper-spawn').length, 1);
  assert.equal(result.capture.events.filter(e => e.event === 'helper-exit').length, 1);
  assert.equal(result.helpersClosed, true);
  assert.deepEqual(result.speechSpawnAttempts, []);
  assert.equal(result.generations, 0);
});
test('BO06 real initApp old-order twin stays null and never starts FM helper', async () => {
  const result = await require('./fm-ui-diagnostic-fixture.cjs').runFixture({ root, browserGlobals: true, legacyOrder: true });
  assert.equal(result.capability, 'null');
  assert.equal(result.rendererMode, 'HTML_ORDER_BROWSER_GLOBALS');
  assert.equal(result.capture.events.filter(e => e.event === 'capability-entry').length, 0);
  assert.equal(result.capture.events.filter(e => e.event === 'helper-spawn').length, 0);
  assert.equal(result.helpersClosed, true); // Vacuous 0 -> 0 is not a model-execution claim.
  assert.deepEqual(result.speechSpawnAttempts, []);
});
test('BO09 browser UMD path does not bypass wrong-frame document admission', async () => {
  const result = await require('./fm-ui-diagnostic-fixture.cjs').runFixture({ root, browserGlobals: true, wrongFrame: true });
  assert.equal(result.capability, 'null');
  assert.equal(result.capture.events.filter(e => e.event === 'helper-spawn').length, 0);
  assert.equal(result.helpersClosed, true);
  assert.deepEqual(result.speechSpawnAttempts, []);
});
test('BO10 explicit CommonJS unit boundary remains compatible', async () => {
  const result = await require('./fm-ui-diagnostic-fixture.cjs').runFixture({ root });
  assert.equal(result.rendererMode, 'COMMONJS_UNIT_BOUNDARY');
  assert.equal(result.capability, 'available');
  assert.equal(result.helpersClosed, true);
  assert.deepEqual(result.speechSpawnAttempts, []);
});
function settingsPage(electronAPI) {
  const page = require('./fixtures/desktop-voice-stop-harness.cjs').settingsUi({
    storage: {}, electronAPI, browserGlobals: { root }
  });
  const html = fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8');
  page.context.synthesizeBrowserSpeech = () => { throw Error('SPEECH_FORBIDDEN'); };
  page.run(html.slice(html.indexOf('async function createVoiceRuntime('), html.indexOf('\nlet availableVoices')));
  return page;
}
test('BO07 Windows capability remains unavailable in actual settings init', async () => {
  let calls = 0, generations = 0;
  const page = settingsPage({
    runtimeHealth: async () => { throw Error('SPEECH_NOT_RUN_SCOPE'); },
    foundationModelsCapabilities: async () => { calls++; return { protocol: 1, platform: 'windows', state: 'unavailable', reason: 'unsupported-platform', sessionId: 'windows-control' }; },
    foundationModelsGenerate: () => { generations++; throw Error('GENERATION_FORBIDDEN'); },
    foundationModelsCancel: async () => ({ state: 'helper-exited' })
  });
  await page.api.initApp();
  assert.equal(calls, 1);
  assert.equal(page.run('foundationModelsCapability.state'), 'unavailable');
  const option = page.elements.providerSelect.options.find(option => option.value === 'apple-foundation-models');
  assert.ok(!option || option.disabled);
  assert.equal(generations, 0);
  assert.equal(page.fetchCalls, 0);
});
test('BO08 browser-only settings init does not offer native FM', async () => {
  const page = settingsPage();
  await page.api.initApp();
  assert.equal(page.run('voiceRuntime.kind'), 'browser');
  assert.equal(page.run('foundationModelsCapability'), null);
  const option = page.elements.providerSelect.options.find(option => option.value === 'apple-foundation-models');
  assert.ok(!option || option.disabled);
  assert.equal(page.fetchCalls, 0);
});
