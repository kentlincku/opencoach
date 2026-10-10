'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preload() {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../apps/desktop/preload.cjs'), 'utf8'), {
    require: id => {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'electronAPI'); api = value; } },
        ipcRenderer: { invoke(channel, payload) { calls.push({ channel, payload }); return Promise.resolve({}); } },
      };
    },
  });
  return { api, calls };
}

test('native model overview has a narrow parameter-free preload command', async () => {
  const { api, calls } = preload();
  assert.equal(typeof api.nativeModelOverview, 'function', 'preload must expose the cached native model overview');
  await api.nativeModelOverview();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'models:overview');
  assert.equal(calls[0].payload, undefined);
});

test('native model cancellation sends only an exact action ID without coercion', async () => {
  const { api, calls } = preload();
  assert.equal(typeof api.cancelNativeModelInstallAction, 'function');
  const id = '3ac3c5f0-e9b3-4df1-b199-167c6f091781';
  await api.cancelNativeModelInstallAction(id);
  assert.equal(calls[0].channel, 'models:cancel-action');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)), { actionId: id });
  for (const value of [null, {}, 42, '', '../path', 'https://example.com/model', { toString: () => id }]) {
    assert.throws(() => api.cancelNativeModelInstallAction(value), /INVALID_MODEL_ACTION/);
  }
  assert.equal(calls.length, 1);
});
