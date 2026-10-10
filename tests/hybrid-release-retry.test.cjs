'use strict';
// NON_NATIVE: tiny real files/managers/lease and actual Main before-quit logic.
// R55's authentic v2 producer exercises the shared Darwin release branch without
// claiming a compiled hybrid runtime, native no-fork coverage or a running App.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {createRequire} = require('node:module');
const {createHash, randomUUID} = require('node:crypto');
const {ModelManager} = require('../apps/desktop/model-manager.cjs');
const {canonicalInventory} = require('../apps/desktop/tree-integrity.cjs');
const trust = require('../apps/desktop/asset-manifest-trust.cjs');
const bundled = require('../apps/desktop/bundled-voice-assets.cjs');
const ROOT = path.resolve(__dirname, '..');
const CONTROL = path.join(ROOT, 'native/darwin/runtime-lifetime/controlled.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hybrid-release-retry-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { fs.rmSync(root, {recursive: true, force: true}); }
  });
  const userData = path.join(root, 'user-data');
  const resourcesPath = path.join(root, 'Tiny.app', 'Contents', 'Resources');
  const license = {spdx: 'MIT', url: 'https://example.test/lifetime-fixture-license'};
  const contents = {
    'tiny-stt': {'config.json': Buffer.from('{}'), 'weights.safetensors': Buffer.from('tiny weights')},
    'tiny-kokoro': {'model.onnx': Buffer.from('tiny onnx'), 'voices.bin': Buffer.from('tiny voices')},
  };
  const artifacts = Object.fromEntries(Object.entries(contents).map(([id, files]) => {
    const inventory = canonicalInventory(Object.entries(files).map(([name, bytes]) =>
      ({path: name, bytes: bytes.length, sha256: hash(bytes)})));
    const revision = hash('lifetime synthetic revision').slice(0, 40);
    return [id, {transport: 'raw-files', bytes: inventory.totalBytes, entrypoint: inventory.files[0].path,
      files: inventory.files, treeDigest: inventory.treeDigest,
      sources: Object.fromEntries(inventory.files.map(file =>
        [file.path, `https://huggingface.co/fixture/${id}/resolve/${revision}/${file.path}`])),
      provenance: {sourceRevision: revision, sourceUrl: `https://huggingface.co/fixture/${id}`, license}}];
  }));
  const manifest = {schemaVersion: 3, release: 'lifetime-fixture-v1', models:
    Object.fromEntries(Object.entries(artifacts).map(([id, artifact]) =>
      [id, {name: id, purpose: 'inert fixture data', license, artifacts: {'darwin-arm64': artifact}}]))};
  trust.authenticateAssetManifest(manifest, 'model', {testOnlyTrustedDigests: [trust.manifestDigest(manifest)]});
  const models = new ModelManager({userData, manifest, platform: 'darwin', arch: 'arm64', fetchImpl: async url => {
    for (const [id, artifact] of Object.entries(artifacts)) {
      const file = artifact.files.find(file => artifact.sources[file.path] === url);
      if (file) {
        const response = new Response(contents[id][file.path]);
        Object.defineProperty(response, 'url', {value: url});
        return response;
      }
    }
    throw Error('UNEXPECTED_FIXTURE_DOWNLOAD');
  }});
  const installed = {};
  for (const id of Object.keys(artifacts)) installed[id] = await models.install(id);
  const runtimeBytes = Buffer.from('inert runtime bytes; never executed\n');
  const runtime = canonicalInventory([{path: 'bin/voice-runtime', bytes: runtimeBytes.length, sha256: hash(runtimeBytes)}]);
  const whole = canonicalInventory(runtime.files.map(file => ({...file, path: `runtime/${file.path}`})));
  const command = path.join(resourcesPath, 'voice-assets', 'runtime', 'bin', 'voice-runtime');
  fs.mkdirSync(path.dirname(command), {recursive: true, mode: 0o700});
  fs.writeFileSync(command, runtimeBytes, {mode: 0o600});
  fs.writeFileSync(path.join(resourcesPath, 'voice-assets-inventory.json'), JSON.stringify({files: whole.files}), {mode: 0o600});
  const raw = id => ({modelId: id, identity: {kind: 'raw-files', treeDigest: artifacts[id].treeDigest}});
  const nativeRuntime = await bundled.prepareBundledRuntimeAssets({resourcesPath, platform: 'darwin', trust: {
    schemaVersion: 2, mode: 'runtime-only', treeDigest: whole.treeDigest, runtimeTreeDigest: runtime.treeDigest,
    fileCount: whole.fileCount, entrypoint: 'runtime/bin/voice-runtime', runtimeProfile: 'macos-mlx-kokoro-v1',
    modelManifestDigest: trust.manifestDigest(manifest), capabilitiesDigest: hash('inert capabilities'),
    modelBindings: {sttRoot: raw('tiny-stt'), onnxModel: {...raw('tiny-kokoro'), path: 'model.onnx'},
      onnxVoices: {...raw('tiny-kokoro'), path: 'voices.bin'}},
  }});
  assert.equal(bundled.describeBundledRuntimeSource(nativeRuntime).authority, 'NON_NATIVE_TEST_ROOT');
  return {root, userData, resourcesPath, cleanups, models, installed, command, nativeRuntime};
}

