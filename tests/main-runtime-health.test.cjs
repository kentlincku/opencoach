'use strict';
// Portable integration: real Main, SidecarClient, RuntimeManager ZIP verification,
// activation and cleanup. Electron and download transport are inert; the archived
// Node child speaks JSONL, never imports Python backends or executes native models.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const yazl = require('yazl');
const cp = require('node:child_process');
const { canonicalInventory } = require('../apps/desktop/tree-integrity.cjs');
const { isHealthyRuntimeResponse } = require('../apps/desktop/runtime-health.cjs');
const { RuntimeManager } = require('../apps/desktop/runtime-manager.cjs');
const mainPath = path.resolve(__dirname, '../apps/desktop/main.cjs');
const realRequire = createRequire(mainPath);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function until(check, label) {
  for (let i = 0; i < 250; i++) { if (await check()) return; await delay(10); }
  throw new Error(`Fixture deadline: ${label}`);
}
async function exists(file) { try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

function producerHealth() {
  // Execute the ACTUAL pure function and protocol assignment. Deferred annotations
  // avoid importing BackendRegistry; registry/environment are declared doubles.
  const source = path.resolve(__dirname, '../native/python/voice_runtime/server.py');
  const script = `import ast, json, types, sys
source = ast.parse(open(sys.argv[1], encoding='utf8').read())
body = [ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)]
body += [n for n in source.body if (isinstance(n, ast.FunctionDef) and n.name == 'health_capabilities') or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'PROTOCOL_VERSION' for t in n.targets))]
namespace = {'os': types.SimpleNamespace(environ={})}
exec(compile(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])), sys.argv[1], 'exec'), namespace)
registry = types.SimpleNamespace(fake=False, platform_name='darwin', arch_name='arm64', capabilities=lambda: {'sttBackends':['mlx-whisper'], 'ttsBackends':['kokoro-python'], 'selectedStt':'mlx-whisper', 'selectedTts':'kokoro-python', 'ready':True, 'degradedReason':None})
print(json.dumps(namespace['health_capabilities'](registry=registry)))`;
  return JSON.parse(execFileSync('python3', ['-B', '-c', script, source], {
    encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  }));
}

async function archiveFor(health, mode = 'healthy', probe = {probeVersion:1,protocol:1,platform:'windows',arch:'x64',executable:true}) {
  const script = `const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
if (mode === 'start-failure') process.exit(1);
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  fs.writeFileSync(path.join(process.env.VOICE_RUNTIME_TEMP_DIR, 'request.json'), line);
  if (mode === 'pending') return;
  process.stdout.write(JSON.stringify(mode === 'request-failure'
    ? {id:message.id, success:false, error:{message:'CONTROLLED_REQUEST_FAILURE'}}
    : {id:message.id, success:true, result:message.method === 'runtime.probe' ? ${JSON.stringify(probe)} : ${JSON.stringify(health)}}) + '\\n');
});
process.stdout.write('{"event":"ready"}\\n');
`;
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(script), 'bin/voice-runtime.cjs', { mode: 0o100755, mtime: new Date('2020-01-01T00:00:00Z') });
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return { bytes: Buffer.concat(chunks), script };
}

