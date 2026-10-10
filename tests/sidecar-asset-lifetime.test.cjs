// C1 producer evidence only. Windows is a MEMORY OS boundary, not native tree proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');
const cp = require('node:child_process');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../apps/desktop/sidecar-client.cjs'), 'utf8');
// Owned inert JSONL child; no model/network/filesystem work or inherited credentials.
const childSource = `
const rl = require('node:readline').createInterface({ input: process.stdin });
console.log(JSON.stringify({event: process.argv[1] === 'held' ? 'fixture-held' : 'ready'}));
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.control === 'exit') { rl.close(); process.exit(0); }
  else console.log(JSON.stringify({id: msg.id, success: true, result: {ack: msg.method}}));
});
`;
function harness(t, options = {}) {
  const children = [], calls = [], deadlines = [];
  const spawned = gate(), ack = gate();
  const boundary = { ...cp,
    spawn(...args) {
      let child;
      if (options.memoryNoPid) {
        // Explicit MEMORY boundary: unclassified ChildProcess without PID.
        child = new (require('node:events').EventEmitter)();
        child.stdin = new (require('node:stream').PassThrough)();
        child.stdout = new (require('node:stream').PassThrough)();
        child.stderr = new (require('node:stream').PassThrough)();
        child.exitCode = child.signalCode = null;
        child.kill = () => true;
      } else child = cp.spawn(...args);
      children.push(child); spawned.resolve(child);
      child.stdout.on('data', data => { if (data.toString().includes('"event":')) ack.resolve(); });
      return child;
    },
    execFile(command, args, settings, callback) {
      calls.push({ command, args: Array.from(args), settings, callback,
        stdinEnded: children.at(-1).stdin.writableEnded });
      return { kill() {} }; // MEMORY taskkill only; test explicitly kills its owned child.
    },
  };
  const sandbox = { module: { exports: {} },
    require: id => id === 'node:child_process' ? boundary : require('node:module').createRequire(require.resolve('../apps/desktop/sidecar-client.cjs'))(id),
    process: { platform: options.platform || 'win32', env: {} }, console, clearTimeout,
    setTimeout(fn, ms) {
      if (options.manualDeadline && ms === 1200) { deadlines.push(fn); return undefined; }
      return setTimeout(fn, ms);
    },
  };
  if (options.failRecords) sandbox.Map = class extends Map {
    set(key, value) {
      if (value?.proc && value?.generation) throw new Error('MEMORY_TRACKING_ALLOCATION_FAILURE');
      return super.set(key, value);
    }
  };
  vm.runInNewContext(source, sandbox, { filename: 'sidecar-client.cjs' });
  const client = new sandbox.module.exports.SidecarClient({ command: process.execPath,
    args: ['-e', childSource, options.held ? 'held' : 'ready'], env: {}, trackAssetLifetime: true,
    stopGraceMs: 200, stopKillWaitMs: 1000, ...options.client });
  t.after(async () => {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await bounded(exited);
      }
      if (child.pid) {
        for (let i = 0; i < 250; i++) {
          try { process.kill(child.pid, 0); } catch (e) { if (e.code === 'ESRCH') break; }
          await new Promise(r => setTimeout(r, 10));
        }
        assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
        t.diagnostic(`owned-child pid=${child.pid} reaped=true`);
      }
    }
  });
  return { client, children, calls, deadlines, spawned, ack };
}
async function naturalExit(child) {
  const exited = once(child, 'exit'); child.stdin.write('{"control":"exit"}\n'); await bounded(exited);
}
function gate() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TEST_DEADLINE')), 2500);
  })]); } finally { clearTimeout(timer); }
}

