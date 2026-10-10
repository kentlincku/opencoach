const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Boundary fakes: DOM, Electron IPC and timer scheduling only. The actual ES
// module is imported and its rendered nodes/events are exercised. These tests
// do NOT attest native consent dialogs, network/model files or real App audio.
class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this._text = '';
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get value() { return this._value ?? 0; }
  set value(value) { this._value = value; this.setAttribute('value', value); }
  get max() { return this._max ?? 1; }
  set max(value) { this._max = value; this.setAttribute('max', value); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(_value) { assert.fail('HTML parsing is forbidden at this UI boundary'); }
  insertAdjacentHTML() { assert.fail('HTML parsing is forbidden at this UI boundary'); }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = '';
    for (const child of children) this.appendChild(child);
  }
  appendChild(child) {
    assert.ok(child instanceof Element, 'append actual DOM nodes, not markup strings');
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  setAttribute(name, value) {
    assert.ok(!/^on/i.test(name), 'inline event handlers are forbidden');
    this.attributes.set(name, String(value));
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener({ ...event, target: this });
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  focus() { this.ownerDocument.activeElement = this; }
}

function createDom() {
  const document = { activeElement: null, createElement(tag) { return new Element(tag, document); } };
  return { document, root: document.createElement('section') };
}
function all(root, tag) {
  const nodes = [root, ...root.children.flatMap(child => all(child))];
  return tag ? nodes.filter(node => node.tagName === tag.toUpperCase()) : nodes;
}
function button(root, text) {
  // Buttons show short labels (下載／取消／重試); the full action stays in aria-label.
  const name = node => node.getAttribute('aria-label') ?? node.textContent;
  const result = all(root, 'button').find(node => typeof text === 'string' ? name(node) === text : text.test(name(node)));
  assert.ok(result, `missing button ${text}; rendered: ${root.textContent}`);
  return result;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function installation(overrides = {}) {
  return { actionId: 'action-A', modelId: 'english-stt', phase: 'downloading', bytes: 0,
    total: 512 * 1024 ** 2, cancelled: false, restartRequired: false, ...overrides };
}

function createClock() {
  let next = 0;
  const tasks = new Map();
  const cleared = [];
  return {
    tasks, cleared,
    setIntervalImpl(callback, ms) { const id = next++; tasks.set(id, { callback, ms }); return id; },
    clearIntervalImpl(id) { cleared.push(id); tasks.delete(id); },
    tick() { for (const task of [...tasks.values()]) task.callback(); },
  };
}
function overview(overrides = {}) {
  return {
    version: 1, mode: 'runtime-only', runtime: { state: 'embedded' },
    targetLanguage: 'en', enabledLanguages: ['en'],
    models: [
      { modelId: 'english-stt', name: 'English recognizer', kind: 'stt', languages: ['en'], bytes: 512 * 1024 ** 2,
        license: { spdx: 'MIT', url: 'https://example.test/stt-license' }, state: 'missing', restartRequired: false },
      { modelId: 'english-tts', name: 'English voice', kind: 'tts', languages: ['en'], bytes: 2 * 1024 ** 3,
        license: { spdx: 'Apache-2.0', url: 'https://example.test/tts-license' }, state: 'active', restartRequired: false },
    ],
    installation: null, restartRequired: false,
    ...overrides,
  };
}
async function mount(t, options = {}) {
  const calls = { overview: 0, install: [], installArgs: [], cancel: [], remove: [], legacyCancel: [], start: 0, reload: 0, fetch: 0 };
  t.mock.method(globalThis, 'fetch', () => { calls.fetch += 1; throw new Error('renderer must not fetch models'); });
  t.mock.method(globalThis, 'eval', () => { assert.fail('eval is forbidden'); });
  const modulePath = path.join(__dirname, '../apps/web/native-model-settings.js');
  assert.ok(existsSync(modulePath), 'native model settings ES module must exist');
  // Load the unchanged browser ES module explicitly as ESM: this repository's
  // package.json is CommonJS, and its scope must not change for a UI test.
  const source = readFileSync(modulePath, 'utf8');
  const { mountNativeModelSettings } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(typeof mountNativeModelSettings, 'function');
  const { root, document } = createDom();
  const clock = createClock();
  let current = options.overview || overview();
  const api = {
    nativeModelOverview() { calls.overview += 1; return options.read ? options.read() : Promise.resolve(current); },
    installNativeModel(...args) {
      calls.installArgs.push(args);
      calls.install.push(args[0]);
      return options.install ? options.install(args[0]) : Promise.resolve();
    },
    cancelNativeModelInstallAction(id) { calls.cancel.push(id); return options.cancel ? options.cancel(id) : Promise.resolve(); },
    cancelNativeModelInstall(id) { calls.legacyCancel.push(id); assert.fail('never cancel by modelId'); },
    startRuntime() { calls.start += 1; assert.fail('install must not start the runtime'); },
    reloadApp() { calls.reload += 1; assert.fail('install must not reload the App'); },
  };
  if (options.remove) api.removeNativeModel = id => { calls.remove.push(id); return options.remove(id); };
  calls.select = [];
  if (options.select) api.selectNativeSttModel = id => { calls.select.push(id); return options.select(id); };
  for (const key of options.omit || []) delete api[key];
  const controller = mountNativeModelSettings({ root, api: options.web ? undefined : api, ...clock });
  assert.equal(typeof controller.refresh, 'function');
  assert.equal(typeof controller.dispose, 'function');
  t.after(() => controller.dispose());
  await settle();
  return { root, document, clock, api, calls, controller, setOverview(value) { current = value; } };
}

test('initial read renders safe model metadata without downloading or polling idle state', async t => {
  const maliciousName = '<img src=x onerror="globalThis.pwned=true">';
  const data = overview();
  data.models[0].name = maliciousName;
  data.models[0].languages = ['en', 'ja'];
  data.models[0].license.url = 'javascript:alert("license")';
  const h = await mount(t, { overview: data });
  assert.equal(h.root.hidden, false);
  assert.equal(h.calls.overview, 1, 'mount reads exactly one cached projection');
  assert.deepEqual(h.calls.install, []);
  assert.deepEqual(h.calls.cancel, []);
  assert.deepEqual(h.calls.remove, []);
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.clock.tasks.size, 0);
  assert.ok(h.root.textContent.includes(maliciousName));
  assert.equal(all(h.root, 'img').length, 0);
  assert.equal(all(h.root, 'script').length, 0);
  assert.equal(all(h.root, 'a').length, 0, 'license metadata cannot inject a navigable URL');
  assert.match(h.root.textContent, /STT.*語音.*文字/);
  assert.match(h.root.textContent, /TTS.*文字.*語音/);
  assert.match(h.root.textContent, /512(?:\.0)? MiB/);
  assert.match(h.root.textContent, /2(?:\.0)? GiB/);
  assert.match(h.root.textContent, /MIT/);
  assert.match(h.root.textContent, /缺模型/);
  assert.match(h.root.textContent, /使用中/);
  assert.match(h.root.textContent, /英文/);
  assert.match(h.root.textContent, /ja/);
  assert.match(h.root.textContent, /能力.*資訊|metadata/);
  assert.match(h.root.textContent, /離線.*重用/);
  assert.match(h.root.textContent, /原生語音對話.*STT.*TTS.*兩包.*就緒/, 'separate downloads must not imply single-model speech readiness');
  assert.match(h.root.textContent, /文字.*功能|文字.*練習/);
  assert.equal(h.calls.start, 0);
  assert.equal(h.calls.reload, 0);
});

test('web or any missing required IPC method hides the panel and performs no native work', async t => {
  for (const options of [
    { omit: ['cancelNativeModelInstallAction'] },
    { omit: ['installNativeModel'] },
    { omit: ['nativeModelOverview'] },
    { web: true },
  ]) {
    const h = await mount(t, options);
    assert.equal(h.root.hidden, true);
    await h.controller.refresh();
    h.clock.tick();
    await settle();
    assert.equal(h.calls.overview, 0);
    assert.deepEqual(h.calls.install, []);
    assert.deepEqual(h.calls.cancel, []);
    assert.deepEqual(h.calls.legacyCancel, []);
    assert.equal(h.calls.fetch, 0);
    assert.equal(h.clock.tasks.size, 0);
    h.controller.dispose();
  }
});

test('an explicit install click delegates consent once and locks duplicate actions until Main settles', async t => {
  const work = deferred();
  const h = await mount(t, { install: () => work.promise });
  const install = button(h.root, '安裝 English recognizer');
  assert.equal(install.type, 'button');
  assert.equal(install.disabled, false);
  assert.deepEqual(h.calls.install, []);
  install.click();
  install.click();
  install.dispatchEvent({ type: 'click' });
  await settle();
  assert.deepEqual(h.calls.install, ['english-stt']);
  assert.deepEqual(h.calls.installArgs, [['english-stt']], 'renderer supplies no approval flag or invented consent');
  assert.match(h.root.textContent, /等待.*同意/);
  assert.equal(button(h.root, '安裝 English recognizer').disabled, true);
  await h.controller.refresh();
  button(h.root, '安裝 English recognizer').click();
  assert.deepEqual(h.calls.install, ['english-stt']);
  assert.match(h.root.textContent, /使用中/);
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.calls.start, 0);
  assert.equal(h.calls.reload, 0);
});

