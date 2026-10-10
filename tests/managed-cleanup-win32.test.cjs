'use strict';
// Windows evidence: Electron 44 (Node 24.18.1) fs.rmSync fails with EPERM on a
// read-only (0o400) snapshot file on win32; system Node 24.14.1 succeeds.
// This fixture injects that exact fs behavior into the coordinator's real path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lease = require('../apps/desktop/managed-asset-lease.cjs');

function electronWin32Fs(calls) {
  // rmSync refuses any tree that still holds a file without the owner write bit.
  const hasReadOnly = dir => fs.readdirSync(dir, {withFileTypes: true}).some(entry => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? hasReadOnly(p) : (fs.lstatSync(p).mode & 0o200) === 0;
  });
  return {...fs, rmSync(root, options) {
    calls.push(['rmSync', root]);
    if (hasReadOnly(root)) { const e = new Error(`EPERM, Permission denied: '${root}'`); e.code = 'EPERM'; e.syscall = 'rm'; throw e; }
    return fs.rmSync(root, options);
  }, chmodSync(p, mode) { calls.push(['chmodSync', p, mode]); return fs.chmodSync(p, mode); }};
}

function setup(t) {
  const appRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cleanup-win32-'));
  t.after(() => { try { fs.chmodSync(appRoot, 0o700); } catch {} fs.rmSync(appRoot, {recursive: true, force: true}); });
  const coordinator = lease.getManagedAssetCoordinator(appRoot);
  const root = path.join(appRoot, 'runtime', 'snapshots', 's-' + 'a'.repeat(64));
  const operation = coordinator.begin(root, null, 1024, () => null);
  const owner = {}, pin = coordinator.pin(root, owner);
  fs.mkdirSync(path.join(appRoot, 'runtime', 'snapshots'), {recursive: true, mode: 0o700});
  fs.mkdirSync(root, {mode: 0o700}); coordinator.created(root);
  const file = path.join(root, 'payload', 'models', 'm', 'model.bin');
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, 'weights'); fs.chmodSync(file, 0o400);
  fs.mkdirSync(path.join(root, 'temp'), {mode: 0o700});
  return {appRoot, coordinator, root, file, operation, release: async () => { await coordinator.finish(operation); await pin.release(owner); }};
}

test('win32: read-only snapshot files are made writable without following links, then removed', async t => {
  const s = setup(t), calls = [];
  s.coordinator.io.remove = root => lease.removeManagedTree(root, {platform: 'win32', fs: electronWin32Fs(calls)});
  await s.release();
  assert.equal(fs.existsSync(s.root), false);
  assert.equal(s.coordinator.roots.has(s.root), false);
  assert.deepEqual(calls.filter(c => c[0] === 'chmodSync'), [['chmodSync', s.file, 0o600]]);
  assert.equal(calls.filter(c => c[0] === 'rmSync').length, 1);
});

test('win32: persistent removal failure keeps the root and fails closed (ASSET_CLEANUP_FAILED path)', async t => {
  const s = setup(t);
  s.coordinator.io.remove = root => lease.removeManagedTree(root, {platform: 'win32', fs: {...electronWin32Fs([]),
    rmSync() { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }}});
  await s.release();
  assert.equal(s.coordinator.roots.has(s.root), true);
  assert.match(s.coordinator.snapshot().retained[0].error, /EBUSY/);
});

test('win32: a link inside the owned tree is refused; nothing is chmodded through it', async t => {
  const s = setup(t), calls = [];
  const outside = path.join(s.appRoot, 'outside.txt'); fs.writeFileSync(outside, 'x'); fs.chmodSync(outside, 0o400);
  fs.symlinkSync(outside, path.join(s.root, 'payload', 'link'));
  s.coordinator.io.remove = root => lease.removeManagedTree(root, {platform: 'win32', fs: electronWin32Fs(calls)});
  await s.release();
  assert.equal(s.coordinator.roots.has(s.root), true);
  assert.match(s.coordinator.snapshot().retained[0].error, /CLEANUP_UNSAFE_PATH/);
  assert.equal(calls.length, 0);
  assert.equal(fs.lstatSync(outside).mode & 0o777, 0o400);
});

test('win32: changed root identity is refused before any chmod or removal', async t => {
  const s = setup(t), calls = [];
  s.coordinator.io.remove = root => lease.removeManagedTree(root, {platform: 'win32', fs: electronWin32Fs(calls)});
  fs.chmodSync(s.file, 0o600);
  fs.renameSync(s.root, s.root + '-moved'); fs.mkdirSync(s.root, {mode: 0o700});
  await s.release();
  assert.equal(s.coordinator.roots.has(s.root), true);
  assert.match(s.coordinator.snapshot().retained[0].error, /CLEANUP_OWNERSHIP_CHANGED/);
  assert.equal(calls.length, 0);
});

test('darwin: unchanged single fs.rmSync, no chmod and no retry', async t => {
  const s = setup(t), calls = [];
  s.coordinator.io.remove = root => lease.removeManagedTree(root, {platform: 'darwin', fs: electronWin32Fs(calls)});
  await s.release();
  // The injected Electron-win32 behavior still rejects read-only trees: darwin must not mutate modes.
  assert.equal(s.coordinator.roots.has(s.root), true);
  assert.deepEqual(calls.map(c => c[0]), ['rmSync']);
  assert.equal(fs.lstatSync(s.file).mode & 0o777, 0o400);
});

test('default io.remove dispatches on the host platform', () => {
  const c = lease.getManagedAssetCoordinator(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cleanup-io-')));
  assert.equal(typeof lease.removeManagedTree, 'function');
  assert.equal(c.io.remove.length, 1);
});
