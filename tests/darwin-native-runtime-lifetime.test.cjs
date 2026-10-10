'use strict';
// MEMORY authority/OS boundaries are explicit; native tests below use real OS
// launches. A test fixture authority never becomes a production compiled root.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const {createHash} = require('node:crypto');
const {PassThrough} = require('node:stream');
const {createRequire} = require('node:module');
const {canonicalInventory, verifyInventorySync} = require('../apps/desktop/tree-integrity.cjs');
const ROOT = path.resolve(__dirname, '..');
const SCOPE = 'DARWIN_KERNEL_NO_FORK_RUNTIME_V1';
const LAUNCHER = '/usr/bin/sandbox-exec';
const PROFILE = '(version 1) (allow default) (deny process-fork)';
const nativeHost = process.platform === 'darwin' && process.arch === 'arm64';
const NATIVE_CONTROL_SOURCE = String.raw`
#include <stdio.h>
#include <errno.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>
int main(void) {
  int fork_error=0, status=0;
  pid_t forked=fork();
  if (forked==0) _exit(0);
  if (forked<0) fork_error=errno;
  else waitpid(forked,&status,0);
  pid_t spawned=0;
  char *args[]={"/usr/bin/true",NULL};
  char *env[]={NULL};
  int spawn_error=posix_spawn(&spawned,args[0],NULL,NULL,args,env);
  if (spawn_error==0) waitpid(spawned,&status,0);
  printf("{\"event\":\"ready\",\"forkErrno\":%d,\"posixSpawnErrno\":%d,\"pid\":%d}\n",fork_error,spawn_error,(int)getpid());
  fflush(stdout);
  char input[4096];
  while (fgets(input,sizeof(input),stdin)) {}
  return 0;
}
`;

const tick = () => new Promise(resolve => setImmediate(resolve));
async function closeMemory(child, {holdStdout = false, holdStderr = false, close = true, code = 0, signal = null} = {}) {
  if (!holdStdout) child.stdout.end();
  if (!holdStderr) child.stderr.end();
  child.exitCode = code; child.signalCode = signal;
  child.emit('exit', code, signal);
  if (close) child.emit('close', code, signal);
  await tick();
}
async function startMemory(b, client) {
  const result = client.start().catch(error => error);
  await tick();
  const child = b.children.at(-1);
  assert.ok(child, `producer did not dispatch: ${(await Promise.race([result, Promise.resolve(null)]))?.message}`);
  child.emit('spawn'); child.stdout.write('{"event":"ready"}\n');
  const ready = await result;
  assert.equal(ready.event, 'ready', ready.message);
  return child;
}


