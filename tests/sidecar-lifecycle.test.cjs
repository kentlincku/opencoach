const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { once } = require('node:events');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');
const fixture = path.join(__dirname, 'fixtures/sidecar-lifecycle.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'TEST_DEADLINE waiting for lifecycle state');
    await delay(1);
  }
}

test('request timeout cancels the child without final asset release and permits restart', async t => {
  let released = 0;
  const client = clientFor(t, { requestTimeoutMs: 40, afterExit: () => { released++; } });
  await client.start();
  const proc = client.process;
  const exited = once(proc, 'exit');
  await assert.rejects(client.request('hang'), /REQUEST_TIMEOUT:hang/);
  await bounded(exited, 500);
  assert.equal(released, 0);
  assert.notEqual((await client.request('echo')).pid, proc.pid);
});

for (const failure of ['circular', 'toJSON', 'write-throw', 'write-callback']) {
  test(`rejected dispatch ${failure} cannot leave a timer/listener that cancels the healthy child`, async t => {
    const client = clientFor(t, { requestTimeoutMs: 40 });
    const controller = new AbortController();
    await client.start();
    const proc = client.process;
    let params = {};
    if (failure === 'circular') params.self = params;
    if (failure === 'toJSON') params = { toJSON() { throw new Error('SERIALIZATION_FAILED'); } };
    let write;
    if (failure.startsWith('write')) write = t.mock.method(proc.stdin, 'write', (_data, callback) => {
      if (failure === 'write-throw') throw new Error('WRITE_FAILED');
      queueMicrotask(() => callback(new Error('WRITE_FAILED')));
      return false;
    });
    await assert.rejects(client.request('echo', params, { signal: controller.signal }), /circular|SERIALIZATION_FAILED|WRITE_FAILED/i);
    write?.mock.restore();
    await delay(100); // exceeds rejected request's timeout; child must remain reusable.
    assert.equal(client.process, proc);
    assert.equal(client.pending.size, 0);
    assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort();
    assert.equal((await client.request('echo')).pid, proc.pid);
  });
}

