const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');
const cp = require('node:child_process');
const {once} = require('node:events');
const {RuntimeManager} = require('../apps/desktop/runtime-manager.cjs');
const {ModelManager} = require('../apps/desktop/model-manager.cjs');
const {canonicalInventory} = require('../apps/desktop/tree-integrity.cjs');
const {createHash} = require('node:crypto');
const yazl = require('yazl');
async function seedAssets(root) {
  const bytes=Buffer.from('inert loader fixture');
  const zip=new yazl.ZipFile();zip.addBuffer(bytes,'asset.bin');zip.end();
  const chunks=[];for await(const chunk of zip.outputStream) chunks.push(chunk);
  const archive=Buffer.concat(chunks), hash=b=>createHash('sha256').update(b).digest('hex');
  const inventory=canonicalInventory([{path:'asset.bin',bytes:bytes.length,sha256:hash(bytes)}]);
  const license={spdx:'MIT',url:'https://example.com/license'};
  const artifact={url:'https://github.com/example/voice/releases/download/fixture/a.zip',bytes:archive.length,sha256:hash(archive),archive:'zip',entrypoint:'asset.bin',files:inventory.files,treeDigest:inventory.treeDigest,provenance:{sourceRevision:'a'.repeat(40),sourceUrl:'https://example.com/source',license}};
  const binding={modelId:'fixture',archiveSha256:artifact.sha256};
  const r=new RuntimeManager({userData:root,platform:'win32',arch:'x64',manifest:{schemaVersion:2,release:'fixture',artifacts:{'win32-x64-cpu':{...artifact,modelBindings:{sttRoot:binding,onnxModel:{...binding,path:'asset.bin'},onnxVoices:{...binding,path:'asset.bin'}}}}},fetchImpl:async()=>new Response(archive),healthCheck:async()=>true});
  const m=new ModelManager({userData:root,platform:'win32',arch:'x64',manifest:{schemaVersion:2,release:'fixture',models:{fixture:{name:'fixture',purpose:'test',license,artifacts:{'win32-x64-cpu':artifact}}}},fetchImpl:async()=>new Response(archive)});
  await r.install();await m.install('fixture');return {r,m};
}
const mainPath = path.resolve(__dirname, '../apps/desktop/main.cjs');
const realRequire = createRequire(mainPath);
const posixOnly = process.platform === 'win32' ? 'controlled SIGTERM/kill failure requires POSIX; native taskkill is a separate gate' : false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label = 'condition') {
  const end = Date.now() + 2500;
  while (!await predicate()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'main-shutdown-test-'));
  let cleanup=async()=>{};
  t.after(async()=>{try{await cleanup();}finally{await fs.rm(root,{recursive:true,force:true});t.diagnostic(`owned-temp=${root} removed=true (harness only)`);}});
  const clients = [], processes = [], handlers = new Map(), windows = [], errors = [], quits = [];
  const starts = new Set();
  let closing = false;
  const ready = gate();
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: Boolean(options.packaged), requestSingleInstanceLock: () => options.lock !== false,
    getPath: () => root, getAppPath: () => path.resolve(__dirname, '..'), whenReady: () => ready.promise,
    quit() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; app.emit('before-quit', event); if (!event.prevented) quits.push(clients.map(c => c.identity())); return event; },
    exit: code => quits.push(code),
  });
  class Window extends EventEmitter {
    constructor() {
      super(); windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, session: { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, setPermissionRequestHandler() {} }, setWindowOpenHandler() {}, getTitle: () => 'fixture', getURL: () => this.webContents.mainFrame.url });
    }
    async loadFile(file) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href; await options.loadFile?.(); }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    focus() { this.focused = true; }
    static getAllWindows() { return windows; }
  }
  // Only monitored probes use the explicit MEMORY Windows C1 boundary.
  const sidecarVM={module:{exports:{}},console,process:{platform:'win32',env:{}},setTimeout,clearTimeout,require:id=>id==='node:child_process'?{...cp,execFile(_c,args,_o,callback){
    const child=processes.find(p=>p.pid===Number(args[args.indexOf('/PID')+1]));if(!child)throw new Error('NOT_OWNED_PID');
    Promise.resolve(options.probeTermination?.()).then(()=>{const exit=once(child,'exit');child.kill('SIGKILL');exit.then(()=>callback(null));});return {kill(){}};
  }}:realRequire(id)};
  vm.runInNewContext(await fs.readFile(path.join(path.dirname(mainPath),'sidecar-client.cjs'),'utf8'),sidecarVM);
  class ControlledClient extends SidecarClient {
    constructor(config) {
      if(config.trackAssetLifetime) {
        const client=new sidecarVM.module.exports.SidecarClient({...config,command:process.execPath,args:[path.join(__dirname,'fixtures/main-shutdown-child.cjs')],env:{...config.env,MAIN_FIXTURE_ROOT:root},stopGraceMs:500,stopKillWaitMs:500});
        clients.push(client);let child=null;Object.defineProperty(client,'process',{get:()=>child,set:value=>{child=value;if(value)processes.push(value);}});return client;
      }
      super({ ...config, command: process.execPath, args: [path.join(__dirname, 'fixtures/main-shutdown-child.cjs')], env: { ...config.env, MAIN_FIXTURE_ROOT: root, MAIN_FIXTURE_NO_READY: options.noReady ? '1' : '' }, stopGraceMs: 500, stopKillWaitMs: 500 });
      clients.push(this);
      // Observe the real spawned process without replacing start/stop/request.
      let child = null;
      Object.defineProperty(this, 'process', { get: () => child, set(value) {
        child = value;
        if (value) { processes.push(value); options.onSpawn?.(value); }
      } });
      this.beforeSpawn = () => {
        if (closing) throw new Error('FIXTURE_CLEANUP');
        config.beforeSpawn?.();
        options.beforeSpawn?.();
      };
    }
  }
  const context = vm.createContext({
    require: name => name === 'electron' ? { app, BrowserWindow: Window, ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, safeStorage: {}, shell: {},
      dialog: {showMessageBox: async () => ({response:1}), showErrorBox() {} } } // explicit MEMORY user consent
      : name === './sidecar-client.cjs' ? { SidecarClient: ControlledClient }
      : name === './managed-asset-lease.cjs' ? {...realRequire(name),...options.lease}
      : name === 'node:fs/promises' ? { ...fs, ...options.fs } : realRequire(name),
    __dirname: path.dirname(mainPath), Buffer, URL, JSON, AbortController, setTimeout, clearTimeout,
    process: { ...process, argv: options.smoke ? ['node', '--smoke-test'] : ['node'], env: {} },
    console: { log() {}, error: (...args) => errors.push(args.map(String).join(' ')) },
  });
  vm.runInContext(`${await fs.readFile(mainPath, 'utf8')}\n globalThis.api = { startRuntime, createWindow, registerIpc, validateRuntimeEntrypoint, setManagers(r, m) { runtimeManager = r; modelManager = m; }, getSidecar() { return sidecar; } };`, context, { filename: mainPath });
  const api = context.api;
  cleanup = async () => {
    // Always release gates and reap children, including every RED assertion path.
    closing = true;
    options.release?.();
    await fs.writeFile(path.join(root, 'release'), 'exit');
    for (const client of clients) {
      if (client.process && !processes.includes(client.process)) processes.push(client.process);
      try { await client.stop(); } catch {}
    }
    for (const proc of processes) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      await until(() => proc.exitCode !== null || proc.signalCode !== null, 'fixture reaped');
    }
    await until(() => starts.size === 0, 'startup fixtures drained');
    for(const proc of processes) t.diagnostic(`owned-child pid=${proc.pid} reaped=true`);
  };
  return { ...api, root, clients, app, ready, windows, errors, quits, handlers,
    startRuntime() {
      const operation = api.startRuntime();
      starts.add(operation);
      operation.then(() => starts.delete(operation), () => starts.delete(operation));
      return operation;
    },
    async ipc(channel, payload) { const window = windows.at(-1); return handlers.get(channel)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, payload); },
    release: () => fs.writeFile(path.join(root, 'release'), 'exit'),
  };
}

