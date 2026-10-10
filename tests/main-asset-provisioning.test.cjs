'use strict';
// Actual Main + B managers + C1 Sidecar. Only Electron, executable loader and
// Windows taskkill are MEMORY adapters; owned Node children/ZIP/copy are real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const cp = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const yazl = require('yazl');
const { RuntimeManager } = require('../apps/desktop/runtime-manager.cjs');
const { ModelManager } = require('../apps/desktop/model-manager.cjs');
const { canonicalInventory } = require('../apps/desktop/tree-integrity.cjs');
const mainPath = path.resolve(__dirname, '../apps/desktop/main.cjs');
const req = createRequire(mainPath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FIXTURE_DEADLINE')), 4000); })]); }
  finally { clearTimeout(timer); }
}
const childSource = `const fs = require('node:fs');
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
 const m = JSON.parse(line);
 if (m.control === 'exit') process.exit(0);
 // Explicit fake protocol backend, not inference; read the real private bindings.
 const result = m.method === 'runtime.probe' ? {probeVersion:1, protocol:1, platform:'windows', arch:'x64', executable:true}
 : m.method === 'runtime.health' ? {protocol:1,platform:'windows',arch:'x64',fake:true,
 sttBackends:['fake'],ttsBackends:['fake'],selectedStt:'fake',selectedTts:'fake',degradedReason:null,
 ready:fs.readFileSync(process.env.VOICE_KOKORO_ONNX_MODEL,'utf8')==='owned-model'
 && fs.readFileSync(process.env.VOICE_KOKORO_ONNX_VOICES,'utf8')==='owned-voices'
 && fs.statSync(process.env.VOICE_FASTER_WHISPER_MODEL).isDirectory()}
 : {pid:process.pid, command:__filename, env:process.env,
 model:fs.readFileSync(process.env.VOICE_KOKORO_ONNX_MODEL,'utf8'),
 audio:m.params?.audioPath ? {path:m.params.audioPath, bytes:fs.readFileSync(m.params.audioPath).length} : null};
 console.log(JSON.stringify({id:m.id, success:true, result}));
});
console.log('{"event":"ready"}');
`;
async function archive(files, runtime = false, bindings) {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of Object.entries(files)) zip.addBuffer(Buffer.from(bytes), name);
  zip.end(); const chunks = []; for await (const chunk of zip.outputStream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const inventory = canonicalInventory(Object.entries(files).map(([name, value]) => ({path:name, bytes:Buffer.byteLength(value), sha256:hash(value)})));
  return { bytes, artifact: {url:'https://github.com/example/voice/releases/download/fixture/asset.zip', sha256:hash(bytes), bytes:bytes.length,
    entrypoint:Object.keys(files)[0], archive:'zip', files:inventory.files, treeDigest:inventory.treeDigest,
    provenance:{sourceRevision:'a'.repeat(40),sourceUrl:'https://github.com/example/voice',license:{spdx:'MIT',url:'https://example.com/license'}},
    ...(runtime ? {modelBindings:bindings} : {})} };
}
async function harness(t, options = {}) {
 const platform = options.platform || 'win32', arch = platform === 'darwin' ? 'arm64' : 'x64';
 const platformKey = platform === 'win32' ? 'win32-x64-cpu' : 'darwin-arm64';
 const root = options.profile || await fsp.mkdtemp(path.join(require('node:fs').realpathSync(os.tmpdir()), 'c2-main-assets-'));
 const children = options.children || [], clients = [], errors = [], handlers = new Map(), stopEvents = [];
 t.after(async()=>{
  options.release?.();
  for(const p of children){if(p.exitCode===null&&p.signalCode===null){const exit=once(p,'exit');p.kill('SIGKILL');await bounded(exit);} assert.throws(()=>process.kill(p.pid,0),{code:'ESRCH'});t.diagnostic(`owned-child pid=${p.pid} reaped=true`);}
  if(options.retainAssets && manager.coordinator.snapshot().pins) {t.diagnostic(`retained-assets=${root} (no tree proof; deliberately not removed)`);return;}
  await fsp.rm(root,{recursive:true,force:true});t.diagnostic(`owned-temp=${root} removed=true (harness teardown, not production proof)`);
 });
 const shutdown = gate();
 const dialogs=[], notices=[], menus=[]; let downloads=0;
 class MenuItem { constructor(value){Object.assign(this,value);if(Array.isArray(this.submenu))this.submenu=Menu.buildFromTemplate(this.submenu);} }
 class Menu {
  constructor(){this.items=[];} append(item){this.items.push(item);}
  getMenuItemById(id){for(const item of this.items){if(item.id===id)return item;const found=item.submenu?.getMenuItemById(id);if(found)return found;}}
  static buildFromTemplate(template){const menu=new Menu();for(const item of template)menu.append(item instanceof MenuItem?item:new MenuItem(item));return menu;}
  static getApplicationMenu(){return menus.at(-1)||null;} static setApplicationMenu(menu){menus.push(menu);}
 }
 const dialog={showMessageBox:async config=>{dialogs.push(config);return options.consent ? options.consent(config) : {response:0};},showErrorBox:(...args)=>notices.push(args)};
 let windows = 0, quitCount = 0;
 const model = options.bundles?.model || await archive({'model.bin':'owned-model', 'voices.bin':'owned-voices'});
 const bindings = {sttRoot:{modelId:'fixture-model',archiveSha256:model.artifact.sha256},
  onnxModel:{modelId:'fixture-model',archiveSha256:model.artifact.sha256,path:'model.bin'},
  onnxVoices:{modelId:'fixture-model',archiveSha256:model.artifact.sha256,path:'voices.bin'}};
 const platformChildSource = platform === 'darwin' ? childSource.replaceAll("platform:'windows', arch:'x64'", "platform:'darwin', arch:'arm64'").replaceAll("platform:'windows',arch:'x64'", "platform:'darwin',arch:'arm64'").replace('process.env.VOICE_FASTER_WHISPER_MODEL).isDirectory()', 'process.env.VOICE_MLX_WHISPER_MODEL).isDirectory()') : childSource;
 const runtime = options.bundles?.runtime || await archive({'bin/runtime.cjs':options.notReady ? 'process.exit(1);' : options.invalidProbe ? platformChildSource.replace('probeVersion:1','probeVersion:2') : platformChildSource}, true, bindings);
 const modelManifest = {schemaVersion:2,release:'fixture',models:{'fixture-model':{name:'fixture',purpose:'test',license:{spdx:'MIT',url:'https://example.com/license'},artifacts:{[platformKey]:model.artifact}}}};
 const runtimeManifest = {schemaVersion:2,release:'fixture',artifacts:{[platformKey]:runtime.artifact}};
 const fetchBytes = bytes => async () => {downloads++;return new Response(bytes, {headers:{'content-length':String(bytes.length)}});};
 if(options.bundledStartup&&!options.profile){await fsp.mkdir(path.join(root,'manifests'));await fsp.writeFile(path.join(root,'manifests/runtime-manifest.json'),JSON.stringify(runtimeManifest));await fsp.writeFile(path.join(root,'manifests/model-manifest.json'),JSON.stringify(modelManifest));}
 const manager = new RuntimeManager({userData:root,manifest:runtimeManifest,platform,arch,fetchImpl:fetchBytes(runtime.bytes),healthCheck:async()=>true}); // MEMORY initial seed only
 const models = new ModelManager({userData:root,manifest:modelManifest,platform,arch,fetchImpl:fetchBytes(model.bytes)});
 const app = Object.assign(new EventEmitter(), {isPackaged:true, requestSingleInstanceLock:()=>true,
  getPath:()=>root,getAppPath:()=>path.resolve(__dirname,'..'),whenReady:()=>new Promise(()=>{}),
  quit(){ const e={prevented:false,preventDefault(){this.prevented=true;}}; app.emit('before-quit',e); if(!e.prevented){quitCount++;shutdown.resolve();} return e; }});
 class Window extends EventEmitter {
  constructor(){ super(); windows++;this.webContents=Object.assign(new EventEmitter(),{mainFrame:{url:''},session:{webRequest:{onBeforeRequest(){},onHeadersReceived(){}},setPermissionRequestHandler(){}},setWindowOpenHandler(){}}); }
  async loadFile(file){this.webContents.mainFrame.url=require('node:url').pathToFileURL(file).href;}
 }
 const sidecarVM={module:{exports:{}},console,process:{platform:options.sidecarPlatform || 'win32',env:{}},setTimeout,clearTimeout,
  require:id=>id==='node:child_process'?{...cp,
   spawn(command,args,config){const child=cp.spawn(process.execPath,[command,...args],config);children.push(child);return child;},
   execFile(command,args,config,callback){
    const child=children.find(p=>p.pid===Number(args[args.indexOf('/PID')+1]));
    stopEvents.push({command,pid:child?.pid});
    if(!child) throw new Error('NOT_OWNED_PID');
    const exited=once(child,'exit');child.kill('SIGKILL');
    exited.then(()=>callback(options.unknownTermination ? new Error('MEMORY_TASKKILL_UNCONFIRMED') : null));return {kill(){}};
   }}:req(id)};
 vm.runInNewContext(fs.readFileSync(path.join(path.dirname(mainPath),'sidecar-client.cjs'),'utf8'),sidecarVM);
 class Client extends sidecarVM.module.exports.SidecarClient {constructor(config){super({...config,stopGraceMs:100,stopKillWaitMs:1000});clients.push(this);options.beforeClient?.(this);}}
 const context=vm.createContext({require:id=>id==='electron'?{app,BrowserWindow:Window,Menu,MenuItem,dialog,ipcMain:{handle:(k,v)=>handlers.set(k,v)},safeStorage:{},shell:{}}
  :id==='./sidecar-client.cjs'?{SidecarClient:Client}
  // Explicit NON_NATIVE test root at the real bundled-reader trust boundary.
  // Production roots stay private/empty; only these exact fixture manifests pass.
  :options.bundledStartup&&id==='./asset-manifest-trust.cjs'?{...req(id),authenticateAssetManifest(input,kind){const trust=req(id);return trust.authenticateAssetManifest(input,kind,{testOnlyTrustedDigests:[trust.manifestDigest(kind==='runtime'?runtimeManifest:modelManifest)]});}}
  :options.bundledStartup&&id==='./runtime-manager.cjs'?{RuntimeManager:class extends RuntimeManager{constructor(config){super({...config,platform:'win32',arch:'x64',fetchImpl:fetchBytes(runtime.bytes)});}}}
  :options.bundledStartup&&id==='./model-manager.cjs'?{ModelManager:class extends ModelManager{constructor(config){super({...config,platform:'win32',arch:'x64',fetchImpl:fetchBytes(model.bytes)});}}}
  :req(id),__dirname:path.dirname(mainPath),Buffer,URL,JSON,AbortController,setTimeout,clearTimeout, // actual required modules share the host JSON/object realm
  process:{argv:['node'],env:{PATH:'polluted',PYTHONPATH:'polluted',VOICE_RUNTIME_FAKE:'1',OPENAI_API_KEY:'fixture-only',DYLD_LIBRARY_PATH:'polluted',HOME:'polluted',VOICE_STT_BACKEND:'faster-whisper',VOICE_MLX_WHISPER_MODEL:'/poisoned'},platform,arch,resourcesPath:root},
  console:{log(){},error(...args){const message=args.map(String).join(' ');errors.push(message);if(message.includes('Desktop shutdown failed'))shutdown.resolve();}}});
 vm.runInContext(fs.readFileSync(mainPath,'utf8')+`\nglobalThis.api={launchRuntime,startApplication,initializeAssetManagers,managers:()=>({runtime:runtimeManager,model:modelManager}),validateRuntimeEntrypoint,createWindow,registerIpc,stopOwnedClient,
 setManagers(r,m){runtimeManager=r;modelManager=m;},startWithManagers(){initializeAssetManagers=async()=>{};return startApplication();},voice(){return sidecar;},owned(){return ownedClients;},window(){return mainWindow;}};`,context);
 const api=context.api;api.setManagers(manager,models);
 if(!options.empty){await models.install('fixture-model');await manager.install();}
 return {root,manager,models,api,app,clients,children,errors,stopEvents,shutdown,model,runtime,dialogs,notices,menus,downloads:()=>downloads,menu:id=>Menu.getApplicationMenu()?.getMenuItemById(id),windows:()=>windows,quits:()=>quitCount,
  async quit(){app.quit();await bounded(shutdown.promise);},
  async invoke(channel,payload){const w=api.window();return handlers.get(channel)({sender:w.webContents,senderFrame:w.webContents.mainFrame},payload);}};
}