test('observing a Main action polls at 500 ms without overlapping reads and renders real progress phases', async t => {
  const slowRead = deferred();
  const reads = [
    overview({ installation: installation({ phase: 'confirming' }) }),
    slowRead.promise,
    overview({ installation: installation({ phase: 'verifying', bytes: 512 * 1024 ** 2 }) }),
    overview({ installation: installation({ phase: 'cancelled', cancelled: true }) }),
  ];
  const h = await mount(t, { read: () => Promise.resolve(reads.shift()) });
  assert.equal(h.clock.tasks.size, 1);
  assert.equal([...h.clock.tasks.values()][0].ms, 500);
  assert.match(h.root.textContent, /等待.*同意/);
  assert.deepEqual(h.calls.install, [], 'observing someone else’s action never requests consent');
  assert.equal(button(h.root, '安裝 English recognizer').disabled, true);
  h.clock.tick();
  h.clock.tick();
  h.clock.tick();
  assert.equal(h.calls.overview, 2, 'slow cached read is not overlapped by timer ticks');
  slowRead.resolve(overview({ installation: installation({ bytes: 256 * 1024 ** 2 }) }));
  await settle();
  assert.match(h.root.textContent, /下載中/);
  assert.match(h.root.textContent, /256(?:\.0)? MiB.*512(?:\.0)? MiB/);
  assert.match(h.root.textContent, /50%/);
  const progress = all(h.root, 'progress')[0];
  assert.ok(progress, 'render an accessible progress element');
  assert.equal(progress.value, 256 * 1024 ** 2);
  assert.equal(progress.max, 512 * 1024 ** 2);
  assert.match(progress.getAttribute('aria-label'), /下載/);
  h.clock.tick();
  await settle();
  assert.match(h.root.textContent, /驗證中/);
  assert.equal(button(h.root, '安裝 English recognizer').disabled, true);
  await h.controller.refresh();
  assert.match(h.root.textContent, /已取消/);
  assert.equal(button(h.root, '安裝 English recognizer').disabled, false);
  assert.equal(h.clock.tasks.size, 0);
  assert.deepEqual(h.calls.install, []);
});