function boundary(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'darwin-native-lifetime-'));
  const calls = [], children = [], cache = new Map();
  t.after(async () => {
    for (const child of children) {
      child.stdout.resume(); child.stderr.resume();
      if (!options.realSpawn) await closeMemory(child);
      if (options.realSpawn && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('TEST_CHILD_REAP_TIMEOUT')), 3000);
          child.once('close', () => {clearTimeout(timer); resolve();});
        });
      }
    }
    fs.rmSync(root, {recursive: true, force: true});
  });
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(runtimeRoot, 'bin'), {recursive: true, mode: 0o700});
  const command = path.join(runtimeRoot, 'bin/voice-runtime');
  if (options.nativeControl) {
    const built = cp.spawnSync('/usr/bin/clang', ['-x', 'c', '-', '-o', command], {
      input: NATIVE_CONTROL_SOURCE, encoding: 'utf8', env: {PATH: '/usr/bin:/bin'}, timeout: 30000, maxBuffer: 65536,
    });
    assert.equal(built.status, 0, built.stderr);
  } else fs.copyFileSync('/usr/bin/true', command);
  fs.chmodSync(command, 0o500);
  const bytes = fs.readFileSync(command);
  const inventory = canonicalInventory([{path: 'bin/voice-runtime', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')}]);
  const nativeRuntime = Object.freeze({});
  const sources = new WeakMap();

  const controls = {launcher: null, rejectSignature: false, signatures: []};
  const fileSystem = {...fs, lstatSync(file, ...args) {
    if (file !== LAUNCHER || !controls.launcher) return fs.lstatSync(file, ...args);
    if (controls.launcher === 'missing') throw Object.assign(Error('fixture missing launcher'), {code: 'ENOENT'});
    const stat = fs.lstatSync(file, ...args);
    if (controls.launcher === 'symlink') stat.isSymbolicLink = () => true;
    if (controls.launcher === 'writable') stat.mode |= typeof stat.mode === 'bigint' ? 0o022n : 0o022;
    if (controls.launcher === 'owner') stat.uid = typeof stat.uid === 'bigint' ? 501n : 501;
    if (controls.launcher === 'identity') stat.ino += typeof stat.ino === 'bigint' ? 4096n : 4096;
    return stat;
  }};
  let sourceChecks = 0, clockOffset = 0;
  const descriptor = Object.freeze({authority: 'COMPILED_ROOT', command, root: runtimeRoot, inventory,
    verifyRuntimeBeforeSpawn() {
      sourceChecks++;
      verifyInventorySync(runtimeRoot, inventory);
      return true;
    }});
  sources.set(nativeRuntime, descriptor);
  class Child extends cp.ChildProcess {
    constructor(file, args) {
      super(); this.pid = 7000 + children.length;
      this.spawnfile = file; this.spawnargs = [file, ...args];
      this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
      this.stdio = [this.stdin, this.stdout, this.stderr];
      this.exitCode = this.signalCode = null; this.killed = false;
    }
    kill(signal) { this.killed = true; this.lastSignal = signal; return true; }
  }
  const childProcess = {...cp, execFileSync(file, args, settings) {
    if (file === '/usr/bin/codesign') {
      controls.signatures.push({command: file, args: [...args], settings});
      if (controls.rejectSignature) throw Error('TEST_ONLY_BAD_APPLE_SIGNATURE');
    }
    return cp.execFileSync(file, args, settings);
  }, spawn(file, args, settings) {
    calls.push({command: file, args: [...args], settings});
    if (controls.throwSpawn) throw Error('TEST_SYNCHRONOUS_SPAWN_FAILURE');
    const child = options.realSpawn ? cp.spawn(file, args, settings) : new Child(file, args);
    if (controls.substituteLaunch) child.spawnfile = '/usr/bin/true';
    children.push(child); return child;
  }};
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = {exports: {}}; cache.set(file, module);
    const localRequire = createRequire(file);
    const req = id => {
      if (id === 'node:child_process') return childProcess;
      if (id === 'node:fs') return fileSystem;
      if (id === 'node:perf_hooks') return {performance: {now: () => performance.now() + clockOffset}};
      if (id === './bundled-voice-assets.cjs') return {
        authenticatedBundledRuntimeSource: value => sources.get(value) || null,
      };
      if (id.startsWith('./') && ['sidecar-client.cjs', 'darwin-owned-lifetime.cjs', 'managed-asset-lease.cjs'].includes(path.basename(id))) {
        return load(path.resolve(path.dirname(file), id));
      }
      return localRequire(id);
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {module, exports: module.exports, require: req,
      __dirname: path.dirname(file), __filename: file,
      process: {platform: options.platform || 'darwin', arch: options.arch || 'arm64', execPath: process.execPath, env: {}},
      console, Buffer, setTimeout, clearTimeout}, {filename: file});
    // Explicit MEMORY managed-source seam; not a production asset authority.
    if (options.sourceProof && path.basename(file) === 'managed-asset-lease.cjs') {
      module.exports.verifyManagedAssetLaunch = () => options.sourceProof;
    }
    return module.exports;
  }
  const producer = load(path.join(ROOT, 'apps/desktop/darwin-owned-lifetime.cjs'));
  const {SidecarClient} = load(path.join(ROOT, 'apps/desktop/sidecar-client.cjs'));
  const {bindClientAssets} = load(path.join(ROOT, 'apps/desktop/managed-asset-lease.cjs'));

  function client(extra = {}) {
    return new SidecarClient({command, args: [], env: {}, nativeRuntime,
      trackAssetLifetime: true, lifetimePurpose: 'hybrid-speech', ...extra});
  }
  return {producer, SidecarClient, bindClientAssets, nativeRuntime, descriptor, sourceChecks: () => sourceChecks,
    children, calls, controls, command, runtimeRoot, root, client,
    advance: ms => {clockOffset += ms;}};
}

test('MEMORY authority: only the original authenticated hybrid runtime gets its distinct scope', {skip: !nativeHost}, t => {
  const b = boundary(t), client = b.client();
  assert.equal(client.assetLifetimeSnapshot().qualificationScope, SCOPE);
  assert.equal(client.assetLifetimeSnapshot().coverage, 'darwin-owned-handles');
  assert.equal(client.assetLifetimeSnapshot().purpose, 'hybrid-speech');
  for (const nativeRuntime of [null, {...b.nativeRuntime}, Object.create(b.nativeRuntime), b.descriptor,
    Object.freeze({...b.descriptor}), Object.freeze({authority: 'COMPILED_ROOT'})]) {
    assert.equal(b.client({nativeRuntime}).assetLifetimeSnapshot().coverage, 'leader-only');
  }
  for (const lifetimePurpose of ['managed-speech', 'candidate-probe', 'r55-control', null]) {
    assert.equal(b.client({lifetimePurpose}).assetLifetimeSnapshot().coverage, 'leader-only');
  }
  assert.throws(() => b.client({args: {length: 0, *[Symbol.iterator]() {}}}), /DARWIN_NATIVE_SOURCE/);
  assert.equal(b.calls.length, 0);
});

test('MEMORY lifecycle: fixed kernel launcher and original drained handle authorize exactly one release', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client({stopGraceMs: 20, stopKillWaitMs: 60});
  let releases = 0;
  const bundle = {verify: async () => true, release: async () => {releases++;}};
  const binding = b.bindClientAssets(client, bundle);
  client.beforeSpawn = () => binding.beforeSpawn();
  const child = await startMemory(b, client);
  assert.equal(b.calls[0].command, LAUNCHER);
  assert.deepEqual(b.calls[0].args, ['-p', PROFILE, b.command]);
  assert.deepEqual(Array.from(b.calls[0].settings.stdio), ['pipe', 'pipe', 'pipe']);
  assert.equal(b.calls[0].settings.shell, false);
  assert.ok(b.sourceChecks() >= 2, 'synchronous integrity must run again at actual launch');
  const live = client.assetLifetimeSnapshot();
  assert.equal(live.unresolvedGenerations, 1);
  assert.equal(b.producer.authenticatedDarwinSnapshot(live, client, bundle), true);
  assert.equal(b.producer.authenticatedDarwinSnapshot(Object.freeze({...live}), client, bundle), false);
  assert.equal(b.producer.authenticatedDarwinSnapshot(Object.create(live), client, bundle), false);
  assert.equal(b.producer.authenticatedDarwinSnapshot(live, {}, bundle), false);
  assert.equal(b.producer.authenticatedDarwinSnapshot(live, client, {}), false);
  binding.retire();
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
  await closeMemory(child);
  await client.stop();
  assert.equal(b.producer.authenticatedDarwinSnapshot(live, client, bundle), false);
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 0);
  assert.equal(b.producer.inspectDarwinControl(client).scope, SCOPE);
  await Promise.all([binding.release(client, bundle), binding.release(client, bundle)]);
  assert.equal(releases, 1);
});