test('Mac profile reaches actual Main private snapshot and child environment (MEMORY tree control, not Darwin retirement)', {timeout:12000}, async t => {
 const h = await harness(t, {platform:'darwin'});
 // This harness uses its existing Windows tree boundary ONLY as profile control.
 // Tiny ZIP/model/protocol fixtures are not native MLX/model execution.
 await h.api.launchRuntime();
 const client = h.api.voice(), observed = await client.request('fixture.consume');
 const bundle = h.api.owned().get(client).assets.bundle;
 assert.equal(observed.env.VOICE_STT_BACKEND, 'mlx-whisper');
 assert.equal(observed.env.VOICE_TTS_BACKEND, 'kokoro-onnx');
 assert.equal(observed.env.VOICE_KOKORO_EXECUTION_PROVIDER, 'cpu');
 assert.equal(observed.env.VOICE_MLX_WHISPER_MODEL, path.join(bundle.payload, 'models/fixture-model'));
 assert.notEqual(observed.env.VOICE_MLX_WHISPER_MODEL, (await h.models.status('fixture-model')).directory);
 assert.equal(observed.model, 'owned-model');
 assert.equal(hash(await fsp.readFile(observed.env.VOICE_KOKORO_ONNX_MODEL)), h.model.artifact.files.find(f=>f.path==='model.bin').sha256);
 assert.equal(hash(await fsp.readFile(observed.env.VOICE_KOKORO_ONNX_VOICES)), h.model.artifact.files.find(f=>f.path==='voices.bin').sha256);
 for (const key of ['VOICE_FASTER_WHISPER_MODEL','VOICE_FASTER_WHISPER_DEVICE','VOICE_FASTER_WHISPER_COMPUTE_TYPE','PATH','PYTHONPATH','DYLD_LIBRARY_PATH','HOME','OPENAI_API_KEY','VOICE_RUNTIME_FAKE']) assert.equal(observed.env[key], undefined, key);
 assert.equal(observed.env.HF_HUB_OFFLINE,'1'); assert.equal(observed.env.HF_HOME,bundle.cacheRoot);
 assert.equal(observed.env.VOICE_RUNTIME_TEMP_DIR,bundle.tempRoot);
 await h.quit(); assert.equal(h.quits(),1,'MEMORY Windows tree control only');
});