function boundary(f) {
  const cache = new Map(), errors = [], quitEvents = [], children = [], handles = new WeakMap();
  let spawnCalls = 0;
  let controlDispatch = null;
  class MemoryChild extends EventEmitter {
    constructor(args) {
      super(); this.args = args; this.pid = 1000 + children.length;
      this.exitCode = this.signalCode = null; this.killed = false;
      this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
      this.stdio = [this.stdin, this.stdout, this.stderr, new PassThrough()];
    }
    kill() { this.killed = true; return true; }
  }
  const noOSProcess = () => { throw Error('UNEXPECTED_OS_PROCESS'); };
  const cp = {...require('node:child_process'),
    ...Object.fromEntries(['exec', 'execFile', 'execSync', 'execFileSync', 'fork', 'spawnSync'].map(key => [key, noOSProcess])),
    spawn(command, args) {
      spawnCalls++;
      if (!controlDispatch) throw Error('UNEXPECTED_OS_SPAWN');
      if (controlDispatch.error) throw controlDispatch.error;
      assert.equal(command, process.execPath);
      assert.equal(args[0], CONTROL);
      const child = new MemoryChild(args); children.push(child); return child;
    }};
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), // only the real shutdown listener is exercised
    getPath: name => name === 'userData' ? f.userData : f.root,
    getAppPath: () => ROOT,
    quit() {
      const event = {prevented: false, preventDefault() { this.prevented = true; }};
      app.emit('before-quit', event);
      quitEvents.push(event);
    },
  });
  class MemoryMenu {
    constructor(items = []) { this.items = items; }
    append(item) { this.items.push(item); }
    static buildFromTemplate(items) { return new MemoryMenu(items); }
    static getApplicationMenu() { return null; }
    static setApplicationMenu() {}
  }
  const electron = {app, BrowserWindow: class {}, Menu: MemoryMenu,
    MenuItem: class { constructor(value) { Object.assign(this, value); } },
    ipcMain: {handle() {}}, safeStorage: {}, shell: {}, dialog: {showErrorBox() {}}};
  const isolated = new Set(['main.cjs', 'managed-asset-lease.cjs', 'sidecar-client.cjs', 'darwin-owned-lifetime.cjs']);
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = {exports: {}};
    cache.set(file, module);
    const realRequire = createRequire(file);
    const requireAtBoundary = id => {
      if (id === 'electron') return electron;
      if (id === 'node:child_process') return cp;
      if (id.startsWith('./') && isolated.has(path.basename(id))) return load(path.resolve(path.dirname(file), id));
      return realRequire(id);
    };
    let source = fs.readFileSync(file, 'utf8');
    if (path.basename(file) === 'main.cjs') source += `\nmodule.exports = {
      adopt(client, bundle) {
        const assets = bindClientAssets(client, bundle);
        ownClient(client, assets);
        return assets;
      },
      state(client) { return {record: ownedClients.get(client), count: ownedClients.size,
        shutdownPromise, quitAllowed, shuttingDown}; },
    };`;
    vm.runInNewContext(source, {module, exports: module.exports, require: requireAtBoundary,
      __dirname: path.dirname(file), __filename: file, Buffer, URL, AbortController,
      setTimeout, clearTimeout, setImmediate, clearImmediate,
      console: {log() {}, warn() {}, error: (...args) => errors.push(args)},
      process: {platform: 'darwin', arch: 'arm64', execPath: process.execPath, env: {}, argv: [],
        pid: process.pid, resourcesPath: f.resourcesPath}}, {filename: file});
    if (path.basename(file) === 'darwin-owned-lifetime.cjs') {
      const create = module.exports.createDarwinProducer;
      // Capture the actual producer handle, not a fabricated snapshot or scope.
      module.exports = {...module.exports, createDarwinProducer(owner, options) {
        const producer = create(owner, options); handles.set(owner, producer); return producer;
      }};
    }
    return module.exports;
  }
  const main = load(path.join(ROOT, 'apps/desktop/main.cjs'));
  const managed = load(path.join(ROOT, 'apps/desktop/managed-asset-lease.cjs'));
  const producer = load(path.join(ROOT, 'apps/desktop/darwin-owned-lifetime.cjs'));
  const {SidecarClient} = load(path.join(ROOT, 'apps/desktop/sidecar-client.cjs'));
  return {main, managed, producer, SidecarClient, errors, quitEvents, children, spawnCalls: () => spawnCalls,
    dispatchControl(client, error = null) {
      // MEMORY R55 events only, never hybrid launch/source proof or an OS child.
      controlDispatch = {error};
      const previous = children.length;
      try {
        const child = producer.spawnDarwinLeader(handles.get(client), client, {command: client.command,
          args: client.args, env: client.env, generation: randomUUID()});
        for (const original of children.slice(previous)) original.emit('spawn');
        return child;
      } finally { controlDispatch = null; }
    },
    quit() {
      const event = {prevented: false, preventDefault() { this.prevented = true; }};
      app.emit('before-quit', event);
      return {event, work: main.state().shutdownPromise};
    }};
}