for (const failure of ['missing', 'symlink', 'writable', 'owner', 'signature']) {
  test(`MEMORY launcher qualification rejects ${failure} before granting scope`, {skip: !nativeHost}, t => {
    const b = boundary(t);
    if (failure === 'signature') b.controls.rejectSignature = true;
    else b.controls.launcher = failure;
    assert.throws(() => b.client(), /DARWIN_NATIVE_LAUNCHER_UNQUALIFIED/);
    assert.equal(b.calls.length, 0);
  });
}

test('MEMORY launcher identity is revalidated before every actual dispatch', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client();
  const bundle = {verify: async () => true, release: async () => assert.fail('retained')};
  const binding = b.bindClientAssets(client, bundle);
  client.beforeSpawn = () => binding.beforeSpawn();
  b.controls.launcher = 'identity';
  const starting = client.start(); starting.catch(() => {});
  await tick();
  assert.equal(b.calls.length, 0, 'changed launcher must never dispatch');
  await assert.rejects(starting, /DARWIN_NATIVE_LAUNCHER_UNQUALIFIED/);
  binding.retire();
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
});

for (const [key, value] of [
  ['DYLD_INSERT_LIBRARIES', '/evil'], ['DYLD_LIBRARY_PATH', '/evil'],
  ['NODE_OPTIONS', '--require=/evil'], ['NODE_PATH', '/evil'],
  ['PYTHONPATH', '/evil'], ['PYTHONHOME', '/evil'], ['PYTHONINSPECT', '1'],
  ['_PYI_APPLICATION_HOME_DIR', '/evil'], ['LD_PRELOAD', '/evil'], ['BASH_ENV', '/evil'],
  ['PATH', '/evil'], ['PYTHONNOUSERSITE', '0'], ['PYTHONDONTWRITEBYTECODE', '0'],
]) {
  test(`MEMORY native launch rejects environment injection ${key}`, {skip: !nativeHost}, t => {
    const b = boundary(t);
    assert.throws(() => b.client({env: {[key]: value}}), /DARWIN_NATIVE_ENV/);
    assert.equal(b.calls.length, 0);
  });
}