test('abort during serialization never writes a request after cancellation', async t => {
  const client = clientFor(t);
  await client.start();
  const controller = new AbortController();
  const write = t.mock.method(client.process.stdin, 'write', () => true);
  const params = { toJSON() { controller.abort(); return {}; } };
  await assert.rejects(client.request('echo', params, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(write.mock.callCount(), 0);
  write.mock.restore();
  await client.cancel();
});

test('old generation callbacks cannot reject/resolve/notify a restarted request', async t => {
  let stderrCount = 0;
  const client = clientFor(t, { onStderr: () => { stderrCount++; } });
  await client.start();
  const old = client.process;
  const oldErrors = old.listeners('error');
  const oldExits = old.listeners('exit');
  const oldData = old.stdout.listeners('data');
  const oldStderr = old.stderr.listeners('data');
  await client.cancel();
  await client.start();
  const current = client.process;
  let started = 0;
  let settled = false;
  const request = client.request('hang', {}, { onStarted: () => { started++; } });
  const observed = request.then(() => { settled = true; }, () => { settled = true; });
  await waitFor(() => client.pending.size);
  const id = [...client.pending.keys()][0];
  await delay(30);
  const priorStderr = stderrCount;
  const priorStarted = started;
  for (const callback of oldData) callback(Buffer.from(`${JSON.stringify({ id, success: true, result: 'STALE' })}\n`));
  for (const callback of oldStderr) callback(Buffer.from(`REQUEST_STARTED:${id}:hang\n`));
  for (const callback of oldErrors) callback(new Error('LATE_OLD_ERROR'));
  for (const callback of oldExits) callback(9, null);
  await delay(10);
  assert.equal(settled, false);
  assert.equal(client.process, current);
  assert.equal(stderrCount, priorStderr);
  assert.equal(started, priorStarted);
  await client.cancel();
  await observed;
});

test('identity and onStarted diagnostics belong to the active process generation', async t => {
  const diagnostics = [];
  const client = clientFor(t, { onStderr: text => { diagnostics.push(text); throw new Error('OBSERVER'); } });
  assert.equal(client.identity(), null);
  await client.start();
  const first = client.identity();
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.pid, client.process.pid);
  assert.equal(first.executable, process.execPath);
  assert.equal(typeof first.processGeneration, 'string');
  let notify;
  const started = new Promise(resolve => { notify = resolve; });
  const request = client.request('hang', {}, { onStarted: info => { notify(info); throw new Error('OBSERVER'); } });
  const rejected = assert.rejects(request, /CANCELLED/);
  const info = await bounded(started, 300);
  assert.equal(info.method, 'hang');
  assert.equal(client.pending.has(info.id), true);
  assert.equal(diagnostics.some(text => text.includes(info.id)), true);
  await client.cancel();
  await rejected;
  assert.equal(client.identity(), null);
  await client.start();
  assert.notEqual(client.identity().processGeneration, first.processGeneration);
});

test('a live child error during termination is not exit confirmation or permission to release assets', async t => {
  let released = 0;
  const client = clientFor(t, { args: [fixture, 'ignore-term'], afterExit: () => { released++; } });
  await client.start();
  const proc = client.process;
  const kill = t.mock.method(proc, 'kill', () => {
    queueMicrotask(() => proc.emit('error', new Error('SIGNAL_FAILED')));
    return false;
  });
  await assert.rejects(client.stop(), /SIGNAL_FAILED/);
  kill.mock.restore();
  assert.equal(client.process, proc);
  assert.equal(released, 0);
  assert.doesNotThrow(() => process.kill(proc.pid, 0));
  await client.stop();
  assert.equal(released, 1);
});

test('stdin stream error rejects pending work without an unhandled error or forgotten child', async t => {
  const client = clientFor(t);
  await client.start();
  const proc = client.process;
  const controller = new AbortController();
  const request = client.request('hang', {}, { signal: controller.signal });
  const rejected = assert.rejects(request, /PIPE_FAILED/);
  await waitFor(() => client.pending.size);
  assert.doesNotThrow(() => proc.stdin.emit('error', new Error('PIPE_FAILED')));
  await rejected;
  assert.equal(client.pending.size, 0);
  assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(client.process, proc);
});

test('spawn failure can retry with fresh validation and then start a real child', async t => {
  let validation = 0;
  const client = clientFor(t, { command: path.join(__dirname, 'missing-sidecar-executable'),
    beforeSpawn: () => { validation++; } });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(client.start(), /ENOENT/);
    assert.equal(client.process, null);
    assert.equal(client.identity(), null);
    assert.equal(client.readyPromise, null);
  }
  client.command = process.execPath;
  assert.ok((await client.request('echo')).pid);
  assert.equal(validation, 3);
});

async function bounded(promise, ms = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TEST_DEADLINE')), ms);
  })]); } finally { clearTimeout(timer); }
}
function clientFor(t, options = {}) {
  const client = new SidecarClient({ command: process.execPath, args: [fixture], requestTimeoutMs: 500,
    stopGraceMs: 40, stopKillWaitMs: 400, ...options });
  const children = new Set();
  for (const method of ['stop', 'cancel']) {
    const original = client[method].bind(client);
    client[method] = (...args) => {
      if (client.process) children.add(client.process);
      return original(...args);
    };
  }
  const start = client.start.bind(client);
  client.start = (...args) => {
    const result = start(...args);
    if (client.process) children.add(client.process);
    // beforeSpawn may be asynchronous; capture again when start settles.
    result.then(() => { if (client.process) children.add(client.process); }, () => {});
    return result;
  };
  t.after(async () => {
    if (client.process) children.add(client.process);
    // Test ownership fallback kills only children created by this client.
    for (const proc of children) {
      if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
        const exited = once(proc, 'exit');
        proc.kill('SIGKILL');
        await bounded(exited);
      }
    }
    await bounded(client.stop());
    for (const proc of children) {
      if (proc.pid) assert.throws(() => process.kill(proc.pid, 0), { code: 'ESRCH' });
    }
  });
  return client;
}