test('late overview responses including the initial read cannot replace a newer refresh', async t => {
  const initial = deferred();
  const older = deferred();
  const newer = deferred();
  const reads = [initial.promise, older.promise, newer.promise];
  const h = await mount(t, { read: () => reads.shift() });
  const firstRefresh = h.controller.refresh();
  const secondRefresh = h.controller.refresh();
  assert.equal(h.calls.overview, 3);
  const current = overview({ installation: installation({ phase: 'verifying', actionId: 'new-action' }) });
  current.models[0].name = 'Latest model metadata';
  newer.resolve(current);
  await secondRefresh;
  const latestText = h.root.textContent;
  assert.match(latestText, /Latest model metadata/);
  assert.match(latestText, /驗證中/);
  older.resolve(overview({ installation: installation({ bytes: 10 }) }));
  await firstRefresh;
  assert.equal(h.root.textContent, latestText);
  initial.resolve(overview());
  await settle();
  assert.equal(h.root.textContent, latestText);
  assert.equal(h.clock.tasks.size, 1);
  assert.deepEqual(h.calls.install, []);
});

test('cancel targets the rendered actionId once and a stale view cannot cancel a replacement action', async t => {
  const cancellation = deferred();
  const h = await mount(t, {
    overview: overview({ installation: installation() }),
    cancel: () => cancellation.promise,
  });
  const oldCancel = button(h.root, '取消本次安裝');
  assert.equal(oldCancel.type, 'button');
  oldCancel.click();
  oldCancel.click();
  oldCancel.dispatchEvent({ type: 'click' });
  assert.deepEqual(h.calls.cancel, ['action-A']);
  assert.equal(button(h.root, '取消本次安裝').disabled, true);
  h.setOverview(overview({ installation: installation({ actionId: 'action-B' }) }));
  await h.controller.refresh();
  oldCancel.dispatchEvent({ type: 'click' });
  assert.deepEqual(h.calls.cancel, ['action-A'], 'detached action A is not rebound to B');
  const newCancel = button(h.root, '取消本次安裝');
  assert.equal(newCancel.disabled, false);
  newCancel.click();
  assert.deepEqual(h.calls.cancel, ['action-A', 'action-B']);
  cancellation.resolve();
  await settle();
  assert.deepEqual(h.calls.legacyCancel, []);
  assert.deepEqual(h.calls.install, []);
});

