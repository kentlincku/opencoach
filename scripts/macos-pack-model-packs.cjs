#!/usr/bin/env node
'use strict';
// Local private macOS runtime-only packaging. NOT release/source admission.
const path = require('node:path');
const {canonicalInventory} = require('../apps/desktop/tree-integrity.cjs');
const {loadTrust, authenticateInventory} = require('../apps/desktop/bundled-voice-assets.cjs');
const {manifestDigest} = require('../apps/desktop/asset-manifest-trust.cjs');
const {parseMacosModelCatalog} = require('../apps/desktop/macos-model-catalog.cjs');
const ROOT = path.resolve(__dirname, '..');

function deriveStageMetadata(catalog, files) {
  if (!catalog || catalog.schemaVersion !== 1
      || !['capabilities,modelBindings,modelManifest,schemaVersion', 'capabilities,modelBindings,modelManifest,schemaVersion,sttChoices'].includes(Object.keys(catalog).sort().join())) {
    throw Error('MODEL_PACK_CATALOG_SCHEMA');
  }
  const whole = canonicalInventory(files);
  const runtime = canonicalInventory(files.filter(f => f.path.startsWith('runtime/'))
    .map(f => ({...f, path:f.path.slice('runtime/'.length)})));
  const trust = loadTrust({schemaVersion:2, mode:'runtime-only', treeDigest:whole.treeDigest,
    runtimeTreeDigest:runtime.treeDigest, fileCount:whole.fileCount, entrypoint:'runtime/bin/voice-runtime',
    runtimeProfile:'macos-mlx-kokoro-v1', modelManifestDigest:manifestDigest(catalog.modelManifest),
    capabilitiesDigest:manifestDigest(catalog.capabilities), modelBindings:catalog.modelBindings,
    ...(catalog.sttChoices ? {sttChoices:catalog.sttChoices} : {})}, 'darwin');
  authenticateInventory({files}, trust);
  parseMacosModelCatalog(catalog.capabilities, trust, catalog.modelManifest);
  return {trust, modelManifest:catalog.modelManifest, capabilities:catalog.capabilities};
}

function compiledTrustBytes(trust) {
  return Buffer.from("'use strict';\n// Generated local runtime-only trust; not a release admission.\n"
    + 'module.exports = Object.freeze(' + JSON.stringify(trust, null, 2) + ');\n');
}

const fs = require('node:fs');
const crypto = require('node:crypto');
const {execFileSync,spawnSync} = require('node:child_process');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const TRUST_REL = 'apps/desktop/bundled-voice-trust.cjs';
// Provenance only: never grant these link descriptors payload authority.
const SOURCE_LINKS = Object.freeze(['.venv','apps/ios/Sources/VoicePracticeCore/ScriptBridgeHandler.swift']);

function safePath(value) {
  // Reject noncanonical tokens; never normalize away their lexical evidence.
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.split(path.sep).includes('..')
      || value !== path.resolve(value)) throw Error('MODEL_PACK_UNSAFE_PATH');
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('MODEL_PACK_UNSAFE_LINK');
    // existsSync is false for dangling links.
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('MODEL_PACK_UNSAFE_LINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return value;
}

