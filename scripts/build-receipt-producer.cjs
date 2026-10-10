'use strict';
// Receipt is OUTSIDE the app/ASAR. A fresh in-process build stage, not a supplied
// SHA or an after-the-fact hash command, authorizes its creation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const stages=new WeakMap();
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=value=>JSON.stringify(value);
function fail(code){throw Error(code);}
function allowedDarwinAlias(at){
 if(process.platform!=='darwin'||!['/var','/tmp','/etc','/dev'].includes(at))return false;
 try{return fs.realpathSync(at)===`/private${at}`;}catch{return false;}
}
function safePath(p){
 const resolved=path.resolve(p),listed=fs.lstatSync(resolved);
 // A caller-supplied root or final path component may never be a symlink.
 if(listed.isSymbolicLink())fail('BUILD_PATH_UNSAFE');
 let at=resolved;
 while(at!==path.dirname(at)){
  const st=fs.lstatSync(at);
  if(st.isSymbolicLink()&&!allowedDarwinAlias(at))fail('BUILD_PATH_UNSAFE');
  at=path.dirname(at);
 }
 // macOS exposes /var (and related system locations) as aliases to /private.
 // Preserve the caller's path for Git and package fixtures after checking the
 // alias itself; unknown symlink components remain rejected above.
 return resolved;
}
function fileSnapshot(p,{includeBlob=true}={}){
 safePath(p);const st=fs.lstatSync(p);if(!st.isFile()||st.nlink!==1||(st.mode&0o022))fail('BUILD_FILE_MODE_UNSAFE');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=crypto.createHash('sha256'),chunk=Buffer.alloc(65536),blocks=includeBlob?[]:null;let bytes=0;
 try{let n;while((n=fs.readSync(fd,chunk,0,chunk.length,null))>0){bytes+=n;if(bytes>st.size)fail('BUILD_FILE_CHANGED');const part=Buffer.from(chunk.subarray(0,n));if(blocks)blocks.push(part);hash.update(part);}
 const end=fs.fstatSync(fd);if(st.dev!==end.dev||st.ino!==end.ino||st.nlink!==end.nlink||st.size!==end.size||st.mtimeMs!==end.mtimeMs||st.ctimeMs!==end.ctimeMs||st.mode!==end.mode)fail('BUILD_FILE_CHANGED');
 }finally{fs.closeSync(fd);}
 const result={receipt:{bytes,sha256:hash.digest('hex'),mode:st.mode&0o777}};
 if(blocks){const blobHash=crypto.createHash('sha1').update(`blob ${bytes}\0`);for(const block of blocks)blobHash.update(block);result.blobSha1=blobHash.digest('hex');}
 return result;
}
function fileReceipt(p){return fileSnapshot(p,{includeBlob:false}).receipt;}
function frameworkLink(root,p,relative){
 const match=/^(Contents\/Frameworks\/[^/]+\.framework)\/(.+)$/.exec(relative);
 if(!match)fail('BUILD_PATH_UNSAFE');
 const boundary=path.join(root,match[1]),seen=new Set();safePath(boundary);
 let pending=path.relative(boundary,p).split(path.sep),at=boundary;
 while(pending.length){
  const name=pending.shift();if(!name||name==='.')continue;
  if(name==='..'){if(at===boundary)fail('BUILD_PATH_UNSAFE');at=path.dirname(at);continue;}
  at=path.join(at,name);const st=fs.lstatSync(at);
  if(st.isSymbolicLink()){
   if(seen.has(at)||seen.size>=40)fail('BUILD_PATH_UNSAFE');seen.add(at);
   const target=fs.readlinkSync(at);if(!target||path.isAbsolute(target)||target.includes('\\'))fail('BUILD_PATH_UNSAFE');
   at=path.dirname(at);pending=[...target.split('/'),...pending];
  }else if(st.isDirectory()){if(st.mode&0o022)fail('BUILD_FILE_MODE_UNSAFE');}
  else if(!st.isFile()||st.nlink!==1||pending.length||st.mode&0o022)fail('BUILD_PATH_UNSAFE');
 }
 if(at===boundary||!at.startsWith(boundary+path.sep))fail('BUILD_PATH_UNSAFE');
 let real, resolvedAt;try{real=fs.realpathSync(p);resolvedAt=fs.realpathSync(at);}catch{fail('BUILD_PATH_UNSAFE');}
 if(real!==resolvedAt)fail('BUILD_PATH_UNSAFE');
 const link=fs.readlinkSync(p);return {link,bytes:Buffer.byteLength(link),sha256:sha256(link),mode:fs.lstatSync(p).mode&0o777};
}
function inventory(root,{frameworks=false}={}){
 safePath(root);const result={};
 function walk(dir){for(const name of fs.readdirSync(dir).sort()){
  const p=path.join(dir,name),relative=path.relative(root,p).split(path.sep).join('/'),st=fs.lstatSync(p);
  if(st.isSymbolicLink()){
   if(!frameworks)fail('BUILD_PATH_UNSAFE');
   try{result[relative]=frameworkLink(root,p,relative);}catch(error){if(error.message.startsWith('BUILD_'))throw error;fail('BUILD_PATH_UNSAFE');}
  }else if(st.isDirectory()){if(st.mode&0o022)fail('BUILD_FILE_MODE_UNSAFE');walk(p);}
  else result[relative]=fileReceipt(p);
 }}walk(root);return result;
}
function git(root,args){return execFileSync('git',['-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},maxBuffer:16*1024*1024});}
function captureSource(root){
 safePath(root);const buildSha=git(root,['rev-parse','HEAD']).trim();if(!/^[a-f0-9]{40}$/.test(buildSha))fail('BUILD_SOURCE_INVALID');
 const tree=git(root,['ls-tree','-r','-z','HEAD']).split('\0').filter(Boolean),source={};
 for(const entry of tree){const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);if(!match)fail('BUILD_SOURCE_TYPE');
  const [,mode,oid,name]=match;if(path.isAbsolute(name)||name.split('/').includes('..'))fail('BUILD_PATH_UNSAFE');
  const p=path.join(root,name),snapshot=fileSnapshot(p),r=snapshot.receipt;
  if(snapshot.blobSha1!==oid||Boolean(r.mode&0o111)!==(mode==='100755'))fail('BUILD_SOURCE_DIRTY');source[name]=r;
 }
 // This inventory deliberately does not honor global Git excludes/info/exclude.
 const outputs=['.git','node_modules','dist','build/foundation-models','build/r22-provenance','apps/web/vendor','apps/web/icons','apps/web/voices'];
 function unknown(dir,rel=''){for(const name of fs.readdirSync(dir)){
  const n=rel?rel+'/'+name:name;if(outputs.includes(n))continue;const p=path.join(dir,name),st=fs.lstatSync(p);
  if(st.isDirectory())unknown(p,n);else if(!Object.hasOwn(source,n))fail('BUILD_SOURCE_UNKNOWN');
 }}unknown(root);
 if(git(root,['rev-parse','HEAD']).trim()!==buildSha)fail('BUILD_SOURCE_CHANGED');
 if(git(root,['diff','--name-only','HEAD']).trim())fail('BUILD_SOURCE_DIRTY');
 if(git(root,['diff','--cached','--name-only','HEAD']).trim())fail('BUILD_SOURCE_INDEX_DIRTY');
 return {buildSha,source,sourceDigest:sha256(canonical(source))};
}
function beginBuild({root=path.resolve(__dirname,'..'),packagedAppPath=path.join(root,'dist/mac-arm64/Voice Practice.app'),evidenceTier='NATIVE_BUILD'}={}){
 if(!['NATIVE_BUILD','NON_NATIVE'].includes(evidenceTier)||(evidenceTier==='NATIVE_BUILD'&&process.platform!=='darwin'))fail('BUILD_PLATFORM_REQUIRED');
 root=safePath(root);packagedAppPath=path.resolve(packagedAppPath);
 if(fs.existsSync(packagedAppPath)||fs.existsSync(packagedAppPath+'.build-receipt.json')||fs.existsSync(path.join(root,'build/r22-provenance'))||fs.existsSync(path.join(root,'build/foundation-models/arm64')))fail('BUILD_FRESH_OUTPUT_REQUIRED');
 const source=captureSource(root),token=Object.freeze({});
 const state={root,packagedAppPath,evidenceTier,...source,buildNonce:crypto.randomBytes(32).toString('hex'),inputs:null};stages.set(token,state);return token;
}
function stateFor(stage){const state=stage&&stages.get(stage);if(!state)fail('BUILD_STAGE_REQUIRED');return state;}
function unchanged(state){if(canonical(captureSource(state.root))!==canonical({buildSha:state.buildSha,source:state.source,sourceDigest:state.sourceDigest}))fail('BUILD_SOURCE_CHANGED');}
function rawInputs(root){
 const inputs={};for(const dir of ['apps/desktop','apps/web','resources','node_modules/pend','node_modules/yauzl']){
  for(const [n,r] of Object.entries(inventory(path.join(root,dir))))inputs[dir+'/'+n]=r;
 }
 inputs['package.json']=fileReceipt(path.join(root,'package.json'));return inputs;
}
function captureBuildInputs(stage,context){
 const s=stateFor(stage);unchanged(s);if(s.inputs||s.capturing)fail('BUILD_STAGE_ALREADY_CAPTURED');
 if(!context&&s.evidenceTier!=='NON_NATIVE')fail('BUILD_PACKAGER_CONTEXT_REQUIRED');
 s.capturing=true;s.rawInputs=rawInputs(s.root);
 const finish=inputs=>{
  unchanged(s);if(canonical(rawInputs(s.root))!==canonical(s.rawInputs))fail('BUILD_INPUTS_CHANGED');
  s.inputs=inputs;
 const helperRoot=path.join(s.root,'build/foundation-models/arm64');
 const compile=readJson(path.join(helperRoot,'build.private.json'));
 const binary=fileReceipt(path.join(helperRoot,'voice-foundation-models'));
 if(compile.status!=='PASS'||compile.source?.sha256!==s.source['native/apple/FoundationModelsHelper.swift']?.sha256||compile.binary?.sha256!==binary.sha256||compile.binary?.bytes!==binary.bytes)fail('BUILD_HELPER_SOURCE_MISMATCH');
 s.helperBuild={binary,compileReceipt:fileReceipt(path.join(helperRoot,'build.private.json'))};
 const marker={version:2,buildSha:s.buildSha,sourceDigest:s.sourceDigest,buildNonce:s.buildNonce,evidenceTier:s.evidenceTier};
 const markerDir=path.join(s.root,'build/r22-provenance');fs.mkdirSync(markerDir,{recursive:true,mode:0o700});safePath(markerDir);
 fs.writeFileSync(path.join(markerDir,'build-source.json'),canonical(marker)+'\n',{flag:'wx',mode:0o600});s.capturing=false;return marker;
 };
 if(!context)return finish(s.rawInputs); // Explicit legacy NON_NATIVE parser controls only.
 return require('./build-packaged-inputs.cjs').packagedInputReceipts(s.root,context,s.rawInputs,fileReceipt,sha256).then(finish);
}
function readJson(p){const r=fileReceipt(p);if(r.bytes>8*1024*1024)fail('BUILD_RECEIPT_INVALID');
 try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{fail('BUILD_RECEIPT_INVALID');}}
function verifyAsar(p,expected){
 fileReceipt(p);const fd=fs.openSync(p,'r');
 try{
  const prefix=Buffer.alloc(16);if(fs.readSync(fd,prefix,0,16,0)!==16)fail('BUILD_ASAR_INVALID');
  const headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
  if(prefix.readUInt32LE(0)!==4||headerSize>8*1024*1024||jsonSize>headerSize-8)fail('BUILD_ASAR_INVALID');
  const buf=Buffer.alloc(jsonSize);if(fs.readSync(fd,buf,0,jsonSize,16)!==jsonSize)fail('BUILD_ASAR_INVALID');
  let header;try{header=JSON.parse(buf.toString());}catch{fail('BUILD_ASAR_INVALID');}
  const seen=new Set(),total=fs.fstatSync(fd).size,chunk=Buffer.alloc(65536);
  function walk(files,base=''){if(!files||typeof files!=='object')fail('BUILD_ASAR_INVALID');for(const [name,entry] of Object.entries(files)){
   if(!name||name==='.'||name==='..'||/[\\/]/.test(name))fail('BUILD_ASAR_INVALID');const n=base+name;
   if(entry.files){walk(entry.files,n+'/');continue;}
   if(entry.link||entry.unpacked||!expected[n]||expected[n].link)fail('BUILD_ASAR_SOURCE_MISMATCH');
   const offset=Number(entry.offset),size=entry.size,start=8+headerSize+offset;
   if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(size)||size<0||start+size>total)fail('BUILD_ASAR_INVALID');
   const hash=crypto.createHash('sha256');let left=size,position=start;
   while(left){const got=fs.readSync(fd,chunk,0,Math.min(chunk.length,left),position);if(!got)fail('BUILD_ASAR_INVALID');hash.update(chunk.subarray(0,got));position+=got;left-=got;}
   if(size!==expected[n].bytes||hash.digest('hex')!==expected[n].sha256||Boolean(entry.executable)!==Boolean(expected[n].mode&0o111))fail('BUILD_ASAR_SOURCE_MISMATCH');seen.add(n);
  }}walk(header.files);
  if(seen.size!==Object.keys(expected).length)fail('BUILD_ASAR_SOURCE_MISMATCH');
 }finally{fs.closeSync(fd);}
}
function verifyPackaged(s){
 const resources=path.join(s.packagedAppPath,'Contents/Resources');
 const marker=readJson(path.join(resources,'build-source.json'));
 if(canonical(marker)!==canonical({version:2,buildSha:s.buildSha,sourceDigest:s.sourceDigest,buildNonce:s.buildNonce,evidenceTier:s.evidenceTier}))fail('BUILD_STAGE_MISMATCH');
 verifyAsar(path.join(resources,'app.asar'),s.inputs);
 const helper=fileReceipt(path.join(resources,'foundation-models/voice-foundation-models'));
 const manifest=readJson(path.join(resources,'foundation-models/manifest.json'));
 if(canonical(helper)!==canonical(s.helperBuild?.binary)||manifest.sha256!==helper.sha256||manifest.sourceSha256!==s.source['native/apple/FoundationModelsHelper.swift']?.sha256)fail('BUILD_HELPER_SOURCE_MISMATCH');
 return inventory(s.packagedAppPath,{frameworks:true});
}
function verifyManifestSourceBinding(s,artifacts){
 const captured=Object.hasOwn(s,'rawInputs')?s.rawInputs:s.source;
 for(const [source,relative] of [
  ['resources/runtime-manifest.json','Contents/Resources/manifests/runtime-manifest.json'],
  ['resources/model-manifest.json','Contents/Resources/manifests/model-manifest.json']
 ]){
  const expected=captured?.[source],actual=artifacts?.[relative];
  // inventory() admits only regular, single-link files here. Compare content
  // identity while allowing the packager to normalize non-executable modes.
  if(!expected||expected.link||!actual||actual.link||actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)fail('BUILD_MANIFEST_SOURCE_MISMATCH');
 }
}
function generateBuildReceipt({stage}={}){
 const s=stateFor(stage);if(!s.inputs||s.capturing)fail('BUILD_INPUTS_REQUIRED');unchanged(s);
 if(canonical(rawInputs(s.root))!==canonical(s.rawInputs))fail('BUILD_INPUTS_CHANGED');
 const artifacts=verifyPackaged(s);verifyManifestSourceBinding(s,artifacts);
 const receipt={version:2,evidenceTier:s.evidenceTier,buildSha:s.buildSha,sourceDigest:s.sourceDigest,buildNonce:s.buildNonce,source:s.source,inputs:s.inputs,helperBuild:s.helperBuild,artifacts};
 const receiptFile=s.packagedAppPath+'.build-receipt.json';fs.writeFileSync(receiptFile,canonical(receipt)+'\n',{flag:'wx',mode:0o600});stages.delete(stage);return {receipt,receiptFile};
}
function readBuildReceipt({root=path.resolve(__dirname,'..'),packagedAppPath=path.join(root,'dist/mac-arm64/Voice Practice.app'),codeTestedSha,evidenceTier='NATIVE_BUILD',expectedReceiptSha256}={}){
 const receiptFile=packagedAppPath+'.build-receipt.json';if(!fs.existsSync(receiptFile))fail('BUILD_RECEIPT_REQUIRED');
 const receiptHash=fileReceipt(receiptFile).sha256;
 if(!expectedReceiptSha256||receiptHash!==expectedReceiptSha256)fail('BUILD_RECEIPT_UNBOUND');
 const r=readJson(receiptFile);
 const keys=['version','evidenceTier','buildSha','sourceDigest','buildNonce','source','inputs','helperBuild','artifacts'];
 if(!r||Object.keys(r).sort().join(',')!==keys.sort().join(',')||r.version!==2||!r.inputs||!r.artifacts||!/^[a-f0-9]{64}$/.test(r.buildNonce||''))fail('BUILD_RECEIPT_INVALID');
 if(r.evidenceTier!==evidenceTier||!['NATIVE_BUILD','NON_NATIVE'].includes(evidenceTier))fail('BUILD_EVIDENCE_TIER_MISMATCH');
 const source=captureSource(root);
 if(r.buildSha!==codeTestedSha||r.buildSha!==source.buildSha||r.sourceDigest!==source.sourceDigest||canonical(r.source)!==canonical(source.source))fail('BUILD_RECEIPT_SOURCE_MISMATCH');
 const artifacts=verifyPackaged({...r,root,packagedAppPath});
 if(canonical(artifacts)!==canonical(r.artifacts))fail('BUILD_ARTIFACT_MISMATCH');
 verifyManifestSourceBinding(r,artifacts);
 const base='Contents/Resources/';return {receipt:r,receiptFile,receiptHash,buildSha:r.buildSha,
  appBinaryReceipt:artifacts['Contents/MacOS/Voice Practice'],asarReceipt:artifacts[base+'app.asar'],helperReceipt:artifacts[base+'foundation-models/voice-foundation-models']};
}
module.exports={beginBuild,captureBuildInputs,generateBuildReceipt,readBuildReceipt,captureSource,fileReceipt,fileSnapshot,sha256};
if(require.main===module){console.error('BUILD_STAGE_REQUIRED: use npm run pack:mac; historical app rehash is forbidden');process.exitCode=1;}