test('Main prevents repeated quit until the real child confirms exit', { timeout: 6000, skip: posixOnly }, async t => {
  const h = await harness(t);
  await h.startRuntime();
  const child = h.clients[0].process;
  assert.ok(child.pid);
  assert.equal(h.app.quit().prevented, true);
  assert.equal(h.app.quit().prevented, true);
  await delay(60);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(h.quits.length, 0);
  await h.release();
  await until(() => h.quits.length === 1, 'confirmed app quit');
  assert.equal(h.clients[0].identity(), null);
  assert.deepEqual(h.quits, [[null]]);
});

test('Main owns/coalesces startup before hooks and revokes all late startup/window work', { timeout: 12000 }, async t => {
  for (const phase of ['mkdir', 'status', 'not-ready']) await t.test(phase, { timeout: 4000, skip: phase === 'not-ready' && posixOnly }, async t => {
    const hold = gate();
    let entered = false;
    const h = await harness(t, { packaged: phase === 'status', noReady: phase === 'not-ready', release: hold.release,
      fs: phase === 'mkdir' ? { mkdir: async (...args) => { entered = true; await hold.promise; return fs.mkdir(...args); } } : {},
    });
    if(phase==='status') {
      const {r,m}=await seedAssets(h.root), status=r.status.bind(r);
      r.status=async()=>{entered=true;await hold.promise;return status();};h.setManagers(r,m);
    }
    const first = h.startRuntime();
    const second = h.startRuntime();
    const settled = Promise.allSettled([first, second]);
    assert.equal(first, second, 'one startup promise registered before filesystem/status hooks');
    if (phase === 'not-ready') await until(async () => (await fs.readdir(h.root)).some(name => name.startsWith('spawn-')));
    else await until(() => entered);
    assert.equal(h.app.quit().prevented, true);
    await assert.rejects(async () => h.startRuntime(), /SHUTTING_DOWN/);
    h.app.emit('second-instance'); h.app.emit('activate');
    await h.createWindow();
    assert.equal(h.windows.length, 0);
    await delay(40);
    assert.equal(h.quits.length, 0, 'quit drains startup, but stops spawned child before readiness');
    hold.release();
    await h.release();
    await until(() => h.quits.length === 1);
    await settled;
    assert.equal(h.clients.length, phase === 'not-ready' ? 1 : 0);
  });
});