test('snapshot opt-out and immutable original identity are pure own flat data', () => {
  assert.equal(new SidecarClient({ command: process.execPath }).assetLifetimeSnapshot(), null);
  const client = new SidecarClient({ command: process.execPath, trackAssetLifetime: true });
  const id = client.clientId;
  const first = client.assetLifetimeSnapshot();
  assert.deepEqual(first, { schemaVersion: 1, clientId: id, coverage: 'leader-only',
    pendingPreparation: false, unresolvedGenerations: 0, unknown: false, fault: false });
  client.clientId = 'not-the-original';
  Object.defineProperty(client, 'process', { get() { throw new Error('OBSERVER_POLLED'); } });
  Object.defineProperty(client, 'identity', { get() { throw new Error('OBSERVER_CALLED_IDENTITY'); } });
  for (let i = 0; i < 10; i++) {
    const next = client.assetLifetimeSnapshot();
    assert.notEqual(next, first);
    assert.deepEqual(next, first);
    assert.equal(Object.isFrozen(next), true);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(next))) {
      assert.equal(Object.hasOwn(descriptor, 'value'), true);
      assert.notEqual(typeof descriptor.value, 'object');
    }
  }
});

test('held preparation survives prompt cancellation and preserves original work/intent promises', async () => {
  const held = gate(), entered = gate();
  let during;
  const client = new SidecarClient({ command: process.execPath, trackAssetLifetime: true,
    beforeSpawn() { during = client.assetLifetimeSnapshot(); entered.resolve(); return held.promise; } });
  const starting = client.start();
  const rejected = assert.rejects(starting, /VOICE_RUNTIME_CANCELLED/);
  const work = client.startWork, caller = client.startPromise, intent = client.startIntent;
  assert.equal(client.assetLifetimeSnapshot().pendingPreparation, true);
  await bounded(entered.promise);
  assert.equal(during.pendingPreparation, true);
  assert.equal(intent.work, work);
  assert.equal(client.startPromise, caller);
  const stopping = client.cancel();
  assert.equal(stopping, client.stopPromise);
  await bounded(rejected);
  assert.equal(client.startWork, work);
  assert.equal(intent.work, work);
  assert.equal(client.assetLifetimeSnapshot().pendingPreparation, true);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 0);
  held.resolve(true);
  await bounded(stopping);
  assert.equal(client.process, null);
  assert.equal(client.assetLifetimeSnapshot().pendingPreparation, false);
  assert.equal(client.assetLifetimeSnapshot().unknown, false);
});

for (const mode of ['idle', 'completed-typed', 'probe']) {
  test(`original G1 ${mode} natural exit remains unknown after empty Stop/afterExit/retry`, async t => {
    let cleanupCalls = 0;
    const { client, children, calls } = harness(t, { client: { afterExit() { cleanupCalls++; } } });
    await bounded(client.start());
    if (mode === 'completed-typed') {
      const op = client.createOperation(() => true);
      await bounded(op.request('tts.synthesize'));
      assert.equal(op.snapshot().status, 'completed');
      assert.equal(client.operations.size, 0);
    }
    if (mode === 'probe') assert.equal((await bounded(client.request('runtime.probe'))).ack, 'runtime.probe');
    assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
    await naturalExit(children[0]);
    assert.equal(client.process, null);
    assert.equal(client.terminationFailure, null, 'passive monitor must not alter legacy/C6 failure');
    assert.equal(client.assetLifetimeSnapshot().unknown, true);
    await bounded(client._terminate(children[0])); // already-exited cannot manufacture evidence
    await bounded(client.stop());
    await bounded(client.stop());
    assert.equal(cleanupCalls, 1, 'existing afterExit semantics unchanged, not Main release proof');
    assert.equal(calls.length, 0);
    assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
    assert.equal(client.assetLifetimeSnapshot().unknown, true);
  });
}

test('spawned but not ready is recorded before callbacks and cannot become no-spawn', async t => {
  const { client, children, ack } = harness(t, { held: true });
  const starting = client.start();
  const rejected = assert.rejects(starting, /VOICE_RUNTIME_EXITED/);
  await bounded(ack.promise);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
  assert.equal(client.assetLifetimeSnapshot().pendingPreparation, true);
  await naturalExit(children[0]);
  await bounded(rejected);
  assert.equal(client.assetLifetimeSnapshot().pendingPreparation, false);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
});