function readFile(file, max = 64 * 1024 ** 2) {
  safePath(file);
  const listed = fs.lstatSync(file);
  if (!listed.isFile() || listed.nlink !== 1 || listed.size > max) throw Error('MODEL_PACK_UNSAFE_FILE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== listed.ino || opened.dev !== listed.dev || opened.size !== listed.size || opened.nlink !== 1) throw Error('MODEL_PACK_FILE_CHANGED');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1 || fs.lstatSync(file).ino !== opened.ino) throw Error('MODEL_PACK_FILE_CHANGED');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function git(root, args) {
  return execFileSync('git', args, {cwd:root, encoding:'utf8', maxBuffer:32 * 1024 ** 2,
    env:{...process.env, GIT_OPTIONAL_LOCKS:'0'}, timeout:30000});
}

const temporarySources = new WeakMap();
function sourceLinkBytes(file) {
  // Only the literal policy leaves reach here. Lstat ancestors root-first; the
  // exception must not let safePath/readFile/fingerprint follow a payload link.
  const parents = [];
  for (let current = path.dirname(file);;) {
    parents.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const ancestors = parents.map(parent => {
    const stat = fs.lstatSync(parent,{bigint:true});
    if (!stat.isDirectory()) throw Error('MODEL_PACK_SOURCE_LINK_ANCESTOR');
    return stat;
  });
  const assertAncestors = () => parents.forEach((parent,index) => {
    const stat = fs.lstatSync(parent,{bigint:true}), before = ancestors[index];
    if (!stat.isDirectory() || stat.dev !== before.dev || stat.ino !== before.ino || stat.mode !== before.mode) {
      throw Error('MODEL_PACK_SOURCE_LINK_ANCESTOR_CHANGED');
    }
  });
  const listed = fs.lstatSync(file,{bigint:true});
  assertAncestors();
  if (!listed.isSymbolicLink() || listed.nlink !== 1n) throw Error('MODEL_PACK_SOURCE_LINK_TYPE');
  // readlink returns raw text, never target contents (including dangling links).
  const bytes = fs.readlinkSync(file,{encoding:'buffer'});
  assertAncestors();
  const after = fs.lstatSync(file,{bigint:true});
  assertAncestors();
  if (!after.isSymbolicLink() || BigInt(bytes.length) !== listed.size
      || ['dev','ino','nlink','mode','size','mtimeNs','ctimeNs'].some(key => after[key] !== listed[key])) {
    throw Error('MODEL_PACK_SOURCE_LINK_CHANGED');
  }
  return bytes;
}

function sourceSnapshot(root, token = null) {
  root = safePath(root);
  const temporary = token && temporarySources.get(token);
  if (token && (!temporary || temporary.root !== root)) throw Error('MODEL_PACK_SOURCE_TOKEN');
  // win32 only: Git prints D:/x for D:\\x and NTFS is case-insensitive. Exact match, never prefix.
  const windows = process.platform === 'win32';
  const top = git(root, ['rev-parse','--show-toplevel']).trim();
  if (windows ? path.resolve(top).toLowerCase() !== root.toLowerCase() : top !== root) throw Error('MODEL_PACK_SOURCE_ROOT');
  const config = key => spawnSync('git',['config','--get',key],{cwd:root,encoding:'utf8',timeout:30000,
    env:{...process.env, GIT_OPTIONAL_LOCKS:'0'}}).stdout.trim().toLowerCase();
  // Blobs must equal disk bytes; refuse CRLF checkout conversion up front instead of a late BYTES error.
  if (windows && config('core.autocrlf') !== 'false') throw Error('MODEL_PACK_SOURCE_AUTOCRLF');
  // No POSIX exec bit on NTFS: Git HEAD mode is authoritative (still recorded); blobs still compared.
  const ignoreExecBit = windows && config('core.filemode') === 'false';
  // core.symlinks=false checks out the two policy links as regular files holding the link text.
  const plainLinks = windows && config('core.symlinks') === 'false';
  const dirty = git(root, ['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none']);
  if (temporary ? dirty !== ' M '+TRUST_REL+'\0' : Boolean(dirty)) throw Error('MODEL_PACK_SOURCE_DIRTY:' + dirty.replaceAll('\0','|'));
  const flags = git(root, ['ls-files','-v','-z']).split('\0').filter(Boolean);
  if (flags.some(line => !line.startsWith('H '))) throw Error('MODEL_PACK_SOURCE_INDEX_FLAGS');
  if (git(root, ['rev-parse','--show-object-format']).trim() !== 'sha1') throw Error('MODEL_PACK_SOURCE_FORMAT');
  const commit = git(root, ['rev-parse','HEAD']).trim();
  const gitTree = git(root, ['rev-parse','HEAD^{tree}']).trim();
  const files = git(root, ['ls-tree','-r','-z','--full-tree','HEAD']).split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) throw Error('MODEL_PACK_SOURCE_TYPE');
    const [,mode,blob,relative] = match;
    const link = mode === '120000';
    if (link && !SOURCE_LINKS.includes(relative)) throw Error('MODEL_PACK_SOURCE_TYPE');
    const file = path.join(root, relative);
    // readFile is lstat/no-follow and nlink=1; a real link here is refused, never followed.
    let bytes = link ? (plainLinks ? readFile(file, 4096) : sourceLinkBytes(file)) : readFile(file);
    if (temporary && relative === TRUST_REL) {
      if (!bytes.equals(temporary.generated)) throw Error('MODEL_PACK_SOURCE_BYTES:' + relative);
      bytes = temporary.original;
    }
    const objectId = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (objectId !== blob || (!link && !ignoreExecBit && Boolean(fs.statSync(file).mode & 0o111) !== (mode === '100755'))) throw Error('MODEL_PACK_SOURCE_BYTES:' + relative);
    return {path:relative, mode, blob, bytes:bytes.length, sha256:sha256(bytes)};
  });
  return {commit, gitTree, treeSha256:manifestDigest(files), files};
}