test('installation completion re-reads Main and requires full Quit instead of starting runtime or reloading', async t => {
  const work = deferred();
  const h = await mount(t, { install: () => work.promise });
  button(h.root, '安裝 English recognizer').click();
  assert.equal(h.clock.tasks.size, 1, 'also observe the pending native consent promise');
  const installed = overview({ mode: 'managed', restartRequired: true,
    installation: installation({ phase: 'installed', restartRequired: true }) });
  installed.models[0].state = 'installed';
  installed.models[0].restartRequired = true;
  h.setOverview(installed);
  work.resolve();
  await settle();
  assert.equal(h.calls.overview, 2, 'operation result is not a substitute for the authoritative overview');
  assert.match(h.root.textContent, /已安裝/);
  assert.match(h.root.textContent, /外置/);
  assert.match(h.root.textContent, /完整結束.*Quit.*再開啟/);
  assert.match(h.root.textContent, /只關閉視窗不算/);
  assert.equal(all(h.root, 'button').some(node => (node.getAttribute('aria-label') ?? node.textContent) === '安裝 English recognizer'), false);
  assert.equal(h.clock.tasks.size, 0);
  assert.equal(h.calls.start, 0);
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.fetch, 0);
});

test('failed installs show literal errors and retry only after another explicit consent action', async t => {
  const first = deferred();
  const retry = deferred();
  const work = [first.promise, retry.promise];
  const maliciousCode = '<img src=x onerror="bad()">HASH_MISMATCH';
  const maliciousMessage = '<svg onload="bad()">disk full';
  const h = await mount(t, {
    overview: overview({ installation: installation({ phase: 'failed', errorCode: maliciousCode }) }),
    install: () => work.shift(),
  });
  assert.ok(h.root.textContent.includes(maliciousCode), 'render Main failure code as text');
  assert.equal(h.clock.tasks.size, 0);
  assert.deepEqual(h.calls.install, []);
  button(h.root, '安裝 English recognizer').click();
  assert.match(h.root.textContent, /等待.*同意/);
  assert.equal(h.root.textContent.includes(maliciousCode), false, 'old failure is not presented as the new action');
  h.setOverview(overview({ installation: installation({ actionId: 'failed-retry', phase: 'failed', errorCode: 'DISK_FULL' }) }));
  first.reject(new Error(maliciousMessage));
  await settle();
  assert.equal(h.calls.overview, 2);
  assert.match(h.root.textContent, /安裝失敗/);
  assert.match(h.root.textContent, /DISK_FULL/);
  assert.ok(h.root.textContent.includes(maliciousMessage));
  assert.ok(all(h.root).some(node => node.getAttribute('role') === 'alert'));
  assert.equal(all(h.root, 'img').length, 0);
  assert.equal(all(h.root, 'svg').length, 0);
  assert.equal(h.clock.tasks.size, 0);
  const retryButton = button(h.root, '安裝 English recognizer');
  assert.equal(retryButton.disabled, false);
  assert.deepEqual(h.calls.install, ['english-stt'], 'no automatic retry');
  retryButton.click();
  assert.deepEqual(h.calls.install, ['english-stt', 'english-stt']);
  assert.match(h.root.textContent, /等待.*同意/);
  assert.equal(h.root.textContent.includes(maliciousMessage), false);
  assert.match(h.root.textContent, /使用中/);
  assert.equal(h.calls.fetch, 0);
});

test('overview failures stay literal and can be retried without downloading or losing valid model metadata', async t => {
  const message = '<img src=x onerror="bad()">IPC_OFFLINE';
  for (const startFailed of [false, true]) {
    const reads = startFailed ? [new Error(message), overview()] : [overview(), new Error(message), overview()];
    const h = await mount(t, { read: () => {
      const result = reads.shift();
      if (result instanceof Error) throw result;
      return Promise.resolve(result);
    } });
    if (!startFailed) await assert.doesNotReject(() => h.controller.refresh());
    assert.ok(h.root.textContent.includes(message));
    assert.match(h.root.textContent, /讀取.*失敗/);
    assert.equal(all(h.root, 'img').length, 0);
    if (!startFailed) assert.match(h.root.textContent, /English voice.*使用中/);
    assert.equal(h.clock.tasks.size, 0);
    button(h.root, '重新整理模型狀態').click();
    await settle();
    assert.equal(h.root.textContent.includes(message), false);
    assert.match(h.root.textContent, /English recognizer/);
    assert.deepEqual(h.calls.install, []);
    assert.equal(h.calls.fetch, 0);
    h.controller.dispose();
  }
});