for (const mode of ['validator-false', 'sync-spawn-throw', 'real-ENOENT']) {
  test(`no-spawn control ${mode} drains without manufacturing native evidence`, async t => {
    const { client, children } = harness(t, { client: mode === 'validator-false' ? { beforeSpawn: () => false }
      : { command: mode === 'sync-spawn-throw' ? null : '/c1-deliberately-nonexistent-executable' } });
    await assert.rejects(bounded(client.start()));
    await bounded(client.startWork.catch(() => {}));
    assert.equal(children.some(child => !!child.pid), false);
    const snapshot = client.assetLifetimeSnapshot();
    assert.equal(snapshot.pendingPreparation, false);
    assert.equal(snapshot.unresolvedGenerations, 0);
    assert.equal(snapshot.unknown, false);
    assert.equal(snapshot.fault, false);
    await bounded(client.stop());
  });
}

async function killOwned(child) {
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await bounded(exited);
}
function checkUtility(call, child) {
  assert.equal(call.command, 'taskkill.exe');
  assert.deepEqual(call.args, ['/PID', String(child.pid), '/T', '/F']);
  assert.equal(call.settings.shell, false);
  assert.equal(call.settings.windowsHide, true);
  assert.equal(call.settings.timeout, 1200);
  assert.equal(call.stdinEnded, false, 'original taskkill precedes EOF/signals');
}

for (const order of ['exit-first', 'utility-first']) {
  test(`MEMORY original taskkill ${order}: both facts required; healthy G1/G2 compact only themselves`, async t => {
    const { client, children, calls } = harness(t);
    const id = client.assetLifetimeSnapshot().clientId;
    for (let generation = 0; generation < 2; generation++) {
      await bounded(client.start());
      const ready = client.readyPromise, work = client.startWork, intent = client.startIntent;
      if (generation) {
        calls[0].callback(null); // original G1's late callback cannot compact live G2
        assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
      }
      const stopping = client.stop();
      const result = stopping.then(() => null, error => error);
      checkUtility(calls[generation], children[generation]);
      assert.equal(client.readyPromise, ready);
      assert.equal(client.startWork, work);
      assert.equal(intent.work, work);
      assert.equal(stopping, client.stopPromise);
      assert.equal(client.assetLifetimeSnapshot().coverage, 'windows-tree');
      if (order === 'exit-first') await killOwned(children[generation]);
      else calls[generation].callback(null);
      assert.equal(client.assetLifetimeSnapshot().unknown, false, 'active original attempt is pending, not unsolicited exit');
      assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
      if (order === 'exit-first') calls[generation].callback(null);
      else await killOwned(children[generation]);
      assert.equal(await bounded(result), null);
      assert.equal(client.assetLifetimeSnapshot().unknown, false);
      assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 0);
      assert.equal(client.assetLifetimeSnapshot().clientId, id);
      assert.equal(client.assetLifetimeSnapshot().fault, false);
    }
  });
}

test('producer-only G2 success isolates evidence, NOT Main admission after unknown G1', async t => {
  const { client, children, calls } = harness(t);
  await bounded(client.start());
  await naturalExit(children[0]);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  await bounded(client.start()); // C2 must deny this via actual Main beforeSpawn; not implemented here.
  const stopping = client.stop();
  calls[0].callback(null);
  await killOwned(children[1]);
  await bounded(stopping);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  await bounded(client.stop());
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
});