function verifyStage(stageRoot, expectedReceiptSha256, source) {
  safePath(stageRoot);
  if (!/^[a-f0-9]{64}$/.test(expectedReceiptSha256)) throw Error('MODEL_PACK_STAGE_RECEIPT_HASH');
  const receiptBytes = readFile(path.join(stageRoot,'receipt.json'),4 * 1024 ** 2);
  if (sha256(receiptBytes) !== expectedReceiptSha256) throw Error('MODEL_PACK_STAGE_RECEIPT_HASH');
  const receipt = JSON.parse(receiptBytes);
  if (receipt.schemaVersion !== 1 || receipt.class !== 'MACOS_RUNTIME_ONLY_LOCAL_NOT_RELEASE'
      || receipt.operation !== 'STAGE' || receipt.status !== 'PASS' || receipt.appAcceptance !== 'NOT_RUN') throw Error('MODEL_PACK_STAGE_RECEIPT_SCHEMA');
  if (!source || ['commit','gitTree','treeSha256'].some(key => receipt.source?.[key] !== source[key])
      || receipt.runtimeInput?.commit !== source.commit) throw Error('MODEL_PACK_SOURCE_MISMATCH');
  const {validateInventory,verifyInventorySync} = require('../apps/desktop/tree-integrity.cjs');
  const staged = validateInventory(receipt.files,receipt.stageTreeDigest);
  if (staged.files.some(f => f.path === 'receipt.json')) throw Error('MODEL_PACK_STAGE_RECEIPT_SCHEMA');
  const all = canonicalInventory([...staged.files,{path:'receipt.json',bytes:receiptBytes.length,sha256:expectedReceiptSha256}]);
  verifyInventorySync(stageRoot,all); // Also rejects extra files/directories/links.
  const privatePaths = new Set([stageRoot]);
  for (const file of all.files) {
    let full = path.join(stageRoot,file.path);
    while (full !== stageRoot) {
      const relative = path.relative(stageRoot,full), parent = path.dirname(full);
      if (!relative || relative === '..' || relative.startsWith('..'+path.sep)
          || path.isAbsolute(relative) || parent === full) throw Error('MODEL_PACK_STAGE_PATH_ESCAPE');
      privatePaths.add(full);
      full = parent;
    }
  }
  for (const full of privatePaths) if (fs.lstatSync(full).mode & 0o077) throw Error('MODEL_PACK_STAGE_NOT_PRIVATE');
  const json = relative => JSON.parse(readFile(path.join(stageRoot,relative),4 * 1024 ** 2));
  if (manifestDigest(json('source.json')) !== manifestDigest(source)) throw Error('MODEL_PACK_SOURCE_MISMATCH');
  for (const [key,relative] of Object.entries({catalog:'resources/macos-model-packs.json',entitlements:'build/entitlements.runtime.plist'})) {
    const current = sha256(readFile(path.join(ROOT,relative)));
    if (receipt.inputs?.[key]?.path !== relative || receipt.inputs[key].sha256 !== current
        || source.files.find(f => f.path === relative)?.sha256 !== current) throw Error('MODEL_PACK_SOURCE_INPUT_MISMATCH');
  }
  const trust = loadTrust(json('trust.json'),'darwin');
  if (trust?.schemaVersion !== 2 || trust.mode !== 'runtime-only') throw Error('MODEL_PACK_RUNTIME_ONLY_REQUIRED');
  const trustBytes = readFile(path.join(stageRoot,'bundled-voice-trust.cjs'));
  if (!trustBytes.equals(compiledTrustBytes(trust))) throw Error('MODEL_PACK_COMPILED_TRUST_MISMATCH');
  const inv = json('resources/voice-assets-inventory.json');
  verifyInventorySync(path.join(stageRoot,'resources/voice-assets'),authenticateInventory(inv,trust).whole);
  const metadata = deriveStageMetadata(JSON.parse(readFile(path.join(ROOT,'resources/macos-model-packs.json'))),inv.files);
  if (manifestDigest(trust) !== manifestDigest(metadata.trust)
      || manifestDigest(json('resources/manifests/model-manifest.json')) !== trust.modelManifestDigest
      || manifestDigest(json('resources/manifests/speech-model-capabilities.json')) !== trust.capabilitiesDigest
      || receipt.treeDigest !== trust.treeDigest || receipt.runtimeTreeDigest !== trust.runtimeTreeDigest
      || receipt.fileCount !== trust.fileCount) throw Error('MODEL_PACK_STAGE_MANIFEST_MISMATCH');
  for (const file of inv.files) {
    const name = path.basename(file.path).toLowerCase();
    if (/\.(onnx|safetensors|gguf|ggml|tflite)$/.test(name) || /^voices(?:-v[0-9.]+)?\.bin$/.test(name)) throw Error('MODEL_PACK_EMBEDDED_SPEECH_MODEL');
  }
  for (const name of fs.readdirSync(path.join(ROOT,'resources')).filter(n => n.endsWith('.json')
    && !['macos-model-packs.json','windows-model-packs.json','model-manifest.json','speech-model-capabilities.json'].includes(n))) {
    const current = readFile(path.join(ROOT,'resources',name));
    if (!readFile(path.join(stageRoot,'resources/manifests',name)).equals(current)
        || source.files.find(f => f.path === 'resources/'+name)?.sha256 !== sha256(current)) throw Error('MODEL_PACK_SOURCE_INPUT_MISMATCH');
  }
  const signing = json('signing.json');
  if (receipt.signing?.status !== 'PASS' || !Array.isArray(receipt.signing.files)
      || !receipt.signing.files.includes(trust.entrypoint) || typeof receipt.signing.identity !== 'string'
      || !receipt.signing.identity.trim() || receipt.signing.identity === '-'
      || (receipt.signing.identity === 'adhoc' && process.env.VOICE_PUBLIC_ADHOC_BUILD !== '1')
      || receipt.signing.entitlementsSha256 !== receipt.inputs.entitlements.sha256
      || Object.keys(receipt.signing).some(key => manifestDigest(receipt.signing[key]) !== manifestDigest(signing[key]))
      || !Array.isArray(signing.commands) || signing.commands.some(command => command.exitCode !== 0)) throw Error('MODEL_PACK_STAGE_SIGNING');
  if (!(fs.statSync(path.join(stageRoot,'resources/voice-assets',trust.entrypoint)).mode & 0o111)) throw Error('MODEL_PACK_ENTRY_NOT_EXECUTABLE');
  return {root:stageRoot, resources:path.join(stageRoot,'resources'), receipt, receiptSha256:expectedReceiptSha256,
    trust, trustBytes, inventory:authenticateInventory(inv,trust).whole};
}