test('runtime availability and English capability gate install even from a stale enabled button', async t => {
  const work = deferred();
  const h = await mount(t, { install: () => work.promise });
  const staleInstall = button(h.root, '安裝 English recognizer');
  const nonEnglish = overview();
  nonEnglish.models[0].languages = ['ja', 'zh'];
  for (const data of [
    overview({ mode: 'unavailable' }),
    overview({ runtime: { state: 'unavailable' } }),
    overview({ enabledLanguages: [] }),
    nonEnglish,
  ]) {
    h.setOverview(data);
    await h.controller.refresh();
    assert.equal(button(h.root, '安裝 English recognizer').disabled, true);
    staleInstall.dispatchEvent({ type: 'click' });
    assert.deepEqual(h.calls.install, []);
    assert.equal(h.clock.tasks.size, 0);
  }
  h.setOverview(overview({ mode: 'managed' }));
  await h.controller.refresh();
  const install = button(h.root, '安裝 English recognizer');
  assert.equal(install.disabled, false);
  install.click();
  assert.deepEqual(h.calls.install, ['english-stt']);
});

test('removal is exposed only by optional IPC plus exact Main permission and re-reads after explicit removal', async t => {
  const data = overview({ mode: 'managed' });
  data.models[0].state = 'installed';
  data.models[0].canRemove = true;
  const withoutMethod = await mount(t, { overview: data });
  assert.equal(withoutMethod.root.textContent.includes('移除'), false);
  withoutMethod.controller.dispose();
  const work = deferred();
  const h = await mount(t, { overview: data, remove: () => work.promise });
  const oldRemove = button(h.root, '移除 English recognizer');
  assert.equal(oldRemove.disabled, false);
  assert.equal(all(h.root, 'button').some(node => node.textContent === '移除 English voice'), false);
  assert.deepEqual(h.calls.remove, []);
  for (const permission of [false, undefined, 'true']) {
    const revoked = structuredClone(data);
    revoked.models[0].canRemove = permission;
    h.setOverview(revoked);
    await h.controller.refresh();
    assert.equal(h.root.textContent.includes('移除'), false);
    oldRemove.dispatchEvent({ type: 'click' });
    assert.deepEqual(h.calls.remove, []);
  }
  h.setOverview(data);
  await h.controller.refresh();
  const remove = button(h.root, '移除 English recognizer');
  assert.equal(remove.type, 'button');
  remove.click();
  remove.click();
  remove.dispatchEvent({ type: 'click' });
  assert.deepEqual(h.calls.remove, ['english-stt']);
  assert.equal(button(h.root, '移除 English recognizer').disabled, true);
  assert.match(h.root.textContent, /移除中/);
  const readsBefore = h.calls.overview;
  h.setOverview(overview());
  work.resolve();
  await settle();
  assert.equal(h.calls.overview, readsBefore + 1);
  assert.match(h.root.textContent, /缺模型/);
  assert.match(h.root.textContent, /使用中/);
  assert.equal(h.clock.tasks.size, 0);
  assert.deepEqual(h.calls.install, []);
  assert.equal(h.calls.start, 0);
});

test('dispose detaches the observer and handlers without cancelling Main work or accepting late results', async t => {
  const work = deferred();
  const pendingRead = deferred();
  let read = () => Promise.resolve(overview());
  const h = await mount(t, { read: () => read(), install: () => work.promise });
  const originalInstall = button(h.root, '安裝 English recognizer');
  originalInstall.click();
  read = () => Promise.resolve(overview({ installation: installation() }));
  await h.controller.refresh();
  const rendered = all(h.root);
  const capturedTick = [...h.clock.tasks.values()][0].callback;
  read = () => pendingRead.promise;
  h.clock.tick();
  const readsBefore = h.calls.overview;
  const textBefore = h.root.textContent;
  h.controller.dispose();
  h.controller.dispose();
  assert.equal(h.clock.tasks.size, 0);
  assert.deepEqual(h.clock.cleared, [0], 'even a zero-valued timer handle is cleared exactly once');
  for (const node of [...rendered, originalInstall]) {
    assert.equal([...node.listeners.values()].reduce((total, set) => total + set.size, 0), 0, 'dispose removes current and retired event handlers');
    node.dispatchEvent({ type: 'click' });
  }
  capturedTick();
  await h.controller.refresh();
  pendingRead.resolve(overview({ restartRequired: true }));
  work.reject(new Error('late install result after panel closed'));
  await settle();
  assert.equal(h.calls.overview, readsBefore);
  assert.equal(h.root.textContent, textBefore);
  assert.equal(h.clock.tasks.size, 0);
  assert.deepEqual(h.calls.install, ['english-stt']);
  assert.deepEqual(h.calls.cancel, [], 'closing settings is not consent to cancel Main installation');
  assert.deepEqual(h.calls.legacyCancel, []);
  assert.equal(h.calls.start, 0);
});

