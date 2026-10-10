'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise actual HTML host functions. Module loading and the DOM container
// are boundary doubles; the separately-tested panel owns the real DOM view.
function harness(api = { nativeModelOverview() {}, installNativeModel() {}, cancelNativeModelInstallAction() {} }) {
  const html = fs.readFileSync(path.resolve(__dirname, '../apps/web/index.html'), 'utf8');
  const functions = ['showNativeModelSettingsPane', 'disposeNativeModelSettingsPane'].map(name => {
    const found = html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(found, `settings host requires ${name}`);
    return found[0];
  });
  const root = { hidden: true, textContent: '', setAttribute() {} };
  const context = { window: { electronAPI: api }, document: { getElementById: id => id === 'nativeModelSettings' ? root : null } };
  vm.createContext(context);
  vm.runInContext(`let nativeModelSettingsController = null; let nativeModelSettingsEpoch = 0;\n${functions.join('\n')}\nglobalThis.host = {show:showNativeModelSettingsPane,close:disposeNativeModelSettingsPane};`, context);
  return { host: context.host, root, html, api };
}
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

test('actual settings open and hide hooks own the native model pane', async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../apps/web/index.html'), 'utf8');
  assert.match(html, /<section[^>]*\bid="nativeModelSettings"[^>]*\bhidden/, 'settings require a dedicated initially-hidden model region');
  const functions = ['openSettingsModal', 'hideSettingsModal'].map(name => html.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]);
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { style: {}, value: '', textContent: '' }); return nodes.get(id); };
  let shown = 0, disposed = 0;
  const context = { document: { getElementById: node }, localStorage: { getItem: () => null },
    DIRECT_API_PROVIDER_ID: 'openai-compatible', PROVIDERS_CONFIG: { 'openai-compatible': {} },
    getCurrentProviderState: () => ({}), isSelectableProviderState: () => true, getTtsMode: () => 'auto',
    invalidateModelDiscovery() {}, removeRetiredOAuthState() {}, migrateLegacyDirectProviderSettings() {}, applyLlmProviderCapabilities() {},
    isIosBrowserEnvironment: () => false, loadProviderIntoForm: async () => {},
    showNativeModelSettingsPane() { shown++; assert.equal(node('settingsModal').style.display, 'flex'); },
    disposeNativeModelSettingsPane() { disposed++; },
  };
  vm.createContext(context);
  vm.runInContext(`let settingsSession = null; let activeSettingsProvider = null;
    function captureSettingsScope(){return settingsSession;}
    function settingsUiIsCurrent(scope){return scope === settingsSession && scope.valid && scope.visible;}
    ${functions.join('\n')}
    globalThis.modal = {open:openSettingsModal,hide:hideSettingsModal};`, context);
  await context.modal.open();
  assert.equal(shown, 1);
  context.modal.hide({ valid: true, visible: true });
  assert.equal(disposed, 0, 'an obsolete modal cannot dispose the current observer');
  context.modal.hide();
  assert.equal(disposed, 1);
  assert.equal(node('settingsModal').style.display, 'none');
});

test('settings host mounts one model observer and disposes it when closed', async () => {
  const h = harness(), mounted = [], disposed = [];
  const loader = async () => ({ mountNativeModelSettings: options => {
    const id = mounted.length; mounted.push(options);
    return { dispose() { disposed.push(id); } };
  } });
  await h.host.show(loader);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].root, h.root);
  assert.equal(mounted[0].api, h.api);
  h.host.close(); h.host.close();
  assert.deepEqual(disposed, [0], 'closing twice does not dispose someone else or duplicate cleanup');
});

test('web and incomplete bridges do not even import the native model view', async () => {
  for (const api of [null, {}, { nativeModelOverview() {} }]) {
    const h = harness(api);
    let loaded = 0;
    await h.host.show(async () => { loaded++; return { mountNativeModelSettings: () => ({ dispose() {} }) }; });
    assert.equal(loaded, 0, 'unsupported platforms never load a desktop-only module');
    assert.equal(h.root.hidden, true);
  }
});

test('model module failures remain in the current pane and do not reject the settings operation', async () => {
  const h = harness();
  await assert.doesNotReject(h.host.show(async () => { throw new Error('fixture-private-path'); }), 'import failure must remain a model-panel error');
  assert.equal(h.root.hidden, false);
  assert.match(h.root.textContent, /模型設定.*失敗/);
  assert.equal(h.root.textContent.includes('fixture-private-path'), false);
  const stale = harness(), loading = deferred();
  const old = stale.host.show(() => loading.promise);
  stale.host.close(); loading.reject(new Error('obsolete import'));
  await assert.doesNotReject(old);
  assert.equal(stale.root.textContent, '', 'a closed pane does not receive the late error');
});

test('late model imports cannot revive a closed pane or replace the successor observer', async () => {
  const h = harness(), first = deferred(), mounts = [], disposals = [];
  const moduleFor = id => ({ mountNativeModelSettings: () => { mounts.push(id); return { dispose() { disposals.push(id); } }; } });
  const old = h.host.show(() => first.promise);
  h.host.close();
  await h.host.show(async () => moduleFor('current'));
  first.resolve(moduleFor('stale'));
  await old;
  assert.deepEqual(mounts, ['current'], 'closed view must not regain a poller after import resolves');
  h.host.close();
  assert.deepEqual(disposals, ['current']);
});