async function prepare(t, {control = true, mode = 'normal'} = {}) {
  const f = await fixture(t), b = boundary(f);
  const lease = b.managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models);
  const coordinator = f.models.coordinator, remove = coordinator.io.remove;
  f.cleanups.push(async () => {
    coordinator.io.remove = remove;
    // Test teardown is not retirement evidence and is never counted as success.
    lease.cancel();
    await lease.release();
  });
  assert.equal(await lease.work, lease);
  assert.equal(await lease.verify(), true);
  const client = new b.SidecarClient(control
    ? {command: process.execPath, args: [CONTROL, 'leader', mode], env: {},
      trackAssetLifetime: true, lifetimePurpose: 'r55-control'}
    : {command: lease.command, env: {}, trackAssetLifetime: true,
      lifetimePurpose: 'hybrid-speech', nativeRuntime: f.nativeRuntime});
  const binding = b.main.adopt(client, lease);
  const snapshot = client.assetLifetimeSnapshot();
  assert.equal(snapshot.schemaVersion, control ? 2 : 1);
  assert.equal(snapshot.coverage, control ? 'darwin-owned-handles' : 'leader-only');
  assert.equal(snapshot.qualificationScope, control ? 'R55_FIRST_PARTY_FIXED_GRAPH' : undefined);
  assert.equal(b.producer.authenticatedDarwinSnapshot(snapshot, client, lease), control);
  assert.equal(b.producer.authenticatedDarwinSnapshot({...snapshot}, client, lease), false);
  assert.equal(b.producer.authenticatedDarwinSnapshot(snapshot, {}, lease), false);
  assert.equal(b.producer.authenticatedDarwinSnapshot(snapshot, client, {...lease}), false);
  return {...f, b, lease, client, binding, coordinator, remove};
}