test('MEMORY native environment permits only fixed safety flags and bound packaged paths', {skip: !nativeHost}, async t => {
  const b = boundary(t);
  const env = require('../apps/desktop/sidecar-environment.cjs').buildPackagedSidecarEnvironment({
    parent: {}, platform: 'darwin', arch: 'arm64', tempRoot: path.join(b.root, 'temp'), cacheRoot: path.join(b.root, 'cache'),
    trustedVoice: {VOICE_STT_BACKEND: 'mlx-whisper', VOICE_TTS_BACKEND: 'kokoro-onnx', VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu'},
  });
  env.PYTHONNOUSERSITE = '1';
  const client = b.client({env});
  const bundle = {verify: async () => true, release: async () => assert.fail('retained')};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  client.env = {...env, TMP: path.join(b.root, 'changed-temp')};
  const starting = client.start(); starting.catch(() => {}); await tick();
  assert.equal(b.calls.length, 0);
  await assert.rejects(starting, /DARWIN_NATIVE_ENV/);
  binding.retire(); await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
});

test('MEMORY native environment rejects accessors without invoking them', {skip: !nativeHost}, t => {
  const b = boundary(t); let invoked = false;
  const env = Object.defineProperty({}, 'HOME', {enumerable: true, get() {invoked = true; return b.root;}});
  assert.throws(() => b.client({env}), /DARWIN_NATIVE_ENV/);
  assert.equal(invoked, false);
});

test('MEMORY native runtime root identity cannot be replaced even with identical inventory bytes', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client();
  assert.throws(() => b.client({command: '/usr/bin/true'}), /DARWIN_NATIVE_SOURCE/);
  assert.throws(() => b.client({args: ['--arbitrary']}), /DARWIN_NATIVE_SOURCE/);
  const bundle = {verify: async () => true, release: async () => assert.fail('retained')};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  const original = path.join(b.root, 'original-runtime');
  fs.renameSync(b.runtimeRoot, original);
  fs.cpSync(original, b.runtimeRoot, {recursive: true});
  const starting = client.start(); starting.catch(() => {}); await tick();
  assert.equal(b.calls.length, 0);
  await assert.rejects(starting, /DARWIN_NATIVE_SOURCE/);
  binding.retire(); await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
});