test('Main retains STT/health resources on failed exit and retries while draining only owned installs', { timeout: 7000, skip: posixOnly }, async t => {
  const probeHold=gate();
  const h = await harness(t,{probeTermination:()=>probeHold.promise,release:probeHold.release});
  await h.startRuntime(); await h.createWindow(); h.registerIpc();
  const modelHold = gate(); t.after(modelHold.release);
  let runtimeInstalls = 0, modelInstalls = 0;
  const cancelled = [];
  const {r,m}=await seedAssets(h.root), install=r.install.bind(r), cancel=r.cancel.bind(r);
  r.healthCheck=h.validateRuntimeEntrypoint;
  // The single D admission now excludes the second install. Keep the original
  // owned-install drain held after its real B work, rather than admit a parallel model.
  r.install=async()=>{runtimeInstalls++;try{return await install();}finally{await modelHold.promise;}};
  r.cancel=()=>{cancelled.push('runtime');cancel();};
  const modelInstallOriginal=m.install.bind(m);m.install=id=>{modelInstalls++;return modelInstallOriginal(id);};
  h.setManagers(r,m);
  const shared = path.join(h.root, 'voice-practice-runtime');
  await fs.writeFile(path.join(shared, 'unowned-sentinel'), 'keep');
  const stt = h.ipc('voice:stt', { buffer: Buffer.from('fixture'), mimeType: 'audio/wav' });
  const runtimeInstall = h.ipc('runtime:install');
  const modelInstall = assert.rejects(h.ipc('models:install', { modelId: 'fixture' }),/INSTALL_ALREADY_RUNNING/);
  const results = Promise.allSettled([stt, runtimeInstall, modelInstall]);
  await until(async () => (await fs.readdir(h.root)).filter(name => name.startsWith('request-')).length === 2);
  const request = JSON.parse(await fs.readFile(path.join(h.root, `request-${h.clients[0].process.pid}.json`)));
  const audioPath = request.params.audioPath;
  const healthRoot = h.clients[1].env.VOICE_RUNTIME_TEMP_DIR;
  // OS signal boundary failure; the SidecarClient termination implementation is real.
  const child = h.clients[0].process;
  const kill = child.kill.bind(child);
  child.kill = () => { throw new Error('CONTROLLED_SIGNAL_FAILURE'); };
  t.after(() => { child.kill = kill; });
  assert.equal(h.app.quit().prevented, true);
  assert.equal(h.app.quit().prevented, true);
  await until(() => h.errors.some(line => line.includes('CONTROLLED_SIGNAL_FAILURE')));
  await delay(40);
  assert.equal(h.quits.length, 0);
  assert.equal(h.getSidecar(), h.clients[0]);
  assert.equal(await fs.readFile(audioPath, 'utf8'), 'fixture');
  assert.ok(await fs.stat(healthRoot));
  assert.deepEqual(cancelled, ['runtime']);
  for (const [channel, payload] of [['runtime:install'], ['models:install', { modelId: 'late' }], ['voice:stt', { buffer: Buffer.from('late') }], ['voice:health'], ['runtime:status']]) {
    await assert.rejects(h.ipc(channel, payload), /SHUTTING_DOWN/);
  }
  assert.equal(runtimeInstalls, 1); assert.equal(modelInstalls, 0,'busy model never starts');
  child.kill = kill;
  probeHold.release();
  assert.equal(h.app.quit().prevented, true);
  await h.release();
  await until(() => h.clients.every(client => !client.identity()));
  assert.equal(h.quits.length, 0, 'owned install still draining');
  modelHold.release();
  await until(() => h.quits.length === 1);
  await results;
  await assert.rejects(fs.stat(audioPath), { code: 'ENOENT' });
  await assert.rejects(fs.stat(healthRoot), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(shared, 'unowned-sentinel'), 'utf8'), 'keep');
});