test('Mac Main denies tampered MLX private bytes at first beforeSpawn, even with POSIX client', {timeout:12000}, async t => {
 const h = await harness(t, {platform:'darwin',sidecarPlatform:'darwin',beforeClient(client) {
   const filename = path.join(client.env.VOICE_MLX_WHISPER_MODEL,'model.bin');
   fs.chmodSync(filename,0o600);fs.writeFileSync(filename,'wrong-model');
 }});
 await assert.rejects(h.api.launchRuntime(),/INVENTORY_FILE_MISMATCH/);
 assert.equal(h.clients.length,1);assert.equal(h.children.length,0,'actual beforeSpawn prevents child');
 assert.equal(h.manager.coordinator.snapshot().pins,0,'never authorized spawn can release');
 await h.quit();assert.equal(h.quits(),1);
});

test('Mac Main binding mismatch and wrong runtime/model platform deny before spawn', {timeout:12000}, async t => {
 for (const mismatch of ['hash','model-platform','runtime-platform']) {
  const h=await harness(t,{platform:'darwin'});
  if(mismatch==='hash') {
   const artifact=h.manager.manifest.artifacts['darwin-arm64'];
   h.manager.manifest={...h.manager.manifest,artifacts:{'darwin-arm64':{...artifact,modelBindings:{...artifact.modelBindings,sttRoot:{...artifact.modelBindings.sttRoot,archiveSha256:'b'.repeat(64)}}}}};
  } else if(mismatch==='model-platform') {h.models.options.platform='win32';h.models.options.arch='x64';}
  else h.manager.platform='linux';
  await assert.rejects(h.api.launchRuntime(),/MODEL_BINDING_MISMATCH|RUNTIME_UNAVAILABLE|UNSUPPORTED_PACKAGED_SPEECH_PLATFORM/);
  assert.equal(h.children.length,0);assert.equal(h.clients.length,0);assert.equal(h.manager.coordinator.snapshot().pins,0);
  await h.quit();assert.equal(h.quits(),1);
 }
});

test('Mac profile does not upgrade POSIX leader retirement or runtime probe cleanup', {timeout:12000}, async t => {
 for (const probe of [false,true]) {
  let observedProbe;
  const h=await harness(t,{platform:'darwin',sidecarPlatform:'darwin',retainAssets:true,beforeClient(client) {
   const request=client.request.bind(client);
   client.request=async(...args)=>{const result=await request(...args);if(args[0]==='runtime.probe')observedProbe=result;return result;};
  }});
  if(probe) {
   const previous=await h.manager.status();h.manager.healthCheck=h.api.validateRuntimeEntrypoint;
   await assert.rejects(h.manager.install(),/RUNTIME_HEALTH_CHECK_FAILED/);
   assert.equal(require('../apps/desktop/runtime-health.cjs').isCompatibleRuntimeProbe(observedProbe,'darwin','arm64'),true,'compatible probe fails ONLY at cleanup gate');
   assert.equal((await h.manager.status()).generation,previous.generation);
   assert.equal(h.clients[0].env.VOICE_STT_BACKEND,undefined,'probe remains minimal');
  } else {
   await h.api.launchRuntime();
   const observed=await h.api.voice().request('fixture.consume');
   assert.equal(observed.env.VOICE_STT_BACKEND,'mlx-whisper');
   await h.api.stopOwnedClient(h.api.voice());
  }
  const client=h.clients[0];
  assert.equal(client.assetLifetimeSnapshot().coverage,'leader-only');
  assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations,0);
  await h.quit();assert.equal(h.quits(),0);
  assert.ok(fs.existsSync(client.command));assert.ok(fs.existsSync(client.env.VOICE_RUNTIME_TEMP_DIR));
  assert.ok(h.manager.coordinator.snapshot().pins>0);
  assert.ok(h.errors.some(e=>e.includes('ASSET_LIFETIME_UNCONFIRMED')));
 }
});