async function harness(t, health, options = {}) {
  const root = await fs.mkdtemp(path.join(require('node:fs').realpathSync(os.tmpdir()), 'main-runtime-health-test-'));
  const clients = [], children = [], tasks = [], events = [], errors = [], handlers = new Map();
  let closing = false;
  t.after(async () => {
    closing = true; options.release?.();
    for (const client of clients) { try { await client.stop(); } catch {} }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
      assert.throws(() => process.kill(child.pid, 0), {code:'ESRCH'});
      t.diagnostic(`owned-child pid=${child.pid} reaped=true`);
    }
    await Promise.allSettled(tasks);
    await fs.rm(root, {recursive:true,force:true});
    assert.equal(await exists(root), false);
    t.diagnostic(`owned-temp=${root} removed=true (harness only)`);
  });
  const archive = await archiveFor(health, options.mode, options.probe);
  const sha256 = createHash('sha256').update(archive.bytes).digest('hex');
  const inventory = canonicalInventory([{path:'bin/voice-runtime.cjs',bytes:Buffer.byteLength(archive.script),sha256:createHash('sha256').update(archive.script).digest('hex')}]);
  const binding = {modelId:'fixture-model',archiveSha256:'a'.repeat(64)};
  const manifest = { schemaVersion: 2, release: 'health-fixture-v1', artifacts: { 'win32-x64-cpu': {
    url: 'https://github.com/example/voice/releases/download/health-fixture-v1/runtime.zip',
    sha256, bytes: archive.bytes.length, entrypoint: 'bin/voice-runtime.cjs', archive: 'zip',
    files:inventory.files,treeDigest:inventory.treeDigest,
    provenance:{sourceRevision:'a'.repeat(40),sourceUrl:'https://example.com/source',license:{spdx:'MIT',url:'https://example.com/license'}},
    modelBindings:{sttRoot:binding,onnxModel:{...binding,path:'model.bin'},onnxVoices:{...binding,path:'voices.bin'}},
  } } };
  const app = new EventEmitter();
  let quitCount = 0;
  Object.assign(app, { isPackaged: true, requestSingleInstanceLock: () => true,
    getPath: () => root, getAppPath: () => path.resolve(__dirname, '..'), whenReady: () => new Promise(() => {}),
    quit() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; app.emit('before-quit', event); if (!event.prevented) quitCount++; return event; },
  });
  let window;
  class Window extends EventEmitter {
    constructor() { super(); window = this; this.webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, session: { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, setPermissionRequestHandler() {} }, setWindowOpenHandler() {},
    }); }
    async loadFile(file) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href; }
  }
  // MEMORY Windows taskkill; actual C1 and owned Node child exit, not native tree proof.
  const sidecarVM = {module:{exports:{}},console,process:{platform:'win32',env:{}},setTimeout,clearTimeout,
    require: id => id === 'node:child_process' ? {...cp,execFile(_command,args,_config,callback) {
      const child = children.find(p => p.pid === Number(args[args.indexOf('/PID')+1]));
      if (!child) throw new Error('NOT_OWNED_PID');
      const exit = once(child,'exit'); child.kill('SIGKILL'); exit.then(() => callback(null)); return {kill(){}};
    }} : realRequire(id)};
  vm.runInNewContext(await fs.readFile(path.join(path.dirname(mainPath),'sidecar-client.cjs'),'utf8'),sidecarVM);
  class ControlledClient extends sidecarVM.module.exports.SidecarClient {
    constructor(config) {
      // Run exactly the staged archive entrypoint, via Node instead of native OS
      // executable loading. The real client still owns spawn/start/request/stop.
      super({ ...config, command: process.execPath, args: [config.command], stopGraceMs: 100, stopKillWaitMs: 100 });
      this.entrypoint = config.command;
      clients.push(this);
      let child = null;
      Object.defineProperty(this, 'process', { get: () => child, set: value => { child = value; if (value) children.push(value); } });
      this.beforeSpawn = () => { if (closing) throw new Error('FIXTURE_CLOSING'); return config.beforeSpawn?.(); };
      const terminate = this._terminate.bind(this);
      this._terminate = async proc => {
        events.push('terminate-enter');
        if (!closing) await options.termination?.(this, proc);
        const result = await terminate(proc);
        events.push('terminated');
        return result;
      };
    }
  }
  const context = vm.createContext({ require: name => name === 'electron'
    ? { app, BrowserWindow: Window, ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, safeStorage: {}, shell: {},
        dialog: {showMessageBox: async () => ({response:1}), showErrorBox() {} } } // explicit MEMORY user consent
    : name === './sidecar-client.cjs' ? { SidecarClient: ControlledClient }
    : name === 'node:fs/promises' ? { ...fs, rm: async (...args) => { const result = await fs.rm(...args); events.push(`rm:${args[0]}`); return result; } }
    : realRequire(name), __dirname: path.dirname(mainPath), Buffer, URL, JSON, AbortController, setTimeout, clearTimeout,
    process: { argv: ['node'], env: {}, platform: process.platform },
    console: { log() {}, error: (...args) => errors.push(args.map(String).join(' ')) },
  });
  // Test-only lexical binding, not a production export or a copied predicate.
  vm.runInContext(`${await fs.readFile(mainPath, 'utf8')}\n globalThis.api = { validateRuntimeEntrypoint, createWindow, registerIpc, setManager(value) { runtimeManager = value; }, setVoice(value) { sidecar = value; }, getVoice() { return sidecar; }, ownedCount() { return ownedClients.size; } };`, context, { filename: mainPath });
  const api = context.api;
  const manager = new RuntimeManager({ userData: root, manifest, platform: 'win32', arch: 'x64',
    fetchImpl: async () => { events.push('download'); return new Response(archive.bytes, { status: 200, headers: { 'content-length': String(archive.bytes.length) } }); },
    healthCheck: async () => true, // MEMORY seed only
  });
  const previousStatus = await manager.install();
  const previous = await fs.readFile(manager._selection().layout.metadata);
  manager.healthCheck = api.validateRuntimeEntrypoint;
  // Observe the actual default atomic metadata writer without replacing it.
  const writeMetadata = manager.writeMetadata;
  manager.writeMetadata = async (...args) => { await writeMetadata(...args); events.push('activated'); };
  api.setManager(manager);
  // Existing healthy voice ownership must not be substituted with a candidate.
  const voice = { request: async () => health, stop() { throw new Error('UNRELATED_VOICE_STOP'); } };
  api.setVoice(voice);
  await api.createWindow(); api.registerIpc();
  const layout = manager._selection().layout;
  let installedSelection;
  const select = manager._selection.bind(manager);
  manager._selection = () => {
    const selected = select();
    installedSelection ||= selected; // observe the real install UUID; never replace it
    return selected;
  };

  const invoke = (channel, payload) => handlers.get(channel)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, payload);
  const syncFs = require('node:fs'), rmSync = syncFs.rmSync;
  syncFs.rmSync = (target,...args) => { const result=rmSync(target,...args); for(const client of clients) if(path.dirname(client.env.VOICE_RUNTIME_TEMP_DIR)===target) events.push(`rm:${client.env.VOICE_RUNTIME_TEMP_DIR}`); return result; };
  t.after(() => { syncFs.rmSync=rmSync; });
  return { root, manager, previousStatus, get layout() { return installedSelection?.layout || layout; }, previous, archive, sha256, events, errors, clients, children, app, api, voice,
    quits: () => quitCount,
    install() { const task = invoke('runtime:install'); tasks.push(task); task.catch(() => {}); return task; },
    invoke,
  };
}
async function rejectedInstall(h) {
  await assert.rejects(h.install(), /RUNTIME_HEALTH_CHECK_FAILED/);
  assert.deepEqual(await fs.readFile(h.layout.metadata), h.previous);
  assert.equal(await fs.readFile(h.previousStatus.entrypoint, 'utf8'), h.archive.script);
  assert.equal(h.events.includes('activated'), false);
  assert.equal(await exists(h.layout.staging), false);
  assert.equal(await exists(h.layout.partial), false);
  assert.equal(h.api.getVoice(), h.voice);
  assert.equal(h.api.ownedCount(), 0);
  assert.equal(h.clients.length, 1);
  assert.equal(await exists(h.clients[0].env.VOICE_RUNTIME_TEMP_DIR), false);
}