test('a restarted SidecarClient needs fresh exit confirmation before STT cleanup', { timeout: 7000, skip: posixOnly }, async t => {
  const h = await harness(t);
  await h.startRuntime(); await h.createWindow(); h.registerIpc();
  const client = h.clients[0];
  client.requestTimeoutMs = 30;
  await assert.rejects(h.ipc('voice:stt', { buffer: Buffer.from('first') }), /TIMEOUT/);
  client.requestTimeoutMs = 10000;
  const stt = h.ipc('voice:stt', { buffer: Buffer.from('second') });
  const settled = Promise.allSettled([stt]);
  await until(async () => client.process && (await fs.readdir(h.root)).includes(`request-${client.process.pid}.json`));
  const request = JSON.parse(await fs.readFile(path.join(h.root, `request-${client.process.pid}.json`)));
  const child = client.process, kill = child.kill.bind(child);
  child.kill = () => { throw new Error('RESTART_SIGNAL_FAILURE'); };
  t.after(() => { child.kill = kill; });
  h.app.quit();
  await until(() => h.errors.some(line => line.includes('RESTART_SIGNAL_FAILURE')));
  await delay(40);
  assert.equal(await fs.readFile(request.params.audioPath, 'utf8'), 'second');
  assert.equal(h.quits.length, 0);
  child.kill = kill;
  h.app.quit(); await h.release();
  await until(() => h.quits.length === 1);
  await settled;
  await assert.rejects(fs.stat(request.params.audioPath), { code: 'ENOENT' });
});

