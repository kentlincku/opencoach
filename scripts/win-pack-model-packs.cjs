'use strict';
// Windows x64 runtime-only (W1, CPU) stage + pack. Local single-machine, NOT a release:
// no code signing (Windows has no codesign step here), no publish. Counterpart of
// scripts/macos-stage-model-packs.py + scripts/macos-pack-model-packs.cjs with the same
// rules: clean committed source, receipted runtime build, models never embedded,
// compiled trust written only through the owned withCompiledTrust transaction, and the
// packaged payload is read back before a PASS receipt is written. The App is never launched.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {canonicalInventory, validateInventory, verifyInventorySync} = require('../apps/desktop/tree-integrity.cjs');
const {loadTrust, authenticateInventory} = require('../apps/desktop/bundled-voice-assets.cjs');
const {manifestDigest} = require('../apps/desktop/asset-manifest-trust.cjs');
const {parseWindowsModelCatalog} = require('../apps/desktop/macos-model-catalog.cjs');
const mac = require('./macos-pack-model-packs.cjs');

const ROOT = path.resolve(__dirname, '..');
const TRUST_REL = 'apps/desktop/bundled-voice-trust.cjs';
const CATALOG_REL = 'resources/windows-model-packs.json';
const CLASS = 'WINDOWS_RUNTIME_ONLY_LOCAL_NOT_RELEASE';
const RUNTIME_CLASS = 'WIN_CPU_LOCAL_SINGLE_MACHINE_NOT_RELEASE';
const ENTRY = 'runtime/bin/voice-runtime.exe';
const PROFILE = 'windows-ct2-kokoro-cpu-v1';
const NON_SOURCE_MANIFESTS = ['macos-model-packs.json', 'windows-model-packs.json', 'model-manifest.json', 'speech-model-capabilities.json'];
// Same family as scripts/win_cpu_runtime_policy.py; kept in sync by tests.
const CUDA = /^(?:cublas.*|cublaslt.*|cudnn.*|nvrtc.*|cudart.*|cufft.*|curand.*|cusparse.*|cusolver.*|nvjitlink.*|nvinfer.*|onnxruntime_providers_cuda.*|onnxruntime_providers_tensorrt.*)$/i;
const SPEECH_MODEL = name => /\.(onnx|safetensors|gguf|ggml|tflite)$/i.test(name) || /^voices(?:-v[0-9.]+)?\.bin$/i.test(name)
  || /^model\.bin$/i.test(name);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function safePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value !== path.resolve(value)
      || value.split(/[\\/]/).includes('..')) throw Error('MODEL_PACK_UNSAFE_PATH');
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('MODEL_PACK_UNSAFE_LINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return value;
}

function readBytes(file, max = 64 * 1024 ** 2) {
  safePath(file);
  const listed = fs.lstatSync(file);
  if (!listed.isFile() || listed.nlink !== 1 || listed.size > max) throw Error('MODEL_PACK_UNSAFE_FILE');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== listed.size) throw Error('MODEL_PACK_FILE_CHANGED');
  return bytes;
}
const readJson = (file, max) => JSON.parse(readBytes(file, max).toString('utf8'));

// faster-whisper's own Silero VAD (pinned by the CPU runtime build) is runtime code data, not an
// on-demand speech model. Only this exact path AND hash is admitted; anything else stays refused.
const SILERO_VAD = Object.freeze({path: 'runtime/bin/_internal/voice_practice_speech_vendor/faster_whisper/assets/silero_vad_v6.onnx',
  sha256: '4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2'});

function assertRuntimeOnlyFiles(files) {
  for (const file of files) {
    if (!file.path.startsWith('runtime/')) throw Error('MODEL_PACK_RUNTIME_ONLY_INVENTORY:' + file.path);
    const name = path.posix.basename(file.path);
    if (CUDA.test(name)) throw Error('MODEL_PACK_CUDA_PAYLOAD:' + file.path);
    if (file.path === SILERO_VAD.path && file.sha256 === SILERO_VAD.sha256) continue;
    if (SPEECH_MODEL(name)) throw Error('MODEL_PACK_EMBEDDED_SPEECH_MODEL:' + file.path);
  }
}

