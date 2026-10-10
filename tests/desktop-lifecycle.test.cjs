const test = require('node:test');
const assert = require('node:assert/strict');
const { enforceSingleInstance, restoreOrCreateWindow } = require('../apps/desktop/lifecycle.cjs');

test('smoke test exits nonzero when the single-instance lock is unavailable', () => {
  const calls = [];
  const allowed = enforceSingleInstance({
    hasLock: false,
    isSmokeTest: true,
    app: { exit: code => calls.push(['exit', code]), quit: () => calls.push(['quit']) },
  });
  assert.equal(allowed, false);
  assert.deepEqual(calls, [['exit', 1]]);
});

test('normal second instance quits quietly when lock is unavailable', () => {
  const calls = [];
  const allowed = enforceSingleInstance({
    hasLock: false,
    isSmokeTest: false,
    app: { exit: code => calls.push(['exit', code]), quit: () => calls.push(['quit']) },
  });
  assert.equal(allowed, false);
  assert.deepEqual(calls, [['quit']]);
});

test('second-instance does not create a renderer before application startup completes', async () => {
  let created = 0;
  await restoreOrCreateWindow({
    getWindow: () => null,
    createWindow: async () => { created += 1; },
    canCreate: false,
  });
  assert.equal(created, 0);
});

test('second-instance recreates a missing or destroyed window', async () => {
  let created = 0;
  await restoreOrCreateWindow({ getWindow: () => null, createWindow: async () => { created += 1; } });
  await restoreOrCreateWindow({
    getWindow: () => ({ isDestroyed: () => true }),
    createWindow: async () => { created += 1; },
  });
  assert.equal(created, 2);
});

test('second-instance restores and focuses an existing window', async () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus'),
  };
  await restoreOrCreateWindow({ getWindow: () => window, createWindow: async () => calls.push('create') });
  assert.deepEqual(calls, ['restore', 'focus']);
});