test('old STT timeout cleanup preserves a fresh request queued behind its termination', { timeout: 7000, skip: posixOnly }, async t => {
  const h = await harness(t);
  await h.startRuntime(); await h.createWindow(); h.registerIpc();
  const client = h.clients[0];
  const oldPid = client.process.pid, oldGeneration = client.processGeneration;
  const cancel = client.cancel.bind(client);
  let fresh, outcome;
  client.cancel = () => {
    const barrier = cancel();
    client.requestTimeoutMs = 10000;
    fresh = h.ipc('voice:health').then(
      value => { outcome = 'resolved'; return value; },
      error => { outcome = error.message; });
    return barrier;
  };
  t.after(() => { client.cancel = cancel; });
  client.requestTimeoutMs = 35;
  await assert.rejects(h.ipc('voice:stt', { buffer: Buffer.from('old-generation') }), /REQUEST_TIMEOUT/);
  await until(() => Boolean(fresh));
  assert.equal(outcome, undefined, 'old cleanup must not revoke the new start intent');
  await until(async () => client.process && client.processGeneration !== oldGeneration
    && (await fs.readdir(h.root)).includes(`request-${client.process.pid}.json`), 'new generation receives health');
  assert.notEqual(client.process.pid, oldPid);
  assert.equal(outcome, undefined);
  assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
  assert.deepEqual(await fs.readdir(path.join(h.root, 'voice-practice-runtime')), []);
  assert.equal(h.quits.length, 0, 'recovery does not require quitting');
  h.app.quit(); await h.release(); await fresh;
  await until(() => h.quits.length === 1);
});

test('failed timeout termination retains STT input until an explicit quit retries', { timeout: 6000, skip: posixOnly }, async t => {
  const h = await harness(t);
  await h.startRuntime(); await h.createWindow(); h.registerIpc();
  const client = h.clients[0], child = client.process;
  const kill = child.kill.bind(child), stop = client.stop.bind(client);
  let stopCalls = 0, settled = false;
  client.stop = (...args) => { stopCalls++; return stop(...args); };
  child.kill = () => { throw new Error('TIMEOUT_SIGNAL_FAILURE'); };
  client.requestTimeoutMs = 200;
  const result = h.ipc('voice:stt', { buffer: Buffer.from('retain-unconfirmed') })
    .then(() => { settled = true; return 'unexpected success'; }, error => { settled = true; return error.message; });
  try {
    await until(() => h.errors.some(line => line.includes('TIMEOUT_SIGNAL_FAILURE')));
    const request = JSON.parse(await fs.readFile(path.join(h.root, `request-${child.pid}.json`)));
    assert.equal(settled, false);
    assert.equal(stopCalls, 0, 'passive cleanup must not issue a new stop even on failure');
    assert.equal(await fs.readFile(request.params.audioPath, 'utf8'), 'retain-unconfirmed');
    assert.equal(h.quits.length, 0);
    assert.equal(child.exitCode, null);
    child.kill = kill;
    h.app.quit(); await h.release();
    await until(() => h.quits.length === 1);
    assert.match(await result, /REQUEST_TIMEOUT/);
    await assert.rejects(fs.stat(request.params.audioPath), { code: 'ENOENT' });
  } finally {
    child.kill = kill; client.stop = stop;
  }
});

test('smoke load continuation cannot bypass a pending safe quit', { timeout: 5000 }, async t => {
  const hold = gate();
  const h = await harness(t, { smoke: true, release: hold.release, loadFile: () => hold.promise });
  h.ready.release();
  await until(() => h.windows.length === 1);
  assert.equal(h.app.quit().prevented, true);
  await delay(30);
  assert.equal(h.quits.length, 0);
  hold.release();
  await until(() => h.quits.length > 0);
  assert.deepEqual(h.quits, [[]], 'before-quit drain, not app.exit(0)');
  assert.equal(h.clients.length, 0);
});

