'use strict';
// Separate domain from C terminal and D Stop. Source binding is NOT retirement,
// inference, readiness, file-read telemetry, or permission to release any lease.
const {randomBytes,createHmac,timingSafeEqual} = require('node:crypto');
const {cloneData}=require('./data-only.cjs');
function sourceData(value){try{return cloneData(value);}catch{throw Error('ASSET_OBSERVATION_SCHEMA');}}
const TYPE='MANAGED_ASSET_SOURCE_V1', PHASE='passive-source';
// In-process provenance is not serializable authority. Only this reader can
// brand an immutable observation; a copied object cannot authorize a test lane.
const authenticated = new WeakMap();
function freeze(value) { if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; }
function authenticatedSource(value, expected) {
 const binding=authenticated.get(value);
 return Boolean(binding && (!expected || ['launchNonce','mainPid','webContentsId'].every(k=>binding[k]===expected[k])));
}
const hex=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string' && /^[a-f0-9-]{36}$/.test(v);
function exact(value, keys) {
 if (!value || typeof value!=='object' || Array.isArray(value) || Reflect.ownKeys(value).length!==keys.length ||
     !keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)||{},'value'))) throw Error('ASSET_OBSERVATION_SCHEMA');
}
function positive(value) {if (!Number.isSafeInteger(value)||value<1) throw Error('ASSET_OBSERVATION_SCHEMA');}
function missingSource(reason) { return Object.freeze({version:1,status:'NOT_PROVEN',reason}); }
function validateSource(value) {
 // Validate an inert own-data copy; caller-supplied prototype methods never run.
 value=sourceData(value);
 if (value && Object.getOwnPropertyDescriptor(value,'status')?.value==='NOT_PROVEN') {
  exact(value,['version','status','reason']);
  if (value.version!==1 || !['NO_MANAGED_LAUNCH','MANIFEST_UNPUBLISHED','MANIFEST_AUTHORITY_MISSING','ASSET_HISTORY_UNCONFIRMED','SOURCE_NOT_CURRENT','OBSERVATION_UNAVAILABLE'].includes(value.reason)) throw Error('ASSET_OBSERVATION_SCHEMA');
  return;
 }
 const hybrid=value.version===3;
 const darwin=value.version===2 || (hybrid && value.coverage==='darwin-owned-handles');
 exact(value,['version','status','authority','clientId','generation','pid','coverage','assets','dispatch',
   ...(darwin ? ['qualificationScope'] : [])]);
 if (![1,2,3].includes(value.version) || value.status!=='SOURCE_BOUND' || !['COMPILED_ROOT','NON_NATIVE_TEST_ROOT'].includes(value.authority) ||
     !id(value.clientId)||!id(value.generation)||!(darwin ? value.coverage==='darwin-owned-handles' &&
       value.qualificationScope===(hybrid ? 'DARWIN_KERNEL_NO_FORK_RUNTIME_V1' : 'R55_FIRST_PARTY_FIXED_GRAPH')
       : ['windows-tree','leader-only'].includes(value.coverage))) throw Error('ASSET_OBSERVATION_SCHEMA');
 positive(value.pid);
 const roles=['runtime','sttRoot','onnxModel','onnxVoices'];
 if (!Array.isArray(value.assets)||value.assets.length!==4) throw Error('ASSET_OBSERVATION_SCHEMA');
 value.assets.forEach((a,i)=>{
  if (hybrid) {
   exact(a,['role','sourceKind','manifestDigest',...(i===0 ? [] : ['identity']),
     'treeDigest','fileCount','totalBytes',...(i===0 ? [] : ['sourceGeneration'])]);
   if (a.role!==roles[i] || a.sourceKind!==(i===0 ? 'bundled-runtime' : 'raw-model') ||
       ![a.manifestDigest,a.treeDigest].every(hex)) throw Error('ASSET_OBSERVATION_SCHEMA');
   if (i!==0) {
    exact(a.identity,['kind','treeDigest']);
    if (a.identity.kind!=='raw-files' || a.identity.treeDigest!==a.treeDigest || a.manifestDigest!==value.assets[1].manifestDigest ||
        typeof a.sourceGeneration!=='string' || !/^g-[a-f0-9]{64}$/.test(a.sourceGeneration)) throw Error('ASSET_OBSERVATION_SCHEMA');
   }
  } else {
   exact(a,['role','manifestDigest','archiveSha256','treeDigest','fileCount','totalBytes','sourceGeneration']);
   if (a.role!==roles[i] || ![a.manifestDigest,a.archiveSha256,a.treeDigest].every(hex)||
       typeof a.sourceGeneration!=='string'||!/^g-[a-f0-9]{64}$/.test(a.sourceGeneration)) throw Error('ASSET_OBSERVATION_SCHEMA');
  }
  positive(a.fileCount);positive(a.totalBytes);
 });
 if (value.dispatch!==null) {
  exact(value.dispatch,['method','nativeRequestId','intentId']);
  if (!['runtime.health','stt.transcribe','tts.synthesize'].includes(value.dispatch.method)||!id(value.dispatch.nativeRequestId)||
      (value.dispatch.intentId!==null && !id(value.dispatch.intentId))) throw Error('ASSET_OBSERVATION_SCHEMA');
 }
}
function validateCommand(value, launchNonce) {
 exact(value,['version','phase','launchNonce','challenge']);
 if (value.version!==1||value.phase!==PHASE||value.launchNonce!==launchNonce||!hex(value.challenge)) throw Error('ASSET_OBSERVATION_COMMAND');
}
function sign(value,secret) {
 const payload=['version','type','phase','launchNonce','mainPid','webContentsId','challenge','seq','issuedAt','observation'].map(k=>value[k]);
 return createHmac('sha256',secret).update(TYPE+'\0'+JSON.stringify(payload)).digest('hex');
}
function createAssetSourceAuthority({launchNonce,mainPid,observe},secret) {
 let seq=0; const challenges=new Set();
 return (command,webContentsId) => {
  command=sourceData(command);validateCommand(command,launchNonce);positive(mainPid);positive(webContentsId);
  if (challenges.has(command.challenge)||challenges.size>=256) throw Error('ASSET_OBSERVATION_REPLAY');
  const observation=sourceData(observe());validateSource(observation);
  challenges.add(command.challenge);
  const value={version:1,type:TYPE,phase:PHASE,launchNonce,mainPid,webContentsId,
    challenge:command.challenge,seq:++seq,issuedAt:Date.now(),observation};
  return Object.freeze({...value,signature:sign(value,secret)});
 };
}
function createAssetSourceConsumer(expected,secret,{testOnlyDeadline}={}) {
 for (const key of ['launchNonce','mainPid','webContentsId']) {
  if (!expected || !Object.hasOwn(Object.getOwnPropertyDescriptor(expected,key)||{},'value')) throw Error('ASSET_OBSERVATION_IDENTITY');
 }
 if (typeof expected.launchNonce!=='string' || !expected.launchNonce || expected.launchNonce.length>128) throw Error('ASSET_OBSERVATION_IDENTITY');
 positive(expected.mainPid);positive(expected.webContentsId);
 const binding=Object.freeze({launchNonce:expected.launchNonce,mainPid:expected.mainPid,webContentsId:expected.webContentsId});
 // A reader owns its bound even for a transport other than CDP. Never lengthen
 // CDP's existing 15s authority; the test-only scheduler controls no source trust.
 const clock=testOnlyDeadline || {setTimeout,clearTimeout};
 let seq=0, pending=false, disposed=false, cancelPending=null;
 return Object.freeze({dispose() {
  disposed=true;cancelPending?.(Error('ASSET_OBSERVER_RETIRED'));
 },async read(query) {
  if (disposed) throw Error('ASSET_OBSERVER_RETIRED');
  if (pending) throw Error('ASSET_OBSERVATION_PENDING');
  pending=true;
  let timer;
  try {
   const command={version:1,phase:PHASE,launchNonce:binding.launchNonce,challenge:randomBytes(32).toString('hex')};
   const deadline=new Promise((_,reject)=>{
    cancelPending=reject;
    timer=clock.setTimeout(()=>reject(Error('ASSET_OBSERVATION_TIMEOUT')),15000);
   });
   // The late transport has no continuation which can validate or update seq.
   const value=sourceData(await Promise.race([Promise.resolve().then(()=>query(command)),deadline]));
   if (disposed) throw Error('ASSET_OBSERVER_RETIRED');
   exact(value,['version','type','phase','launchNonce','mainPid','webContentsId','challenge','seq','issuedAt','observation','signature']);
   if (value.version!==1||value.type!==TYPE||value.phase!==PHASE||value.launchNonce!==binding.launchNonce||
       value.mainPid!==binding.mainPid||value.webContentsId!==binding.webContentsId||value.challenge!==command.challenge||
       !Number.isSafeInteger(value.seq)||value.seq<=seq||!Number.isSafeInteger(value.issuedAt)||
       Math.abs(Date.now()-value.issuedAt)>10000||!hex(value.signature)) throw Error('ASSET_OBSERVATION_AUTHORITY');
   validateSource(value.observation);
   if (!timingSafeEqual(Buffer.from(value.signature,'hex'),Buffer.from(sign(value,secret),'hex'))) throw Error('ASSET_OBSERVATION_SIGNATURE');
   seq=value.seq;
   // Authenticate and expose the SAME inert snapshot. No second serialization
   // of transport-owned data can substitute a different observation after auth.
   const observation=freeze(value.observation);
   authenticated.set(observation,binding);return observation;
  } finally {clock.clearTimeout(timer);cancelPending=null;pending=false;}
 }});
}
module.exports={createAssetSourceAuthority,createAssetSourceConsumer,missingSource,validateSource,authenticatedSource};