async function withCompiledTrust(root, generated, work) {
  const baseline = sourceSnapshot(root); // ZERO preexisting changes, including trust.
  const file = path.join(root,TRUST_REL), originalStat = fs.lstatSync(file), original = readFile(file);
  if (sha256(original) !== baseline.files.find(entry => entry.path === TRUST_REL)?.sha256) throw Error('MODEL_PACK_SOURCE_BYTES:' + TRUST_REL);
  // This transaction restores ordinary permission bits only; reject special bits before any write.
  if (originalStat.mode & 0o7000) throw Error('MODEL_PACK_TRUST_MODE_UNSUPPORTED');
  if (!Buffer.isBuffer(generated) || !generated.length) throw Error('MODEL_PACK_COMPILED_TRUST_MISSING');
  const compiled = Buffer.from(generated);
  delete require.cache[require.resolve(file)];
  if (require(file) !== null) throw Error('MODEL_PACK_COMMITTED_TRUST_NOT_NULL');
  const token = Object.freeze({});
  const fd = fs.openSync(file,fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  temporarySources.set(token,{root,original,generated:compiled});
  const assertOwned = expected => {
    safePath(file);
    const opened = fs.fstatSync(fd), listed = fs.lstatSync(file);
    const sameIdentity = stat => stat.isFile() && stat.dev === originalStat.dev
      && stat.ino === originalStat.ino && stat.nlink === 1;
    if (![opened,listed].every(sameIdentity)) throw Error('MODEL_PACK_TRUST_IDENTITY_CHANGED');
    if ([opened,listed].some(stat => stat.mode !== originalStat.mode || stat.size !== expected.length)) throw Error('MODEL_PACK_TRUST_OWNERSHIP_CONFLICT');
    // Read the held descriptor at explicit offsets; pathname bytes alone cannot
    // establish ownership after an equal-byte replacement of the original inode.
    const current = Buffer.alloc(expected.length);
    let offset = 0, count;
    while (offset < current.length && (count = fs.readSync(fd,current,offset,current.length-offset,offset))) offset += count;
    const after = fs.fstatSync(fd), relisted = fs.lstatSync(file);
    if (![after,relisted].every(sameIdentity)) throw Error('MODEL_PACK_TRUST_IDENTITY_CHANGED');
    if ([listed,after,relisted].some(stat => stat.mode !== opened.mode || stat.size !== opened.size
        || stat.mtimeMs !== opened.mtimeMs || stat.ctimeMs !== opened.ctimeMs)
        || offset !== expected.length || !current.equals(expected)) throw Error('MODEL_PACK_TRUST_OWNERSHIP_CONFLICT');
  };
  let ownedWriteStarted = false;
  const replace = (expected,bytes) => {
    assertOwned(expected); // Before BOTH the initial write and restoration.
    // A syscall can take effect and then throw. Recovery must not depend on
    // replace returning; it still requires exact compiled ownership below.
    ownedWriteStarted = true;
    fs.ftruncateSync(fd,bytes.length);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);
    fs.fchmodSync(fd,originalStat.mode & 0o777);
    fs.fsyncSync(fd);
    assertOwned(bytes);
    delete require.cache[require.resolve(file)];
  };
  const assertSourceUnchanged = () => {
    assertOwned(compiled);
    if (manifestDigest(sourceSnapshot(root,token)) !== manifestDigest(baseline)) throw Error('MODEL_PACK_SOURCE_MISMATCH');
  };
  try {
    replace(original,compiled);
    assertSourceUnchanged();
    const result = await work({source:baseline,assertSourceUnchanged});
    assertSourceUnchanged();
    return result;
  } finally {
    try {
      // A conflicting writer owns the current state. Leave it and the pack's
      // private original backup intact; never claim a clean restore on conflict.
      if (ownedWriteStarted) replace(compiled,original);
    } finally {
      fs.closeSync(fd);
      temporarySources.delete(token);
      delete require.cache[file];
    }
    if (ownedWriteStarted && manifestDigest(sourceSnapshot(root)) !== manifestDigest(baseline)) throw Error('MODEL_PACK_SOURCE_MISMATCH');
  }
}

function runChecked(command, args, options = {}, journal = []) {
  const result = spawnSync(command,args,{cwd:ROOT,env:process.env,timeout:120000,maxBuffer:16 * 1024 ** 2,...options,
    shell:false,stdio:['ignore','pipe','pipe']});
  const record = {command:[command,...args],cwd:options.cwd || ROOT,exitCode:result.status,signal:result.signal,
    stdout:result.stdout?.toString('utf8') || '',stderr:result.stderr?.toString('utf8') || '',error:result.error?.code || null};
  journal.push(record);
  if (result.status !== 0 || result.signal || result.error) {
    const error = Error('MODEL_PACK_COMMAND_FAILED:' + command);
    error.commands = journal;
    throw error;
  }
  return record;
}

function verifyNativeSignatures(assetRoot, inventory, signing) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('MODEL_PACK_MAC_ARM64_REQUIRED');
  require('../apps/desktop/tree-integrity.cjs').verifyInventorySync(assetRoot,inventory);
  const magics = new Set(['cffaedfe','feedfacf','cefaedfe','feedface','cafebabe','bebafeca','cafebabf','bfbafeca']);
  const files = [];
  for (const file of inventory.files) {
    const fd = fs.openSync(safePath(path.join(assetRoot,file.path)),fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const prefix = Buffer.alloc(4);
      if (fs.readSync(fd,prefix,0,4,0) === 4 && magics.has(prefix.toString('hex'))) files.push(file.path);
    } finally { fs.closeSync(fd); }
  }
  files.sort();
  if (!files.includes('runtime/bin/voice-runtime')) throw Error('MODEL_PACK_MACHO_ENTRY_REQUIRED');
  if (JSON.stringify(files) !== JSON.stringify(signing.files)) throw Error('MODEL_PACK_MACHO_SET_MISMATCH');
  const commands = [];
  for (const file of files) {
    runChecked('/usr/bin/lipo',[path.join(assetRoot,file),'-verify_arch','arm64'],{},commands);
    runChecked('/usr/bin/codesign',['--verify','--strict',path.join(assetRoot,file)],{},commands);
  }
  return {status:'PASS',files,commands};
}

function assertPackagedSourceFiles(config) {
  // Closed payload selection: source-only descriptors cannot be included or
  // renamed through a file mapping. Accept the real loader's normalized form.
  const expected = [{filter:['package.json','apps/desktop/**','apps/web/**','node_modules/pend/**','node_modules/yauzl/**']}];
  const files = Array.isArray(config.files) && config.files.every(file => typeof file === 'string')
    ? [{filter:config.files}] : config.files;
  if (manifestDigest(files) !== manifestDigest(expected) || config.mac?.files != null
      || config.extraFiles != null || config.mac?.extraFiles != null) throw Error('MODEL_PACK_BUILDER_SOURCE_FILES');
}