test('admitted STT-write/health-mkdir/boot-read work drains without late spawn or request', { timeout: 12000 }, async t => {
  for (const phase of ['stt-write', 'health-mkdir', 'boot-read']) await t.test(phase, { timeout: 4000 }, async t => {
    const hold = gate(); let entered = false, candidateBundle, candidateManager;
    const methods = {
      'stt-write': { writeFile: async (...args) => { entered = true; await hold.promise; return fs.writeFile(...args); } },
      'health-mkdir': {},
      'boot-read': { open: async (...args) => { const fd=await fs.open(...args);const read=fd.read.bind(fd);fd.read=async(...readArgs)=>{entered=true;await hold.promise;return read(...readArgs);};return fd; } },
    };
    const h = await harness(t, { fs: methods[phase], release: hold.release,
      lease:phase==='health-mkdir'?{prepareProbeAssets(...args){const bundle=realRequire('./managed-asset-lease.cjs').prepareProbeAssets(...args);candidateBundle=bundle;bundle.work=bundle.work.then(async value=>{entered=true;await hold.promise;return value;});return bundle;}}:{} });
    let operation;
    if (phase === 'stt-write') {
      await h.startRuntime(); await h.createWindow(); h.registerIpc();
      operation = h.ipc('voice:stt', { buffer: Buffer.from('pending') });
    } else if (phase === 'health-mkdir') {
      const {r,m}=await seedAssets(h.root);candidateManager=r;h.setManagers(r,m);r.healthCheck=h.validateRuntimeEntrypoint;operation=r.install();
    }
    else h.ready.release();
    const settled = Promise.allSettled([operation]);
    await until(() => entered);
    h.app.quit(); await h.release();
    await delay(30);
    assert.equal(h.quits.length, 0);
    if(candidateBundle){assert.ok(await fs.stat(candidateBundle.tempRoot));assert.ok(candidateManager.coordinator.snapshot().pins>=2);}
    hold.release();
    await until(() => h.quits.length === 1);
    await settled;
    if(candidateBundle){await assert.rejects(fs.stat(candidateBundle.root),{code:'ENOENT'});assert.equal(candidateManager.coordinator.snapshot().pins,0);}
    assert.equal(h.clients.length, phase === 'stt-write' ? 1 : 0);
    assert.equal((await fs.readdir(h.root)).filter(name => name.startsWith('request-')).length, 0);
    assert.equal((await fs.readdir(h.root)).filter(name => name.startsWith('voice-practice-runtime-health-')).length, 0);
    if (phase === 'stt-write') assert.deepEqual(await fs.readdir(path.join(h.root, 'voice-practice-runtime')), []);
    else assert.equal(h.windows.length, 0);
  });
});

test('unchanged smoke and single-instance outcomes plus normal runtime-before-window timing', { timeout: 9000 }, async t => {
  for (const options of [{ smoke: true }, { smoke: true, lock: false }, { lock: false }]) {
    const h = await harness(t, options); h.ready.release();
    await until(() => h.quits.length === 1);
    assert.equal(h.clients.length, 0);
    assert.deepEqual(h.quits, options.smoke ? [options.lock === false ? 1 : 0] : [[]]);
  }
  const hold = gate(); let entered = false;
  const h = await harness(t, { release: hold.release, fs: { mkdir: async (...args) => { entered = true; await hold.promise; return fs.mkdir(...args); } } });
  h.ready.release(); await until(() => entered);
  h.app.emit('second-instance');
  assert.equal(h.windows.length, 0);
  hold.release(); await until(() => h.windows.length === 1);
  await until(() => h.app.listenerCount('activate') === 1);
  h.app.quit(); h.app.emit('second-instance');
  assert.equal(h.windows[0].focused, undefined);
  h.windows.splice(0); h.app.emit('activate');
  assert.equal(h.windows.length, 0);
  await h.release(); await until(() => h.quits.length === 1);
});

test('quit between Sidecar preparation and spawn synchronously revokes its start token', { timeout: 5000 }, async t => {
  let spawned = 0;
  const h = await harness(t, {
    beforeSpawn: () => queueMicrotask(() => h.app.quit()), onSpawn: () => { spawned++; },
  });
  const start = Promise.allSettled([h.startRuntime()]);
  await until(() => h.quits.length === 1);
  await start;
  assert.equal(spawned, 0, 'no process may spawn after before-quit admission closes');
});