test('Main Quit retries the original Darwin-bound hybrid lease after temporary cleanup failure', {timeout: 10000}, async t => {
  const f = await prepare(t), {b, lease, client, binding, coordinator} = f;
  const record = b.main.state(client).record;
  assert.equal(record.assets, binding);
  assert.equal(binding.bundle, lease);
  assert.equal(coordinator.snapshot().pins, 1);
  await assert.rejects(binding.release(client, lease), /ASSET_LIFETIME_UNCONFIRMED/, 'retirement is mandatory');
  let busy = true, removals = 0;
  coordinator.io.remove = root => {
    assert.equal(root, lease.root, 'cleanup must target only the original private snapshot');
    removals++;
    if (busy) throw Object.assign(Error('FIXTURE_EBUSY'), {code: 'EBUSY'});
    return f.remove(root);
  };
  const first = b.quit();
  assert.equal(first.event.prevented, true);
  assert.ok(first.work);
  await first.work; // Main catches the failure; assert its retained state, not promise resolution.
  assert.equal(b.errors.length, 1);
  assert.equal(b.errors[0][1].message, 'ASSET_CLEANUP_FAILED');
  assert.equal(b.main.state(client).record, record);
  assert.equal(b.main.state(client).quitAllowed, false);
  assert.equal(b.main.state(client).shutdownPromise, null);
  assert.equal(b.quitEvents.length, 0);
  assert.equal(fs.existsSync(lease.root), true);
  const retained = coordinator.snapshot().retained.find(value => value.root === lease.root);
  assert.equal(retained.error, 'FIXTURE_EBUSY');
  assert.ok(retained.reservation > 0);
  assert.ok(removals > 0);
  const failedRemovals = removals;
  busy = false;
  const second = b.quit(), concurrent = b.quit();
  assert.equal(second.event.prevented, true);
  assert.equal(concurrent.event.prevented, true);
  assert.equal(concurrent.work, second.work, 'overlapping Quit callers share the original shutdown');
  await second.work;
  t.diagnostic(`NON_NATIVE no-spawn: first cleanup=${b.errors[0][1].message}; initial remove calls=${failedRemovals}; recovered retry remove calls=${removals - failedRemovals}; rootExists=${fs.existsSync(lease.root)}`);
  assert.equal(removals - failedRemovals, 1, 'recovered I/O must receive a new cleanup attempt from the SAME binding');
  assert.equal(fs.existsSync(lease.root), false);
  assert.equal(coordinator.roots.has(lease.root), false);
  assert.equal(coordinator.snapshot().pins, 0);
  assert.equal(b.main.state(client).record, undefined);
  assert.equal(b.main.state(client).count, 0);
  assert.equal(b.main.state(client).quitAllowed, true);
  assert.equal(b.main.state(client).shutdownPromise, null);
  assert.equal(b.errors.length, 1);
  assert.equal(b.quitEvents.length, 1);
  assert.equal(b.quitEvents[0].prevented, false, 'Main permits its final Quit only after original cleanup');
  const successfulRemovals = removals;
  await Promise.all([binding.release(client, lease), binding.release(client, lease)]);
  assert.equal(removals, successfulRemovals, 'successful release stays idempotent');
  await assert.rejects(binding.release({}, lease), /ASSET_LIFETIME_UNCONFIRMED/);
  await assert.rejects(binding.release(client, {...lease}), /ASSET_LIFETIME_UNCONFIRMED/);
  assert.equal(b.spawnCalls(), 0);
  assert.equal(fs.existsSync(f.command), true, 'the App runtime is not snapshot-owned');
  for (const source of Object.values(f.installed)) assert.equal(fs.existsSync(source.directory), true);
});

async function rejectWrongOwnerOrEvidence(f) {
  const {binding, client, lease, b} = f;
  await assert.rejects(binding.release({...client}, lease), /ASSET_LIFETIME_UNCONFIRMED/);
  await assert.rejects(binding.release(client, {...lease}), /ASSET_LIFETIME_UNCONFIRMED/);
  const read = client.assetLifetimeSnapshot, id = client.clientId;
  try {
    client.clientId = randomUUID();
    await assert.rejects(binding.release(client, lease), /ASSET_LIFETIME_UNCONFIRMED/);
  } finally { client.clientId = id; }
  const original = read.call(client);
  assert.equal(b.producer.authenticatedDarwinSnapshot(original, client, lease), true);
  try {
    client.assetLifetimeSnapshot = () => Object.freeze({...original});
    await assert.rejects(binding.release(client, lease), /ASSET_LIFETIME_UNCONFIRMED/);
    binding.retire(); // real producer revision makes the formerly authentic body stale
    assert.equal(b.producer.authenticatedDarwinSnapshot(original, client, lease), false);
    client.assetLifetimeSnapshot = () => original;
    await assert.rejects(binding.release(client, lease), /ASSET_LIFETIME_UNCONFIRMED/);
  } finally { client.assetLifetimeSnapshot = read; }
}