test('NATIVE kernel control: ordinary program runs, fork and posix_spawn are denied; EOF drains before release',
  {skip: !nativeHost, timeout: 40000}, async t => {
    const b = boundary(t, {realSpawn: true, nativeControl: true});
    const baseline = cp.spawnSync(b.command, [], {input: '', env: {}, encoding: 'utf8', timeout: 3000});
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).forkErrno, 0);
    assert.equal(JSON.parse(baseline.stdout).posixSpawnErrno, 0);
    const client = b.client({stopGraceMs: 200, stopKillWaitMs: 500});
    let releases = 0;
    const bundle = {verify: async () => true, release: async () => {releases++;}};
    const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
    const ready = await client.start();
    assert.equal(ready.forkErrno, os.constants.errno.EPERM, 'real fork must fail in the kernel');
    assert.equal(ready.posixSpawnErrno, os.constants.errno.EPERM, 'real posix_spawn must fail in the kernel');
    const child = b.children[0];
    assert.equal(child.spawnfile, LAUNCHER);
    assert.equal(ready.pid, child.pid, 'sandbox-exec must exec into the original owned leader');
    assert.deepEqual(child.spawnargs, [LAUNCHER, '-p', PROFILE, b.command]);
    assert.equal(b.controls.signatures.length >= 2, true);
    for (const call of b.controls.signatures) {
      assert.equal(call.settings.timeout, 3000);
      assert.equal(call.settings.killSignal, 'SIGKILL', 'signature verifier deadline cannot rely on an ignorable signal');
      assert.deepEqual(Object.keys(call.settings.env), []);
      assert.equal(call.settings.shell, false);
    }
    binding.retire();
    const stopping = client.stop(); stopping.catch(() => {});
    assert.equal(child.killed, false, 'native stop must first request EOF, not preempt it with SIGTERM');
    await stopping;
    const control = b.producer.inspectDarwinControl(client);
    assert.equal(control.groups.length, 1);
    const record = control.groups[0].records[0];
    assert.equal(record.exited, true); assert.equal(record.reaped, true); assert.equal(record.drained, true);
    assert.equal(record.code, 0); assert.equal(record.signal, null);
    assert.equal(Object.hasOwn(record, 'receipt'), false, 'no fabricated R55 receipt');
    await binding.release(client, bundle); assert.equal(releases, 1);
    t.diagnostic(JSON.stringify({nativeKernel: true, forkErrno: ready.forkErrno, posixSpawnErrno: ready.posixSpawnErrno,
      pid: child.pid, exited: record.exited, reaped: record.reaped, drained: record.drained, code: record.code, scope: control.scope}));
  });

test('MEMORY original stderr handle cannot be replaced with an ended lookalike to claim closure', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client({stopGraceMs: 20, stopKillWaitMs: 40});
  let releases = 0;
  const bundle = {verify: async () => true, release: async () => {releases++;}};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  const child = await startMemory(b, client), original = child.stderr;
  await closeMemory(child, {holdStderr: true}); binding.retire();
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
  const replacement = new PassThrough(); replacement.resume(); replacement.end(); await tick();
  child.stderr = replacement;
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
  assert.equal(releases, 0);
  child.stderr = original; original.end(); await tick();
  await client.stop();
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/, 'replacement history must remain sticky');
});