test('H1 actual pure Python canonical health activates through Main and RuntimeManager once', { timeout: 8000 }, async t => {
  const health = producerHealth();
  assert.equal(health.protocol, 1); assert.equal(health.ready, true);
  assert.equal(Object.hasOwn(health, 'protocolVersion'), false);
  const h = await harness(t, health);
  t.diagnostic(`tiny ZIP bytes=${h.archive.bytes.length} SHA256=${h.sha256}`);
  const result = await h.install();
  assert.equal(result.state, 'installed');
  assert.equal((await h.manager.status()).state, 'installed');
  assert.equal(await fs.readFile(result.entrypoint, 'utf8'), h.archive.script);
  assert.equal(h.clients[0].entrypoint, result.entrypoint, 'probe executes exact B candidate generation subsequently published');
  assert.equal(h.events.filter(event => event === 'activated').length, 1);
  assert.equal(h.events.filter(event => event === 'terminated').length, 1);
  const rm = h.events.indexOf(`rm:${h.clients[0].env.VOICE_RUNTIME_TEMP_DIR}`);
  assert.ok(h.events.indexOf('terminated') < rm && rm < h.events.indexOf('activated'));
  assert.equal(JSON.parse(await fs.readFile(h.layout.metadata)).previous.generation, h.previousStatus.generation);
  assert.equal(isHealthyRuntimeResponse(await h.invoke('voice:health')), true);
  assert.equal(h.api.getVoice(), h.voice);
  assert.equal(h.api.ownedCount(), 0);
});

test('H2 legacy-only protocolVersion with empty arrays is rejected and previous activation preserved', { timeout: 8000 }, async t => {
  const h = await harness(t, { protocolVersion: 1, sttBackends: [], ttsBackends: [] }, {probe:{protocolVersion:1,sttBackends:[],ttsBackends:[]}});
  assert.equal(isHealthyRuntimeResponse(await h.invoke('voice:health')), false);
  await rejectedInstall(h);
});