async function assertRetained(f) {
  const before = f.coordinator.snapshot();
  await assert.rejects(f.binding.release(f.client, f.lease), /ASSET_LIFETIME_UNCONFIRMED/);
  assert.deepEqual(f.coordinator.snapshot(), before, 'denied evidence cannot touch original pins or roots');
  assert.equal(fs.existsSync(f.lease.root), true);
}

function endReadable(stream, value) {
  const ended = new Promise(resolve => stream.once('end', resolve));
  stream.end(value);
  return ended;
}
async function closeControl(child, {holdStderr = false} = {}) {
  const ends = [endReadable(child.stdio[3], JSON.stringify({token: child.args[3], role: child.args[1], mode: child.args[2]}) + '\n'),
    endReadable(child.stdout)];
  if (!holdStderr) ends.push(endReadable(child.stderr));
  await Promise.all(ends);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  if (!holdStderr) child.emit('close', 0, null);
}

test('concurrent Darwin release retries share cleanup without bypassing per-call evidence', {timeout: 10000}, async t => {
  const f = await prepare(t), {binding, client, lease, coordinator} = f;
  const originalRetry = coordinator.retryCleanup;
  let busy = true, removals = 0, retries = 0, paused = null;
  const pauses = [];
  const holdNext = () => {
    const pause = {entered: gate(), resume: gate()};
    pauses.push(pause); paused = pause; return pause;
  };
  f.cleanups.push(() => {
    for (const pause of pauses) pause.resume.resolve();
    coordinator.retryCleanup = originalRetry;
  });
  coordinator.retryCleanup = async () => {
    retries++;
    const pause = paused; paused = null;
    if (pause) { pause.entered.resolve('entered'); await pause.resume.promise; }
    return originalRetry.call(coordinator);
  };
  coordinator.io.remove = root => {
    assert.equal(root, lease.root); removals++;
    if (busy) throw Error('FIXTURE_EBUSY');
    return f.remove(root);
  };
  binding.retire();
  await rejectWrongOwnerOrEvidence(f);
  assert.equal(retries, 0);
  const firstPause = holdNext();
  const failed = Promise.allSettled([binding.release(client, lease), binding.release(client, lease)]);
  assert.equal(await Promise.race([firstPause.entered.promise, failed.then(() => 'settled')]), 'entered');
  assert.equal(retries, 1, 'only one original release enters the held cleanup');
  await rejectWrongOwnerOrEvidence(f);
  assert.equal(retries, 1, 'invalid concurrent callers do not borrow the held cleanup');
  firstPause.resume.resolve();
  const failures = await failed;
  assert.equal(failures[0].status, 'rejected');
  assert.equal(failures[1].status, 'rejected');
  assert.equal(failures[0].reason, failures[1].reason, 'all waiters receive the same original failure');
  assert.equal(failures[0].reason.message, 'ASSET_CLEANUP_FAILED');
  assert.equal(fs.existsSync(lease.root), true);
  const failedRemovals = removals, failedRetries = retries;
  busy = false;
  await rejectWrongOwnerOrEvidence(f);
  assert.equal(retries, failedRetries);
  const retryPause = holdNext();
  const succeeded = Promise.allSettled([binding.release(client, lease), binding.release(client, lease)]);
  assert.equal(await Promise.race([retryPause.entered.promise, succeeded.then(() => 'settled')]), 'entered',
    'a rejected latch cannot prevent recovered cleanup from starting');
  assert.equal(retries - failedRetries, 1);
  await rejectWrongOwnerOrEvidence(f);
  assert.equal(retries - failedRetries, 1);
  retryPause.resume.resolve();
  for (const result of await succeeded) assert.equal(result.status, 'fulfilled');
  assert.equal(removals - failedRemovals, 1, 'concurrent retry removes the original root only once');
  assert.equal(coordinator.snapshot().pins, 0);
  assert.equal(fs.existsSync(lease.root), false);
  const successfulRetries = retries;
  await rejectWrongOwnerOrEvidence(f);
  await Promise.all([binding.release(client, lease), binding.release(client, lease)]);
  assert.equal(retries, successfulRetries, 'cached success stays idempotent after revalidation');
  assert.equal(f.b.spawnCalls(), 0);
});