test('cancel failure is retryable only for its own action and stale rejection cannot label a new download', async t => {
  const first = deferred();
  const retry = deferred();
  const cancellations = [first.promise, retry.promise];
  const message = '<img src=x>cannot cancel A';
  const h = await mount(t, {
    overview: overview({ installation: installation() }),
    cancel: () => cancellations.shift(),
  });
  button(h.root, '取消本次安裝').click();
  assert.match(h.root.textContent, /取消中/);
  first.reject(new Error(message));
  await settle();
  assert.ok(h.root.textContent.includes(message));
  assert.match(h.root.textContent, /取消失敗/);
  assert.equal(all(h.root, 'img').length, 0);
  assert.equal(button(h.root, '取消本次安裝').disabled, false);
  assert.equal(button(h.root, '安裝 English recognizer').disabled, true);
  button(h.root, '取消本次安裝').click();
  assert.equal(h.root.textContent.includes(message), false);
  h.setOverview(overview({ installation: installation({ actionId: 'action-B' }) }));
  await h.controller.refresh();
  const currentText = h.root.textContent;
  retry.reject(new Error('stale A cancellation error'));
  await settle();
  assert.equal(h.root.textContent, currentText);
  assert.equal(button(h.root, '取消本次安裝').disabled, false);
  assert.deepEqual(h.calls.cancel, ['action-A', 'action-A']);
  assert.deepEqual(h.calls.legacyCancel, []);
});

test('cancelling stays busy until the original install promise settles rather than claiming early cancellation', async t => {
  const work = deferred();
  const data = overview();
  data.models[1].canRemove = true;
  const h = await mount(t, { overview: data, install: () => work.promise, remove: () => Promise.resolve() });
  const staleRemove = button(h.root, '移除 English voice');
  button(h.root, '安裝 English recognizer').click();
  h.setOverview({ ...data, installation: installation() });
  await h.controller.refresh();
  const oldCancel = button(h.root, '取消本次安裝');
  oldCancel.click();
  h.setOverview({ ...data, installation: installation({ phase: 'cancelling', cancelled: false }) });
  await h.controller.refresh();
  await settle();
  assert.ok(h.root.textContent.includes('取消中，等待原始作業結束'));
  assert.equal(h.root.textContent.includes('已取消'), false);
  assert.equal(button(h.root, '取消本次安裝').disabled, true);
  assert.equal(button(h.root, '安裝 English recognizer').disabled, true);
  assert.equal(button(h.root, '移除 English voice').disabled, true);
  oldCancel.dispatchEvent({ type: 'click' });
  staleRemove.dispatchEvent({ type: 'click' });
  assert.deepEqual(h.calls.cancel, ['action-A']);
  assert.deepEqual(h.calls.remove, []);
  assert.equal(h.clock.tasks.size, 1);
  h.setOverview({ ...data, installation: installation({ phase: 'cancelled', cancelled: true }) });
  await h.controller.refresh();
  assert.ok(h.root.textContent.includes('取消中，等待原始作業結束'), 'a queued terminal projection cannot release the original promise lock');
  assert.equal(h.root.textContent.includes('已取消'), false);
  assert.equal(button(h.root, '安裝 English recognizer').disabled, true);
  work.resolve();
  await settle();
  assert.match(h.root.textContent, /已取消/);
  assert.equal(button(h.root, '安裝 English recognizer').disabled, false);
  assert.equal(h.clock.tasks.size, 0);
  h.controller.dispose();
  const observer = await mount(t, { overview: overview({ installation: installation({ phase: 'cancelling' }) }) });
  assert.ok(observer.root.textContent.includes('取消中，等待原始作業結束'));
  assert.equal(observer.clock.tasks.size, 1, 'a reopened panel keeps observing the original Main transaction');
  assert.equal(button(observer.root, '取消本次安裝').disabled, true);
  assert.equal(button(observer.root, '安裝 English recognizer').disabled, true);
  assert.deepEqual(observer.calls.install, []);
});

test('optional removal failures keep installed models visible and require an explicit retry', async t => {
  const first = deferred();
  const retry = deferred();
  const work = [first.promise, retry.promise];
  const data = overview({ mode: 'managed' });
  data.models[0].state = 'installed';
  data.models[0].canRemove = true;
  const message = '<img src=x>MODEL_IN_USE';
  const h = await mount(t, { overview: data, remove: () => work.shift() });
  button(h.root, '移除 English recognizer').click();
  first.reject(new Error(message));
  await settle();
  assert.match(h.root.textContent, /移除失敗/);
  assert.ok(h.root.textContent.includes(message));
  assert.equal(all(h.root, 'img').length, 0);
  assert.match(h.root.textContent, /English recognizer.*已安裝/);
  assert.equal(button(h.root, '移除 English recognizer').disabled, false);
  assert.deepEqual(h.calls.remove, ['english-stt']);
  assert.equal(h.clock.tasks.size, 0);
  button(h.root, '移除 English recognizer').click();
  assert.deepEqual(h.calls.remove, ['english-stt', 'english-stt']);
  assert.equal(h.root.textContent.includes(message), false);
  h.setOverview(overview());
  retry.resolve();
  await settle();
  assert.match(h.root.textContent, /缺模型/);
  assert.deepEqual(h.calls.install, []);
});