test('held real copy excludes concurrent install and rejects mutated source before verified spawn', {timeout:12000}, async t => {
 for(const tamper of [false,true]) {
  const entered=gate(),held=gate(),h=await harness(t,{release:held.resolve});
  const previous=await h.manager.status(), metadata=await fsp.readFile(h.manager._selection().layout.metadata);
  const open=fsp.open;let copying=false,heldOnce=false;
  fsp.open=async(file,flags,...args)=>{
   const fd=await open(file,flags,...args);
   if(String(file).includes('/snapshots/')&&flags==='wx') copying=true;
   if(file===previous.entrypoint) {const read=fd.read.bind(fd);fd.read=async(...readArgs)=>{
    if(copying&&!heldOnce){heldOnce=true;entered.resolve();await held.promise;}
    return read(...readArgs);
   };}
   return fd;
  };
  const start=h.api.launchRuntime();const result=Promise.allSettled([start]);
  try {
   await bounded(entered.promise);
   assert.equal(h.children.length,0);assert.ok(h.manager.coordinator.snapshot().pins>=2);
   await assert.rejects(h.manager.install(),/INSTALL_ALREADY_RUNNING/);
   assert.deepEqual(await fsp.readFile(h.manager._selection().layout.metadata),metadata);
   assert.equal(fs.existsSync(previous.entrypoint),true);
   if(tamper){const bytes=await fsp.readFile(previous.entrypoint);bytes[0]^=1;await fsp.writeFile(previous.entrypoint,bytes);}
   held.resolve();const [outcome]=await bounded(result);
   if(tamper){assert.equal(outcome.status,'rejected');assert.match(outcome.reason.message,/INVENTORY_FILE_MISMATCH/);assert.equal(h.children.length,0);assert.equal(h.manager.coordinator.snapshot().pins,0);}
   else {assert.equal(outcome.status,'fulfilled');assert.equal((await h.api.voice().request('fixture.consume')).model,'owned-model');await h.quit();assert.equal(h.quits(),1);}
  } finally {held.resolve();fsp.open=open;await result;}
 }
});

test('unknown original probe termination retains candidate pin and temp with previous pointer unchanged', {timeout:12000}, async t => {
 const h=await harness(t,{unknownTermination:true}), previous=await h.manager.status();
 h.manager.healthCheck=h.api.validateRuntimeEntrypoint;
 await assert.rejects(bounded(h.manager.install()),/RUNTIME_HEALTH_CHECK_FAILED/);
 assert.equal(h.clients.length,1);assert.equal(h.stopEvents.length,1);
 const client=h.clients[0],snapshot=client.assetLifetimeSnapshot();
 assert.ok(snapshot.unknown||snapshot.unresolvedGenerations>0);
 assert.equal((await h.manager.status()).generation,previous.generation);
 assert.equal(h.api.owned().size,1);assert.equal(h.manager.coordinator.snapshot().pins,1);
 assert.equal(fs.existsSync(client.command),true);assert.equal(fs.existsSync(client.env.VOICE_RUNTIME_TEMP_DIR),true);
 await h.quit();assert.equal(h.quits(),0);assert.equal(fs.existsSync(client.command),true);
 assert.equal(h.stopEvents.length,1,'never kill historic PID on retry');
});

test('probe immediate cancellation observes skipped admission preparation and releases the original pin', {timeout:12000}, async t => {
 const h=await harness(t); const previous=await h.manager.status();
 h.manager.healthCheck=(file,ctx)=>{const task=h.api.validateRuntimeEntrypoint(file,ctx);h.manager.cancel();h.app.quit();return task;};
 await assert.rejects(bounded(h.manager.install()),/DESKTOP_SHUTTING_DOWN|ASSET_PREPARATION_ABORTED|INSTALL_CANCELLED/);
 await bounded(h.shutdown.promise);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.quits(),1,JSON.stringify(h.errors));assert.equal(h.children.length,0);
 assert.equal(h.manager.coordinator.snapshot().pins,0);
 assert.equal((await h.manager.status()).generation,previous.generation);
});

test('probe skipped admission observes rejected underlying work while another original stop is held', {timeout:12000}, async t => {
 const held=gate(),h=await harness(t,{release:held.resolve});await h.api.launchRuntime();
 const original=h.api.voice(),terminate=original._terminate.bind(original);
 original._terminate=async child=>{await held.promise;return terminate(child);};
 const previous=await h.manager.status();
 h.manager.healthCheck=(file,ctx)=>{const task=h.api.validateRuntimeEntrypoint(file,ctx);h.manager.cancel();h.app.quit();return task;};
 try {
  await assert.rejects(bounded(h.manager.install()),/DESKTOP_SHUTTING_DOWN/);
  // A full event-loop turn makes an unobserved ORIGINAL bundle.work reject fail node:test.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.quits(),0);assert.equal(h.children.length,1,'no probe candidate spawn');
 } finally {held.resolve();}
 await bounded(h.shutdown.promise);assert.equal(h.quits(),1,JSON.stringify(h.errors));
 assert.equal(h.manager.coordinator.snapshot().pins,0);
 assert.equal((await h.manager.status()).generation,previous.generation);
});

test('Main bundled manifest reader rejects oversized files before parsing', async t => {
 const h = await harness(t, {empty: true});
 const folder = path.join(h.root, 'manifests'); await fsp.mkdir(folder);
 const runtimePath = path.join(folder, 'runtime-manifest.json');
 const modelPath = path.join(folder, 'model-manifest.json');
 const runtime = JSON.stringify({schemaVersion: 2, release: 'unpublished', artifacts: {}});
 const model = JSON.stringify({schemaVersion: 2, release: 'unpublished', models: {}});
 await fsp.writeFile(runtimePath, runtime); await fsp.writeFile(modelPath, model);
 await h.api.initializeAssetManagers();
 assert.ok(h.api.managers().runtime instanceof RuntimeManager);
 assert.ok(h.api.managers().model instanceof ModelManager);
 const max = require('../apps/desktop/tree-integrity.cjs').ASSET_LIMITS.maxMetadataBytes;
 // Valid JSON plus trailing whitespace defeats a post-parse/stringify size check.
 await fsp.writeFile(runtimePath, runtime + ' '.repeat(max));
 await fsp.writeFile(modelPath, model + ' '.repeat(max));
 await h.api.initializeAssetManagers();
 assert.equal(h.api.managers().runtime instanceof RuntimeManager, false);
 assert.equal(h.api.managers().model instanceof ModelManager, false);
 assert.equal((await h.api.managers().runtime.status()).reason, 'RUNTIME_MANIFEST_UNAVAILABLE');
 assert.equal((await h.api.managers().model.status()).reason, 'MODEL_MANIFEST_UNAVAILABLE');
 assert.equal(h.children.length, 0);
});

