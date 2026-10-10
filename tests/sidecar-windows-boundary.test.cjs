// UNIT OS-boundary doubles, NOT native Windows/taskkill/process-tree proof.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../apps/desktop/sidecar-client.cjs'), 'utf8');
async function bounded(promise, ms = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TEST_DEADLINE')), ms);
  })]); } finally { clearTimeout(timer); }
}

for (const mode of ['success', 'failure', 'unconfirmed']) {
  test(`Windows startup deadline boundary: ${mode} uses tracked tree termination before final cleanup`, async t => {
    // Actual product source + owned Node child; only OS/utility/deadline are doubles.
    // Invoke the real 30s callback explicitly; this is NOT native Windows proof.
    let deadline;
    let child;
    let utilityCallback;
    let utilityCalls = 0;
    let released = 0;
    const boundary = {
      ...cp,
      spawn(...args) { child = cp.spawn(...args); return child; },
      execFile(command, args, options, callback) {
        utilityCalls++;
        assert.equal(command, 'taskkill.exe');
        assert.deepEqual(Array.from(args), ['/PID', String(child.pid), '/T', '/F']);
        assert.equal(options.shell, false);
        assert.equal(child.stdin.writableEnded, false);
        utilityCallback = callback;
        child.kill('SIGKILL'); // Only the owned child, never a host process tree.
        return { kill() {} };
      },
    };
    const sandbox = {
      module: { exports: {} }, require: id => id === 'node:child_process' ? boundary : require('node:module').createRequire(require.resolve('../apps/desktop/sidecar-client.cjs'))(id),
      process: { platform: 'win32', env: process.env }, console, clearTimeout,
      setTimeout(callback, ms) {
        if (ms === 30000) { deadline = callback; return undefined; }
        return setTimeout(callback, ms);
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'sidecar-client.cjs' });
    const client = new sandbox.module.exports.SidecarClient({ command: process.execPath,
      args: [path.join(__dirname, 'fixtures/sidecar-lifecycle.cjs'), 'no-ready'],
      stopGraceMs: 20, stopKillWaitMs: 200, afterExit: () => { released++; } });
    t.after(async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await bounded(exited);
      }
      await bounded(client.stop().catch(() => {}));
      if (child?.pid) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    });
    const starting = client.start();
    const rejected = assert.rejects(starting, { message: 'VOICE_RUNTIME_START_TIMEOUT' });
    await bounded(new Promise(resolve => setImmediate(resolve)));
    assert.equal(typeof deadline, 'function');
    const exited = once(child, 'exit');
    deadline();
    await bounded(rejected, 300);
    assert.equal(utilityCalls, 1, 'deadline must not directly kill the leader');
    let stopped = false;
    const stopping = client.stop().then(() => { stopped = true; });
    const result = stopping.then(() => null, error => error);
    await bounded(exited);
    assert.equal(released, 0, 'leader exit alone cannot release assets');
    assert.equal(stopped, false);
    if (mode !== 'unconfirmed') utilityCallback(mode === 'failure' ? new Error('TASKKILL_FAILED') : null);
    const error = await bounded(result);
    if (mode === 'success') {
      assert.equal(error, null);
      assert.equal(released, 1);
      assert.equal(client.terminationFailure, null);
    } else {
      assert.match(error.message, /TASKKILL_FAILED|TERMINATION_TIMEOUT/);
      assert.equal(client.terminationFailure, error);
      await assert.rejects(bounded(client.stop()), { message: error.message });
      await assert.rejects(bounded(client.start()), { message: error.message });
      utilityCallback(null); // Late utility success cannot erase an unknown-tree failure.
      assert.equal(released, 0);
      assert.equal(client.terminationFailure, error);
    }
    assert.equal(client.process, null);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  });
}