test('MEMORY source observation keeps version 3 and the actual producer scope, not an overridable snapshot', {skip: !nativeHost}, async t => {
  const proof = Object.freeze({version: 3, authority: 'COMPILED_ROOT', assets: Object.freeze([])});
  const b = boundary(t, {sourceProof: proof}), client = b.client();
  const bundle = {verify: async () => true, release: async () => {}};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  const child = await startMemory(b, client);
  client.assetLifetimeSnapshot = () => Object.freeze({qualificationScope: 'forged-scope'});
  const observation = b.SidecarClient.observeManagedAssets(client);
  assert.equal(observation.status, 'SOURCE_BOUND'); assert.equal(observation.version, 3);
  assert.equal(observation.qualificationScope, SCOPE);
  assert.equal(observation.coverage, 'darwin-owned-handles');
  await closeMemory(child); await client.stop();
});

for (const missing of ['stdout', 'stderr', 'close']) {
  test(`MEMORY retirement waits for original ${missing}; Stop retains ownership until it arrives`, {skip: !nativeHost}, async t => {
    const b = boundary(t), client = b.client({stopGraceMs: 100, stopKillWaitMs: 100});
    let releases = 0, stopped = false;
    const bundle = {verify: async () => true, release: async () => {releases++;}};
    const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
    const child = await startMemory(b, client);
    await closeMemory(child, {holdStdout: missing === 'stdout', holdStderr: missing === 'stderr', close: missing !== 'close'});
    binding.retire(); await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
    const stopping = client.stop().then(() => {stopped = true;});
    await tick(); assert.equal(stopped, false); assert.equal(releases, 0);
    if (missing === 'close') child.emit('close', 0, null); else child[missing].end();
    await stopping; await binding.release(client, bundle); assert.equal(releases, 1);
  });
}

test('MEMORY timeout is bounded and sticky despite a later clean-looking original closure', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client({stopGraceMs: 10, stopKillWaitMs: 20});
  const bundle = {verify: async () => true, release: async () => assert.fail('retained')};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  const child = await startMemory(b, client);
  binding.retire();
  await assert.rejects(client.stop(), /DARWIN_OWNED_CLOSURE_TIMEOUT/);
  assert.equal(child.lastSignal, 'SIGKILL');
  await closeMemory(child);
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
});

for (const deadline of [Infinity, NaN, -1, 30001]) {
  test(`MEMORY native Stop rejects invalid finite bound ${deadline}`, {skip: !nativeHost}, async t => {
    const b = boundary(t), client = b.client();
    const bundle = {verify: async () => true, release: async () => {}};
    const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
    const child = await startMemory(b, client);
    client.stopGraceMs = deadline;
    const stopping = client.stop(); stopping.catch(() => {});
    await closeMemory(child);
    await assert.rejects(stopping, /DARWIN_STOP_DEADLINE/);
  });
}

test('MEMORY long native session and large TTS output do not inherit R55 caps; old generation stays stale', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client({lifetimeDeadline: 1});
  let releases = 0;
  const bundle = {verify: async () => true, release: async () => {releases++;}};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  b.advance(60000);
  const first = await startMemory(b, client);
  first.stdout.write(JSON.stringify({event: 'test-audio-sized-message', data: 'x'.repeat(300000)}) + '\n');
  const live = client.assetLifetimeSnapshot(); assert.equal(live.fault, false);
  await closeMemory(first); await client.cancel();
  const old = client.assetLifetimeSnapshot();
  const second = await startMemory(b, client);
  assert.notEqual(second, first);
  assert.equal(b.producer.authenticatedDarwinSnapshot(old, client, bundle), false);
  await assert.rejects(client._terminate({...first}), /DARWIN_ORIGINAL_GENERATION/);
  first.emit('close', 0, null);
  binding.retire(); await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
  await closeMemory(second); await client.stop(); await binding.release(client, bundle);
  const groups = b.producer.inspectDarwinControl(client).groups;
  assert.equal(groups.length, 2); assert.equal(groups[0].records[0].retained.stdout, 262144);
  assert.equal(releases, 1);
});

test('MEMORY authorization without dispatch is not a zero-leader closure proof', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client();
  const bundle = {verify: async () => true, release: async () => assert.fail('retained')};
  const binding = b.bindClientAssets(client, bundle);
  await binding.beforeSpawn(); binding.retire(); await client.stop();
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations, 1);
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
  assert.equal(b.calls.length, 0);
});