test('Main bundled manifest reader refuses linked and nonregular inputs', async t => {
 const h = await harness(t, {empty: true});
 const folder = path.join(h.root, 'manifests'); await fsp.mkdir(folder);
 const runtimePath = path.join(folder, 'runtime-manifest.json');
 const modelPath = path.join(folder, 'model-manifest.json');
 const target = path.join(h.root, 'manifest-target.json');
 await fsp.writeFile(target, JSON.stringify({schemaVersion: 2, release: 'unpublished', artifacts: {}}));
 await fsp.writeFile(modelPath, JSON.stringify({schemaVersion: 2, release: 'unpublished', models: {}}));
 await fsp.symlink(target, runtimePath);
 await h.api.initializeAssetManagers();
 assert.equal(h.api.managers().runtime instanceof RuntimeManager, false);
 assert.ok(h.api.managers().model instanceof ModelManager);
 assert.equal((await h.api.managers().runtime.status()).reason, 'RUNTIME_MANIFEST_UNAVAILABLE');
 await fsp.unlink(runtimePath); await fsp.mkdir(runtimePath);
 await h.api.initializeAssetManagers();
 assert.equal(h.api.managers().runtime instanceof RuntimeManager, false);
 assert.ok(h.api.managers().model instanceof ModelManager);
 assert.equal(h.children.length, 0);
 assert.equal(JSON.parse(await fsp.readFile(target, 'utf8')).release, 'unpublished');
});

test('POSIX leader-only Stop is not asset-tree retirement proof', {timeout:12000}, async t=>{
 const h=await harness(t,{sidecarPlatform:'linux'});await h.api.launchRuntime();
 const client=h.api.voice();await h.api.stopOwnedClient(client);
 assert.equal(client.assetLifetimeSnapshot().coverage,'leader-only');
 assert.equal(client.assetLifetimeSnapshot().unresolvedGenerations,0,'C1 compacts its original leader proof');
 await h.quit();assert.equal(h.quits(),0);assert.ok(fs.existsSync(client.command));
 assert.ok(h.errors.some(e=>e.includes('ASSET_LIFETIME_UNCONFIRMED')));
});

test('spawned-not-ready startup retains unknown assets but creates fallback window', {timeout:12000}, async t=>{
 const h=await harness(t,{notReady:true});await bounded(h.api.startWithManagers());
 assert.equal(h.windows(),1);assert.equal(h.quits(),0);assert.equal(h.api.voice(),null);
 const client=h.clients[0];assert.equal(client.assetLifetimeSnapshot().unknown,true);
 assert.equal(h.api.owned().size,1);assert.ok(fs.existsSync(client.command));
 await h.quit();assert.equal(h.quits(),0);assert.ok(h.errors.some(e=>e.includes('ASSET_LIFETIME_UNCONFIRMED')));
});

test('invalid probe preserves previous installation and releases only confirmed candidate', {timeout:12000}, async t=>{
 const h=await harness(t,{invalidProbe:true});const previous=await h.manager.status();
 h.manager.healthCheck=h.api.validateRuntimeEntrypoint;
 await assert.rejects(h.manager.install(),/RUNTIME_HEALTH_CHECK_FAILED/);
 assert.equal((await h.manager.status()).generation,previous.generation);
 assert.equal(h.api.owned().size,0);assert.equal(h.clients.length,1);
 assert.equal(fs.existsSync(h.clients[0].env.VOICE_RUNTIME_TEMP_DIR),false);
});

test('Main G1 idle unknown refuses G2 and repeated normal Quit retains original assets', {timeout:12000}, async t=>{
 const h=await harness(t);await h.api.launchRuntime();
 const client=h.api.voice(), result=await client.request('fixture.consume');
 const exited=once(h.children[0],'exit');h.children[0].stdin.write('{"control":"exit"}\n');await bounded(exited);
 assert.equal(client.assetLifetimeSnapshot().unknown,true);
 await assert.rejects(client.start(),/ASSET_LIFETIME_UNCONFIRMED/);assert.equal(h.children.length,1);
 await h.quit();assert.equal(h.quits(),0);assert.ok(h.errors.some(e=>e.includes('ASSET_LIFETIME_UNCONFIRMED')));
 assert.ok(fs.existsSync(result.command));assert.equal(h.api.owned().size,1);
 h.app.quit();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.quits(),0);assert.ok(fs.existsSync(result.command));
});

test('Main rechecks tampered private bytes and rejects wrong model binding before spawn', {timeout:12000}, async t=>{
 const h=await harness(t);await h.api.launchRuntime();
 const client=h.api.voice();await h.api.stopOwnedClient(client);
 const bundle=h.api.owned().get(client).assets.bundle;
 await fsp.chmod(bundle.command,0o600);await fsp.appendFile(bundle.command,'tampered');
 await assert.rejects(client.start(),/INVENTORY_FILE_MISMATCH/);assert.equal(h.children.length,1);
 await h.quit();assert.equal(h.quits(),1,JSON.stringify(h.errors));
 const h2=await harness(t);
 const artifact=h2.manager.manifest.artifacts['win32-x64-cpu'];
 h2.manager.manifest={...h2.manager.manifest,artifacts:{'win32-x64-cpu':{...artifact,modelBindings:{...artifact.modelBindings,sttRoot:{...artifact.modelBindings.sttRoot,archiveSha256:'b'.repeat(64)}}}}};
 await assert.rejects(h2.api.launchRuntime(),/MODEL_BINDING_MISMATCH/);assert.equal(h2.children.length,0);
});