for (const failure of ['utility-error', 'timeout', 'live-child-error']) {
  test(`MEMORY original attempt ${failure} stays unknown through late success and retry`, async t => {
    const { client, children, calls, deadlines } = harness(t, { manualDeadline: true });
    await bounded(client.start());
    const stopping = client.stop();
    const result = stopping.then(() => null, error => error);
    checkUtility(calls[0], children[0]);
    if (failure === 'utility-error') calls[0].callback(new Error('TASKKILL_FAILED'));
    else if (failure === 'timeout') {
      await killOwned(children[0]);
      assert.equal(client.assetLifetimeSnapshot().unknown, false);
      assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
      assert.equal(deadlines.length, 1);
      deadlines[0](); // actual original deadline callback, no arbitrary delay
    } else children[0].emit('error', new Error('MEMORY_SIGNAL_FAILURE'));
    const error = await bounded(result);
    assert.match(error.message, /TASKKILL_FAILED|TERMINATION_TIMEOUT|MEMORY_SIGNAL_FAILURE/);
    assert.equal(client.terminationFailure, error);
    assert.equal(client.assetLifetimeSnapshot().unknown, true);
    assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
    calls[0].callback(null);
    if (children[0].exitCode === null && children[0].signalCode === null) await killOwned(children[0]);
    await assert.rejects(bounded(client.stop()), { message: error.message });
    assert.equal(client.assetLifetimeSnapshot().unknown, true);
    assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
  });
}

test('real POSIX leader termination is only leader-only coverage, never Windows tree evidence', async t => {
  const { client, calls } = harness(t, { platform: process.platform });
  await bounded(client.start());
  await bounded(client.stop());
  assert.equal(calls.length, 0);
  assert.equal(client.assetLifetimeSnapshot().coverage, 'leader-only');
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 0);
  assert.equal(client.assetLifetimeSnapshot().unknown, false);
});

test('32 unresolved generations are bounded; overflow stays fault/unknown through later success', async t => {
  const { client, children, calls } = harness(t);
  // Producer-only history stress: actual Main admission after G1 unknown is C2.
  for (let i = 0; i < 32; i++) {
    await bounded(client.start()); await naturalExit(children[i]);
    assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, i + 1);
    assert.equal(client.assetLifetimeSnapshot().fault, false);
  }
  await bounded(client.start());
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 32);
  assert.equal(client.assetLifetimeSnapshot().fault, true);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  const stopping = client.stop();
  calls[0].callback(null); await killOwned(children[32]); await bounded(stopping);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 32);
  assert.equal(client.assetLifetimeSnapshot().fault, true);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  assert.equal(client.terminationFailure, null);
});

test('MEMORY evidence allocation failure is sticky fail-closed but cannot change original Stop success', async t => {
  const { client, children, calls } = harness(t, { failRecords: true });
  await bounded(client.start());
  assert.equal(client.assetLifetimeSnapshot().fault, true);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  const stopping = client.stop();
  calls[0].callback(null); await killOwned(children[0]); await bounded(stopping);
  assert.equal(client.terminationFailure, null);
  assert.equal(client.assetLifetimeSnapshot().fault, true);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
});

test('MEMORY missing PID alone and unrelated error never prove failed spawn', async t => {
  const { client, spawned } = harness(t, { memoryNoPid: true });
  const starting = client.start();
  const rejected = assert.rejects(starting, /UNCLASSIFIED_CHILD/);
  const child = await bounded(spawned.promise);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
  assert.equal(client.assetLifetimeSnapshot().unknown, false);
  child.emit('error', Object.assign(new Error('UNCLASSIFIED_CHILD'), { syscall: 'kill' }));
  await bounded(rejected);
  assert.equal(client.assetLifetimeSnapshot().pendingPreparation, false);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  child.emit('close');
  await bounded(client.stop());
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
});

test('producer records before swallowed operation listener; listener throw cannot own evidence', async t => {
  const { client, children, calls } = harness(t);
  const op = client.createOperation(() => true);
  const observed = [];
  op.subscribe(value => {
    if (value.binding?.generation) observed.push(client.assetLifetimeSnapshot());
    throw new Error('OBSERVER_FAILURE');
  });
  await bounded(op.request('runtime.probe'));
  assert.ok(observed.length > 0);
  assert.equal(observed.every(value => value.unresolvedGenerations === 1), true);
  const stopping = client.stop();
  calls[0].callback(null); await killOwned(children[0]); await bounded(stopping);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 0);
  assert.equal(client.assetLifetimeSnapshot().unknown, false);
});