test('beforeSpawn validates every spawn and false/rejection never starts a child', async t => {
  let validation = 0;
  let allowed = false;
  const client = clientFor(t, { beforeSpawn: async () => {
    validation++;
    if (allowed === 'throw') throw new Error('INVALID_ASSET');
    return allowed;
  } });
  await assert.rejects(client.start(), /VALIDATION/);
  assert.equal(client.process, null);
  allowed = 'throw';
  await assert.rejects(client.start(), /INVALID_ASSET/);
  assert.equal(client.process, null);
  allowed = true;
  const first = await client.request('echo');
  await client.stop();
  allowed = false;
  await assert.rejects(client.start(), /VALIDATION/);
  assert.equal(client.process, null);
  allowed = undefined; // void is accepted for throwing validators (legacy hook convention).
  const second = await client.request('echo');
  assert.notEqual(first.pid, second.pid);
  assert.equal(validation, 5);
});

test('POSIX stop waits for real exit and escalates even when killed is already true', { skip: process.platform === 'win32' }, async t => {
  const client = clientFor(t, { args: [fixture, 'ignore-term'], stopGraceMs: 40, stopKillWaitMs: 400 });
  const ready = await client.start();
  const proc = client.process;
  let observedExit = false;
  proc.once('exit', () => { observedExit = true; });
  const stopping = client.stop();
  await delay(10);
  assert.equal(proc.killed, true); // SIGTERM sent is NOT exit confirmation.
  assert.equal(observedExit, false);
  await bounded(stopping, 1000);
  assert.equal(observedExit, true);
  assert.equal(proc.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
  assert.equal(client.process, null);
});

test('concurrent cancel + final stop holds restart until actual exit then asset cleanup', async t => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const client = clientFor(t, { beforeSpawn: () => { order.push('validate'); },
    afterExit: async () => { order.push('cleanup'); await gate; order.push('released'); } });
  await client.start();
  client.process.once('exit', () => order.push('exit'));
  const cancelling = client.cancel();
  const stopping = client.stop();
  const stoppingAgain = client.stop();
  const restarting = client.request('echo');
  await bounded(cancelling);
  await delay(20);
  assert.deepEqual(order, ['validate', 'exit', 'cleanup']);
  release();
  await bounded(Promise.all([stopping, stoppingAgain, restarting]));
  assert.deepEqual(order, ['validate', 'exit', 'cleanup', 'released', 'validate']);
  await client.cancel();
  assert.equal(order.filter(value => value === 'cleanup').length, 1);
  await client.stop();
  await client.stop();
  assert.equal(order.filter(value => value === 'cleanup').length, 2);
});

for (const invalidation of ['abort-queued-start', 'cancel-start-final-stop']) {
  test(`${invalidation}: later cancellation owns queued intent; a fresh restart waits for cleanup`, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let entered;
    const cleanupEntered = new Promise(resolve => { entered = resolve; });
    let validations = 0;
    const client = clientFor(t, {
      beforeSpawn: () => { validations++; },
      afterExit: async () => { entered(); await gate; },
    });
    await bounded(client.start());
    const oldPid = client.process.pid;
    const firstStop = invalidation === 'abort-queued-start' ? client.stop() : client.cancel();
    const controller = new AbortController();
    const queued = invalidation === 'abort-queued-start'
      ? client.request('echo', {}, { signal: controller.signal }) : client.start();
    // Observe immediately, including the RED path which incorrectly fulfills.
    const outcome = queued.then(value => ({ value }), error => ({ error }));
    if (invalidation === 'abort-queued-start') controller.abort();
    const finalStop = invalidation === 'abort-queued-start' ? firstStop : client.stop();
    await bounded(cleanupEntered);
    assert.equal(validations, 1);
    release();
    await bounded(Promise.all([firstStop, finalStop]));
    const result = await bounded(outcome);
    assert.match(result.error?.name === 'AbortError' ? result.error.name : result.error?.message || 'FULFILLED',
      /AbortError|STOPPED/);
    // Drain the queued continuation, not just the already-rejected request wrapper.
    if (client.startPromise) await bounded(client.startPromise.catch(() => {}));
    assert.equal(validations, 1, 'invalidated queued start must not validate or spawn');
    assert.equal(client.process, null);
    assert.equal(client.pending.size, 0);
    assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
    assert.ok((await bounded(client.request('echo'))).pid, 'genuinely fresh restart is allowed');
    assert.equal(validations, 2);
  });
}