test('H3 unsupported protocol 2 never activates', { timeout: 8000 }, async t => {
  const h = await harness(t, { ...producerHealth(), protocol: 2 }, {probe:{probeVersion:1,protocol:2,platform:'windows',arch:'x64',executable:true}});
  assert.equal(isHealthyRuntimeResponse(await h.invoke('voice:health')), false);
  await rejectedInstall(h);
});

for (const [label, change] of [['not ready', { ready: false, degradedReason: 'MODELS_UNAVAILABLE' }],
  ['missing TTS selection', { selectedTts: null }]]) {
  test(`H4 ${label} stays speech-unhealthy despite independent probe install`, { timeout: 8000 }, async t => {
    const h = await harness(t, { ...producerHealth(), ...change });
    assert.equal(isHealthyRuntimeResponse(await h.invoke('voice:health')), false);
    assert.equal((await h.install()).state, 'installed');
    assert.equal(isHealthyRuntimeResponse(await h.invoke('voice:health')), false);
    assert.equal(h.api.getVoice(), h.voice);
  });
}

for (const mode of ['start-failure', 'request-failure']) {
  test(`H5 ${mode} cleans only the original candidate and preserves voice identity`, { timeout: 8000 }, async t => {
    const h = await harness(t, producerHealth(), { mode });
    if (mode === 'start-failure') {
      await assert.rejects(h.install(), /RUNTIME_HEALTH_CHECK_FAILED/);
      assert.deepEqual(await fs.readFile(h.layout.metadata), h.previous);
      assert.equal(await fs.readFile(h.previousStatus.entrypoint,'utf8'),h.archive.script);
      assert.equal(h.api.getVoice(),h.voice);assert.equal(h.events.includes('activated'),false);
      assert.equal(h.clients[0].assetLifetimeSnapshot().unknown,true);
      assert.equal(h.api.ownedCount(),1);
      assert.equal(await exists(h.clients[0].env.VOICE_RUNTIME_TEMP_DIR),true);
    } else await rejectedInstall(h);
    assert.ok(h.errors.some(error => error.includes('Candidate runtime health check failed')));
    if (mode === 'request-failure') assert.ok(h.errors.some(error => error.includes('CONTROLLED_REQUEST_FAILURE')));
    assert.equal((await h.invoke('voice:health')).ready, true);
    assert.equal(h.events.filter(event => event === `rm:${h.clients[0].env.VOICE_RUNTIME_TEMP_DIR}`).length, mode === 'start-failure' ? 0 : 1);
  });
}

test('H6 original termination held prevents cleanup and activation until real exit', { timeout: 8000 }, async t => {
  const hold = gate();
  const h = await harness(t, producerHealth(), { termination: () => hold.promise, release: hold.release });
  let settled = false;
  const install = h.install(); install.then(() => { settled = true; }, () => { settled = true; });
  await until(() => h.events.includes('terminate-enter'), 'termination entered');
  const client = h.clients[0], child = h.children[0], temp = client.env.VOICE_RUNTIME_TEMP_DIR;
  await delay(30);
  assert.equal(settled, false);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  assert.equal(await exists(temp), true); assert.equal(await exists(client.entrypoint), true);
  assert.equal(h.events.includes(`rm:${temp}`), false); assert.equal(h.events.includes('activated'), false);
  assert.deepEqual(await fs.readFile(h.layout.metadata), h.previous);
  hold.release();
  assert.equal((await install).state, 'installed');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(h.events.filter(event => event === 'terminated').length, 1);
  assert.equal(h.events.filter(event => event === `rm:${temp}`).length, 1);
  assert.equal(h.events.filter(event => event === 'activated').length, 1);
  assert.ok(h.events.indexOf('terminated') < h.events.indexOf(`rm:${temp}`));
  assert.ok(h.events.indexOf(`rm:${temp}`) < h.events.indexOf('activated'));
});