test('progress is indeterminate for unknown totals and clamps invalid byte values to an honest range', async t => {
  const h = await mount(t, { overview: overview({ installation: installation({ total: 0 }) }) });
  assert.match(h.root.textContent, /總大小未知/);
  assert.equal(all(h.root, 'progress')[0].getAttribute('value'), null, 'no fabricated completion percentage');
  assert.doesNotMatch(h.root.textContent, /NaN|Infinity/);
  for (const [bytes, total, expected] of [
    [1024 ** 3, 512 * 1024 ** 2, 512 * 1024 ** 2],
    [-1, 512 * 1024 ** 2, 0],
  ]) {
    h.setOverview(overview({ installation: installation({ bytes, total }) }));
    await h.controller.refresh();
    const progress = all(h.root, 'progress')[0];
    assert.equal(progress.value, expected);
    assert.equal(progress.max, total);
    assert.doesNotMatch(h.root.textContent, /NaN|Infinity|200%|-[0-9.]+ MiB/);
  }
  h.setOverview(overview({ installation: installation({ bytes: Infinity, total: Infinity }) }));
  await h.controller.refresh();
  assert.match(h.root.textContent, /總大小未知/);
  assert.equal(all(h.root, 'progress')[0].getAttribute('value'), null);
  assert.doesNotMatch(h.root.textContent, /NaN|Infinity/);
});

test('progress refresh preserves keyboard focus only for the same action and never steals external focus', async t => {
  const h = await mount(t, { overview: overview({ installation: installation() }) });
  button(h.root, '取消本次安裝').focus();
  h.setOverview(overview({ installation: installation({ bytes: 100 }) }));
  h.clock.tick();
  await settle();
  assert.ok(h.document.activeElement === button(h.root, '取消本次安裝'), 'same action retains keyboard focus after progress render');
  assert.equal(h.root.contains(h.document.activeElement), true);
  h.setOverview(overview({ installation: installation({ actionId: 'action-B' }) }));
  await h.controller.refresh();
  assert.ok(h.document.activeElement !== button(h.root, '取消本次安裝'), 'focus must not be rebound from action A to B');
  const outside = h.document.createElement('button');
  outside.focus();
  await h.controller.refresh();
  assert.equal(h.document.activeElement, outside);
  assert.deepEqual(h.calls.cancel, []);
});

test('retry after cancellation waits for new consent instead of attributing the old cancelled action to the new promise', async t => {
  const work = deferred();
  const h = await mount(t, {
    overview: overview({ installation: installation({ phase: 'cancelled', cancelled: true }) }),
    install: () => work.promise,
  });
  button(h.root, '安裝 English recognizer').click();
  assert.match(h.root.textContent, /等待.*同意/);
  assert.equal(h.root.textContent.includes('取消中'), false);
  await h.controller.refresh();
  assert.match(h.root.textContent, /等待.*同意/);
  h.setOverview(overview({ installation: installation({ actionId: 'action-B', phase: 'cancelled', cancelled: true }) }));
  await h.controller.refresh();
  assert.ok(h.root.textContent.includes('取消中，等待原始作業結束'));
  work.resolve();
  await settle();
  assert.match(h.root.textContent, /已取消/);
  assert.equal(h.clock.tasks.size, 0);
  assert.deepEqual(h.calls.install, ['english-stt']);
  assert.deepEqual(h.calls.cancel, []);
});

test('Windows overview renders Windows wording and a CPU-only note; macOS wording unchanged', async t => {
  const w = await mount(t, { overview: overview({ platform: 'win32' }) });
  assert.match(w.root.textContent, /Windows 原生語音模型/);
  assert.match(w.root.textContent, /Windows 原生對話框/);
  assert.match(w.root.textContent, /CPU/);
  assert.doesNotMatch(w.root.textContent, /macOS/);
  const m = await mount(t, { overview: overview({ platform: 'darwin' }) });
  assert.match(m.root.textContent, /macOS 原生語音模型/);
  assert.doesNotMatch(m.root.textContent, /Windows/);
});

