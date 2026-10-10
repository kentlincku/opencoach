const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once, getEventListeners } = require('node:events');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');
const fixture = path.join(__dirname, 'fixtures/voice-operation-permit-child.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise, ms = process.platform === 'win32' ? 3000 : 1800) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TEST_DEADLINE')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate) {
  const end = Date.now() + 1500;
  while (!predicate()) { assert.ok(Date.now() < end, 'TEST_DEADLINE'); await delay(2); }
}
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c6a-permit-'));
  const log = path.join(dir, 'requests');
  const readyFile = path.join(dir, 'ready');
  const releases = [];
  const client = new SidecarClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 1000,
    stopGraceMs: 30, stopKillWaitMs: process.platform === 'win32' ? 1500 : 300, ...options,
    env: { ...process.env, PERMIT_REQUEST_LOG: log, ...(options.heldReady ? { PERMIT_READY_GATE: readyFile } : {}),
      ...(options.heldStop ? { PERMIT_HELD_STOP: '1' } : {}) } });
  const children = new Set();
  let current = client.process;
  Object.defineProperty(client, 'process', { get: () => current, set: proc => { current = proc; if (proc) children.add(proc); } });
  t.after(async () => {
    releases.forEach(release => release());
    fs.writeFileSync(readyFile, 'ready');
    try { await bounded(client.stop()); }
    finally {
      for (const proc of children) {
        if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
          const exit = once(proc, 'exit'); proc.kill('SIGKILL'); await bounded(exit);
        }
        if (proc.pid) {
          for (let i = 0; i < 50; i++) {
            try { process.kill(proc.pid, 0); } catch (e) { if (e.code === 'ESRCH') break; }
            await new Promise(r => setTimeout(r, 10));
          }
          assert.throws(() => process.kill(proc.pid, 0), { code: 'ESRCH' });
        }
      }
      t.diagnostic('owned child PIDs reaped: ' + [...children].map(proc => proc.pid).join(','));
      fs.rmSync(dir, { recursive: true }); // this test's unique directory only
    }
  });
  return { client, children, releases, ready: () => fs.writeFileSync(readyFile, 'ready'),
    requests: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

test('MATRIX producer spawn reentry installs listeners and barrier before cancellation; no late ready dispatch', async t => {
  const h = setup(t, { heldReady: true });
  const operation = h.client.createOperation(() => true), seen = [];
  let cancel, joined, atSpawn;
  operation.subscribe(snapshot => {
    seen.push(snapshot);
    if (snapshot.status === 'starting' && snapshot.binding.generation) {
      atSpawn = { pid: h.client.process.pid, exit: h.client.process.listenerCount('exit'), ready: !!h.client.readyPromise };
      cancel = operation.cancel();
    } else if (snapshot.status === 'stopping') {
      joined = { barrier: h.client.stopPromise, cancellation: operation.cancel() };
      throw new Error('MATRIX_ISOLATED_STOP');
    }
  });
  const request = operation.request('echo').catch(error => error);
  await until(() => cancel);
  h.ready(); await bounded(Promise.all([cancel, joined.cancellation, request]));
  assert.ok(atSpawn.pid); assert.ok(atSpawn.exit > 0); assert.equal(atSpawn.ready, true);
  assert.ok(joined.barrier); assert.equal(operation.snapshot().status, 'confirmed');
  assert.deepEqual(h.requests(), []); assert.equal(h.client.operations.size, 0);
  assert.equal(seen.filter(s => s.status === 'confirmed').length, 1);
});

test('MATRIX producer terminal reentry cannot reuse old work; listener replacement and retirement remain bounded', async t => {
  const h = setup(t); const operation = h.client.createOperation(() => true);
  let replaced = 0, current = 0, retired = 0, stopped, attempted, terminal;
  const detachOld = operation.subscribe(() => { replaced++; });
  operation.subscribe(snapshot => {
    current++;
    if (snapshot.status === 'completed') {
      terminal = { snapshot, pending: h.client.pending.size, active: h.client.operations.size };
      attempted = operation.request('echo').catch(error => error);
      stopped = h.client.stop();
      operation.subscribe(() => { retired++; });
      throw new Error('MATRIX_ISOLATED_TERMINAL');
    }
  });
  detachOld(); // an obsolete detach cannot remove the replacement listener
  const first = await operation.request('echo'); await bounded(stopped);
  assert.match((await attempted).message, /ALREADY_USED/);
  assert.equal(terminal.pending, 0); assert.equal(terminal.active, 0);
  assert.equal(terminal.snapshot.terminal.nativeRequestId, first.id);
  assert.equal(replaced, 0); assert.ok(current > 0);
  const atRetirement = current, original = operation.snapshot();
  for (let i = 0; i < 130; i++) {
    const fresh = h.client.createOperation(() => true);
    fresh.subscribe(() => {});
    const response = await fresh.request('echo');
    assert.notEqual(response.pid, first.pid);
    await operation.cancel();
    assert.equal(h.client.process.pid, response.pid);
    assert.equal(h.client.operations.size, 0);
  }
  assert.equal(current, atRetirement); assert.equal(retired, 0);
  assert.deepEqual(operation.snapshot(), original); assert.equal(h.children.size, 2);
  assert.equal(h.requests().length, 131);
});

// Permanent ports of independent-confirm's real-child schedules, not reviewer output assertions.
test('producer transitions install original state and stop barrier before reentry; retired listeners stay detached', async t => {
  const h = setup(t, { heldStop: true });
  const operation = h.client.createOperation(() => true);
  const seen = []; let joined, barrier;
  operation.subscribe(snapshot => {
    seen.push(snapshot);
    if (snapshot.status === 'stopping') {
      barrier = h.client.stopPromise;
      joined = operation.cancel();
      throw new Error('isolated listener');
    }
  });
  const result = operation.request('hang').catch(error => error);
  await until(() => h.requests().length === 1);
  assert.equal(seen.at(-1).status, 'running');
  assert.ok(seen.some(s => s.status === 'starting' && s.binding.generation));
  await operation.cancel(); await result; await joined;
  assert.ok(barrier, 'public stop is installed before notification');
  assert.equal(seen.at(-1).status, 'confirmed');
  const count = seen.length, oldGeneration = seen.at(-1).binding.generation;
  const fresh = h.client.createOperation(() => true);
  const freshResult = await fresh.request('echo');
  assert.notEqual(fresh.snapshot().binding.generation, oldGeneration);
  await operation.cancel();
  assert.equal(seen.length, count);
  assert.equal(h.client.process.pid, freshResult.pid);
});

test('producer starting callback can synchronously cancel held preparation and throws cannot lose ownership', async t => {
  const hold = deferred();
  const h = setup(t, { beforeSpawn: () => hold.promise }); h.releases.push(hold.resolve);
  const operation = h.client.createOperation(() => true); let cancelled;
  operation.subscribe(snapshot => {
    if (snapshot.status === 'starting') { cancelled = operation.cancel(); throw new Error('listener'); }
  });
  const request = operation.request('echo').catch(error => error);
  hold.resolve(); await bounded(cancelled); await bounded(request);
  assert.equal(operation.snapshot().status, 'confirmed');
  assert.equal(h.children.size, 0);
  assert.deepEqual(h.requests(), []);
});

test('producer unsubscribe prevents later terminal callbacks without mutating receipt', async t => {
  const h = setup(t); const operation = h.client.createOperation(() => true); let calls = 0;
  const detach = operation.subscribe(() => { calls++; });
  detach(); detach(); await operation.request('echo');
  assert.equal(calls, 0); assert.equal(operation.snapshot().status, 'completed');
});

for (const mode of ['legacy', 'fresh', 'fault', 'throw', 'revoked']) {
  test(`IND01 healthy old stop barrier: ${mode}`, async t => {
    const h = setup(t, { heldStop: true, stopGraceMs: 100 });
    await h.client.start();
    const oldProc = h.client.process;
    const stopping = h.client.cancel();
    let calls = 0;
    const operation = mode === 'legacy' ? null : h.client.createOperation(() => {
      calls++;
      if (mode === 'throw') throw new Error('CALLER_FAULT');
      return mode !== 'fault';
    });
    const pending = (operation || h.client).request('echo').then(value => ({ value }), error => ({ error }));
    if (operation) assert.ok(calls > 0, 'caller gate runs synchronously while old stop is pending');
    assert.equal(oldProc.exitCode, null);
    assert.equal(oldProc.signalCode, null);
    if (mode === 'revoked') await operation.cancel();
    if (['fault', 'throw'].includes(mode)) {
      assert.match((await bounded(pending, 60)).error?.message || 'FULFILLED', /PERMIT_DENIED/);
      assert.equal(oldProc.signalCode, null, 'fault denial does not wait for old termination');
    }
    await bounded(stopping);
    const result = await bounded(pending);
    if (['legacy', 'fresh'].includes(mode)) {
      assert.ok(result.value, result.error?.message);
      assert.notEqual(result.value.pid, oldProc.pid);
      if (operation) {
        assert.equal(operation.snapshot().nativeRequestId, result.value.id);
        assert.equal(operation.snapshot().terminal.success, true);
      }
    } else {
      assert.match(result.error?.message || 'FULFILLED', /PERMIT_DENIED|CANCELLED/);
      assert.equal(h.children.size, 1);
      assert.deepEqual(h.requests(), []);
    }
  });
}

for (const nextKind of ['optin', 'legacy']) for (const lateAbort of [false, true]) {
  test(`IND02 original queued cancellation isolates fresh ${nextKind}; lateAbort=${lateAbort}`, async t => {
    const gate = deferred(); const entered = deferred(); let cleanupDone = false;
    const h = setup(t, { afterExit: async () => { entered.resolve(); await gate.promise; cleanupDone = true; } });
    h.releases.push(gate.resolve);
    await h.client.start();
    const oldPid = h.client.process.pid;
    const stopping = h.client.stop();
    await bounded(entered.promise);
    const controller = new AbortController();
    const old = h.client.createOperation(() => true);
    let settled = false;
    const pending = old.request('echo', {}, { signal: controller.signal }).then(
      value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await bounded(old.cancel());
    assert.equal(old.snapshot().status, 'confirmed');
    const settledBeforeRelease = settled;
    const listenersBeforeRelease = getEventListeners(controller.signal, 'abort').length;
    assert.equal(cleanupDone, false, 'original no-work confirmation is not shared asset drain');
    const fresh = nextKind === 'optin' ? h.client.createOperation(() => true) : null;
    const next = (fresh || h.client).request('echo').then(value => ({ value }), error => ({ error }));
    if (lateAbort) controller.abort();
    gate.resolve();
    await bounded(stopping);
    const result = await bounded(next);
    assert.ok(result.value, result.error?.message);
    assert.notEqual(result.value.pid, oldPid);
    if (fresh) assert.equal(fresh.snapshot().terminal.nativeRequestId, result.value.id);
    assert.equal(settledBeforeRelease, true, 'old logical wait settles without irrelevant cleanup');
    assert.equal(listenersBeforeRelease, 0, 'old signal loses cancellation authority before fresh work');
    assert.match((await pending).error?.message || 'FULFILLED', /CANCELLED/);
    assert.equal(h.requests().length, 1);
    await old.cancel();
    assert.equal(h.client.process.pid, result.value.pid);
  });
}

for (const mode of ['already-aborted', 'startup-gate', 'ready-gate', 'write-gate', 'serialization', 'success-signal', 'success-no-signal']) {
  test(`IND03 public gate AbortSignal boundary: ${mode}`, async t => {
    const started = [];
    const h = setup(t, { onStderr: text => started.push(text) });
    await h.client.start();
    const controller = new AbortController(); let calls = 0;
    if (mode === 'already-aborted') controller.abort();
    const abortAt = { 'startup-gate': 1, 'ready-gate': 2, 'write-gate': 3 }[mode];
    const operation = h.client.createOperation(() => {
      if (++calls === abortAt) controller.abort();
      return true;
    });
    const params = mode === 'serialization' ? { toJSON() { controller.abort(); return {}; } } : {};
    const result = await operation.request('echo', params,
      mode === 'success-no-signal' ? {} : { signal: controller.signal }).then(value => ({ value }), error => ({ error }));
    t.diagnostic(JSON.stringify({ mode, aborted: controller.signal.aborted, result: result.value || result.error?.name,
      receipt: operation.snapshot(), requests: h.requests(), started }));
    if (mode.startsWith('success')) {
      assert.equal(result.value?.id, operation.snapshot().nativeRequestId);
      assert.equal(operation.snapshot().status, 'completed');
      assert.equal(operation.snapshot().terminal.success, true);
      assert.equal(h.requests().length, 1);
    } else {
      assert.equal(result.error?.name, 'AbortError', 'abort cannot be lost during gate reentry');
      assert.equal(operation.snapshot().terminal, null);
      assert.equal(operation.snapshot().nativeRequestId, null, 'denied write cannot publish a UUID');
      assert.notEqual(operation.snapshot().status, 'running');
      assert.notEqual(operation.snapshot().status, 'completed');
      assert.deepEqual(h.requests(), []);
      assert.deepEqual(started, []);
      assert.equal(h.client.pending.size, 0);
      await bounded(operation.cancel());
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('late-beforeSpawn denial: caller fault fence covers batch-excluded already-preparing operation', async t => {
  const gate = deferred(); const entered = deferred();
  const h = setup(t, { beforeSpawn: () => { entered.resolve(); return gate.promise; } });
  h.releases.push(gate.resolve);
  let allowed = true;
  assert.equal(typeof h.client.createOperation, 'function', 'opt-in operation API exists');
  const operation = h.client.createOperation(() => allowed);
  const outcome = operation.request('echo').then(value => ({ value }), error => ({ error }));
  await bounded(entered.promise);
  allowed = false; // deliberately NOT operation.cancel(): global caller fault, outside revoke batch
  gate.resolve();
  assert.match((await bounded(outcome)).error?.message || 'FULFILLED', /PERMIT_DENIED/);
  assert.equal(h.children.size, 0);
  assert.deepEqual(h.requests(), []);
});

test('genuine backend error provenance: spawn-time original receipt is read-only and terminal-correlated', async t => {
  let cleanup = 0;
  const h = setup(t, { heldReady: true, afterExit: () => { cleanup++; } });
  const operation = h.client.createOperation(() => true);
  assert.equal(typeof operation.snapshot, 'function', 'read-only original receipt API exists');
  assert.equal(operation.snapshot().status, 'not-dispatched');
  const failed = assert.rejects(operation.request('error'), { message: 'backend failed', code: 'BACKEND_FIXTURE' });
  await until(() => h.client.process);
  const proc = h.client.process;
  const starting = operation.snapshot();
  assert.equal(starting.status, 'starting');
  assert.equal(starting.binding.generation, h.client.processGeneration, 'generation visible before ready');
  assert.equal(typeof starting.binding.intentId, 'string');
  assert.equal(Object.isFrozen(starting.binding), true);
  assert.deepEqual(operation.snapshot(), starting);
  assert.equal(cleanup, 0);
  assert.equal(proc.killed, false);
  h.ready();
  await bounded(failed);
  const completed = operation.snapshot();
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.binding, starting.binding);
  assert.equal(completed.nativeRequestId, h.requests()[0].id);
  assert.deepEqual(completed.terminal, { ...completed.binding, nativeRequestId: completed.nativeRequestId, success: false });
  assert.equal(Object.isFrozen(completed.terminal), true);
  assert.equal(h.client.process, proc, 'completed is not process exit');
  assert.equal(proc.killed, false);
  assert.equal(cleanup, 0);
});

test('healthy cancel confirms original receipt then new PID correlated success; retired handle never kills new generation', async t => {
  let cleanup = 0;
  const h = setup(t, { afterExit: () => { cleanup++; } });
  const old = h.client.createOperation(() => true);
  assert.equal(typeof old.cancel, 'function', 'original cancellation handle exists');
  const rejected = assert.rejects(old.request('hang'), /CANCELLED/);
  await until(() => h.requests().length === 1);
  const oldPid = h.client.process.pid;
  const original = old.snapshot().binding;
  const firstCancel = old.cancel();
  assert.equal(old.snapshot().status, 'stopping');
  assert.equal(old.snapshot().terminal, null);
  await bounded(Promise.all([firstCancel, old.cancel(), rejected]));
  assert.equal(old.snapshot().status, 'confirmed');
  assert.deepEqual(old.snapshot().binding, original);
  assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
  assert.equal(cleanup, 0);
  const fresh = h.client.createOperation(() => true);
  const result = await bounded(fresh.request('echo'));
  assert.notEqual(result.pid, oldPid);
  assert.notEqual(fresh.snapshot().binding.intentId, original.intentId);
  assert.notEqual(fresh.snapshot().binding.generation, original.generation);
  assert.equal(fresh.snapshot().nativeRequestId, result.id);
  assert.equal(fresh.snapshot().terminal.success, true);
  await old.cancel();
  await fresh.cancel(); // completed request has no remaining generation obligation
  assert.equal(h.client.process.pid, result.pid);
  assert.equal(h.client.process.killed, false);
  assert.equal(cleanup, 0);
  await assert.rejects(old.request('echo'), /ALREADY_USED/);
});

test('original unused permit cannot upgrade after natural exit into a replacement generation', async t => {
  const h = setup(t);
  await h.client.start();
  const old = h.client.createOperation(() => true);
  const proc = h.client.process;
  const exit = once(proc, 'exit');
  proc.stdin.end();
  await bounded(exit);
  const fresh = h.client.createOperation(() => true);
  await bounded(fresh.request('echo'));
  const count = h.requests().length;
  await assert.rejects(old.request('echo'), /PERMIT_DENIED/);
  assert.equal(h.requests().length, count);
  assert.notEqual(h.client.process.pid, proc.pid);
  await old.cancel();
  assert.equal(old.snapshot().status, 'confirmed');
  assert.equal(h.client.process.killed, false);
});

test('cancelQuit cleanup failure does not rewrite confirmed native termination as unconfirmed', async t => {
  let attempts = 0;
  const h = setup(t, { afterExit: () => { if (++attempts === 1) throw new Error('CLEANUP_FAILED'); } });
  const operation = h.client.createOperation(() => true);
  const rejected = assert.rejects(operation.request('hang'), /STOPPED/);
  await until(() => h.requests().length === 1);
  await assert.rejects(h.client.stop(), /CLEANUP_FAILED/);
  await rejected;
  assert.equal(operation.snapshot().status, 'confirmed', 'receipt describes native termination, not final asset cleanup');
  assert.equal(operation.snapshot().terminal, null);
  await operation.cancel();
  await h.client.stop();
  assert.equal(attempts, 2);
});

// Regression characterization of boundaries already implemented by the preceding slices.
test('cancelQuit queued receipt confirms no spawn even when shared final asset cleanup fails', async t => {
  const entered = deferred(); const gate = deferred(); let fail = true;
  const h = setup(t, { afterExit: async () => { entered.resolve(); await gate.promise; if (fail) throw new Error('CLEANUP_FAILED'); } });
  h.releases.push(gate.resolve);
  await h.client.start();
  const stopping = assert.rejects(h.client.stop(), /CLEANUP_FAILED/);
  await entered.promise;
  const queued = h.client.createOperation(() => true);
  const rejected = assert.rejects(queued.request('echo'), /CANCELLED/);
  const cancelled = queued.cancel();
  const final = assert.rejects(h.client.stop(), /CLEANUP_FAILED/);
  gate.resolve();
  await bounded(cancelled); // original no-spawn confirmation is not the public cleanup promise
  await bounded(Promise.all([stopping, rejected, final]));
  fail = false;
  assert.equal(queued.snapshot().status, 'confirmed');
  assert.equal(queued.snapshot().binding.generation, null);
  assert.equal(h.children.size, 1);
  assert.equal(h.client.cleanupPromise, null, 'failed cleanup is retained for retry');
  await h.client.stop();
  const fresh = h.client.createOperation(() => true);
  const result = await fresh.request('echo');
  await queued.cancel();
  assert.equal(h.client.process.pid, result.pid);
  assert.equal(h.client.process.killed, false);
});

for (const nativeUnknown of [false, true]) {
  test(`queued beforeSpawn final Stop escalation separates original receipts; nativeUnknown=${nativeUnknown}`, async t => {
    const gate = deferred(); const entered = deferred(); let cleanup = 0;
    const h = setup(t, { beforeSpawn: () => { entered.resolve(); return gate.promise; }, afterExit: () => { cleanup++; } });
    h.releases.push(gate.resolve);
    const old = h.client.createOperation(() => true);
    const rejected = assert.rejects(old.request('echo'), /CANCELLED/);
    await bounded(entered.promise);
    // MEMORY native uncertainty injection plus a real held preparation. No Windows proof.
    let terminate;
    if (nativeUnknown) {
      gate.resolve();
      await until(() => h.client.process);
      terminate = t.mock.method(h.client, '_terminate', async () => { throw new Error('NATIVE_UNKNOWN'); });
    }
    const cancel = h.client.cancel();
    const cancelResult = nativeUnknown ? assert.rejects(cancel, /NATIVE_UNKNOWN/) : cancel;
    const queued = h.client.createOperation(() => true);
    const queuedResult = assert.rejects(queued.request('echo'), /STOPPED/);
    const final = h.client.stop();
    const finalResult = nativeUnknown ? assert.rejects(final, /NATIVE_UNKNOWN/) : final;
    try {
      await bounded(queued.cancel());
      assert.equal(queued.snapshot().status, 'confirmed');
      assert.equal(queued.snapshot().binding.generation, null);
      if (!nativeUnknown) assert.equal(old.snapshot().status, 'stopping', 'queued no-work cannot confirm held original preparation');
      gate.resolve();
      await bounded(Promise.all([cancelResult, finalResult, rejected, queuedResult]));
      assert.equal(old.snapshot().status, nativeUnknown ? 'unconfirmed' : 'confirmed');
      if (nativeUnknown) await assert.rejects(old.cancel(), /NATIVE_UNKNOWN/);
      assert.equal(cleanup, nativeUnknown ? 0 : 1);
      assert.equal(h.requests().length, 0);
    } finally { terminate?.mock.restore(); }
  });
}

test('late request denial after serialization reentry sends no native request', async t => {
  const h = setup(t);
  await h.client.start();
  let allowed = true;
  const operation = h.client.createOperation(() => allowed);
  await assert.rejects(operation.request('echo', { toJSON() { allowed = false; return {}; } }), /PERMIT_DENIED/);
  assert.deepEqual(h.requests(), []);
  assert.equal(operation.snapshot().terminal, null);
  assert.equal(operation.snapshot().status, 'starting');
  allowed = true;
  await assert.rejects(operation.request('echo'), /ALREADY_USED/);
});

test('shared ready concurrent operations bind one spawned generation before ready and correlate separate UUIDs', async t => {
  const h = setup(t, { heldReady: true });
  const a = h.client.createOperation(() => true);
  const b = h.client.createOperation(() => true);
  const results = Promise.all([a.request('echo'), b.request('echo')]);
  await until(() => h.client.process);
  assert.deepEqual(a.snapshot().binding, b.snapshot().binding);
  assert.equal(a.snapshot().binding.generation, h.client.processGeneration);
  assert.equal(b.snapshot().status, 'starting');
  h.ready();
  const [x, y] = await bounded(results);
  assert.equal(x.pid, y.pid);
  assert.notEqual(x.id, y.id);
  assert.equal(a.snapshot().nativeRequestId, x.id);
  assert.equal(b.snapshot().nativeRequestId, y.id);
  assert.equal(h.children.size, 1);
});

test('shared-ready request denial: caller fault excludes both preparing continuations without a kill', async t => {
  const h = setup(t, { heldReady: true });
  let allowed = true;
  const a = h.client.createOperation(() => allowed);
  const b = h.client.createOperation(() => allowed);
  const rejected = [assert.rejects(a.request('echo'), /PERMIT_DENIED/), assert.rejects(b.request('echo'), /PERMIT_DENIED/)];
  await until(() => h.client.process);
  allowed = false;
  h.ready();
  await bounded(Promise.all(rejected));
  assert.deepEqual(h.requests(), []);
  assert.equal(h.client.process.killed, false);
  assert.equal(a.snapshot().terminal, null);
  assert.equal(b.snapshot().terminal, null);
});

test('shared-ready cancellation updates collateral original receipts without dispatch', async t => {
  const h = setup(t, { heldReady: true });
  const a = h.client.createOperation(() => true);
  const b = h.client.createOperation(() => true);
  const rejected = [assert.rejects(a.request('echo'), /CANCELLED/), assert.rejects(b.request('echo'), /CANCELLED/)];
  await until(() => h.client.process);
  const binding = a.snapshot().binding;
  await bounded(Promise.all([a.cancel(), ...rejected]));
  assert.equal(a.snapshot().status, 'confirmed');
  assert.equal(b.snapshot().status, 'confirmed');
  assert.deepEqual(b.snapshot().binding, binding);
  assert.deepEqual(h.requests(), []);
});

test('reentry cancelQuit rejects logically before held validator drains; read-only original receipt never cleans assets', async t => {
  const gate = deferred(); const entered = deferred();
  let operation, cancel, quit, acquired = false, cleanup = 0;
  const h = setup(t, { beforeSpawn: async () => {
    cancel = operation.cancel(); quit = h.client.stop(); entered.resolve();
    await gate.promise; acquired = true;
  }, afterExit: () => { cleanup++; acquired = false; } });
  h.releases.push(gate.resolve);
  operation = h.client.createOperation(() => true);
  const rejected = assert.rejects(operation.request('echo'), /CANCELLED/);
  await bounded(entered.promise);
  await bounded(rejected);
  assert.equal(operation.snapshot().status, 'stopping');
  assert.equal(operation.snapshot().binding.generation, null);
  for (let i = 0; i < 10; i++) operation.snapshot();
  assert.equal(cleanup, 0);
  gate.resolve();
  await bounded(Promise.all([cancel, quit]));
  assert.equal(operation.snapshot().status, 'confirmed');
  assert.equal(acquired, false);
  assert.equal(cleanup, 1);
  assert.equal(h.children.size, 0);
});

test('waiting old final stop revalidates original caller fence before starting again', async t => {
  const gate = deferred(); const entered = deferred();
  const h = setup(t, { afterExit: async () => { entered.resolve(); await gate.promise; } });
  h.releases.push(gate.resolve);
  await h.client.start();
  const stopping = h.client.stop();
  let allowed = true;
  const queued = h.client.createOperation(() => allowed);
  const rejected = assert.rejects(queued.request('echo'), /PERMIT_DENIED/);
  await bounded(entered.promise);
  allowed = false;
  gate.resolve();
  await bounded(Promise.all([stopping, rejected]));
  assert.equal(h.children.size, 1);
  assert.deepEqual(h.requests(), []);
});

test('real child wrong and duplicate IDs cannot generate or overwrite original terminal provenance', async t => {
  const h = setup(t);
  const wrong = h.client.createOperation(() => true);
  const pending = wrong.request('wrong-first');
  await until(() => h.requests().length);
  assert.equal(wrong.snapshot().terminal, null);
  const result = await bounded(pending);
  assert.equal(wrong.snapshot().nativeRequestId, result.id);
  assert.equal(wrong.snapshot().terminal.success, true);
  const duplicate = h.client.createOperation(() => true);
  await duplicate.request('duplicate');
  const original = duplicate.snapshot();
  await delay(20);
  assert.deepEqual(duplicate.snapshot(), original);
  assert.equal(original.terminal.success, true);
});

test('request timeout is not backend provenance and original receipt follows real termination', async t => {
  const h = setup(t, { requestTimeoutMs: 50 });
  const operation = h.client.createOperation(() => true);
  await assert.rejects(operation.request('hang'), /REQUEST_TIMEOUT/);
  assert.equal(operation.snapshot().terminal, null);
  await bounded(operation.cancel());
  assert.equal(operation.snapshot().status, 'confirmed');
  assert.equal(h.client.process, null);
});

test('bounded ownership recycles unused and completed handles without reviving retired handles', async t => {
  const h = setup(t);
  const handles = Array.from({ length: 128 }, () => h.client.createOperation(() => true));
  assert.throws(() => h.client.createOperation(() => true), /CAPACITY/);
  await Promise.all(handles.map(handle => handle.cancel()));
  await assert.rejects(handles[0].request('echo'), /ALREADY_USED/);
  for (let i = 0; i < 130; i++) await h.client.createOperation(() => true).request('echo');
  assert.equal(h.children.size, 1);
});

// Explicit memory/transport fault injection on a real owned child, NOT native fault proof.
test('MEMORY injection: stdin and old-generation data cannot masquerade as a terminal backend response', async t => {
  const h = setup(t);
  await h.client.start();
  const old = h.client.process;
  const oldData = old.stdout.listeners('data');
  await h.client.cancel();
  const operation = h.client.createOperation(() => true);
  const rejected = assert.rejects(operation.request('hang'), /PIPE_FAILED/);
  await until(() => h.requests().length === 1);
  const id = operation.snapshot().nativeRequestId;
  for (const callback of oldData) callback(Buffer.from(JSON.stringify({ id, success: true, result: 'STALE' }) + '\n'));
  assert.equal(operation.snapshot().terminal, null);
  h.client.process.stdin.emit('error', new Error('PIPE_FAILED'));
  await rejected;
  assert.equal(operation.snapshot().status, 'running');
  assert.equal(operation.snapshot().terminal, null);
  h.client.process.stdout.emit('data', Buffer.from(JSON.stringify({ id, success: false, error: { message: 'TOO_LATE' } }) + '\n'));
  assert.equal(operation.snapshot().terminal, null);
  await operation.cancel();
});

test('MEMORY signal failure: new permit cannot adopt the still-live failed-termination generation', async t => {
  const h = setup(t, { requestTimeoutMs: 60 });
  const old = h.client.createOperation(() => true);
  const rejected = assert.rejects(old.request('hang'), /CANCELLED/);
  await until(() => h.requests().length);
  const proc = h.client.process;
  const kill = t.mock.method(proc, 'kill', () => { throw new Error('SIGNAL_FAILED'); });
  const end = t.mock.method(proc.stdin, 'end', () => {});
  try {
    await assert.rejects(old.cancel(), /SIGNAL_FAILED/);
    await rejected;
    assert.equal(old.snapshot().status, 'unconfirmed');
    const fresh = h.client.createOperation(() => true);
    await assert.rejects(fresh.request('echo'), /PERMIT_DENIED/);
    await assert.rejects(old.cancel(), /SIGNAL_FAILED/);
    assert.equal(h.requests().length, 1);
    assert.equal(old.snapshot().terminal, null);
  } finally { kill.mock.restore(); end.mock.restore(); }
});

test('failed-spawn original binding is immutable across retry and old cancellation cannot kill replacement', async t => {
  const h = setup(t, { command: path.join(os.tmpdir(), 'c6a-missing-executable') });
  const old = h.client.createOperation(() => true);
  await assert.rejects(old.request('echo'), /ENOENT/);
  const binding = old.snapshot().binding;
  h.client.command = process.execPath;
  const fresh = h.client.createOperation(() => true);
  const result = await fresh.request('echo');
  assert.deepEqual(old.snapshot().binding, binding, 'failed original must not acquire the retry generation');
  await old.cancel();
  assert.equal(old.snapshot().status, 'confirmed');
  assert.equal(h.client.process.pid, result.pid);
  assert.equal(h.client.process.killed, false);
});

for (const mode of ['failure', 'timeout', 'natural-exit']) {
  test(`MEMORY Windows ${mode}: original unknown-tree latch survives leader exit and late utility success`, async t => {
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const vm = require('node:vm');
    // Entire process/OS boundary is in memory: no real Windows, taskkill or PID authority.
    const proc = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let utilityCallback, cleanup = 0, spawned = 0;
    const sandbox = { module: { exports: {} }, console, setTimeout, clearTimeout,
      process: { platform: 'win32', env: {} }, require: id => id !== 'node:child_process' ? require('node:module').createRequire(require.resolve('../apps/desktop/sidecar-client.cjs'))(id) : {
        spawn() { spawned++; queueMicrotask(() => proc.stdout.write('{"event":"ready"}\n')); return proc; },
        execFile(_command, _args, _options, callback) {
          utilityCallback = callback;
          if (mode === 'failure') queueMicrotask(() => callback(new Error('TASKKILL_FAILED')));
          return { kill() {} };
        },
      } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../apps/desktop/sidecar-client.cjs'), 'utf8'), sandbox);
    const client = new sandbox.module.exports.SidecarClient({ command: 'memory-only', stopGraceMs: 5,
      stopKillWaitMs: 20, afterExit: () => { cleanup++; } });
    t.after(async () => {
      proc.exitCode = 0; proc.emit('exit', 0, null); proc.emit('close');
      await bounded(client.stop().catch(() => {}));
      proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy();
    });
    const operation = client.createOperation(() => true);
    const rejected = assert.rejects(operation.request('hang'), /CANCELLED|EXITED/);
    await until(() => client.pending.size);
    if (mode === 'natural-exit') { proc.exitCode = 0; proc.emit('exit', 0, null); }
    await assert.rejects(operation.cancel(), /TASKKILL_FAILED|TERMINATION_TIMEOUT|ORIGINAL.*UNCONFIRMED/);
    await rejected;
    const original = JSON.stringify(operation.snapshot());
    assert.equal(operation.snapshot().status, 'unconfirmed');
    proc.exitCode = 0; proc.emit('exit', 0, null);
    utilityCallback?.(null);
    await assert.rejects(operation.cancel(), /TASKKILL_FAILED|TERMINATION_TIMEOUT|ORIGINAL.*UNCONFIRMED/);
    const blocked = client.createOperation(() => true);
    await assert.rejects(blocked.request('echo'), /PERMIT_DENIED/);
    await assert.rejects(blocked.cancel(), /TASKKILL_FAILED|TERMINATION_TIMEOUT|ORIGINAL.*UNCONFIRMED/);
    assert.equal(blocked.snapshot().status, 'unconfirmed', 'protected Windows latch is not bypassed by no-spawn confirmation');
    await assert.rejects(client.stop(), /TASKKILL_FAILED|TERMINATION_TIMEOUT|ORIGINAL.*UNCONFIRMED/);
    assert.equal(JSON.stringify(operation.snapshot()), original);
    assert.equal(cleanup, 0);
    assert.equal(spawned, 1);
  });
}

for (const mode of ['serialization', 'write-throw', 'write-callback']) {
  test(`MEMORY ${mode}: logical reject never manufactures completed provenance`, async t => {
    const h = setup(t);
    await h.client.start();
    const operation = h.client.createOperation(() => true);
    let write;
    if (mode !== 'serialization') write = t.mock.method(h.client.process.stdin, 'write', (_data, callback) => {
      if (mode === 'write-throw') throw new Error('WRITE_FAILED');
      queueMicrotask(() => callback(new Error('WRITE_FAILED')));
    });
    try {
      await assert.rejects(operation.request('echo', mode === 'serialization' ? { toJSON() { throw new Error('SERIALIZATION'); } } : {}), /WRITE_FAILED|SERIALIZATION/);
      assert.equal(operation.snapshot().terminal, null);
      assert.notEqual(operation.snapshot().status, 'completed');
      assert.deepEqual(h.requests(), []);
    } finally { write?.mock.restore(); }
    await operation.cancel();
    assert.equal(operation.snapshot().status, 'confirmed');
  });
}