test('original wrong or missing client evidence never releases; filesystem-only failure retains retry', {timeout:12000}, async t=>{
 const h=await harness(t);await h.api.launchRuntime();
 const client=h.api.voice(), assets=h.api.owned().get(client).assets;
 await h.api.stopOwnedClient(client);assets.retire();
 await assert.rejects(assets.release({},assets.bundle),/ASSET_LIFETIME_UNCONFIRMED/);
 const snapshot=client.assetLifetimeSnapshot.bind(client);
 client.assetLifetimeSnapshot=()=>null;
 await assert.rejects(assets.release(client,assets.bundle),/ASSET_LIFETIME_UNCONFIRMED/);
 client.assetLifetimeSnapshot=snapshot;
 const remove=h.manager.coordinator.io.remove;let failures=0;
 h.manager.coordinator.io.remove=root=>{if(root===assets.bundle.root){failures++;throw new Error('MEMORY_FS_FAILURE');}return remove(root);};
 await h.quit();assert.equal(h.quits(),0);assert.ok(failures>0);assert.ok(fs.existsSync(assets.bundle.command));
 h.manager.coordinator.io.remove=remove;h.app.quit();
 // Exact production success event, not a sleep or previous failed-Quit signal.
 if(!h.quits()) await bounded(new Promise(resolve=>h.app.on('before-quit',e=>{if(!e.prevented)resolve();})));
 assert.equal(h.quits(),1);assert.equal(fs.existsSync(assets.bundle.command),false);
});

test('held source verification stays owned through Quit; actual no-spawn work drains before removal', {timeout:12000}, async t=>{
 const h=await harness(t), entered=gate(), held=gate();
 const status=h.manager.status.bind(h.manager);
 h.manager.status=async()=>{entered.resolve();await held.promise;return status();};
 const start=h.api.launchRuntime();const rejected=assert.rejects(start,/ASSET_PREPARATION_ABORTED|DESKTOP_SHUTTING_DOWN/);
 await bounded(entered.promise);
 const roots=h.manager.coordinator.snapshot();assert.equal(roots.active,true);assert.ok(roots.pins>=2);
 h.app.quit();assert.equal(h.quits(),0);assert.equal(h.children.length,0);
 held.resolve();await bounded(rejected);await bounded(h.shutdown.promise);
 assert.equal(h.quits(),1,JSON.stringify(h.errors));assert.equal(h.manager.coordinator.snapshot().pins,0);
});

test('startup without trusted bundle still creates a fallback window', {timeout:12000}, async t=>{
 const h=await harness(t,{empty:true});await h.api.startApplication();
 assert.equal(h.windows(),1);assert.equal(h.children.length,0);assert.equal(h.quits(),0);
});

test('runtime-only install uses actual Main/C1 pure probe while install transaction is active', {timeout:12000}, async t=>{
 const h=await harness(t,{empty:true,consent:()=>({response:1})});
 h.manager.healthCheck=h.api.validateRuntimeEntrypoint;
 await h.api.createWindow();h.api.registerIpc();
 const result=await h.invoke('runtime:install');
 assert.equal(result.state,'installed');assert.equal(result.restartRequired,true);
 assert.equal(h.clients.length,1,'no postinstall hot voice startup');
 assert.equal(h.api.voice(),undefined);
 assert.equal(h.clients[0].assetLifetimeSnapshot().unresolvedGenerations,0);
 assert.equal(h.clients[0].env.PATH,undefined);assert.equal(h.clients[0].env.VOICE_RUNTIME_FAKE,undefined);
 assert.equal(fs.existsSync(h.clients[0].env.VOICE_RUNTIME_TEMP_DIR),false);
 assert.equal(h.api.owned().size,0);assert.equal(h.manager.coordinator.snapshot().pins,0);
 assert.equal((await h.models.status('fixture-model')).state,'unavailable');
 await h.quit();assert.equal(h.quits(),1,JSON.stringify(h.errors));
 t.diagnostic('runtime-only tiny ZIP→Main→C1 runtime.probe ACK→original MEMORY taskkill/exit→candidate pin release→B activation; models unavailable');
});

test('Main uses independent verified bundle; original healthy Stop/restart retains it until final retirement', {timeout:12000}, async t=>{
 const h=await harness(t);
 await h.api.launchRuntime();
 const client=h.api.voice();
 assert.ok(client,'verified voice published');
 const result=await client.request('fixture.consume');
 const installed=await h.manager.status();
 assert.notEqual(result.command,installed.entrypoint,'Main must not execute installed cache directly');
 assert.equal(result.model,'owned-model');
 assert.notEqual(fs.statSync(result.command).ino,fs.statSync(installed.entrypoint).ino,'not a hardlink');
 assert.equal(result.env.PATH,undefined);assert.equal(result.env.PYTHONPATH,undefined);assert.equal(result.env.VOICE_RUNTIME_FAKE,undefined);
 const payloadRoot=path.dirname(path.dirname(result.command));
 assert.ok(!result.env.VOICE_RUNTIME_TEMP_DIR.startsWith(payloadRoot+path.sep));
 await h.api.stopOwnedClient(client);
 assert.ok(fs.existsSync(result.command),'ordinary Stop retains snapshot');
 await h.manager.install();
 await client.start();
 const restarted=await client.request('fixture.consume');
 assert.notEqual(result.pid,restarted.pid);assert.equal(restarted.command,result.command);
 await h.api.createWindow();h.api.registerIpc();
 const stt=await h.invoke('voice:stt',{buffer:Buffer.from('inert-audio'),mimeType:'audio/wav'});
 assert.equal(path.dirname(stt.audio.path),result.env.VOICE_RUNTIME_TEMP_DIR);assert.equal(stt.audio.bytes,11);
 assert.equal(fs.existsSync(stt.audio.path),false);
 await h.quit();
 assert.equal(h.quits(),1,JSON.stringify(h.errors));assert.equal(fs.existsSync(result.command),false);
 assert.equal(fs.existsSync(result.env.VOICE_RUNTIME_TEMP_DIR),false);assert.equal(h.api.owned().size,0);
 t.diagnostic(`Main→B-pin→private-copy→C1-Sidecar→child ACK pid=${result.pid}→restart pid=${restarted.pid}→MEMORY Windows taskkill+exit→retirement`);
});