function tierOverview(overrides = {}) {
  const stt = (id, tier, extra = {}) => ({ modelId: id, name: id, kind: 'stt', languages: ['en'], bytes: 100 * 1024 ** 2,
    license: { spdx: 'MIT', url: 'https://example.test/l' }, state: 'installed', restartRequired: false,
    canRemove: false, tier, selected: false, recommended: false, warning: null, ...extra });
  return overview({
    models: [
      stt('w-tiny', 'ultrafast', { canRemove: true }),
      stt('w-base', 'fast', { state: 'missing' }),
      stt('w-small', 'balanced', { selected: true, recommended: true, state: 'active' }),
      stt('w-turbo', 'accurate', { warning: 'CPU_SLOW_ACCURATE', canRemove: true }),
      { modelId: 'english-tts', name: 'English voice', kind: 'tts', languages: ['en'], bytes: 2 * 1024 ** 3,
        license: { spdx: 'Apache-2.0', url: 'https://example.test/tts' }, state: 'active', restartRequired: false, canRemove: false },
    ],
    stt: { selectedModelId: 'w-small', source: 'preference', preferenceError: null,
      recommendedModelId: 'w-small', recommendationReason: 'WIN_AVX2_16GB_OR_MORE' },
    ...overrides,
  });
}

test('STT tiers render as a pick-one group: titles, one line, tags, reason and the CPU warning as text', async t => {
  const { root } = await mount(t, { overview: tierOverview(), select: async () => {}, remove: async () => {} });
  const text = root.textContent;
  for (const fragment of ['語音辨識', '語音合成', '極速', '快速', '平衡', '精準', '速度與準確度兼顧',
    '推薦「平衡」：此電腦記憶體 16 GB 以上', '可改選任何一檔', '每句約需 5 秒以上', 'w-small · 100.0 MiB · MIT']) {
    assert.ok(text.includes(fragment), `missing ${fragment}`);
  }
  const rows = all(root).filter(n => /native-model-tier/.test(n.getAttribute?.('class') || ''));
  assert.deepEqual(rows.map(r => all(r).find(n => /native-model-name/.test(n.getAttribute?.('class') || '')).textContent),
    ['極速', '快速', '平衡', '精準'], 'tiers in speed order');
  const selected = rows.find(r => /is-selected/.test(r.getAttribute('class')));
  const tags = all(selected).filter(n => /native-model-tag/.test(n.getAttribute?.('class') || '')).map(n => n.textContent);
  assert.deepEqual(tags, ['使用中', '推薦']);
  assert.ok(!all(root, 'button').some(b => b.getAttribute('aria-label') === '選用 w-small'), 'the selected tier has no select button');
  const use = all(root, 'button').find(b => b.getAttribute('aria-label') === '選用 w-turbo');
  assert.equal(use.textContent, '使用', 'short visible label, full accessible name');
});

test('select calls Main once with the modelId, then re-reads; unsupported API hides select buttons', async t => {
  let current = tierOverview();
  const { root, calls, setOverview } = await mount(t, { overview: current, select: async id => {
    current = tierOverview({ stt: { ...current.stt, selectedModelId: id, source: 'preference' }, restartRequired: true });
    setOverview(current);
  } });
  const before = calls.overview;
  button(root, '選用 w-turbo').click();
  await settle(); await settle();
  assert.deepEqual(calls.select, ['w-turbo']);
  assert.ok(calls.overview > before);
  assert.deepEqual(calls.install, [], 'selecting never starts a download');
  const plain = await mount(t, { overview: tierOverview() });
  assert.ok(!all(plain.root, 'button').some(b => /^選用 /.test(b.getAttribute('aria-label') || '')));
});

test('remove buttons follow Main canRemove exactly; selected, active and TTS rows have none', async t => {
  const { root, calls } = await mount(t, { overview: tierOverview(), select: async () => {}, remove: async () => {} });
  const removeButtons = all(root, 'button').map(b => b.getAttribute('aria-label') || '').filter(n => /^移除 /.test(n)).sort();
  assert.deepEqual(removeButtons, ['移除 w-tiny', '移除 w-turbo']);
  button(root, '移除 w-tiny').click();
  await settle(); await settle();
  assert.deepEqual(calls.remove, ['w-tiny']);
});

test('an invalid preference is shown as an alert and not as a default selection', async t => {
  const { root } = await mount(t, { overview: tierOverview({ stt: { selectedModelId: null, source: null,
    preferenceError: 'STT_PREFERENCE_INVALID', recommendedModelId: 'w-small', recommendationReason: 'MAC_16GB_OR_MORE' } }),
    select: async () => {} });
  const alert = all(root).find(n => n.getAttribute?.('role') === 'alert' && n.textContent.includes('STT_PREFERENCE_INVALID'));
  assert.ok(alert, root.textContent);
});