function packConfiguration(stageRoot, output, dmg = false) {
  safePath(stageRoot); safePath(output);
  if (typeof dmg !== 'boolean') throw Error('MODEL_PACK_TARGET');
  const builder = require('electron-builder'), targets = dmg ? ['dir','dmg'] : ['dir'];
  const base = require('js-yaml').load(readFile(path.join(ROOT,'electron-builder.yml')).toString('utf8'));
  assertPackagedSourceFiles(base);
  const privateBase = path.join(output,'builder-base.json');
  if (readFile(privateBase).toString('utf8') !== '{}\n') throw Error('MODEL_PACK_BUILDER_BASE');
  return {projectDir:ROOT,publish:'never',targets:builder.Platform.MAC.createTarget(targets,builder.Arch.arm64),config:{
    ...base,
    // electron-builder deepAssign CONCATENATES arrays. Load the reviewed YAML
    // once ourselves, explicitly replace resource/target arrays, and make the
    // real Packager loader start from an empty, private, receipted config file.
    // Never inherit a second resources->manifests or legacy model-bundle writer.
    extends:privateBase,
    electronDist:path.join(ROOT,'node_modules/electron/dist'),
    npmRebuild:false,nodeGypRebuild:false,buildDependenciesFromSource:false,forceCodeSigning:false,
    publish:null,asar:true,
    directories:{output:path.join(output,'artifacts'),buildResources:path.join(ROOT,'build')},
    // Replace the global resources mapping; never leave a second, stale model-manifest writer.
    extraResources:[{from:path.join(stageRoot,'resources/manifests'),to:'manifests',filter:['*.json']}],
    mac:{...base.mac,identity:null,notarize:false,signIgnore:['/voice-assets/'],
      target:targets.map(target=>({target,arch:['arm64']})),
      extraResources:[
        {from:path.join(output,'foundation-models'),to:'foundation-models',filter:['voice-foundation-models','manifest.json']},
        {from:path.join(stageRoot,'resources/voice-assets'),to:'voice-assets'},
        {from:path.join(stageRoot,'resources/voice-assets-inventory.json'),to:'voice-assets-inventory.json'},
      ]},
    dmg:{writeUpdateInfo:false,sign:false},
  }};
}

function fingerprint(file) {
  safePath(file);
  const listed = fs.lstatSync(file);
  if (!listed.isFile() || listed.nlink !== 1) throw Error('MODEL_PACK_UNSAFE_FILE');
  const fd = fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== listed.ino || opened.dev !== listed.dev || opened.size !== listed.size || opened.nlink !== 1) throw Error('MODEL_PACK_FILE_CHANGED');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0, count;
    while ((count = fs.readSync(fd,buffer,0,buffer.length,null))) {
      bytes += count;
      if (bytes > 32 * 1024 ** 3) throw Error('MODEL_PACK_TREE_LIMIT');
      hash.update(buffer.subarray(0,count));
    }
    const after = fs.fstatSync(fd);
    if (bytes !== opened.size || after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs || fs.lstatSync(file).ino !== opened.ino) throw Error('MODEL_PACK_FILE_CHANGED');
    return {bytes,sha256:hash.digest('hex')};
  } finally { fs.closeSync(fd); }
}

function artifactSnapshot(root) {
  safePath(root);
  if (!fs.lstatSync(root).isDirectory()) throw Error('MODEL_PACK_TREE_ROOT');
  const files = [];
  function visit(directory,depth) {
    if (depth > 128 || files.length > 200000) throw Error('MODEL_PACK_TREE_LIMIT');
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory,name), stat = fs.lstatSync(full), relative = path.relative(root,full).split(path.sep).join('/');
      const record = {path:relative,mode:stat.mode & 0o777};
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(full), real = fs.realpathSync(full);
        if (path.isAbsolute(target) || (real !== root && !real.startsWith(root+path.sep))) throw Error('MODEL_PACK_TREE_EXTERNAL_LINK');
        files.push({...record,type:'symlink',target});
      } else if (stat.isDirectory()) { files.push({...record,type:'directory'}); visit(full,depth+1); }
      else if (stat.isFile()) files.push({...record,type:'file',...fingerprint(full)});
      else throw Error('MODEL_PACK_TREE_SPECIAL');
    }
  }
  visit(root,0);
  files.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {treeSha256:manifestDigest(files),fileCount:files.filter(f=>f.type==='file').length,files};
}

function assertArtifactPolicy(artifacts, appRelative, inventory, dmg) {
  // Only exact files from the admitted runtime may be internal ZIPs. Compare
  // the final snapshot bytes as well: an earlier payload readback is not enough.
  const runtimeZips = new Map(inventory.files.filter(f=>f.path.startsWith('runtime/') && f.path.endsWith('.zip'))
    .map(f=>[appRelative+'/Contents/Resources/voice-assets/'+f.path,f]));
  const images = artifacts.files.filter(f=>f.type==='file' && f.path.endsWith('.dmg'));
  const unexpectedZip = artifacts.files.some(file=>{
    if (!file.path.endsWith('.zip')) return false;
    const admitted = runtimeZips.get(file.path);
    return file.type !== 'file' || !admitted || file.bytes !== admitted.bytes || file.sha256 !== admitted.sha256;
  });
  if (unexpectedZip || images.length !== (dmg?1:0)) throw Error('MODEL_PACK_UNEXPECTED_ARTIFACTS');
}