test('D IPC consent owns intent before dialog; unconfirmed or declined means zero download', async t=>{
 const entered=gate(),held=gate();const h=await harness(t,{empty:true,release:()=>held.resolve({response:0}),consent:()=>{entered.resolve();return held.promise;}});
 await h.api.createWindow();h.api.registerIpc();
 const install=h.invoke('runtime:install');const settled=Promise.allSettled([install]);
 await bounded(Promise.race([entered.promise,settled]));
 assert.equal(h.dialogs.length,1,'IPC must reach native consent before B installation');
 assert.equal(h.dialogs[0].defaultId,0);assert.equal(h.dialogs[0].cancelId,0);
 assert.match(h.dialogs[0].detail,/fixture/);assert.match(h.dialogs[0].detail,/MIT/);assert.match(h.dialogs[0].detail,/重新啟動/);
 assert.equal(h.downloads(),0);assert.equal(h.children.length,0);
 await assert.rejects(h.invoke('runtime:install'),/INSTALL_ALREADY_RUNNING/);
 held.resolve({response:0});assert.equal((await install).cancelled,true);
 assert.equal(h.downloads(),0);assert.equal((await h.manager.status()).state,'unavailable');
 await h.quit();assert.equal(h.quits(),1);
});

test('D Windows startup Menu shares IPC admission and cancels only original consent', async t=>{
 const first=gate(),second=gate();let count=0;
 const h=await harness(t,{empty:true,release:()=>{first.resolve({response:0});second.resolve({response:0});},consent:()=>++count===1?first.promise:second.promise});
 await h.api.startWithManagers();
 assert.ok(h.menu('asset-runtime'),'real startup must expose native install menu');
 assert.ok(h.menus.at(-1).items.some(i=>i.role==='editMenu'));
 const task=h.menu('asset-runtime').click();
 assert.equal(h.dialogs.length,1);assert.equal(h.menu('asset-runtime').enabled,false);
 assert.equal(h.menu('asset-cancel').enabled,true);assert.match(h.menu('asset-status').label,/同意/);
 await assert.rejects(h.invoke('models:install',{modelId:'fixture-model'}),/INSTALL_ALREADY_RUNNING/);
 const cancelOriginal=h.menu('asset-cancel').click;
 assert.equal((await h.invoke('models:cancel',{modelId:'fixture-model'})).cancelled,false,'wrong kind cannot cancel runtime');
 assert.equal((await h.invoke('runtime:cancel')).cancelled,true);
 await assert.rejects(h.invoke('runtime:install'),/INSTALL_ALREADY_RUNNING/,'one pending modal, no queue');
 first.resolve({response:1});assert.equal((await task).cancelled,true);
 assert.equal(h.downloads(),0);assert.equal(h.children.length,0);
 const successor=h.invoke('models:install',{modelId:'fixture-model'});
 assert.equal(h.dialogs.length,2);assert.equal(cancelOriginal().cancelled,false,'stale Menu callback cannot cancel successor');
 second.resolve({response:1});const result=await successor;
 assert.equal(result.state,'installed');assert.equal(result.restartRequired,true);
 assert.equal(h.children.length,0);assert.match(h.menu('asset-status').label,/重新啟動/);
 assert.equal(h.menu('asset-runtime').enabled,true);assert.equal(h.menu('asset-cancel').enabled,false);
 await h.quit();
});

test('D Quit synchronously retires late consent and visibly retains unknown assets with or without window', {timeout:12000}, async t=>{
 for(const rejectLate of [false,true]) {
  const held=gate();const h=await harness(t,{consent:()=>held.promise,release:()=>held.resolve({response:0})});
  await h.api.startWithManagers();const original=h.api.voice();
  const exit=once(h.children[0],'exit');h.children[0].stdin.write('{"control":"exit"}\n');await bounded(exit);
  const before=h.downloads(),task=h.menu('asset-runtime').click();
  if(rejectLate)h.api.window().emit('closed');
  h.app.quit();
  assert.equal(h.dialogs[0].signal?.aborted,true,'Quit must invalidate original dialog synchronously');
  await bounded(h.shutdown.promise);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.quits(),0);assert.equal(h.notices.length,1,'native error even without BrowserWindow');
  assert.match(h.notices[0][1],/ASSET_LIFETIME_UNCONFIRMED/);
  assert.equal(fs.existsSync(original.command),true);assert.equal(h.api.owned().size,1);
  if(rejectLate)held.resolve(Promise.reject(new Error('late private diagnostic')));else held.resolve({response:1});
  assert.equal((await task).cancelled,true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.downloads(),before);assert.equal(h.children.length,1);
  assert.equal(h.notices.length,1);assert.equal(h.notices.flat().join(' ').includes('private diagnostic'),false);
 }
});

