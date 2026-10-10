'use strict';
// Two disjoint authorities: the original R55 fixed graph and an authenticated
// hybrid runtime launched under a kernel-enforced no-fork policy. Neither
// ordinary leader-only processes nor caller-authored receipts gain closure.
const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomBytes} = require('node:crypto');
const {spawn,execFileSync,ChildProcess} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const {trackOwnedProcess,ownedProcessSnapshot} = require('./owned-process-lifetime.cjs');
const SOURCE = path.resolve(__dirname,'../../native/darwin/runtime-lifetime/controlled.cjs');
const SOURCE_SHA256 = 'fd568ee237f5bf744ad758d78c98b380ae827d921abf2b9cd74f3d7fbd53ad75';
const SCOPE = 'R55_FIRST_PARTY_FIXED_GRAPH';
const NATIVE_SCOPE = 'DARWIN_KERNEL_NO_FORK_RUNTIME_V1';
const NATIVE_LAUNCHER = '/usr/bin/sandbox-exec';
const NATIVE_PROFILE = '(version 1) (allow default) (deny process-fork)';
const MODES = new Set(['normal','worker-first','cancel','deadline-term','deadline-kill','held-stream','missing-receipt','late-receipt','forged-receipt']);
const producers = new WeakMap(), snapshots = new WeakMap(), ownerProducers = new WeakMap();
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function sourceValid() {
  const s=fs.lstatSync(SOURCE);
  return s.isFile() && !s.isSymbolicLink() && s.nlink===1 && sha(SOURCE)===SOURCE_SHA256;
}
// These two immutable system paths, not PATH or a caller-supplied launcher,
// are the trust boundary for the deprecated, local-engineering sandbox tool.
function systemExecutableIdentity(file) {
  if (fs.realpathSync(file)!==file) throw Error('system path changed');
  const stat=fs.lstatSync(file,{bigint:true});
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==0n || stat.nlink!==1n ||
      (stat.mode&0o6022n)!==0n || (stat.mode&0o111n)===0n || stat.size<=0n || stat.size>1048576n) throw Error('unsafe system file');
  for (let dir=path.dirname(file);;dir=path.dirname(dir)) {
    const parent=fs.lstatSync(dir,{bigint:true});
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid!==0n || (parent.mode&0o022n)!==0n) throw Error('unsafe system parent');
    if (dir==='/') break;
  }
  const identity=value=>JSON.stringify(['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].map(k=>String(value[k])));
  const original=identity(stat), fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    if (identity(fs.fstatSync(fd,{bigint:true}))!==original) throw Error('system file replaced');
    const hash=createHash('sha256'), buffer=Buffer.alloc(65536);
    let total=0, count;
    while ((count=fs.readSync(fd,buffer,0,buffer.length,null))) {
      total+=count;
      if (total>1048576) throw Error('system file grew');
      hash.update(buffer.subarray(0,count));
    }
    if (BigInt(total)!==stat.size || identity(fs.fstatSync(fd,{bigint:true}))!==original ||
        identity(fs.lstatSync(file,{bigint:true}))!==original) throw Error('system file changed');
    return Object.freeze({stat:original,sha256:hash.digest('hex')});
  } finally {fs.closeSync(fd);}
}
function qualifyNativeLauncher(previous=null) {
  try {
    const verifier='/usr/bin/codesign';
    const identity={launcher:systemExecutableIdentity(NATIVE_LAUNCHER),verifier:systemExecutableIdentity(verifier)};
    execFileSync(verifier,['--verify','--strict','-R=anchor apple and identifier "com.apple.sandbox-exec"',NATIVE_LAUNCHER],
      {env:{},stdio:['ignore','pipe','pipe'],timeout:3000,killSignal:'SIGKILL',maxBuffer:65536,shell:false});
    if (JSON.stringify(identity.launcher)!==JSON.stringify(systemExecutableIdentity(NATIVE_LAUNCHER)) ||
        JSON.stringify(identity.verifier)!==JSON.stringify(systemExecutableIdentity(verifier)) ||
        (previous && JSON.stringify(previous)!==JSON.stringify(identity))) throw Error('system identity changed');
    return Object.freeze(identity);
  } catch {throw Error('DARWIN_NATIVE_LAUNCHER_UNQUALIFIED');}
}
const NATIVE_ENV_VALUES=Object.freeze({
  PATH:'/usr/bin:/bin',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',
  PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',VOICE_RUNTIME_DEBUG:'1',
  VOICE_STT_BACKEND:'mlx-whisper',VOICE_TTS_BACKEND:'kokoro-onnx',VOICE_KOKORO_EXECUTION_PROVIDER:'cpu',
});
const NATIVE_ENV_PATHS=new Set(['HOME','TEMP','TMP','TMPDIR','SYSTEMROOT','WINDIR',
  'VOICE_RUNTIME_TEMP_DIR','HF_HOME','XDG_CACHE_HOME','VOICE_MLX_WHISPER_MODEL',
  'VOICE_KOKORO_ONNX_MODEL','VOICE_KOKORO_ONNX_VOICES']);