function verifyPackagedPayload(appPath, admitted) {
  safePath(appPath);
  const resources = path.join(appPath,'Contents/Resources'), archive = path.join(resources,'app.asar');
  const archiveBefore = fingerprint(archive), asar = require('@electron/asar');
  asar.uncache(archive);
  // Reject descriptor names as files, links, directories or unpacked entries.
  if (asar.listPackage(archive).some(file => SOURCE_LINKS.some(relative =>
    file === '/'+relative || file.startsWith('/'+relative+'/')))) throw Error('MODEL_PACK_PACKAGED_SOURCE_LINK');
  const compiled = asar.statFile(archive,TRUST_REL,false);
  if (compiled.unpacked || compiled.link || !asar.extractFile(archive,TRUST_REL,false).equals(admitted.trustBytes)) throw Error('MODEL_PACK_PACKAGED_COMPILED_TRUST');
  const source = JSON.parse(readFile(path.join(admitted.root,'source.json')));
  const code = source.files.filter(f=>f.path.startsWith('apps/desktop/') || f.path.startsWith('apps/web/'));
  for (const file of code) {
    if (file.path === TRUST_REL) continue;
    const info = asar.statFile(archive,file.path,false);
    if (info.unpacked || info.link || sha256(asar.extractFile(archive,file.path,false)) !== file.sha256) throw Error('MODEL_PACK_PACKAGED_SOURCE_MISMATCH:' + file.path);
  }
  const {verifyInventorySync} = require('../apps/desktop/tree-integrity.cjs');
  verifyInventorySync(path.join(resources,'voice-assets'),admitted.inventory);
  if (!readFile(path.join(resources,'voice-assets-inventory.json')).equals(readFile(path.join(admitted.resources,'voice-assets-inventory.json')))) throw Error('MODEL_PACK_PACKAGED_INVENTORY');
  const prefix = 'resources/manifests/';
  const manifests = canonicalInventory(admitted.receipt.files.filter(f=>f.path.startsWith(prefix)).map(f=>({...f,path:f.path.slice(prefix.length)})));
  verifyInventorySync(path.join(resources,'manifests'),manifests);
  if (fingerprint(archive).sha256 !== archiveBefore.sha256) throw Error('MODEL_PACK_PACKAGED_ASAR_CHANGED');
  return {appPath,asar:archiveBefore,compiledTrustSha256:sha256(admitted.trustBytes),packagedSourceFiles:code.length,
    treeDigest:admitted.trust.treeDigest,runtimeTreeDigest:admitted.trust.runtimeTreeDigest,
    modelManifestDigest:admitted.trust.modelManifestDigest,capabilitiesDigest:admitted.trust.capabilitiesDigest,
    manifestsTreeDigest:manifests.treeDigest,appAcceptance:'NOT_RUN'};
}

function privateJson(file, value) {
  const describeHook = (_key,item) => typeof item === 'function'
    ? {kind:'in-process-hook',sha256:sha256(Buffer.from(item.toString()))} : item;
  fs.writeFileSync(file,JSON.stringify(value,describeHook,2)+'\n',{flag:'wx',mode:0o600});
}