function deriveStageMetadata(catalog, files) {
  if (!catalog || catalog.schemaVersion !== 1
      || !['capabilities,modelBindings,modelManifest,schemaVersion', 'capabilities,modelBindings,modelManifest,schemaVersion,sttChoices'].includes(Object.keys(catalog).sort().join())) throw Error('MODEL_PACK_CATALOG_SCHEMA');
  assertRuntimeOnlyFiles(files);
  const whole = canonicalInventory(files);
  const runtime = canonicalInventory(files.map(f => ({...f, path: f.path.slice('runtime/'.length)})));
  const trust = loadTrust({schemaVersion: 2, mode: 'runtime-only', treeDigest: whole.treeDigest,
    runtimeTreeDigest: runtime.treeDigest, fileCount: whole.fileCount, entrypoint: ENTRY, runtimeProfile: PROFILE,
    modelManifestDigest: manifestDigest(catalog.modelManifest), capabilitiesDigest: manifestDigest(catalog.capabilities),
    modelBindings: catalog.modelBindings, ...(catalog.sttChoices ? {sttChoices: catalog.sttChoices} : {})}, 'win32');
  authenticateInventory({files}, trust);
  parseWindowsModelCatalog(catalog.capabilities, trust, catalog.modelManifest);
  return {trust, modelManifest: catalog.modelManifest, capabilities: catalog.capabilities};
}
const compiledTrustBytes = mac.compiledTrustBytes;

function listTree(root) {
  const files = [];
  (function visit(directory) {
    const names = fs.readdirSync(directory).sort();
    if (!names.length && directory !== root) throw Error('MODEL_PACK_EMPTY_DIRECTORY');
    for (const name of names) {
      const full = path.join(directory, name), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw Error('MODEL_PACK_UNSAFE_LINK');
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) {
        if (stat.nlink !== 1) throw Error('MODEL_PACK_UNSAFE_FILE');
        const hash = crypto.createHash('sha256'), fd = fs.openSync(full, 'r'), buffer = Buffer.alloc(1 << 20);
        try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
        finally { fs.closeSync(fd); }
        files.push({path: path.relative(root, full).split(path.sep).join('/'), bytes: stat.size, sha256: hash.digest('hex')});
      } else throw Error('MODEL_PACK_TREE_SPECIAL');
    }
  })(root);
  return canonicalInventory(files).files;
}

function stageReceipt({root, source, metadata, runtimeInput}) {
  const staged = canonicalInventory(listTree(root).filter(f => f.path !== 'receipt.json'));
  return {schemaVersion: 1, class: CLASS, operation: 'STAGE', status: 'PASS',
    source: {commit: source.commit, gitTree: source.gitTree, treeSha256: source.treeSha256}, runtimeInput,
    signing: {status: 'NOT_APPLICABLE_WINDOWS_LOCAL'},
    treeDigest: metadata.trust.treeDigest, runtimeTreeDigest: metadata.trust.runtimeTreeDigest, fileCount: metadata.trust.fileCount,
    stageTreeDigest: staged.treeDigest, files: staged.files, appAcceptance: 'NOT_RUN'};
}