test('D cold owned profile: real Main Menu runtime, IPC models, fresh Main VM startup exact bundle and speech health', {timeout:12000}, async t=>{
 const h=await harness(t,{empty:true,bundledStartup:true,consent:()=>({response:1})});
 await h.api.startApplication();const managers=h.api.managers();
 assert.equal(h.children.length,0);assert.equal(h.downloads(),0);assert.equal(h.dialogs.length,0);
 await assert.rejects(h.invoke('voice:health'),/NATIVE_VOICE_RUNTIME_UNAVAILABLE/);
 const runtime=await h.menu('asset-runtime').click();assert.equal(runtime.state,'installed');assert.equal(runtime.restartRequired,true);
 assert.equal(h.dialogs.length,1);assert.equal(h.children.length,1,'probe only, no hot startup');
 assert.equal((await managers.model.status('fixture-model')).state,'unavailable');
 await assert.rejects(h.invoke('voice:health'),/NATIVE_VOICE_RUNTIME_UNAVAILABLE/);
 const model=await h.invoke('models:install',{modelId:'fixture-model'});
 assert.equal(model.state,'installed');assert.equal(model.restartRequired,true);assert.equal(h.dialogs.length,2);
 assert.equal(h.children.length,1);await assert.rejects(h.invoke('voice:health'),/NATIVE_VOICE_RUNTIME_UNAVAILABLE/);
 const runtimeStatus=await managers.runtime.status(), modelStatus=await managers.model.status('fixture-model');
 const metadata=await fsp.readFile(managers.runtime._selection().layout.metadata);
 await h.quit();assert.equal(h.quits(),1);assert.equal(managers.runtime.coordinator.snapshot().pins,0);
 // Fresh Main VM/new B managers, SAME Node process/module cache: not packaged restart.
 const restarted=await harness(t,{empty:true,bundledStartup:true,profile:h.root,children:h.children,bundles:{runtime:h.runtime,model:h.model}});
 await restarted.api.startApplication();
 assert.equal(restarted.downloads(),0);assert.equal(restarted.dialogs.length,0);
 assert.equal(h.children.length,2);assert.notEqual(h.children[0].pid,h.children[1].pid);
 const health=await restarted.invoke('voice:health');
 assert.equal(health.fake,true,'explicit protocol fixture, never native inference');
 assert.equal(require('../apps/desktop/runtime-health.cjs').isHealthyRuntimeResponse(health),true);
 const observed=await restarted.api.voice().request('fixture.consume');
 assert.equal(observed.model,'owned-model');assert.notEqual(observed.command,runtimeStatus.entrypoint);
 assert.notEqual(observed.env.VOICE_KOKORO_ONNX_MODEL,modelStatus.entrypoint);
 assert.equal(hash(await fsp.readFile(observed.command)),h.runtime.artifact.files.find(f=>f.path==='bin/runtime.cjs').sha256);
 assert.equal(hash(await fsp.readFile(observed.env.VOICE_KOKORO_ONNX_MODEL)),h.model.artifact.files.find(f=>f.path==='model.bin').sha256);
 assert.equal(hash(await fsp.readFile(observed.env.VOICE_KOKORO_ONNX_VOICES)),h.model.artifact.files.find(f=>f.path==='voices.bin').sha256);
 assert.deepEqual(await fsp.readFile(restarted.api.managers().runtime._selection().layout.metadata),metadata);
 await restarted.quit();assert.equal(restarted.quits(),1);assert.equal(fs.existsSync(observed.command),false);
 t.diagnostic(`D cold profile→Main native Menu/dialog→B tiny ZIP→C1 probe pid=${h.children[0].pid}→IPC model consent→restartRequired/no hotstart→fresh Main VM (same OS process)→exact private binding→original voice:health fake protocol readiness pid=${h.children[1].pid}→owned exit/retirement`);
});

test('D selection controls reject arbitrary getters, inherited IDs and unavailable artifacts before consent', async t=>{
 const h=await harness(t,{empty:true});await h.api.startWithManagers();let accessed=0;
 const getter={};Object.defineProperty(getter,'modelId',{enumerable:true,get(){accessed++;return 'fixture-model';}});
 for(const payload of [getter,{modelId:'toString'},{modelId:'wrong'},Object.create({modelId:'fixture-model'}),{modelId:'fixture-model',url:'https://evil.invalid'}])await assert.rejects(h.invoke('models:install',payload),/UNKNOWN_MODEL/);
 await assert.rejects(h.invoke('runtime:install',{toString(){accessed++;throw new Error('NO_COERCION');}}),/INVALID_RUNTIME_REQUEST/);
 assert.equal(accessed,0);assert.equal(h.downloads(),0);assert.equal(h.dialogs.length,0);
 h.manager.manifest={schemaVersion:2,release:'fixture',artifacts:{}};
 await assert.rejects(h.invoke('runtime:install'),/UNAVAILABLE/);
 const h2=await harness(t,{empty:true});await h2.api.startApplication();
 assert.equal(h2.menu('asset-runtime').enabled,false);assert.match(h2.menu('asset-runtime').label,/無相容/);
 assert.equal(h2.downloads(),0);assert.equal(h2.dialogs.length,0);
 await h.quit();await h2.quit();
});

test('D pure consent Quit never waits on a modal and observes late IPC approve or reject', async t=>{
 for(const rejection of [false,true]) {
  const held=gate(),h=await harness(t,{empty:true,release:()=>held.resolve({response:0}),consent:()=>held.promise});await h.api.startWithManagers();
  const task=h.invoke('runtime:install');const observed=Promise.allSettled([task]);
  await h.quit();assert.equal(h.quits(),1);assert.equal(h.dialogs[0].signal.aborted,true);
  if(rejection)held.resolve(Promise.reject(new Error('late modal')));else held.resolve({response:1});
  assert.equal((await task).cancelled,true);await observed;
  assert.equal(h.downloads(),0);assert.equal(h.children.length,0);assert.equal(h.notices.length,0);
 }
});

test('D real B model cancellation before versus after commit preserves installed restart truth', async t=>{
 for(const committed of [false,true]) {
  const held=gate(),entered=gate(),h=await harness(t,{empty:true,consent:()=>({response:1}),release:held.resolve});await h.api.startWithManagers();
  h.models.options.writeMetadata=async(_file,_value,{commit})=>{if(committed)commit();entered.resolve();await held.promise;if(!committed)commit();};
  const task=h.invoke('models:install',{modelId:'fixture-model'}),observed=Promise.allSettled([task]);
  await bounded(entered.promise);assert.match(h.menu('asset-status').label,/下載／驗證／安裝中/);
  assert.equal((await h.invoke('runtime:cancel')).cancelled,false);
  assert.equal((await h.invoke('models:cancel',{modelId:'fixture-model'})).cancelled,true);held.resolve();
  const [result]=await observed;
  if(committed){assert.equal(result.status,'fulfilled');assert.equal(result.value.state,'installed');assert.equal(result.value.restartRequired,true);assert.match(h.menu('asset-status').label,/重新啟動/);}
  else {assert.equal(result.status,'rejected');assert.match(result.reason.message,/INSTALL_CANCELLED/);}
  assert.equal((await h.models.status('fixture-model')).state,committed?'installed':'unavailable');
  assert.equal(h.children.length,0);assert.equal(h.models.coordinator.snapshot().pins,0);await h.quit();
 }
});

test('D native Menu observes dialog rejection and presents a sanitized visible error', async t=>{
 const h=await harness(t,{empty:true,consent:()=>Promise.reject(new Error('fixture-private-secret'))});await h.api.startWithManagers();
 const result=await h.menu('asset-runtime').click();
 assert.equal(result.state,'unavailable');assert.equal(h.downloads(),0);assert.equal(h.notices.length,1);
 assert.equal(h.notices.flat().join(' ').includes('fixture-private-secret'),false);
 assert.match(h.menu('asset-status').label,/失敗/);assert.equal(h.menu('asset-runtime').enabled,true);await h.quit();
});