test('H7 Quit during pending health retains unconfirmed temp and rolls back without late activation', { timeout: 8000 }, async t => {
  let blocked = true;
  const h = await harness(t, producerHealth(), { mode: 'pending',
    termination: async () => { if (blocked) throw new Error('CONTROLLED_EXIT_UNCONFIRMED'); },
    release: () => { blocked = false; },
  });
  let settled = false;
  const install = h.install(); install.then(() => { settled = true; }, () => { settled = true; });
  await until(async () => h.clients[0] && await exists(path.join(h.clients[0].env.VOICE_RUNTIME_TEMP_DIR, 'request.json')), 'child consumed health request');
  const temp = h.clients[0].env.VOICE_RUNTIME_TEMP_DIR;
  const request = JSON.parse(await fs.readFile(path.join(temp, 'request.json')));
  assert.equal(request.method, 'runtime.probe');
  const controller = h.manager.controller;
  assert.equal(h.app.quit().prevented, true);
  await until(() => h.errors.some(error => error.includes('Desktop shutdown failed')), 'unconfirmed shutdown');
  await delay(30);
  assert.equal(controller.signal.aborted, true, 'owned install cancellation reaches real manager');
  assert.equal(h.quits(), 0); assert.equal(settled, true, 'probe returns without self-join; candidate pin retains cleanup obligations');
  assert.equal(await exists(temp), true); assert.equal(await exists(h.clients[0].entrypoint), true);
  assert.equal(h.events.includes('activated'), false);
  assert.deepEqual(await fs.readFile(h.layout.metadata), h.previous);
  await assert.rejects(async () => h.invoke('runtime:install'), /DESKTOP_SHUTTING_DOWN/);
  blocked = false;
  assert.equal(h.app.quit().prevented, true);
  await assert.rejects(install, /RUNTIME_HEALTH_CHECK_FAILED/);
  await until(() => h.quits() === 1, 'confirmed Quit drain');
  assert.equal(await exists(temp), false); assert.equal(await exists(h.layout.staging), false);
  assert.equal(await exists(h.layout.partial), false);
  assert.deepEqual(await fs.readFile(h.layout.metadata), h.previous);
  assert.equal(await fs.readFile(h.previousStatus.entrypoint, 'utf8'), h.archive.script);
  assert.equal(h.events.includes('activated'), false);
});

test('H8 actual factory normalizer and ElectronRuntime select native versus browser fallback', async t => {
  const { createRuntime } = require('../apps/web/runtime/create-runtime.js');
  const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
  const { normalizeRuntimeCapabilities } = require('../apps/web/runtime/runtime-contract.js');
  const canonical = producerHealth();
  for (const health of [canonical, { ...canonical, ready: false, degradedReason: 'MODELS_UNAVAILABLE' }]) {
    const calls = [];
    // These are preload/audio/browser engine seams, not alternate factories.
    const runtime = await createRuntime({ electronAPI: {
      runtimeHealth: async () => health,
      voiceOperationState: async () => { throw new Error('UNEXPECTED_OBSERVE'); },
      voiceOperationRevoke: async () => { throw new Error('UNEXPECTED_REVOKE'); },
      transcribeAudio: async payload => { calls.push(['native-stt', payload]); return { text: 'native transcript' }; },
      synthKokoro: async payload => { calls.push(['native-tts', payload]); return { audio: 'inert-audio-marker' }; },
    }, browser: {
      transcribe: async payload => { calls.push(['fallback-stt', payload]); return { text: 'browser transcript' }; },
      synthesize: async payload => { calls.push(['fallback-tts', payload]); return { useSystemSpeech: true }; },
    } });
    assert.ok(runtime instanceof ElectronRuntime);
    assert.deepEqual(await runtime.capabilities(), normalizeRuntimeCapabilities(health));
    const { encodePcmWav, isNativePcmWav } = require('../apps/web/runtime/native-audio.js');
    const stt = await runtime.transcribe({ buffer: encodePcmWav(new Float32Array([0, 0.5])), mimeType: 'audio/wav' });
    if (health.ready) {
      assert.equal(calls[0][1].mimeType, 'audio/wav');
      assert.equal(isNativePcmWav(calls[0][1].buffer), true);
    }
    const tts = await runtime.synthesize({ text: 'hello' });
    assert.deepEqual(calls.map(([kind]) => kind), health.ready ? ['native-stt', 'native-tts'] : ['fallback-stt', 'fallback-tts']);
    assert.equal(stt.text, health.ready ? 'native transcript' : 'browser transcript');
    if (health.ready) {
      assert.equal(tts.audio, 'inert-audio-marker');
      assert.ok(calls.every(([, payload]) => typeof payload.requestId === 'string'));
    } else assert.equal(tts.useSystemSpeech, true);
    await runtime.dispose();
  }
});