function nativeEnvironment(env) {
  if (!env || typeof env!=='object' || Array.isArray(env)) throw Error('DARWIN_NATIVE_ENV');
  const values=Object.getOwnPropertyDescriptors(env), keys=Reflect.ownKeys(values);
  if (keys.length>32 || keys.some(k=>typeof k!=='string')) throw Error('DARWIN_NATIVE_ENV');
  for (const key in env) if (!Object.hasOwn(env,key)) throw Error('DARWIN_NATIVE_ENV');
  const result=Object.create(null);
  for (const key of keys.sort()) {
    const descriptor=values[key], value=descriptor.value;
    if (!Object.hasOwn(descriptor,'value') || !descriptor.enumerable || typeof value!=='string' ||
        !value || value.length>4096 || /[\x00-\x1f\x7f]/.test(value)) throw Error('DARWIN_NATIVE_ENV');
    if (Object.hasOwn(NATIVE_ENV_VALUES,key)) {
      if (value!==NATIVE_ENV_VALUES[key]) throw Error('DARWIN_NATIVE_ENV');
    } else if (!NATIVE_ENV_PATHS.has(key) || !path.isAbsolute(value) || value.includes('\\') ||
        value.split('/').some(part=>part==='.' || part==='..')) throw Error('DARWIN_NATIVE_ENV');
    result[key]=value;
  }
  return Object.freeze(result);
}
function nativeSourceIdentity(source) {
  try {
    for (const key of ['authority','command','root','inventory','verifyRuntimeBeforeSpawn']) {
      if (!Object.hasOwn(Object.getOwnPropertyDescriptor(source,key)||{},'value')) throw Error('source own data required');
    }
    if (!Object.isFrozen(source) || source.authority!=='COMPILED_ROOT' || typeof source.root!=='string' ||
        !path.isAbsolute(source.root) || path.resolve(source.root)!==source.root ||
        fs.realpathSync(source.root)!==source.root || source.command!==path.join(source.root,'bin','voice-runtime') ||
        typeof source.verifyRuntimeBeforeSpawn!=='function') throw Error('source binding changed');
    return JSON.stringify([source.root,path.dirname(source.command),source.command].map((file,index)=> {
      const stat=fs.lstatSync(file,{bigint:true});
      if (stat.isSymbolicLink() || fs.realpathSync(file)!==file || (stat.mode&0o022n)!==0n ||
          (index<2?!stat.isDirectory():!stat.isFile() || stat.nlink!==1n || (stat.mode&0o111n)===0n)) throw Error('unsafe source');
      return ['dev','ino','mode','uid','gid'].map(key=>String(stat[key]));
    }));
  } catch {throw Error('DARWIN_NATIVE_SOURCE_UNQUALIFIED');}
}
function createDarwinProducer(owner, {command,args,purpose,deadline,nativeRuntime=null,env={}}) {
  if (process.platform!=='darwin') return null;
  const nativeSource=purpose==='hybrid-speech' && process.arch==='arm64'
    ? require('./bundled-voice-assets.cjs').authenticatedBundledRuntimeSource?.(nativeRuntime) : null;
  if (!nativeSource && (purpose!=='r55-control' || command!==process.execPath ||
      args.length!==3 || args[0]!==SOURCE || args[1]!=='leader' || !MODES.has(args[2]))) return null;
  if (nativeSource) {
    if (!Object.isFrozen(nativeSource) || nativeSource.authority!=='COMPILED_ROOT' ||
        command!==nativeSource.command || !Array.isArray(args) || args.length!==0 || nativeSource.verifyRuntimeBeforeSpawn()!==true) {
      throw Error('DARWIN_NATIVE_SOURCE_UNQUALIFIED');
    }
  } else if (!sourceValid()) throw Error('DARWIN_SOURCE_UNQUALIFIED');
  const state={owner,clientId:owner.clientId,command,args:[...args],purpose,sourceSha256:nativeSource?null:SOURCE_SHA256,
    scope:nativeSource?NATIVE_SCOPE:SCOPE,nativeSource,env:nativeSource?nativeEnvironment(env):null,
    nativeSourceIdentity:nativeSource?nativeSourceIdentity(nativeSource):null,
    launcherIdentity:nativeSource?qualifyNativeLauncher():null,
    executableSha256:sha(command),bundle:null,groups:[],authorizations:[],preparations:0,revision:0,fault:false,unknown:false,revoked:false,
    deadline:nativeSource?null:deadline ?? performance.now()+30000};
  if (!nativeSource && (!Number.isFinite(state.deadline) || state.deadline>performance.now()+30000)) throw Error('DARWIN_DEADLINE');
  const producer=Object.freeze({}); producers.set(producer,state);ownerProducers.set(owner,state);return producer;
}
function authorizeDarwinDispatch(producer,owner,bundle) {
  const s=producers.get(producer);
  if (!s || s.owner!==owner || s.bundle!==bundle || s.revoked || s.authorizations.length>=32) throw Error('DARWIN_AUTHORIZATION');
  s.authorizations.push({dispatched:false});s.revision++;
}
function updateDarwinPreparation(producer,owner,count) {
  const s=producers.get(producer);
  if (!s || s.owner!==owner || !Number.isSafeInteger(count) || count<0) throw Error('DARWIN_PREPARATION');
  if (s.preparations!==count) {s.preparations=count;s.revision++;}
}
function bindDarwinLease(producer, owner, bundle) {
  const s=producers.get(producer);
  if (!s || s.owner!==owner || s.bundle || s.groups.length) throw Error('DARWIN_LEASE_BINDING');
  s.bundle=bundle; s.revision++;
}
function spawnDarwinLeader(producer, owner, {command,args,env,generation}) {
  const s=producers.get(producer);
  if (!s || s.owner!==owner || s.clientId!==owner.clientId || !s.bundle || s.revoked || s.fault || s.unknown ||
      s.groups.some(g=>!g.closed) || command!==s.command || JSON.stringify(args)!==JSON.stringify(s.args) ||
      (!s.nativeSource && (!sourceValid() || performance.now()>=s.deadline-5000)) || sha(command)!==s.executableSha256 ||
      !s.authorizations.at(-1) || s.authorizations.at(-1).dispatched) throw Error('DARWIN_DISPATCH_UNQUALIFIED');
  if (s.groups.length>=32) throw Error('DARWIN_GENERATION_LIMIT');
  if (s.nativeSource) return spawnNativeLeader(s, owner, env, generation);
  if (Object.keys(env).length) throw Error('DARWIN_CONTROL_ENV');
  const mode=args[2], group={generation,token:randomBytes(32).toString('hex'),records:[],closed:false,
    deadline:s.deadline-5000, mode, output:{stdout:0,stderr:0}};
  s.authorizations.at(-1).dispatched=true;
  s.groups.push(group); s.revision++;
  const launch=role=> {
    // Responsibility precedes even a synchronous spawn failure. No unowned PID.
    const r={role,child:null,receipt:false,receiptEnd:false,receiptBytes:0,raw:{stdout:[],stderr:[]},retained:{stdout:0,stderr:0}};
    group.records.push(r); s.revision++;
    try {
      r.child=spawn(command,[SOURCE,role,mode,group.token],{env:{},stdio:['pipe','pipe','pipe','pipe'],windowsHide:true});
      trackOwnedProcess(owner,r.child,{gracefulSignal:true});
      for (const stream of ['stdout','stderr']) r.child[stream].on('data',b=> {
        group.output[stream]+=b.length;
        const keep=Math.max(0,Math.min(b.length,262144-(group.output[stream]-b.length)));
        if (keep) {r.raw[stream].push(Buffer.from(b.subarray(0,keep)));r.retained[stream]+=keep;}
        if (group.output[stream]>262144) {s.fault=true;s.revision++;}
      });
      let raw='';
      r.child.stdio[3].on('data',b=> {
        r.receiptBytes+=b.length;
        if (r.receiptBytes>4096) {s.fault=true; return;}
        raw+=b.toString('utf8');
      });
      r.child.stdio[3].once('end',()=> {
        r.receiptEnd=true;
        try {
          const value=JSON.parse(raw);
          r.receipt=Object.keys(value).length===3 && value.token===group.token && value.role===role && value.mode===mode;
        } catch {}
        if (!r.receipt) s.fault=true;
        s.revision++;
      });
      r.child.stdio[3].on('error',()=>{s.fault=true;s.revision++;});
      r.child.once('error',()=>{s.fault=true;s.revision++;});
      r.child.once('close',()=>{s.revision++;});
      if (role==='worker') {r.child.stdout.resume();r.child.stderr.resume();}
      return r.child;
    } catch(error) {s.unknown=true;s.revision++;throw error;}
  };
  const leader=launch('leader');
  if (['worker-first','held-stream'].includes(mode)) launch('worker');
  return leader;
}
function spawnNativeLeader(s, owner, env, generation) {
  if (typeof generation!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(generation) ||
      s.groups.some(group=>group.generation===generation)) throw Error('DARWIN_NATIVE_GENERATION');
  const launchEnv=nativeEnvironment(env);
  if (JSON.stringify(launchEnv)!==JSON.stringify(s.env)) throw Error('DARWIN_NATIVE_ENV_CHANGED');
  qualifyNativeLauncher(s.launcherIdentity);
  if (nativeSourceIdentity(s.nativeSource)!==s.nativeSourceIdentity ||
      s.nativeSource.verifyRuntimeBeforeSpawn()!==true ||
      nativeSourceIdentity(s.nativeSource)!==s.nativeSourceIdentity) throw Error('DARWIN_NATIVE_SOURCE_UNQUALIFIED');
  const group={generation,records:[],closed:false,deadline:Infinity,mode:'kernel-no-fork',output:{stdout:0,stderr:0}};
  const record={role:'leader',child:null,raw:{stdout:[],stderr:[]},retained:{stdout:0,stderr:0}};
  // Authorize and own the obligation BEFORE even a synchronous spawn failure.
  s.authorizations.at(-1).dispatched=true; group.records.push(record); s.groups.push(group); s.revision++;
  try {
    record.child=spawn(NATIVE_LAUNCHER,['-p',NATIVE_PROFILE,s.command],{
      env:launchEnv,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    record.streams=Object.freeze(Object.fromEntries(['stdin','stdout','stderr'].map(key=>[key,record.child[key]])));
    record.signal=record.child.kill.bind(record.child);
    trackOwnedProcess(owner,record.child,{gracefulSignal:true});
    for (const stream of ['stdout','stderr']) record.child[stream].on('data',b=> {
      group.output[stream]+=b.length;
      const keep=Math.max(0,Math.min(b.length,262144-record.retained[stream]));
      if (keep) {record.raw[stream].push(Buffer.from(b.subarray(0,keep)));record.retained[stream]+=keep;}
    });
    record.child.once('error',()=>{s.fault=true;s.revision++;});
    record.child.once('close',()=>{s.revision++;});
    if (!(record.child instanceof ChildProcess) || record.child.spawnfile!==NATIVE_LAUNCHER ||
        JSON.stringify(record.child.spawnargs)!==JSON.stringify([NATIVE_LAUNCHER,'-p',NATIVE_PROFILE,s.command])) {
      throw Error('DARWIN_NATIVE_LAUNCH_UNQUALIFIED');
    }
    return record.child;
  } catch(error) {s.unknown=true;s.revision++;throw error;}
}
function refresh(s) {
  for (const g of s.groups) {
    const closed=g.records.every(r=> {
      if (!r.child || (s.nativeSource && !r.streams)) return false;
      const [o]=ownedProcessSnapshot(s.owner,r.child);
      if (s.nativeSource && Object.entries(r.streams).some(([key,stream])=>r.child[key]!==stream) && !s.unknown) {
        s.unknown=true;s.revision++;
      }
      const drained=s.nativeSource?['stdout','stderr'].every(key=>r.streams[key]?.readableEnded===true):o?.drained;
      if (o && (o.error || (o.exited && (o.code!==0 || o.signal!==null))) && !s.fault) {s.fault=true;s.revision++;}
      return Boolean(o && (o.noSpawn || (o.exited && o.reaped && drained)) && (s.nativeSource || r.receiptEnd));
    });
    if (closed && !g.closed) {g.closed=true;s.revision++;}
  }
}
function darwinSnapshot(producer, owner, preparation) {
  const s=producers.get(producer);
  if (!s || s.owner!==owner) throw Error('DARWIN_PRODUCER_OWNER');
  if (preparation!==s.preparations) throw Error('DARWIN_PREPARATION_DRIFT');
  refresh(s);
  const value=Object.freeze({schemaVersion:2,clientId:s.clientId,coverage:'darwin-owned-handles',
    pendingPreparation:preparation>0,unresolvedGenerations:s.groups.filter(g=>!g.closed).length+s.authorizations.filter(a=>!a.dispatched).length,
    unknown:s.unknown,fault:s.fault,qualificationScope:s.scope,purpose:s.purpose});
  snapshots.set(value,{s,revision:s.revision,bundle:s.bundle});
  return value;
}
async function closeDarwinOwner(producer,owner,graceMs,killWaitMs) {
  const s=producers.get(producer);
  if (!s || s.owner!==owner) throw Error('DARWIN_PRODUCER_OWNER');
  for (const group of s.groups) {
    if (group.records[0]?.child) await closeDarwinGeneration(producer,owner,group.records[0].child,graceMs,killWaitMs);
  }
}
function inspectDarwinControl(owner) {
  const s=ownerProducers.get(owner);
  if (!s) return null;
  refresh(s);
  return {scope:s.scope,sourceSha256:s.sourceSha256,executableSha256:s.executableSha256,
    preparations:s.preparations,unknown:s.unknown,fault:s.fault,groups:s.groups.map(g=>({
      generation:g.generation,closed:g.closed,mode:g.mode,received:{...g.output},records:g.records.map(r=>({
        role:r.role,...(s.nativeSource?{}:{receipt:r.receipt,receiptEnd:r.receiptEnd}),...(r.child?ownedProcessSnapshot(owner,r.child)[0]:{}),
        retained:{...r.retained},raw:{stdout:Buffer.concat(r.raw.stdout).toString('base64'),stderr:Buffer.concat(r.raw.stderr).toString('base64')}}))}))};
}
function authenticatedDarwinSnapshot(value, owner, bundle) {
  const a=snapshots.get(value);
  if (!a || a.s.owner!==owner || a.s.bundle!==bundle || a.bundle!==bundle ||
      a.s.clientId!==owner.clientId || a.revision!==a.s.revision || a.s.unknown || a.s.fault) return false;
  refresh(a.s);
  return a.revision===a.s.revision && value.qualificationScope===a.s.scope;
}
function revokeDarwin(producer,owner) {
  const s=producers.get(producer); if (!s || s.owner!==owner) throw Error('DARWIN_PRODUCER_OWNER');
  s.revoked=true;s.revision++;
}
async function closeDarwinGeneration(producer,owner,leader,graceMs,killWaitMs) {
  const s=producers.get(producer), g=s?.groups.find(g=>g.records[0]?.child===leader);
  if (!s || s.owner!==owner || !g) throw Error('DARWIN_ORIGINAL_GENERATION');
  if (s.nativeSource && (![graceMs,killWaitMs].every(ms=>Number.isSafeInteger(ms) && ms>=0 && ms<=30000) || killWaitMs===0)) {
    s.unknown=true;s.revision++;throw Error('DARWIN_STOP_DEADLINE');
  }
  const deadline=Math.min(g.deadline+5000,performance.now()+graceMs+killWaitMs);
  const termAt=Math.min(deadline-killWaitMs,performance.now()+graceMs);
  for (const r of [...g.records].reverse()) {
    if (!r.child) continue;
    try {(r.streams?.stdin || r.child.stdin).end();} catch {s.fault=true;s.revision++;}
    // The frozen native server closes normally on EOF. Do not race it with
    // SIGTERM; the existing bounded kill/deadline still applies if EOF stalls.
    if (!s.nativeSource && r.child.exitCode===null && r.child.signalCode===null && g.mode!=='held-stream') {
      try {r.child.kill('SIGTERM');} catch {s.fault=true;}
    }
  }
  let forced=false;
  while (true) {
    refresh(s);
    if (g.closed) return;
    const now=performance.now();
    if (now>=deadline) {s.unknown=true;s.revision++;throw Error('DARWIN_OWNED_CLOSURE_TIMEOUT');}
    if (!forced && now>=termAt) {
      forced=true;
      for (const r of g.records) if (r.child && r.child.exitCode===null && r.child.signalCode===null) {
        try {if (r.signal) r.signal('SIGKILL'); else r.child.kill('SIGKILL');} catch {s.fault=true;s.revision++;}
      }
    }
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
module.exports={createDarwinProducer,bindDarwinLease,spawnDarwinLeader,darwinSnapshot,
  authenticatedDarwinSnapshot,revokeDarwin,closeDarwinGeneration,updateDarwinPreparation,inspectDarwinControl,
  closeDarwinOwner,authorizeDarwinDispatch};
