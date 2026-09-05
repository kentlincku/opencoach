const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const modulePath = path.join(__dirname, '../apps/web/runtime/model-cache.js');
const { requestPersistentStorage, estimateStorage } = require(modulePath);

test('persistent storage request reports granted and degrades safely', async () => {
  assert.equal(await requestPersistentStorage({ storage: { persist: async () => true } }), true);
  assert.equal(await requestPersistentStorage({ storage: { persist: async () => false } }), false);
  assert.equal(await requestPersistentStorage({}), false);
  assert.equal(await requestPersistentStorage({ storage: { persist: async () => { throw new Error('denied'); } } }), false);
});

test('storage estimate returns bounded local capacity information', async () => {
  assert.deepEqual(
    await estimateStorage({ storage: { estimate: async () => ({ usage: 40, quota: 100 }) } }),
    { usage: 40, quota: 100, remaining: 60 },
  );
  assert.deepEqual(
    await estimateStorage({ storage: { estimate: async () => ({ usage: 120, quota: 100 }) } }),
    { usage: 120, quota: 100, remaining: 0 },
  );
  assert.equal(await estimateStorage({}), null);
});