test('authentic Darwin pending preparation retains the original snapshot until no-spawn work drains', {timeout: 10000}, async t => {
  const f = await prepare(t), entered = gate(), resume = gate();
  f.cleanups.push(() => resume.resolve());
  f.client.beforeSpawn = async () => { entered.resolve(); await resume.promise; return false; };
  const start = f.client.start(); start.catch(() => {});
  await entered.promise;
  f.binding.retire();
  const pending = f.client.assetLifetimeSnapshot();
  assert.equal(f.b.producer.authenticatedDarwinSnapshot(pending, f.client, f.lease), true);
  assert.equal(pending.pendingPreparation, true);
  await assertRetained(f);
  const stop = f.client.stop();
  await assertRetained(f);
  assert.equal(f.coordinator.snapshot().pins, 1);
  resume.resolve();
  await assert.rejects(start, /VOICE_RUNTIME_STOPPED/);
  await stop;
  assert.equal(f.client.assetLifetimeSnapshot().pendingPreparation, false);
  assert.equal(f.client.assetLifetimeSnapshot().unresolvedGenerations, 0);
  await f.binding.release(f.client, f.lease);
  assert.equal(fs.existsSync(f.lease.root), false);
  assert.equal(f.b.spawnCalls(), 0);
});

test('Darwin authorization without dispatch cannot turn empty records into retirement proof', {timeout: 10000}, async t => {
  const f = await prepare(t);
  await f.binding.beforeSpawn(); f.binding.retire();
  const snapshot = f.client.assetLifetimeSnapshot();
  assert.equal(f.b.producer.authenticatedDarwinSnapshot(snapshot, f.client, f.lease), true);
  assert.equal(snapshot.unresolvedGenerations, 1);
  assert.equal(f.b.producer.inspectDarwinControl(f.client).groups.length, 0);
  await assertRetained(f);
  await assertRetained(f);
  assert.equal(f.coordinator.snapshot().pins, 1);
  assert.equal(f.b.spawnCalls(), 0);
});

test('leader-only zero records never gain Darwin cleanup authority after authorization', {timeout: 10000}, async t => {
  const f = await prepare(t, {control: false});
  await f.binding.beforeSpawn(); f.binding.retire();
  const snapshot = f.client.assetLifetimeSnapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.coverage, 'leader-only');
  assert.equal(snapshot.unresolvedGenerations, 0);
  await assertRetained(f);
  await assertRetained(f);
  assert.equal(f.coordinator.snapshot().pins, 1);
  assert.equal(f.b.spawnCalls(), 0);
});

test('Darwin hybrid cleanup retries only after every original R55 handle has exit close and both drains', {timeout: 10000}, async t => {
  const f = await prepare(t, {mode: 'worker-first'}), {b, client, lease, binding, coordinator} = f;
  await binding.beforeSpawn();
  const leader = b.dispatchControl(client), worker = b.children[1];
  assert.equal(b.children.length, 2);
  binding.retire();
  await assertRetained(f);
  await closeControl(leader);
  await assertRetained(f); // leader closure cannot substitute for the worker
  await closeControl(worker, {holdStderr: true});
  await assertRetained(f); // original exit alone cannot substitute for close/drain
  worker.emit('close', 0, null);
  await assertRetained(f); // original close still cannot substitute for stderr drain
  assert.equal(coordinator.snapshot().pins, 1);
  await endReadable(worker.stderr);
  const closed = client.assetLifetimeSnapshot();
  assert.equal(b.producer.authenticatedDarwinSnapshot(closed, client, lease), true);
  assert.equal(closed.unresolvedGenerations, 0);
  const records = b.producer.inspectDarwinControl(client).groups[0].records;
  for (const record of records) assert.ok(record.exited && record.reaped && record.drained);
  let busy = true, removals = 0;
  coordinator.io.remove = root => {
    assert.equal(root, lease.root); removals++;
    if (busy) throw Error('FIXTURE_EBUSY');
    return f.remove(root);
  };
  await assert.rejects(binding.release(client, lease), /ASSET_CLEANUP_FAILED/);
  assert.equal(fs.existsSync(lease.root), true);
  const failures = removals;
  busy = false;
  await binding.release(client, lease);
  assert.equal(removals - failures, 1);
  assert.equal(fs.existsSync(lease.root), false);
  t.diagnostic('MEMORY R55 child events + real hybrid filesystem only; not native handle or hybrid spawn qualification');
});