function privateOutput(output, inputs) {
  safePath(output);
  for (const input of inputs) {
    safePath(input);
    if (output === input || output.startsWith(input+path.sep) || input.startsWith(output+path.sep)) throw Error('MODEL_PACK_OUTPUT_OVERLAPS_INPUT');
  }
  // Lexical no-link checks MUST precede physical identity checks. Comparing
  // ancestor dev/ino also catches case aliases without realpath hiding links.
  const ancestry = value => {
    const identities = new Set();
    let current = value, self = null;
    for (;;) {
      let stat;
      try { stat = fs.lstatSync(current,{bigint:true}); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        if (stat.isSymbolicLink()) throw Error('MODEL_PACK_UNSAFE_LINK');
        if (current !== value && !stat.isDirectory()) throw Error('MODEL_PACK_UNSAFE_PATH');
        const identity = `${stat.dev}:${stat.ino}`;
        identities.add(identity);
        if (current === value) self = identity;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return {self,identities};
  };
  const destination = ancestry(output);
  for (const input of inputs) {
    const source = ancestry(input);
    if ((source.self && destination.identities.has(source.self))
        || (destination.self && source.identities.has(destination.self))) throw Error('MODEL_PACK_OUTPUT_OVERLAPS_INPUT');
  }
  if (!fs.statSync(path.dirname(output)).isDirectory()) throw Error('MODEL_PACK_OUTPUT_PARENT_REQUIRED');
  try { fs.mkdirSync(output,{mode:0o700}); }
  catch (error) { if (error.code === 'EEXIST') throw Error('MODEL_PACK_OUTPUT_EXISTS'); throw error; }
  return output;
}

async function pack(options) {
  if (!options || Object.keys(options).some(key=>!['stage','stageReceiptSha256','output','dmg'].includes(key))) throw Error('MODEL_PACK_OPTIONS');
  const {stage:stageRoot,stageReceiptSha256,output,dmg=false} = options;
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('MODEL_PACK_MAC_ARM64_REQUIRED');
  if (typeof dmg !== 'boolean') throw Error('MODEL_PACK_TARGET');
  safePath(stageRoot); safePath(output);
  const source = sourceSnapshot(ROOT);
  const admitted = verifyStage(stageRoot,stageReceiptSha256,source);
  const out = privateOutput(output,[ROOT,stageRoot,admitted.receipt.runtimeInput.buildDirectory,admitted.receipt.acquisition.path]);
  const environment = {CSC_IDENTITY_AUTO_DISCOVERY:'false',ELECTRON_SKIP_BINARY_DOWNLOAD:'1',npm_config_offline:'true'};
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));
  const commands = [];
  try {
    // Existing local distribution only; never enter Electron/npm acquisition.
    const electron = path.join(ROOT,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    const electronInput = fingerprint(electron);
    const dependencies = artifactSnapshot(path.join(ROOT,'node_modules'));
    privateJson(path.join(out,'dependencies.json'),dependencies);
    privateJson(path.join(out,'source.json'),source);
    privateJson(path.join(out,'stage-receipt.json'),admitted.receipt);
    fs.writeFileSync(path.join(out,'original-bundled-voice-trust.cjs'),readFile(path.join(ROOT,TRUST_REL)),{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(out,'builder-base.json'),'{}\n',{flag:'wx',mode:0o600});
    const native = verifyNativeSignatures(path.join(admitted.resources,'voice-assets'),admitted.inventory,admitted.receipt.signing);
    privateJson(path.join(out,'stage-signature-readback.json'),native);
    runChecked('/usr/bin/lipo',[electron,'-verify_arch','arm64'],{},commands);
    Object.assign(process.env,environment);
    const plan = packConfiguration(stageRoot,out,dmg);
    runChecked(process.execPath,[path.join(ROOT,'scripts/build-web.mjs')],{timeout:180000},commands);
    if (manifestDigest(sourceSnapshot(ROOT)) !== manifestDigest(source)) throw Error('MODEL_PACK_SOURCE_MISMATCH');
    const web = artifactSnapshot(path.join(ROOT,'apps/web'));
    if (web.files.some(f=>f.type==='symlink')) throw Error('MODEL_PACK_WEB_LINK');
    privateJson(path.join(out,'web-inputs.json'),web);
    let helper = null, captured = false;
    const hookReadbacks = [];
    const appPath = path.join(out,'artifacts/mac-arm64',plan.config.productName+'.app');
    const checkContext = context => {
      if (context.electronPlatformName !== 'darwin' || context.arch !== 3 || context.packager.projectDir !== ROOT
          || path.join(context.appOutDir,context.packager.appInfo.productFilename+'.app') !== appPath) throw Error('MODEL_PACK_BUILDER_CONTEXT');
      const config = context.packager.config;
      assertPackagedSourceFiles(config);
      if (config.mac?.identity !== null || config.mac.notarize !== false || process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') throw Error('FM_SIGNING_NOT_AUTHORIZED');
      if (config.publish !== null || manifestDigest(config.extraResources) !== manifestDigest(plan.config.extraResources)
          || manifestDigest(config.mac.extraResources) !== manifestDigest(plan.config.mac.extraResources)
          || JSON.stringify(config.mac.signIgnore) !== '["/voice-assets/"]') throw Error('MODEL_PACK_BUILDER_CONFIG_CHANGED');
    };
    const packed = await withCompiledTrust(ROOT,admitted.trustBytes,async ({assertSourceUnchanged})=>{
      plan.config.beforePack = async context => {
        checkContext(context); assertSourceUnchanged();
        if (captured) throw Error('MODEL_PACK_HELPER_ALREADY_BUILT');
        captured = true;
        // Preserve the existing helper's platform/toolchain/build guards while
        // moving its fresh output to private storage. No deletion of R56 inputs.
        helper = await require('./build-foundation-models.cjs').buildHelper({root:ROOT,arch:'arm64',output:path.join(out,'foundation-models')});
        assertSourceUnchanged();
      };
      const after = async context => {
        checkContext(context); assertSourceUnchanged();
        await require('./verify-foundation-models-bundle.cjs')(context);
        hookReadbacks.push(verifyPackagedPayload(appPath,admitted));
      };
      plan.config.afterPack = after;
      plan.config.afterSign = after;
      // Record the actual hooks, not the original YAML hook strings.
      privateJson(path.join(out,'builder-configuration.json'),{...plan,targets:dmg?['dir','dmg']:['dir'],environment});
      // This calls the default compiled module. NEVER supply options.trust or
      // testOnlyTrustedDigests on the executable packaging path.
      const bundled = require('../apps/desktop/bundled-voice-assets.cjs');
      const prepared = await bundled.prepareBundledRuntimeAssets({resourcesPath:admitted.resources,platform:'darwin'});
      if (!bundled.authenticatedBundledRuntimeSource(prepared)) throw Error('MODEL_PACK_COMPILED_AUTHORITY_REQUIRED');
      await require('electron-builder').build(plan);
      if (!captured || helper?.status !== 'PASS' || !hookReadbacks.length) throw Error('MODEL_PACK_HOOKS_NOT_RUN');
      assertSourceUnchanged();
      const readback = verifyPackagedPayload(appPath,admitted);
      const packagedResources = path.join(appPath,'Contents/Resources');
      const packaged = await bundled.prepareBundledRuntimeAssets({resourcesPath:packagedResources,platform:'darwin'});
      if (!bundled.authenticatedBundledRuntimeSource(packaged)) throw Error('MODEL_PACK_COMPILED_AUTHORITY_REQUIRED');
      const manifest = JSON.parse(readFile(path.join(packagedResources,'manifests/model-manifest.json')));
      const authority = require('../apps/desktop/asset-manifest-trust.cjs');
      authority.authenticateAssetManifest(manifest,'model');
      if (authority.manifestAuthority(manifest)?.authority !== 'COMPILED_ROOT') throw Error('MODEL_PACK_COMPILED_AUTHORITY_REQUIRED');
      const nativeReadback = verifyNativeSignatures(path.join(packagedResources,'voice-assets'),admitted.inventory,admitted.receipt.signing);
      privateJson(path.join(out,'app-signature-readback.json'),nativeReadback);
      const asar = require('@electron/asar'), archive = path.join(packagedResources,'app.asar');
      asar.uncache(archive);
      for (const file of web.files.filter(f=>f.type==='file')) {
        if (sha256(asar.extractFile(archive,'apps/web/'+file.path,false)) !== file.sha256) throw Error('MODEL_PACK_PACKAGED_WEB_MISMATCH');
      }
      verifyStage(stageRoot,stageReceiptSha256,source);
      return readback;
    }); // Restore only owned trust; concurrent edits fail closed and keep the backup.
    if (artifactSnapshot(path.join(ROOT,'node_modules')).treeSha256 !== dependencies.treeSha256
        || fingerprint(electron).sha256 !== electronInput.sha256
        || artifactSnapshot(path.join(ROOT,'apps/web')).treeSha256 !== web.treeSha256
        || manifestDigest(sourceSnapshot(ROOT)) !== manifestDigest(source)) throw Error('MODEL_PACK_INPUT_CHANGED');
    const artifacts = artifactSnapshot(path.join(out,'artifacts'));
    assertArtifactPolicy(artifacts,path.relative(path.join(out,'artifacts'),appPath).split(path.sep).join('/'),admitted.inventory,dmg);
    privateJson(path.join(out,'artifacts.json'),artifacts);
    privateJson(path.join(out,'commands.json'),commands);
    privateJson(path.join(out,'hook-readbacks.json'),hookReadbacks);
    const outputTree = artifactSnapshot(out);
    const receipt = {schemaVersion:1,class:'MACOS_RUNTIME_ONLY_LOCAL_NOT_RELEASE',operation:'PACK',status:'PASS',
      source:{commit:source.commit,gitTree:source.gitTree,treeSha256:source.treeSha256},
      stage:{path:stageRoot,receiptSha256:stageReceiptSha256,stageTreeDigest:admitted.receipt.stageTreeDigest},
      inputs:{runtime:admitted.receipt.runtimeInput,acquisition:admitted.receipt.acquisition,manifests:admitted.receipt.inputs,
        dependenciesTreeSha256:dependencies.treeSha256,webTreeSha256:web.treeSha256,electron:electronInput,
        node:{version:process.version,path:fs.realpathSync(process.execPath),...fingerprint(fs.realpathSync(process.execPath))}},
      compiledTrustSha256:sha256(admitted.trustBytes),treeDigest:admitted.trust.treeDigest,runtimeTreeDigest:admitted.trust.runtimeTreeDigest,
      modelManifestDigest:admitted.trust.modelManifestDigest,capabilitiesDigest:admitted.trust.capabilitiesDigest,
      targets:dmg?['dir','dmg']:['dir'],packaged:packed,artifactsTreeSha256:artifacts.treeSha256,
      outputTreeSha256:outputTree.treeSha256,files:outputTree.files,environment,
      published:false,notarized:false,appAcceptance:'NOT_RUN'};
    privateJson(path.join(out,'receipt.json'),receipt);
    return {type:'MACOS_MODEL_PACKS_PACKAGE',receiptPath:path.join(out,'receipt.json'),receiptSha256:fingerprint(path.join(out,'receipt.json')).sha256,
      appPath:packed.appPath,sourceCommit:source.commit,appAcceptance:'NOT_RUN'};
  } catch (error) {
    privateJson(path.join(out,'failure.json'),{status:'FAILED',error:error.stack || String(error),commands:[...commands,...(error.commands || [])],appAcceptance:'NOT_RUN'});
    throw error;
  } finally {
    for (const [key,value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function parseCli(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help:true};
  const values = {dmg:false}, seen = new Set();
  const keys = {'--stage':'stage','--stage-receipt-sha256':'stageReceiptSha256','--output':'output'};
  for (let i=0;i<argv.length;i++) {
    const flag = argv[i];
    if (seen.has(flag) || (flag !== '--dmg' && !Object.hasOwn(keys,flag))) throw Error('MODEL_PACK_CLI_OPTION:' + flag);
    seen.add(flag);
    if (flag === '--dmg') values.dmg = true;
    else {
      const value = argv[++i];
      if (typeof value !== 'string' || !value || value.startsWith('--')) throw Error('MODEL_PACK_CLI_VALUE:' + flag);
      values[keys[flag]] = value;
    }
  }
  if (!values.stage || !values.output || !/^[a-f0-9]{64}$/.test(values.stageReceiptSha256 || '')) throw Error('MODEL_PACK_CLI_REQUIRED');
  safePath(values.stage); safePath(values.output);
  return values;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseCli(argv);
    if (options.help) {
      console.log('Usage: node scripts/macos-pack-model-packs.cjs --stage /absolute/stage --stage-receipt-sha256 <sha256> --output /absolute/fresh-pack [--dmg]\nLocal macOS arm64 only; no publish, notarize, trust override or dirty-source bypass. App is never launched.');
      return 0;
    }
    process.umask(0o077);
    console.log(JSON.stringify(await pack(options)));
    return 0;
  } catch (error) { console.error(error.stack || String(error)); return 1; }
}

module.exports = {deriveStageMetadata, compiledTrustBytes, sourceSnapshot, verifyStage, withCompiledTrust, verifyNativeSignatures,
  packConfiguration, artifactSnapshot, verifyPackagedPayload, pack, parseCli};
if (require.main === module) main().then(code=>{
  process.exitCode=code;
  // temp-file's async-exit-hook calls process.exit(0) after beforeExit cleanup.
  // Preserve failure only after main/pack/finally settle. Let output and async
  // cleanup drain normally; do not force an early exit or affect module imports.
  if (code !== 0) process.once('exit',()=>{process.exitCode=code;});
});