for (const fault of ['pipe', 'child', 'nonzero', 'signal']) {
  test(`MEMORY native ${fault} fault survives exit/reap/drain and retains assets`, {skip: !nativeHost}, async t => {
    const b = boundary(t), client = b.client();
    const bundle = {verify: async () => true, release: async () => assert.fail('retained')};
    const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
    const child = await startMemory(b, client);
    if (fault === 'pipe') child.stderr.emit('error', Error('TEST_PIPE_ERROR'));
    if (fault === 'child') child.emit('error', Error('TEST_CHILD_ERROR'));
    await closeMemory(child, {code: fault === 'nonzero' ? 1 : fault === 'signal' ? null : 0,
      signal: fault === 'signal' ? 'SIGKILL' : null});
    binding.retire(); await client.stop();
    assert.equal(client.assetLifetimeSnapshot().fault, true);
    await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
  });
}

test('MEMORY actual spawn identity mismatch retains the original child obligation', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client({stopGraceMs: 20, stopKillWaitMs: 30});
  const bundle = {verify: async () => true, release: async () => assert.fail('retained')};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  b.controls.substituteLaunch = true;
  const starting = client.start(); starting.catch(() => {}); await tick();
  assert.equal(b.children.length, 1, 'attempted spawn remains producer-owned');
  b.children[0].emit('spawn'); b.children[0].stdout.write('{"event":"ready"}\n');
  await assert.rejects(starting, /DARWIN_NATIVE_LAUNCH_UNQUALIFIED/);
  assert.equal(b.producer.inspectDarwinControl(client).groups.length, 1);
  binding.retire(); await closeMemory(b.children[0]); await client.stop();
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
});

test('MEMORY native producer rejects a repeated generation and copied producer handles', {skip: !nativeHost}, async t => {
  const b = boundary(t), owner = {clientId: 'native-generation-owner'}, bundle = {};
  const producer = b.producer.createDarwinProducer(owner, {command: b.command, args: [], env: {},
    purpose: 'hybrid-speech', nativeRuntime: b.nativeRuntime});
  b.producer.bindDarwinLease(producer, owner, bundle);
  assert.throws(() => b.producer.authorizeDarwinDispatch(Object.freeze({...producer}), owner, bundle), /DARWIN_AUTHORIZATION/);
  const generation = '22222222-2222-4222-8222-222222222222';
  b.producer.authorizeDarwinDispatch(producer, owner, bundle);
  const child = b.producer.spawnDarwinLeader(producer, owner, {command: b.command, args: [], env: {}, generation});
  child.emit('spawn'); await closeMemory(child);
  b.producer.darwinSnapshot(producer, owner, 0);
  b.producer.authorizeDarwinDispatch(producer, owner, bundle);
  assert.throws(() => b.producer.spawnDarwinLeader(producer, owner,
    {command: b.command, args: [], env: {}, generation}), /DARWIN_NATIVE_GENERATION/);
  assert.equal(b.calls.length, 1);
});

test('MEMORY synchronous spawn failure keeps an unknown obligation, never borrowing the previous handle', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client();
  const bundle = {verify: async () => true, release: async () => assert.fail('retained')};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  const first = await startMemory(b, client); await closeMemory(first); await client.cancel();
  b.controls.throwSpawn = true;
  await assert.rejects(client.start(), /TEST_SYNCHRONOUS_SPAWN_FAILURE/);
  binding.retire(); await client.stop();
  assert.equal(client.assetLifetimeSnapshot().unknown, true);
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
  const groups = b.producer.inspectDarwinControl(client).groups;
  assert.equal(groups.length, 2); assert.equal(groups[1].closed, false);
  assert.equal(groups[1].records[0].pid, undefined);
  assert.equal(groups[1].records[0].exited, undefined);
});

