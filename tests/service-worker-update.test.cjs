const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'service-worker.js'), 'utf8');
const appCacheMatch = source.match(/const APP_CACHE = "([^"]+)"/);
assert.ok(appCacheMatch, 'service worker must declare APP_CACHE');
const currentAppCache = appCacheMatch[1];

function createHarness({ cacheKeys = [], failPrecache = false, hasActiveWorker = false, rejectNavigationUrl = '' } = {}) {
  const listeners = {};
  const deleted = [];
  const navigated = [];
  let claimed = 0;
  let skipped = 0;
  const cachedResponses = new Map();
  const cache = {
    async addAll() {
      if (failPrecache) throw new Error('offline');
    },
    async match(key) { return cachedResponses.get(String(key)) || null; },
    async put(key, value) { cachedResponses.set(String(key), value); },
    async delete(key) { return cachedResponses.delete(String(key)); },
  };
  const clients = [
    { url: 'https://voice.example/app/', async navigate(url) {
      if (url === rejectNavigationUrl) throw new Error('tab closed');
      navigated.push(url);
    } },
    { url: 'https://voice.example/app/index.html', async navigate(url) { navigated.push(url); } },
    { url: 'https://voice.example/other/', async navigate(url) { navigated.push(`OUTSIDE:${url}`); } },
  ];
  const context = vm.createContext({
    AbortController,
    URL,
    Request,
    Response,
    Set,
    Object,
    Promise,
    setTimeout,
    clearTimeout,
    fetch: async () => new Response('ok'),
    caches: {
      async open() { return cache; },
      async keys() { return [...cacheKeys, currentAppCache]; },
      async delete(key) { deleted.push(key); return true; },
      async match() { return null; },
    },
    self: {
      registration: { scope: 'https://voice.example/app/', active: hasActiveWorker ? {} : null },
      addEventListener(type, handler) { listeners[type] = handler; },
      async skipWaiting() { skipped += 1; },
      clients: {
        async claim() { claimed += 1; },
        async matchAll() { return clients; },
      },
      location: { origin: 'https://voice.example' },
    },
  });
  vm.runInContext(source, context);

  async function dispatch(type) {
    let pending;
    listeners[type]({
      request: new Request('https://voice.example/app/'),
      respondWith(value) { pending = value; },
      waitUntil(value) { pending = value; },
    });
    return pending;
  }

  return {
    dispatch,
    deleted,
    navigated,
    get claimed() { return claimed; },
    get skipped() { return skipped; },
  };
}

test('successful service worker upgrade takes over and refreshes only in-scope windows once', async () => {
  const harness = createHarness({
    cacheKeys: ['voice-practice-app-v17-20260831', 'unrelated-cache'],
    hasActiveWorker: true,
  });
  await harness.dispatch('install');
  await harness.dispatch('activate');

  assert.equal(harness.skipped, 1);
  assert.equal(harness.claimed, 1);
  assert.deepEqual(harness.deleted, ['voice-practice-app-v17-20260831']);
  assert.deepEqual(harness.navigated, [
    'https://voice.example/app/',
    'https://voice.example/app/index.html',
  ]);
});

test('first service worker installation claims clients without refreshing the page', async () => {
  const harness = createHarness();
  await harness.dispatch('install');
  await harness.dispatch('activate');

  assert.equal(harness.skipped, 1);
  assert.equal(harness.claimed, 1);
  assert.deepEqual(harness.navigated, []);
});

test('active old worker triggers refresh even when its app cache was evicted', async () => {
  const harness = createHarness({ hasActiveWorker: true });
  await harness.dispatch('install');
  await harness.dispatch('activate');
  assert.deepEqual(harness.navigated, [
    'https://voice.example/app/',
    'https://voice.example/app/index.html',
  ]);
});

test('prefix-colliding non-version cache is preserved and does not turn first install into upgrade', async () => {
  const harness = createHarness({ cacheKeys: ['voice-practice-app-models'] });
  await harness.dispatch('install');
  await harness.dispatch('activate');
  assert.deepEqual(harness.deleted, []);
  assert.deepEqual(harness.navigated, []);
});

test('one closing tab cannot prevent other in-scope clients from refreshing', async () => {
  const harness = createHarness({
    hasActiveWorker: true,
    rejectNavigationUrl: 'https://voice.example/app/',
  });
  await harness.dispatch('install');
  await harness.dispatch('activate');
  assert.deepEqual(harness.navigated, ['https://voice.example/app/index.html']);
});

test('failed precache never calls skipWaiting', async () => {
  const harness = createHarness({ cacheKeys: ['voice-practice-app-v17-20260831'], failPrecache: true });
  await assert.rejects(harness.dispatch('install'), /offline/);
  assert.equal(harness.skipped, 0);
});