test('afterExit failure is reported and a final stop retries cleanup without respawn', async t => {
  let attempts = 0;
  const client = clientFor(t, { afterExit: () => {
    if (++attempts === 1) throw new Error('RELEASE_FAILED');
  } });
  await client.start();
  await assert.rejects(client.stop(), /RELEASE_FAILED/);
  assert.equal(client.process, null);
  await client.stop();
  await client.stop();
  assert.equal(attempts, 2);
});

test('stop promptly rejects startup while waiting for ready and leaves its real PID gone', async t => {
  const client = clientFor(t, { args: [fixture, 'no-ready'] });
  const starting = client.start();
  const rejected = assert.rejects(starting, /STOPPED/);
  await waitFor(() => client.process);
  const proc = client.process;
  const pid = proc.pid;
  await bounded(client.stop(), 1000);
  await bounded(rejected);
  assert.equal(client.process, null);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

for (const abortTiming of ['synchronous', 'queueMicrotask']) {
  test(`reentrant-validator-abort: ${abortTiming} final stop owns preparation through cleanup`, { timeout: 4000 }, async t => {
    const controller = new AbortController();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const order = [];
    let acquired = false;
    let registered = false;
    const client = clientFor(t, {
      beforeSpawn: async () => {
        const abort = () => {
          registered = Boolean(client.startWork && client.startPromise && client.startToken);
          controller.abort();
        };
        order.push('validator-enter');
        if (abortTiming === 'synchronous') abort();
        else queueMicrotask(abort);
        enter();
        await gate;
        acquired = true;
        order.push('asset-acquired');
      },
      afterExit: () => { order.push('cleanup'); acquired = false; },
    });
    await bounded(client.stop()); // A previous fulfilled cleanup must not mask this lifecycle.
    order.length = 0;
    const request = client.request('echo', {}, { signal: controller.signal });
    const rejected = assert.rejects(request, { name: 'AbortError' });
    // Attach final stop to the entry signal, without first draining the cancel barrier.
    let stopped = false;
    const stopping = entered.then(() => client.stop()).then(() => {
      stopped = true;
      order.push('stop-resolved');
    });
    try {
      await bounded(entered);
      await bounded(rejected, 300); // Caller rejects while actual validation stays gated.
      // Drain runnable continuations while preparation remains explicitly blocked.
      await bounded(new Promise(resolve => setImmediate(resolve)));
      assert.equal(stopped, false, 'final stop must own the synchronously cancelled validator');
      assert.equal(registered, true, 'all startup ownership must exist before user code runs');
      assert.deepEqual(order, ['validator-enter']);
      assert.equal(client.process, null);
    } finally {
      release();
      await bounded(stopping);
      await bounded(client.startWork.catch(() => {}));
    }
    assert.deepEqual(order, ['validator-enter', 'asset-acquired', 'cleanup', 'stop-resolved']);
    assert.equal(acquired, false);
    assert.equal(client.process, null, 'no late spawn after validator completion');
    assert.equal(client.pending.size, 0);
    assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
    await bounded(client.stop());
    assert.equal(acquired, false, 'a repeated stop must not leave late-acquired assets');
    assert.equal(order.filter(value => value === 'cleanup').length, 1);
  });
}

test('immediate-cancel-before-deferred-hook prevents preparation and late spawn', { timeout: 4000 }, async t => {
  let validations = 0;
  let acquired = false;
  let cleanups = 0;
  const client = clientFor(t, {
    beforeSpawn: () => { validations++; acquired = true; },
    afterExit: () => { cleanups++; acquired = false; },
  });
  const starting = client.start();
  const rejected = assert.rejects(starting, /CANCELLED/);
  const cancelling = client.cancel(); // No yield: cancellation precedes the deferred hook.
  const stopping = client.stop();
  await bounded(rejected, 300);
  await bounded(Promise.all([cancelling, stopping]));
  await bounded(client.startWork.catch(() => {}));
  assert.equal(validations, 0, 'a cancelled deferred start must not invoke the validator');
  assert.equal(acquired, false);
  assert.equal(client.process, null);
  assert.equal(client.pending.size, 0);
  await bounded(client.stop());
  assert.equal(cleanups, 1);
  assert.ok((await bounded(client.request('echo'))).pid, 'post-stop fresh startup remains allowed');
  assert.equal(validations, 1);
  await bounded(client.stop());
  assert.equal(acquired, false);
  assert.equal(cleanups, 2);
});

for (const validationResult of ['resolve', 'reject']) {
  for (const interruption of ['stop', 'cancel']) {
  test(`validator-final-stop: ${interruption} waits for actual ${validationResult} after prompt caller rejection, then releases acquired assets`, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    let acquired = false;
    let validations = 0;
    const order = [];
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const client = clientFor(t, {
      beforeSpawn: async () => {
        validations++;
        order.push('validation-start');
        enter();
        await gate;
        acquired = true;
        order.push('asset-acquired');
        if (validationResult === 'reject') throw new Error('VALIDATOR_FAILED');
      },
      afterExit: () => { order.push('cleanup'); acquired = false; },
    });
    await bounded(client.stop()); // Prime fulfilled cleanup cache from prior lifecycle.
    order.length = 0;
    const starting = client.start();
    const rejected = assert.rejects(starting, interruption === 'stop' ? /STOPPED/ : /CANCELLED/);
    await bounded(entered);
    const cancelling = client[interruption]();
    let stopped = false;
    const stopping = client.stop().then(() => { stopped = true; });
    await bounded(rejected, 300); // Caller cancellation must NOT wait for validator.
    await delay(20);
    assert.equal(stopped, false, 'final stop must wait for actual preparation completion');
    assert.deepEqual(order, ['validation-start']);
    assert.equal(client.process, null);
    release();
    await bounded(Promise.all([cancelling, stopping]));
    assert.deepEqual(order, ['validation-start', 'asset-acquired', 'cleanup']);
    assert.equal(acquired, false);
    assert.equal(validations, 1);
    assert.equal(client.process, null, 'no late spawn after validator settles');
    await bounded(client.stop());
    assert.equal(order.filter(value => value === 'cleanup').length, 1);
    client.beforeSpawn = () => { acquired = true; };
    await bounded(client.start());
    await bounded(client.stop());
    assert.equal(acquired, false, 'fresh restart receives fresh final cleanup');
    assert.equal(order.filter(value => value === 'cleanup').length, 2);
  });
  }
}

for (const phase of ['before-start', 'await-ready', 'in-flight']) {
  test(`request AbortSignal: ${phase} rejects promptly and does not retain listeners`, async t => {
    const controller = new AbortController();
    const client = clientFor(t, { args: [fixture, phase === 'await-ready' ? 'no-ready' : 'normal'] });
    if (phase === 'before-start') controller.abort();
    if (phase === 'in-flight') await client.start();
    const request = client.request('hang', {}, { signal: controller.signal });
    const rejected = assert.rejects(bounded(request, 300), { name: 'AbortError' });
    if (phase !== 'before-start') {
      await waitFor(() => client.process && (phase !== 'in-flight' || client.pending.size));
      controller.abort();
    }
    await rejected;
    assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(client.pending.size, 0);
    if (phase === 'before-start') assert.equal(client.process, null);
    else {
      await bounded(client.cancel());
      assert.equal(client.process, null);
    }
  });
}