for (const mode of ['hang', 'failure', 'success-without-exit', 'exit-before-utility-success', 'exit-without-utility-success', 'success-with-open-stdin']) {
  test(`Windows utility boundary: ${mode} is bounded and never substitutes for observed exit`, async t => {
    let child;
    let utilityCalls = 0;
    let utilityKills = 0;
    let utilityCallback;
    let released = 0;
    let exitObserved = false;
    const timers = [];
    const boundary = {
      ...cp,
      spawn(...args) { child = cp.spawn(...args); return child; },
      execFile(command, args, options, callback) {
        utilityCalls++;
        utilityCallback = callback;
        assert.equal(command, 'taskkill.exe');
        assert.deepEqual(Array.from(args), ['/PID', String(child.pid), '/T', '/F']);
        assert.equal(options.windowsHide, true);
        assert.equal(options.shell, false);
        assert.equal(options.killSignal, 'SIGKILL');
        assert.ok(Number.isFinite(options.timeout) && options.timeout > 0 && options.timeout <= 100);
        if (mode === 'success-with-open-stdin') {
          // EOF could make the leader exit before taskkill can enumerate its tree.
          assert.equal(child.stdin.writableEnded, false);
          child.once('exit', () => callback(null));
          child.kill('SIGKILL');
        }
        if (mode === 'failure') queueMicrotask(() => callback(new Error('TASKKILL_FAILED')));
        if (mode === 'success-without-exit') queueMicrotask(() => callback(null));
        if (mode === 'exit-without-utility-success') child.kill('SIGKILL');
        if (mode === 'exit-before-utility-success') {
          child.kill('SIGKILL');
          child.once('exit', () => {
            timers.push(setTimeout(() => callback(null), 20));
          });
        }
        return { kill(signal) { assert.equal(signal, 'SIGKILL'); utilityKills++; } };
      },
    };
    const sandbox = { module: { exports: {} }, require: id => id === 'node:child_process' ? boundary : require('node:module').createRequire(require.resolve('../apps/desktop/sidecar-client.cjs'))(id),
      process: { platform: 'win32', env: process.env }, console, setTimeout, clearTimeout };
    vm.runInNewContext(source, sandbox, { filename: 'sidecar-client.cjs' });
    const client = new sandbox.module.exports.SidecarClient({ command: process.execPath,
      args: [path.join(__dirname, 'fixtures/sidecar-lifecycle.cjs'), 'ignore-term'],
      stopGraceMs: 20, stopKillWaitMs: 60, afterExit: () => { released++; } });
    t.after(async () => {
      for (const timer of timers) clearTimeout(timer);
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await bounded(exited);
      }
      await bounded(client.stop().catch(() => {}));
      if (child?.pid) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    });
    await bounded(client.start());
    child.once('exit', () => { exitObserved = true; });
    const exitListenersBeforeStop = child.listeners('exit');
    const stopping = client.stop();
    if (mode === 'success-with-open-stdin') {
      await bounded(stopping);
      assert.equal(exitObserved, true);
      assert.equal(released, 1);
    } else if (mode === 'exit-before-utility-success') {
      await bounded(once(child, 'exit'));
      assert.equal(released, 0);
      await bounded(stopping);
      assert.equal(released, 1);
    } else if (mode === 'exit-without-utility-success') {
      await assert.rejects(stopping, /TERMINATION_TIMEOUT/);
      assert.equal(exitObserved, true);
      assert.equal(released, 0);
      await assert.rejects(client.stop(), /TERMINATION_TIMEOUT/);
      await assert.rejects(client.start(), /TERMINATION_TIMEOUT/);
      utilityCallback(null);
      assert.equal(released, 0);
    } else {
      await assert.rejects(stopping, /TASKKILL_FAILED|TERMINATION_TIMEOUT/);
      assert.equal(exitObserved, false);
      assert.equal(released, 0);
      assert.equal(client.process, child);
      assert.deepEqual(child.listeners('exit'), exitListenersBeforeStop); // retain real lifecycle observers; no abandoned termination listener.
      if (mode === 'hang') assert.equal(utilityKills, 1);
      utilityCallback?.(null); // late completion must not release assets or confirm exit.
      assert.equal(released, 0);
    }
    assert.equal(utilityCalls, 1);
  });
}