test('MEMORY native preparation remains pending through cancellation; retired late authorization cannot spawn', {skip: !nativeHost}, async t => {
  const b = boundary(t), client = b.client();
  let resolve, releases = 0;
  const bundle = {verify: () => new Promise(r => {resolve = r;}), release: async () => {releases++;}};
  const binding = b.bindClientAssets(client, bundle); client.beforeSpawn = () => binding.beforeSpawn();
  const initial = client.assetLifetimeSnapshot();
  const starting = client.start(); starting.catch(() => {}); await tick();
  assert.equal(client.assetLifetimeSnapshot().pendingPreparation, true);
  assert.equal(b.producer.authenticatedDarwinSnapshot(initial, client, bundle), false);
  binding.retire(); const stopping = client.stop();
  await assert.rejects(starting, /VOICE_RUNTIME_STOPPED/);
  await assert.rejects(binding.release(client, bundle), /UNCONFIRMED/);
  assert.equal(releases, 0); resolve(true); await stopping;
  await binding.release(client, bundle); assert.equal(releases, 1);
  assert.equal(b.calls.length, 0);
});

test('MEMORY platform/architecture mismatch never grants native no-fork scope', {skip: !nativeHost}, t => {
  for (const host of [{platform: 'darwin', arch: 'x64'}, {platform: 'linux', arch: 'arm64'}]) {
    const b = boundary(t, host);
    assert.equal(b.client().assetLifetimeSnapshot().coverage, 'leader-only');
    assert.equal(b.controls.signatures.length, 0);
  }
});

test('real bundled authority: explicit test-root preparation and prototype copies never gain native qualification', {skip: !nativeHost}, async t => {
  const b = boundary(t), resourcesPath = path.join(b.root, 'resources');
  fs.mkdirSync(path.join(resourcesPath, 'voice-assets'), {recursive: true, mode: 0o700});
  fs.cpSync(b.runtimeRoot, path.join(resourcesPath, 'voice-assets/runtime'), {recursive: true});
  const runtime = b.descriptor.inventory;
  const whole = canonicalInventory(runtime.files.map(file => ({...file, path: `runtime/${file.path}`})));
  fs.writeFileSync(path.join(resourcesPath, 'voice-assets-inventory.json'), JSON.stringify({files: whole.files}));
  const digest = createHash('sha256').update('NON_NATIVE test data only').digest('hex');
  const binding = {modelId: 'test-data', identity: {kind: 'raw-files', treeDigest: digest}};
  const trust = {schemaVersion: 2, mode: 'runtime-only', treeDigest: whole.treeDigest,
    runtimeTreeDigest: runtime.treeDigest, fileCount: whole.fileCount, entrypoint: 'runtime/bin/voice-runtime',
    runtimeProfile: 'macos-mlx-kokoro-v1', modelManifestDigest: digest, capabilitiesDigest: digest,
    modelBindings: {sttRoot: binding, onnxModel: {...binding, path: 'model.onnx'}, onnxVoices: {...binding, path: 'voices.bin'}}};
  const bundled = require('../apps/desktop/bundled-voice-assets.cjs');
  const prepared = await bundled.prepareBundledRuntimeAssets({resourcesPath, platform: 'darwin', trust});
  assert.equal(bundled.describeBundledRuntimeSource(prepared).authority, 'NON_NATIVE_TEST_ROOT');
  assert.equal(bundled.authenticatedBundledRuntimeSource(prepared), null);
  const {SidecarClient} = require('../apps/desktop/sidecar-client.cjs');
  for (const nativeRuntime of [prepared, Object.freeze({...prepared}), Object.create(prepared),
    new Proxy(prepared, {get() {assert.fail('untrusted argument properties must not be read');}})]) {
    const client = new SidecarClient({command: prepared.command, args: [], env: {}, nativeRuntime,
      lifetimePurpose: 'hybrid-speech', trackAssetLifetime: true});
    assert.equal(client.assetLifetimeSnapshot().coverage, 'leader-only');
  }
});
