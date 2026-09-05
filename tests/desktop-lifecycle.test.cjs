const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { enforceSingleInstance, restoreOrCreateWindow, writeSmokeResult } = require('../apps/desktop/lifecycle.cjs');

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

test('writes smoke result exclusively to a direct child of the temporary root', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-smoke-result-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const resultPath = path.join(tempRoot, 'portable-result.txt');
  const marker = 'PACKAGED_APP_SMOKE_OK:Voice Practice';

  await writeSmokeResult({ filePath: resultPath, tempRoot, marker });
  assert.equal(await fs.readFile(resultPath, 'utf8'), `${marker}\n`);
  await assert.rejects(
    writeSmokeResult({ filePath: resultPath, tempRoot, marker: 'PACKAGED_APP_SMOKE_OK:Replacement' }),
    error => error?.code === 'EEXIST',
  );
});

test('rejects smoke result paths outside or below subdirectories of the temporary root', async t => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-smoke-result-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    writeSmokeResult({ filePath: path.join(tempRoot, 'nested', 'result.txt'), tempRoot, marker: 'PACKAGED_APP_SMOKE_OK:Nested' }),
    /INVALID_SMOKE_RESULT_PATH/,
  );
  await assert.rejects(
    writeSmokeResult({ filePath: path.join(tempRoot, '..', 'outside.txt'), tempRoot, marker: 'PACKAGED_APP_SMOKE_OK:Outside' }),
    /INVALID_SMOKE_RESULT_PATH/,
  );
});

test('restores and focuses an existing window', async () => {
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