function verifyStage(stageRoot, expectedReceiptSha256, source, {catalog = readJson(path.join(ROOT, CATALOG_REL)), sourceManifests = true} = {}) {
  safePath(stageRoot);
  const receiptBytes = readBytes(path.join(stageRoot, 'receipt.json'), 8 * 1024 ** 2);
  if (!/^[a-f0-9]{64}$/.test(expectedReceiptSha256) || sha256(receiptBytes) !== expectedReceiptSha256) throw Error('MODEL_PACK_STAGE_RECEIPT_HASH');
  const receipt = JSON.parse(receiptBytes);
  if (receipt.schemaVersion !== 1 || receipt.class !== CLASS || receipt.operation !== 'STAGE' || receipt.status !== 'PASS'
      || receipt.appAcceptance !== 'NOT_RUN') throw Error('MODEL_PACK_STAGE_RECEIPT_SCHEMA');
  if (!source || ['commit', 'gitTree', 'treeSha256'].some(k => receipt.source?.[k] !== source[k])
      || receipt.runtimeInput?.commit !== source.commit) throw Error('MODEL_PACK_SOURCE_MISMATCH');
  const staged = validateInventory(receipt.files, receipt.stageTreeDigest);
  verifyInventorySync(stageRoot, canonicalInventory([...staged.files, {path: 'receipt.json', bytes: receiptBytes.length, sha256: expectedReceiptSha256}]));
  const json = rel => readJson(path.join(stageRoot, rel));
  if (manifestDigest(json('source.json')) !== manifestDigest(source)) throw Error('MODEL_PACK_SOURCE_MISMATCH');
  const trust = loadTrust(json('trust.json'), 'win32');
  if (trust?.schemaVersion !== 2 || trust.runtimeProfile !== PROFILE) throw Error('MODEL_PACK_RUNTIME_ONLY_REQUIRED');
  const trustBytes = readBytes(path.join(stageRoot, 'bundled-voice-trust.cjs'));
  if (!trustBytes.equals(compiledTrustBytes(trust))) throw Error('MODEL_PACK_COMPILED_TRUST_MISMATCH');
  const inv = json('resources/voice-assets-inventory.json');
  const inventory = authenticateInventory(inv, trust).whole;
  verifyInventorySync(path.join(stageRoot, 'resources/voice-assets'), inventory);
  const metadata = deriveStageMetadata(catalog, inv.files);
  if (manifestDigest(metadata.trust) !== manifestDigest(trust)
      || manifestDigest(json('resources/manifests/model-manifest.json')) !== trust.modelManifestDigest
      || manifestDigest(json('resources/manifests/speech-model-capabilities.json')) !== trust.capabilitiesDigest
      || receipt.treeDigest !== trust.treeDigest || receipt.fileCount !== trust.fileCount) throw Error('MODEL_PACK_STAGE_MANIFEST_MISMATCH');
  if (sourceManifests) {
    const expected = fs.readdirSync(path.join(ROOT, 'resources')).filter(n => n.endsWith('.json') && !NON_SOURCE_MANIFESTS.includes(n)).sort();
    const present = fs.readdirSync(path.join(stageRoot, 'resources/manifests')).filter(n => !NON_SOURCE_MANIFESTS.includes(n)).sort();
    if (expected.join() !== present.join()) throw Error('MODEL_PACK_SOURCE_INPUT_MISMATCH');
    for (const name of expected) {
      const current = readBytes(path.join(ROOT, 'resources', name));
      if (!readBytes(path.join(stageRoot, 'resources/manifests', name)).equals(current)
          || source.files?.find(f => f.path === 'resources/' + name)?.sha256 !== sha256(current)) throw Error('MODEL_PACK_SOURCE_INPUT_MISMATCH');
    }
  }
  return {root: stageRoot, resources: path.join(stageRoot, 'resources'), receipt, receiptSha256: expectedReceiptSha256, trust, trustBytes, inventory};
}

function verifyRuntimeBuild(build, commit) {
  safePath(build);
  const receipt = readJson(path.join(build, 'receipt.json'));
  if (receipt.class !== RUNTIME_CLASS || receipt.flavor !== 'cpu' || receipt.commit !== commit
      || !Array.isArray(receipt.symlinks) || receipt.symlinks.length || !Array.isArray(receipt.nonPortableNames) || receipt.nonPortableNames.length
      || !Array.isArray(receipt.cudaPayload) || receipt.cudaPayload.length) throw Error('MODEL_PACK_RUNTIME_RECEIPT_INVALID');
  const root = path.join(build, 'dist', 'runtime');
  const files = listTree(root);
  const map = Object.fromEntries(files.map(f => [f.path, f.sha256]));
  const sorted = Object.fromEntries(Object.keys(map).sort().map(k => [k, map[k]]));
  // Python json.dumps(sort_keys=True) default separators.
  const tree = sha256(Buffer.from(JSON.stringify(sorted).replace(/","/g, '", "').replace(/":"/g, '": "')));
  if (tree !== receipt.treeSha256 || files.length !== receipt.fileCount) throw Error('MODEL_PACK_RUNTIME_RECEIPT_MISMATCH');
  if (!files.some(f => f.path === 'bin/voice-runtime.exe')) throw Error('MODEL_PACK_RUNTIME_ENTRY_MISSING');
  assertRuntimeOnlyFiles(files.map(f => ({...f, path: 'runtime/' + f.path})));
  return {root, receipt, receiptSha256: sha256(readBytes(path.join(build, 'receipt.json'))), files};
}

function freshPrivateDir(output, inputs) {
  safePath(output);
  for (const input of inputs) {
    const a = output.toLowerCase(), b = input.toLowerCase(); // NTFS is case-insensitive
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw Error('MODEL_PACK_OUTPUT_OVERLAPS_INPUT');
  }
  if (!fs.statSync(path.dirname(output)).isDirectory()) throw Error('MODEL_PACK_OUTPUT_PARENT_REQUIRED');
  try { fs.mkdirSync(output, {mode: 0o700}); } catch (error) { if (error.code === 'EEXIST') throw Error('MODEL_PACK_OUTPUT_EXISTS'); throw error; }
  return output;
}
const writeNew = (file, data) => { fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700}); fs.writeFileSync(file, data, {flag: 'wx', mode: 0o600}); };
const writeJson = (file, value) => writeNew(file, JSON.stringify(value, null, 2) + '\n');