test('authentic Darwin unknown remains sticky across repeated Main Quit', {timeout: 10000}, async t => {
  const f = await prepare(t), {b, binding, client, lease, coordinator} = f;
  await binding.beforeSpawn();
  assert.throws(() => b.dispatchControl(client, Error('MEMORY_SPAWN_FAILURE')), /MEMORY_SPAWN_FAILURE/);
  binding.retire();
  assert.equal(client.assetLifetimeSnapshot().schemaVersion, 2);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  assert.equal(b.producer.inspectDarwinControl(client).groups.length, 1, 'lost original obligation is retained');
  let removals = 0;
  coordinator.io.remove = root => { removals++; return f.remove(root); };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertRetained(f);
    const quit = b.quit(); await quit.work;
    assert.equal(quit.event.prevented, true);
    assert.equal(b.errors.at(-1)[1].message, 'ASSET_LIFETIME_UNCONFIRMED');
    assert.equal(b.main.state(client).record.assets, binding);
    assert.equal(b.main.state(client).quitAllowed, false);
    assert.equal(b.main.state(client).shutdownPromise, null);
    assert.equal(client.assetLifetimeSnapshot().unknown, true);
  }
  assert.equal(removals, 0);
  assert.equal(coordinator.snapshot().pins, 1);
  assert.equal(b.quitEvents.length, 0);
});

for (const cleanup of ['failed', 'successful']) {
  test(`late authentic Darwin fault cannot borrow a ${cleanup} cleanup result`, {timeout: 10000}, async t => {
    const f = await prepare(t), {b, binding, client, lease, coordinator} = f;
    await binding.beforeSpawn();
    const originalChild = b.dispatchControl(client);
    await closeControl(originalChild);
    binding.retire();
    const closed = client.assetLifetimeSnapshot();
    assert.equal(b.producer.authenticatedDarwinSnapshot(closed, client, lease), true);
    assert.equal(closed.unresolvedGenerations, 0);
    let busy = cleanup === 'failed', removals = 0;
    coordinator.io.remove = root => {
      assert.equal(root, lease.root); removals++;
      if (busy) throw Error('FIXTURE_EBUSY');
      return f.remove(root);
    };
    if (busy) await assert.rejects(binding.release(client, lease), /ASSET_CLEANUP_FAILED/);
    else await binding.release(client, lease);
    const priorRemovals = removals;
    busy = false;
    originalChild.stderr.emit('error', Error('MEMORY_ORIGINAL_PIPE_FAULT'));
    const fault = client.assetLifetimeSnapshot();
    assert.equal(fault.schemaVersion, 2);
    assert.equal(fault.fault, true);
    assert.equal(fault.unresolvedGenerations, 0, 'a fully closed history can still carry sticky faults');
    assert.equal(b.producer.authenticatedDarwinSnapshot(closed, client, lease), false);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(binding.release(client, lease), /ASSET_LIFETIME_UNCONFIRMED/);
      assert.equal(client.assetLifetimeSnapshot().fault, true);
    }
    const quit = b.quit(); await quit.work;
    assert.equal(quit.event.prevented, true);
    assert.equal(b.errors.at(-1)[1].message, 'ASSET_LIFETIME_UNCONFIRMED');
    assert.equal(b.main.state(client).record.assets, binding);
    assert.equal(b.main.state(client).quitAllowed, false);
    assert.equal(b.main.state(client).shutdownPromise, null);
    assert.equal(b.quitEvents.length, 0);
    assert.equal(removals, priorRemovals, 'faulted lifetime never reaches cleanup again');
    assert.equal(fs.existsSync(lease.root), cleanup === 'failed');
  });
}