function stage({runtimeBuild, output}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('MODEL_PACK_WIN_X64_REQUIRED');
  const source = mac.sourceSnapshot(ROOT);
  const runtime = verifyRuntimeBuild(runtimeBuild, source.commit);
  const out = freshPrivateDir(output, [ROOT, runtimeBuild]);
  try {
    const assets = path.join(out, 'resources', 'voice-assets', 'runtime');
    for (const file of runtime.files) {
      const target = path.join(assets, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.copyFileSync(path.join(runtime.root, ...file.path.split('/')), target, fs.constants.COPYFILE_EXCL);
    }
    const files = listTree(path.join(out, 'resources', 'voice-assets'));
    const catalog = readJson(path.join(ROOT, CATALOG_REL));
    const metadata = deriveStageMetadata(catalog, files);
    writeJson(path.join(out, 'resources/voice-assets-inventory.json'), {files});
    writeJson(path.join(out, 'resources/manifests/model-manifest.json'), metadata.modelManifest);
    writeJson(path.join(out, 'resources/manifests/speech-model-capabilities.json'), metadata.capabilities);
    for (const name of fs.readdirSync(path.join(ROOT, 'resources')).filter(n => n.endsWith('.json') && !NON_SOURCE_MANIFESTS.includes(n)).sort()) {
      writeNew(path.join(out, 'resources/manifests', name), readBytes(path.join(ROOT, 'resources', name)));
    }
    writeJson(path.join(out, 'trust.json'), metadata.trust);
    writeNew(path.join(out, 'bundled-voice-trust.cjs'), compiledTrustBytes(metadata.trust));
    writeJson(path.join(out, 'source.json'), source);
    if (manifestDigest(mac.sourceSnapshot(ROOT)) !== manifestDigest(source)
        || manifestDigest(verifyRuntimeBuild(runtimeBuild, source.commit).files) !== manifestDigest(runtime.files)) throw Error('MODEL_PACK_STAGE_INPUT_CHANGED');
    const receipt = stageReceipt({root: out, source, metadata, runtimeInput: {buildDirectory: runtimeBuild, receiptSha256: runtime.receiptSha256,
      commit: runtime.receipt.commit, treeSha256: runtime.receipt.treeSha256, fileCount: runtime.receipt.fileCount,
      droppedBinaries: runtime.receipt.droppedBinaries || [], cudaPayload: runtime.receipt.cudaPayload}});
    writeJson(path.join(out, 'receipt.json'), receipt);
    const receiptSha256 = sha256(readBytes(path.join(out, 'receipt.json')));
    verifyStage(out, receiptSha256, source);
    return {type: 'WINDOWS_MODEL_PACKS_STAGE', receiptPath: path.join(out, 'receipt.json'), receiptSha256,
      sourceCommit: source.commit, treeDigest: receipt.treeDigest, fileCount: receipt.fileCount};
  } catch (error) {
    try { writeJson(path.join(out, 'failure.json'), {status: 'FAILED', error: String(error.stack || error), appAcceptance: 'NOT_RUN'}); } catch {}
    throw error;
  }
}

function packConfiguration(stageRoot, output, {nsis = true} = {}) {
  safePath(stageRoot); safePath(output);
  if (typeof nsis !== 'boolean') throw Error('MODEL_PACK_TARGET');
  const base = require('js-yaml').load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
  const targetNames = nsis ? ['dir', 'nsis'] : ['dir'];
  const config = {...base,
    // electron-builder deep-merges by CONCATENATING arrays: start from an empty private base and
    // replace every resource/target array explicitly (same rule as the macOS runtime-only pack).
    extends: path.join(output, 'builder-base.json'),
    electronDist: path.join(ROOT, 'node_modules/electron/dist'),
    npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false, forceCodeSigning: false,
    publish: null, asar: true, beforePack: null, afterPack: null, afterSign: null,
    directories: {output: path.join(output, 'artifacts'), buildResources: path.join(ROOT, 'build')},
    extraResources: [{from: path.join(stageRoot, 'resources/manifests'), to: 'manifests', filter: ['*.json']}],
    win: {...base.win, signAndEditExecutable: false, target: targetNames.map(target => ({target, arch: ['x64']})),
      extraResources: [
        {from: path.join(stageRoot, 'resources/voice-assets'), to: 'voice-assets'},
        {from: path.join(stageRoot, 'resources/voice-assets-inventory.json'), to: 'voice-assets-inventory.json'},
      ]},
    nsis: {...base.nsis},
    compression: 'normal',
  };
  delete config.mac; delete config.portable; delete config.dmg;
  return {projectDir: ROOT, publish: 'never', targetNames, config};
}

// @electron/asar splits lookups on path.sep; repo-relative paths use '/', so Windows needs '\\'.
const asarPath = relative => relative.split('/').join(path.sep);

function verifyPackagedPayload(appDir, admitted) {
  const resources = path.join(appDir, 'resources'), archive = path.join(resources, 'app.asar');
  const asar = require('@electron/asar');
  asar.uncache(archive);
  const compiled = asar.statFile(archive, asarPath(TRUST_REL), false);
  if (compiled.unpacked || compiled.link || !asar.extractFile(archive, asarPath(TRUST_REL), false).equals(admitted.trustBytes)) throw Error('MODEL_PACK_PACKAGED_COMPILED_TRUST');
  const source = readJson(path.join(admitted.root, 'source.json'));
  for (const file of source.files.filter(f => (f.path.startsWith('apps/desktop/') || f.path.startsWith('apps/web/')) && f.path !== TRUST_REL)) {
    const info = asar.statFile(archive, asarPath(file.path), false);
    if (info.unpacked || info.link || sha256(asar.extractFile(archive, asarPath(file.path), false)) !== file.sha256) throw Error('MODEL_PACK_PACKAGED_SOURCE_MISMATCH:' + file.path);
  }
  verifyInventorySync(path.join(resources, 'voice-assets'), admitted.inventory);
  if (!readBytes(path.join(resources, 'voice-assets-inventory.json')).equals(readBytes(path.join(admitted.resources, 'voice-assets-inventory.json')))) throw Error('MODEL_PACK_PACKAGED_INVENTORY');
  const prefix = 'resources/manifests/';
  const manifests = canonicalInventory(admitted.receipt.files.filter(f => f.path.startsWith(prefix)).map(f => ({...f, path: f.path.slice(prefix.length)})));
  verifyInventorySync(path.join(resources, 'manifests'), manifests);
  return {appDir, asarSha256: sha256(fs.readFileSync(archive)), compiledTrustSha256: sha256(admitted.trustBytes),
    treeDigest: admitted.trust.treeDigest, modelManifestDigest: admitted.trust.modelManifestDigest, appAcceptance: 'NOT_RUN'};
}

async function pack({stage: stageRoot, stageReceiptSha256, output, nsis = true}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('MODEL_PACK_WIN_X64_REQUIRED');
  const source = mac.sourceSnapshot(ROOT);
  const admitted = verifyStage(stageRoot, stageReceiptSha256, source);
  const out = freshPrivateDir(output, [ROOT, stageRoot, admitted.receipt.runtimeInput.buildDirectory]);
  const previous = {CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY, ELECTRON_SKIP_BINARY_DOWNLOAD: process.env.ELECTRON_SKIP_BINARY_DOWNLOAD};
  try {
    writeNew(path.join(out, 'builder-base.json'), '{}\n');
    writeNew(path.join(out, 'original-bundled-voice-trust.cjs'), readBytes(path.join(ROOT, TRUST_REL)));
    writeJson(path.join(out, 'stage-receipt.json'), admitted.receipt);
    Object.assign(process.env, {CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_SKIP_BINARY_DOWNLOAD: '1'});
    const plan = packConfiguration(stageRoot, out, {nsis});
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-web.mjs')], {cwd: ROOT, stdio: 'inherit', timeout: 180000});
    if (manifestDigest(mac.sourceSnapshot(ROOT)) !== manifestDigest(source)) throw Error('MODEL_PACK_SOURCE_MISMATCH');
    const appDir = path.join(out, 'artifacts', 'win-unpacked');
    const packed = await mac.withCompiledTrust(ROOT, admitted.trustBytes, async ({assertSourceUnchanged}) => {
      const bundled = require('../apps/desktop/bundled-voice-assets.cjs');
      const prepared = await bundled.prepareBundledRuntimeAssets({resourcesPath: admitted.resources, platform: 'win32'});
      if (!bundled.authenticatedBundledRuntimeSource(prepared)) throw Error('MODEL_PACK_COMPILED_AUTHORITY_REQUIRED');
      writeJson(path.join(out, 'builder-configuration.json'), plan);
      const builder = require('electron-builder');
      await builder.build({projectDir: ROOT, publish: 'never', config: plan.config,
        targets: builder.Platform.WINDOWS.createTarget(plan.targetNames, builder.Arch.x64)});
      assertSourceUnchanged();
      const readback = verifyPackagedPayload(appDir, admitted);
      const packaged = await bundled.prepareBundledRuntimeAssets({resourcesPath: path.join(appDir, 'resources'), platform: 'win32'});
      if (!bundled.authenticatedBundledRuntimeSource(packaged)) throw Error('MODEL_PACK_COMPILED_AUTHORITY_REQUIRED');
      const manifest = readJson(path.join(appDir, 'resources/manifests/model-manifest.json'));
      const authority = require('../apps/desktop/asset-manifest-trust.cjs');
      authority.authenticateAssetManifest(manifest, 'model');
      if (authority.manifestAuthority(manifest)?.authority !== 'COMPILED_ROOT') throw Error('MODEL_PACK_COMPILED_AUTHORITY_REQUIRED');
      verifyStage(stageRoot, stageReceiptSha256, source);
      return readback;
    });
    if (manifestDigest(mac.sourceSnapshot(ROOT)) !== manifestDigest(source)) throw Error('MODEL_PACK_INPUT_CHANGED');
    const artifacts = fs.readdirSync(path.join(out, 'artifacts')).filter(n => n.endsWith('.exe'))
      .map(n => ({name: n, ...(s => ({bytes: s.length, sha256: sha256(s)}))(fs.readFileSync(path.join(out, 'artifacts', n)))}));
    if (nsis && artifacts.length !== 1) throw Error('MODEL_PACK_UNEXPECTED_ARTIFACTS');
    const receipt = {schemaVersion: 1, class: CLASS, operation: 'PACK', status: 'PASS',
      source: {commit: source.commit, gitTree: source.gitTree, treeSha256: source.treeSha256},
      stage: {path: stageRoot, receiptSha256: stageReceiptSha256, stageTreeDigest: admitted.receipt.stageTreeDigest},
      targets: plan.targetNames, installers: artifacts, packaged: packed, signed: false, published: false, appAcceptance: 'NOT_RUN'};
    writeJson(path.join(out, 'receipt.json'), receipt);
    return {type: 'WINDOWS_MODEL_PACKS_PACKAGE', receiptPath: path.join(out, 'receipt.json'), appDir, installers: artifacts, appAcceptance: 'NOT_RUN'};
  } catch (error) {
    try { writeJson(path.join(out, 'failure.json'), {status: 'FAILED', error: String(error.stack || error), appAcceptance: 'NOT_RUN'}); } catch {}
    throw error;
  } finally {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function parseCli(argv) {
  const values = {nsis: false}, seen = new Set();
  const keys = {'--stage': 'stage', '--stage-receipt-sha256': 'stageReceiptSha256', '--output': 'output'};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag) || (flag !== '--nsis' && !Object.hasOwn(keys, flag))) throw Error('MODEL_PACK_CLI_OPTION:' + flag);
    seen.add(flag);
    if (flag === '--nsis') values.nsis = true;
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

module.exports = {deriveStageMetadata, compiledTrustBytes, stageReceipt, verifyStage, verifyRuntimeBuild, packConfiguration,
  verifyPackagedPayload, stage, pack, parseCli, CUDA_PATTERN: CUDA};
if (require.main === module) {
  (async () => {
    process.umask?.(0o077);
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === 'stage') {
      const args = Object.fromEntries([[rest[0], rest[1]], [rest[2], rest[3]]]);
      if (rest.length !== 4 || !args['--runtime-build'] || !args['--output']) throw Error('MODEL_PACK_CLI_REQUIRED');
      return stage({runtimeBuild: safePath(args['--runtime-build']), output: safePath(args['--output'])});
    }
    if (mode === 'pack') return pack(parseCli(rest));
    throw Error('Usage: node scripts/win-pack-model-packs.cjs stage --runtime-build <abs build-cpu-NNN> --output <abs fresh>\n'
      + '       node scripts/win-pack-model-packs.cjs pack --stage <abs> --stage-receipt-sha256 <sha> --output <abs fresh> [--nsis]');
  })().then(result => { console.log(JSON.stringify(result)); }, error => {
    console.error(error.stack || String(error)); process.exitCode = 1;
    // temp-file's async-exit-hook calls process.exit(0) after cleanup; keep the failure (same as macOS pack CLI).
    process.once('exit', () => { process.exitCode = 1; });
  });
}
