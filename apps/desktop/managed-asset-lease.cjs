const fs = require('node:fs');
const path = require('node:path');
const { assertManagedPath, ensureManagedDirectory } = require('./runtime-paths.cjs');
const { selectPackagedSpeechProfile } = require('./packaged-speech-profile.cjs');

const LEASE_LIMITS = Object.freeze({roots: 32, pins: 128, managedBytes: 32 * 1024 ** 3,
  freeBytes: 1024 ** 3, scanEntries: 65536, scratchBytes: 4 * 1024 ** 2});
const coordinators = new Map();
const leaseSources = new WeakMap();
const launchBindings = new WeakMap();
// Electron's Node on win32 refuses fs.rmSync of a tree holding read-only files
// (EPERM; snapshots are written 0o400). Clear only the owner write bit on regular
// files of the already identity-checked root; any link/special entry aborts
// before mutation. darwin/POSIX keep the original single rmSync unchanged.
function removeManagedTree(root, {platform = process.platform, fs: io = fs} = {}) {
  if (platform !== 'win32') return io.rmSync(root, {recursive: true});
  const readOnly = [];
  let count = 0;
  const visit = filename => {
    if (++count > LEASE_LIMITS.scanEntries) throw new Error('CLEANUP_SCAN_LIMIT');
    const stat = io.lstatSync(filename);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('CLEANUP_UNSAFE_PATH');
    if (stat.isDirectory()) { for (const name of io.readdirSync(filename)) visit(path.join(filename, name)); }
    else if ((stat.mode & 0o200) === 0) readOnly.push({filename, dev: stat.dev, ino: stat.ino});
  };
  visit(root);
  for (const item of readOnly) {
    const stat = io.lstatSync(item.filename);
    if (!stat.isFile() || stat.dev !== item.dev || stat.ino !== item.ino) throw new Error('CLEANUP_UNSAFE_PATH');
    io.chmodSync(item.filename, 0o600);
  }
  return io.rmSync(root, {recursive: true});
}
class ManagedAssetCoordinator {
  constructor(appRoot) {
    this.appRoot = path.resolve(appRoot);
    this.roots = new Map();
    this.active = null;
    // Trusted host I/O seam for portable fault injection, never renderer input.
    this.io = {statfs: root => fs.statfsSync(root), remove: root => removeManagedTree(root)};
  }
  snapshot() {
    const records = [...this.roots.values()];
    return Object.freeze({active: this.active !== null, roots: records.length,
      pins: records.reduce((n, r) => n + r.pins.size, 0),
      reservedBytes: records.reduce((n, r) => n + r.reservation, 0),
      retained: Object.freeze(records.filter(r => !r.keep).map(r => Object.freeze({root: r.root,
        pins: r.pins.size, reservation: r.reservation, error: r.error})))});
  }
  begin(root, metadata, reservation, readMetadata) {
    if (this.active) throw new Error('INSTALL_ALREADY_RUNNING');
    if (this.roots.size >= LEASE_LIMITS.roots) throw new Error('OWNED_ROOT_LIMIT');
    if (this.snapshot().pins >= LEASE_LIMITS.pins) throw new Error('PIN_LIMIT');
    if (!Number.isSafeInteger(reservation) || reservation <= 0) throw new Error('INVALID_RESERVATION');
    const relative = path.relative(this.appRoot, root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || this.roots.has(root)) throw new Error('MANAGED_PATH_ESCAPE');
    const operation = {};
    this.active = operation;
    this.roots.set(root, {root, metadata, readMetadata, owned: false, identity: null, reservation, pins: new Map(), keep: false, error: null});
    return operation;
  }
  checkDisk() {
    ensureManagedDirectory(this.appRoot, this.appRoot);
    let total = 0, count = 0;
    const visit = filename => {
      if (++count > LEASE_LIMITS.scanEntries) throw new Error('DISK_SCAN_LIMIT');
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('DISK_UNSAFE_PATH');
      if (stat.isDirectory()) {
        const directory = fs.opendirSync(filename);
        try { let entry; while ((entry = directory.readSync())) visit(path.join(filename, entry.name)); }
        finally { directory.closeSync(); }
      } else {
        total += stat.size;
        if (!Number.isSafeInteger(total) || total + this.snapshot().reservedBytes > LEASE_LIMITS.managedBytes) throw new Error('DISK_BUDGET');
      }
    };
    try {
      for (const name of ['runtime', 'models']) {
        const root = path.join(this.appRoot, name);
        try { fs.lstatSync(root); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        assertManagedPath(this.appRoot, root); visit(root);
      }
      const reserved = this.snapshot().reservedBytes;
      if (total + reserved > LEASE_LIMITS.managedBytes) throw new Error('DISK_BUDGET');
      const stat = this.io.statfs(this.appRoot);
      const free = stat.bavail * stat.bsize;
      if (!Number.isSafeInteger(free) || free < 0) throw new Error('DISK_UNAVAILABLE');
      if (free < reserved + LEASE_LIMITS.freeBytes) throw new Error('DISK_FREE_RESERVE');
    } catch (error) {
      if (error.message.startsWith('DISK_')) throw error;
      throw new Error(`DISK_UNAVAILABLE:${error.message}`);
    }
  }
  created(root) {
    const record = this.roots.get(root);
    assertManagedPath(this.appRoot, root);
    const stat = fs.lstatSync(root);
    record.owned = true; record.identity = {dev: stat.dev, ino: stat.ino};
  }
  prepare(root, metadata, owner) {
    assertManagedPath(this.appRoot, root);
    let added = false;
    if (!this.roots.has(root)) {
      if (this.roots.size >= LEASE_LIMITS.roots) throw new Error('OWNED_ROOT_LIMIT');
      // An earlier-process generation can be pinned after bundled tuple selection,
      // but observing it never grants deletion ownership.
      this.roots.set(root, {root, metadata, owned: false, identity: null, reservation: 0, pins: new Map(), keep: true, error: null});
      added = true;
    }
    try { return this.pin(root, owner); }
    catch (error) { if (added) this.roots.delete(root); throw error; }
  }
  pin(root, owner) {
    const record = this.roots.get(root);
    if (!record || !owner || !['object', 'function'].includes(typeof owner)) throw new Error('INVALID_PIN_OWNER');
    if (this.snapshot().pins >= LEASE_LIMITS.pins) throw new Error('PIN_LIMIT');
    const token = {};
    record.pins.set(token, owner);
    return Object.freeze({directory: path.join(root, 'payload'), release: async originalOwner => {
      if (!record.pins.has(token) || record.pins.get(token) !== originalOwner) return false;
      record.pins.delete(token);
      if (!this.active) await this.retryCleanup();
      return true;
    }});
  }
  publish(root, previousRoot) {
    const selected = this.roots.get(root);
    selected.reservation = 0; // actual bytes (including archive) now count in disk scan
    for (const record of this.roots.values()) {
      if (record.metadata === selected.metadata) record.keep = record.root === root || record.root === previousRoot;
    }
  }
  cleanup() {
    // No await between the pin/identity check and removal: a new pin cannot race rm.
    for (const record of this.roots.values()) {
      if (record.keep || record.pins.size) continue;
      try {
        if (record.owned) {
          const metadata = record.readMetadata();
          if ([metadata?.current, metadata?.previous].some(tuple => tuple?.directory === path.join(record.root, 'payload'))) throw new Error('CLEANUP_METADATA_REFERENCED');
          assertManagedPath(this.appRoot, path.dirname(record.root));
          let stat;
          try { stat = fs.lstatSync(record.root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (stat) {
            assertManagedPath(this.appRoot, record.root);
            if (stat.dev !== record.identity.dev || stat.ino !== record.identity.ino) throw new Error('CLEANUP_OWNERSHIP_CHANGED');
            this.io.remove(record.root);
          }
        }
        this.roots.delete(record.root);
      } catch (error) { record.error = error.message; }
    }
  }
  async finish(operation) {
    if (this.active !== operation) throw new Error('INSTALL_OWNER_MISMATCH');
    try { this.cleanup(); } finally { if (this.active === operation) this.active = null; }
  }
  async retryCleanup() {
    if (this.active) throw new Error('INSTALL_ALREADY_RUNNING');
    const operation = {}; this.active = operation;
    await this.finish(operation);
    return this.snapshot();
  }
}
function getManagedAssetCoordinator(appRoot) {
  const root = path.resolve(appRoot);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (!coordinators.has(key)) coordinators.set(key, new ManagedAssetCoordinator(root));
  return coordinators.get(key);
}
// Private payloads use the SAME app-root budget and cleanup authority as installs.
// The handle and concrete root are registered before any asynchronous preparation.
function prepareVoiceAssets(runtimeManager, modelManager) {
  const { randomBytes } = require('node:crypto');
  const { selectRuntimeArtifact, resolveModelBindings } = require('./runtime-manifest.cjs');
  const { canonicalInventory, verifyInventory, ASSET_LIMITS } = require('./tree-integrity.cjs');
  const coordinator = runtimeManager.coordinator;
  const profile = selectPackagedSpeechProfile(runtimeManager.platform, runtimeManager.arch);
  const artifact = selectRuntimeArtifact(runtimeManager.manifest, runtimeManager.platform, runtimeManager.arch, runtimeManager.flavor);
  const key = runtimeManager.platform === 'win32' ? `${runtimeManager.platform}-${runtimeManager.arch}-${runtimeManager.flavor}` : `${runtimeManager.platform}-${runtimeManager.arch}`;
  const bindings = resolveModelBindings(artifact, modelManager.manifest, key);
  const {manifestAuthority} = require('./asset-manifest-trust.cjs');
  const runtimeAuthority = manifestAuthority(runtimeManager.manifest);
  const modelAuthority = manifestAuthority(modelManager.manifest);
  const models = [...new Set(Object.values(bindings).map(binding => binding.modelId))];
  const inventories = [{prefix: 'runtime', artifact}, ...models.map(id => ({prefix: `models/${id}`, id, artifact: modelManager.manifest.models[id].artifacts[key]}))];
  const inventory = canonicalInventory(inventories.flatMap(item => item.artifact.files.map(file => ({...file, path: `${item.prefix}/${file.path}`}))));
  const root = path.join(coordinator.appRoot, 'runtime', 'snapshots', `s-${randomBytes(32).toString('hex')}`);
  const payload = path.join(root, 'payload'), tempRoot = path.join(root, 'temp'), cacheRoot = path.join(root, 'cache');
  const owner = {}, controller = new AbortController();
  const operation = coordinator.begin(root, null, inventory.totalBytes + LEASE_LIMITS.scratchBytes, () => null);
  const pin = coordinator.pin(root, owner);
  let released = false;
  const check = () => { if (controller.signal.aborted) throw new Error('ASSET_PREPARATION_ABORTED'); };
  const lease = {root, payload, tempRoot, cacheRoot, work: null,
    command: path.join(payload, 'runtime', artifact.entrypoint),
    trustedVoice: Object.freeze({...profile.enums, ...Object.fromEntries(Object.entries(profile.paths).map(([key, role]) => {
      const binding = bindings[role];
      return [key, path.join(payload, 'models', binding.modelId, binding.path || '')];
    }))}),
    cancel() { controller.abort(); },
    async verify() { check(); await verifyInventory(payload, inventory, {signal: controller.signal}); check(); return true; },
    async release() {
      await lease.work.catch(() => {}); // underlying copy/handles, not caller race
      if (!released) { if (!await pin.release(owner)) throw new Error('ASSET_PIN_OWNER_MISMATCH'); released = true; }
      if (!coordinator.active) await coordinator.retryCleanup();
      if (coordinator.roots.has(root)) throw new Error('ASSET_CLEANUP_FAILED');
    },
  };
  const expectedCommand = lease.command;
  const expectedEnv = require('./sidecar-environment.cjs').buildPackagedSidecarEnvironment({
    tempRoot, cacheRoot, trustedVoice: lease.trustedVoice, platform: runtimeManager.platform, arch: runtimeManager.arch});
  lease.work = Promise.resolve().then(async () => {
    const sources = [];
    try {
      check(); coordinator.checkDisk();
      ensureManagedDirectory(coordinator.appRoot, path.dirname(root));
      fs.mkdirSync(root, {mode: 0o700}); coordinator.created(root);
      for (const directory of [payload, tempRoot, cacheRoot]) fs.mkdirSync(directory, {mode: 0o700});
      // Each B API synchronously pins its selected original before verification.
      for (const item of inventories) {
        check();
        const source = await (item.id ? modelManager.pinCurrent(item.id, owner) : runtimeManager.pinCurrent(owner));
        sources.push(source);
        if (source.sha256 !== item.artifact.sha256 || source.treeDigest !== item.artifact.treeDigest) throw new Error('ASSET_BINDING_CHANGED');
        const buffer = Buffer.alloc(ASSET_LIMITS.streamBytes);
        for (const file of item.artifact.files) {
          check();
          const input = assertManagedPath(source.directory, path.join(source.directory, file.path));
          const output = path.join(payload, item.prefix, file.path);
          ensureManagedDirectory(root, path.dirname(output));
          const reader = await fs.promises.open(input, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          let writer;
          try {
            const stat = await reader.stat();
            if (!stat.isFile() || stat.size !== file.bytes) throw new Error('ASSET_COPY_SOURCE_CHANGED');
            writer = await fs.promises.open(output, 'wx', 0o600);
            let total = 0;
            for (;;) {
              check(); const {bytesRead} = await reader.read(buffer, 0, buffer.length, null); check();
              if (!bytesRead) break;
              total += bytesRead; if (total > file.bytes) throw new Error('ASSET_COPY_SOURCE_CHANGED');
              for (let offset = 0; offset < bytesRead;) {
                check(); const {bytesWritten} = await writer.write(buffer, offset, bytesRead - offset, null);
                if (!bytesWritten) throw new Error('ASSET_COPY_WRITE_FAILED'); offset += bytesWritten;
              }
            }
            if (total !== file.bytes) throw new Error('ASSET_COPY_SOURCE_CHANGED');
            await writer.chmod(item.prefix === 'runtime' && file.path === artifact.entrypoint ? 0o500 : 0o400);
          } finally { try { if (writer) await writer.close(); } finally { await reader.close(); } }
        }
      }
      await lease.verify();
      const summary = (role, item, source, authority) => Object.freeze({role,
        manifestDigest: authority.digest, archiveSha256: item.sha256, treeDigest: item.treeDigest,
        fileCount: item.files.length, totalBytes: item.files.reduce((n,f)=>n+f.bytes,0),
        sourceGeneration: source.generation});
      const proven = runtimeAuthority && modelAuthority && runtimeAuthority.kind === 'runtime' && modelAuthority.kind === 'model';
      const sourceById = new Map(inventories.map((item,i)=>[item.id,sources[i]]));
      const source = proven ? Object.freeze({authority: runtimeAuthority.authority === 'COMPILED_ROOT' && modelAuthority.authority === 'COMPILED_ROOT'
        ? 'COMPILED_ROOT' : 'NON_NATIVE_TEST_ROOT',
        assets:Object.freeze([summary('runtime',artifact,sources[0],runtimeAuthority),
          ...Object.entries(bindings).map(([role,binding])=>summary(role,
            inventories.find(item=>item.id===binding.modelId).artifact,sourceById.get(binding.modelId),modelAuthority))])}) : null;
      leaseSources.set(lease, {source, expectedCommand, expectedEnv, payload, inventory});
      return lease;
    } finally {
      for (const source of sources) await source.release(owner);
      await coordinator.finish(operation);
    }
  });
  return lease;
}

// Runtime-only App bytes stay in the authenticated bundle. Only model data is
// copied into the existing app-root snapshot transaction; this is not an install.
function prepareHybridVoiceAssets(nativeRuntime, modelManager, {sttModelId = null} = {}) {
  const {randomBytes} = require('node:crypto');
  const {canonicalInventory, verifyInventory, ASSET_LIMITS} = require('./tree-integrity.cjs');
  const {artifactIdentity} = require('./runtime-manifest.cjs');
  const {manifestAuthority, manifestDigest} = require('./asset-manifest-trust.cjs');
  const runtimeSource = require('./bundled-voice-assets.cjs').describeBundledRuntimeSource(nativeRuntime);
  if (!runtimeSource) throw new Error('HYBRID_RUNTIME_SOURCE_REQUIRED');
  const coordinator = modelManager.coordinator;
  const platform = modelManager.options.platform ?? process.platform;
  const arch = modelManager.options.arch ?? process.arch;
  const flavor = modelManager.options.flavor ?? 'cpu';
  // Windows W1 is CPU only; any other flavor (cuda) is refused before any pin.
  const key = platform === 'darwin' && arch === 'arm64' ? 'darwin-arm64'
    : platform === 'win32' && arch === 'x64' && flavor === 'cpu' ? 'win32-x64-cpu' : null;
  if (!key) throw new Error('UNSUPPORTED_HYBRID_SPEECH_PLATFORM');
  if (runtimeSource.trust.runtimeProfile !== require('./bundled-voice-assets.cjs').RUNTIME_ONLY_PROFILES[platform].runtimeProfile) {
    throw new Error('UNSUPPORTED_HYBRID_SPEECH_PLATFORM');
  }
  const profile = selectPackagedSpeechProfile(platform, arch, {hybrid: true});
  const manifest = modelManager.manifest;
  if (manifest.schemaVersion !== 3) throw new Error('HYBRID_RAW_MODELS_REQUIRED');
  const modelAuthority = manifestAuthority(manifest);
  if (!modelAuthority || modelAuthority.kind !== 'model' ||
      !['COMPILED_ROOT', 'NON_NATIVE_TEST_ROOT'].includes(modelAuthority.authority)) throw new Error('HYBRID_MODEL_MANIFEST_UNTRUSTED');
  if (runtimeSource.trust.modelManifestDigest !== modelAuthority.digest ||
      modelAuthority.digest !== manifestDigest(manifest)) throw new Error('HYBRID_MODEL_MANIFEST_MISMATCH');
  // Only the selected STT choice (or the trust default) plus the TTS bindings are
  // snapshotted; other allowed STT packs are never copied or exposed to the child.
  const bindings = require('./bundled-voice-assets.cjs').resolveEffectiveBindings(runtimeSource.trust, sttModelId);
  for (const [role, binding] of Object.entries(bindings)) {
    const artifact = manifest.models[binding.modelId]?.artifacts[key];
    if (!artifact || artifact.transport !== 'raw-files') throw new Error(`MODEL_BINDING_MISMATCH:${role}`);
    const identity = artifactIdentity(artifact);
    if (identity.kind !== 'raw-files' || binding.identity.kind !== identity.kind ||
        binding.identity.treeDigest !== identity.treeDigest) throw new Error(`MODEL_BINDING_MISMATCH:${role}`);
    if (role !== 'sttRoot' && !artifact.files.some(file => file.path === binding.path)) throw new Error(`MODEL_BINDING_PATH_MISSING:${role}`);
  }
  const models = [...new Set(Object.values(bindings).map(binding => binding.modelId))];
  const inventories = models.map(id => ({id, prefix: `models/${id}`, artifact: manifest.models[id].artifacts[key]}));
  const inventory = canonicalInventory(inventories.flatMap(item => item.artifact.files.map(file => ({...file, path: `${item.prefix}/${file.path}`}))));
  const root = path.join(coordinator.appRoot, 'runtime', 'snapshots', `s-${randomBytes(32).toString('hex')}`);
  const payload = path.join(root, 'payload'), tempRoot = path.join(root, 'temp'), cacheRoot = path.join(root, 'cache');
  const owner = {}, controller = new AbortController();
  const trustedVoice = Object.freeze({...profile.enums, ...Object.fromEntries(Object.entries(profile.paths).map(([key, role]) => {
    const binding = bindings[role];
    return [key, path.join(payload, 'models', binding.modelId, binding.path || '')];
  }))});
  const expectedEnv = require('./sidecar-environment.cjs').buildPackagedSidecarEnvironment({
    tempRoot, cacheRoot, trustedVoice, platform, arch, hybrid: true});
  const operation = coordinator.begin(root, null, inventory.totalBytes + LEASE_LIMITS.scratchBytes, () => null);
  const pin = coordinator.pin(root, owner);
  let released = false, releaseWork = null;
  const sources = [], releasedSources = new Set();
  const releaseSourcePins = async () => {
    let failure;
    for (const source of sources) {
      if (releasedSources.has(source)) continue;
      try {
        if (!await source.release(owner)) throw new Error('ASSET_SOURCE_PIN_OWNER_MISMATCH');
        releasedSources.add(source);
      } catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  };
  const check = () => {
    if (controller.signal.aborted) throw new Error('ASSET_PREPARATION_ABORTED');
    if (released) throw new Error('ASSET_PREPARATION_RELEASED');
  };
  const lease = {command: runtimeSource.command, trustedVoice, root, payload, tempRoot, cacheRoot, work: null,
    cancel() { controller.abort(); },
    async verify() {
      check(); await verifyInventory(payload, inventory, {signal: controller.signal}); check();
      if (runtimeSource.verifyRuntimeBeforeSpawn() !== true) throw new Error('HYBRID_RUNTIME_UNCONFIRMED');
      check(); return true;
    },
    release() {
      releaseWork ||= (async () => {
        await lease.work.catch(() => {}); // join the original copy and open handles
        await releaseSourcePins(); // failed source handles stay attached to this owner
        if (!released) { if (!await pin.release(owner)) throw new Error('ASSET_PIN_OWNER_MISMATCH'); released = true; }
        if (!coordinator.active) await coordinator.retryCleanup();
        if (coordinator.roots.has(root)) throw new Error('ASSET_CLEANUP_FAILED');
      })().catch(error => { releaseWork = null; throw error; });
      return releaseWork;
    },
  };
  const selected = {source: null, ready: false, expectedCommand: runtimeSource.command,
    expectedEnv, payload, inventory, runtimeSource, check};
  leaseSources.set(lease, selected);
  lease.work = Promise.resolve().then(async () => {
    try {
      check(); coordinator.checkDisk();
      ensureManagedDirectory(coordinator.appRoot, path.dirname(root));
      fs.mkdirSync(root, {mode: 0o700}); coordinator.created(root);
      for (const directory of [payload, tempRoot, cacheRoot]) fs.mkdirSync(directory, {mode: 0o700});
      for (const item of inventories) {
        check();
        const source = await modelManager.pinCurrent(item.id, owner);
        sources.push(source);
        const identity = source.identity;
        if (!identity || Reflect.ownKeys(identity).length !== 2 ||
            !['kind', 'treeDigest'].every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(identity, key) || {}, 'value')) ||
            identity.kind !== 'raw-files' || identity.treeDigest !== item.artifact.treeDigest ||
            source.treeDigest !== item.artifact.treeDigest || Object.hasOwn(source, 'sha256') ||
            source.kind !== 'model' || source.modelId !== item.id || source.platformKey !== key ||
            typeof source.generation !== 'string' || !/^g-[a-f0-9]{64}$/.test(source.generation) ||
            source.directory !== path.join(coordinator.appRoot, 'models', item.id, 'runtime', 'generations', source.generation, 'payload') ||
            source.entrypoint !== path.join(source.directory, item.artifact.entrypoint)) throw new Error('ASSET_BINDING_CHANGED');
        const buffer = Buffer.alloc(ASSET_LIMITS.streamBytes);
        for (const file of item.artifact.files) {
          check();
          const input = assertManagedPath(source.directory, path.join(source.directory, file.path));
          const output = path.join(payload, item.prefix, file.path);
          ensureManagedDirectory(root, path.dirname(output));
          const reader = await fs.promises.open(input, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          let writer;
          try {
            const stat = await reader.stat();
            if (!stat.isFile() || stat.size !== file.bytes) throw new Error('ASSET_COPY_SOURCE_CHANGED');
            writer = await fs.promises.open(output, 'wx', 0o600);
            let total = 0;
            for (;;) {
              check(); const {bytesRead} = await reader.read(buffer, 0, buffer.length, null); check();
              if (!bytesRead) break;
              total += bytesRead; if (total > file.bytes) throw new Error('ASSET_COPY_SOURCE_CHANGED');
              for (let offset = 0; offset < bytesRead;) {
                check(); const {bytesWritten} = await writer.write(buffer, offset, bytesRead - offset, null);
                if (!bytesWritten) throw new Error('ASSET_COPY_WRITE_FAILED'); offset += bytesWritten;
              }
            }
            if (total !== file.bytes) throw new Error('ASSET_COPY_SOURCE_CHANGED');
            await writer.chmod(0o400);
          } finally { try { if (writer) await writer.close(); } finally { await reader.close(); } }
        }
      }
      await lease.verify();
      const sourceById = new Map(inventories.map((item, index) => [item.id, sources[index]]));
      return Object.freeze({version: 3,
        authority: runtimeSource.authority === 'COMPILED_ROOT' && modelAuthority.authority === 'COMPILED_ROOT'
          ? 'COMPILED_ROOT' : 'NON_NATIVE_TEST_ROOT',
        assets: Object.freeze([
          Object.freeze({role: 'runtime', sourceKind: 'bundled-runtime', manifestDigest: manifestDigest(runtimeSource.trust),
            treeDigest: runtimeSource.inventory.treeDigest, fileCount: runtimeSource.inventory.fileCount, totalBytes: runtimeSource.inventory.totalBytes}),
          ...Object.entries(bindings).map(([role, binding]) => {
            const artifact = manifest.models[binding.modelId].artifacts[key];
            return Object.freeze({role, sourceKind: 'raw-model', manifestDigest: modelAuthority.digest,
              identity: artifactIdentity(artifact), treeDigest: artifact.treeDigest,
              fileCount: artifact.files.length, totalBytes: artifact.bytes, sourceGeneration: sourceById.get(binding.modelId).generation});
          }),
        ]),
      });
    } finally {
      try { await releaseSourcePins(); }
      finally { await coordinator.finish(operation); }
    }
  }).then(source => {
    check(); selected.source = source; selected.ready = true; return lease;
  });
  return Object.freeze(lease);
}

function prepareProbeAssets(manager, entrypoint, context) {
  const { randomBytes } = require('node:crypto');
  const { selectRuntimeArtifact } = require('./runtime-manifest.cjs');
  const { verifyInventory } = require('./tree-integrity.cjs');
  if (!context || context.authority !== 'MEMORY' || typeof context.pin !== 'function') throw new Error('ASSET_CANDIDATE_CONTEXT_REQUIRED');
  const artifact = selectRuntimeArtifact(manager.manifest, manager.platform, manager.arch, manager.flavor);
  if (entrypoint !== path.join(context.directory, artifact.entrypoint)) throw new Error('ASSET_CANDIDATE_MISMATCH');
  const owner = {}, pin = context.pin(owner);
  const root = path.join(path.dirname(context.directory), `probe-${randomBytes(32).toString('hex')}`);
  const tempRoot = path.join(root, 'temp'), cacheRoot = path.join(root, 'cache');
  let created = false, identity, released = false;
  const bundle = {root, tempRoot, cacheRoot, work: null,
    cancel() {}, // manager owns the install AbortController; Main also stops its client
    async verify() {
      if (context.signal.aborted) throw new Error('ASSET_PREPARATION_ABORTED');
      await verifyInventory(context.directory, artifact, {signal: context.signal}); return true;
    },
    async release() {
      await bundle.work.catch(() => {});
      if (created) {
        assertManagedPath(manager.coordinator.appRoot, root);
        const stat = fs.lstatSync(root);
        if (stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error('ASSET_CLEANUP_OWNERSHIP_CHANGED');
        fs.rmSync(root, {recursive: true}); created = false;
      }
      if (!released) { if (!await pin.release(owner)) throw new Error('ASSET_PIN_OWNER_MISMATCH'); released = true; }
    },
  };
  bundle.work = Promise.resolve().then(async () => {
    assertManagedPath(manager.coordinator.appRoot, path.dirname(root));
    fs.mkdirSync(root, {mode: 0o700}); created = true; identity = fs.lstatSync(root);
    for (const directory of [tempRoot, cacheRoot]) fs.mkdirSync(directory, {mode: 0o700});
    await bundle.verify(); return bundle;
  });
  return bundle;
}

function bindClientAssets(client, bundle) {
  const hybridSource = leaseSources.get(bundle);
  if (hybridSource?.runtimeSource && (hybridSource.client || launchBindings.has(client))) throw new Error('ASSET_CLIENT_OWNER_MISMATCH');
  const {SidecarClient}=require('./sidecar-client.cjs');
  SidecarClient.bindDarwinAssets(client,bundle);
  const clientId = client.clientId;
  let originalCoverage;
  let retired = false;
  let spawnAuthorized = false;
  let darwinRelease = null;
  const evidence = () => {
    const value = client.assetLifetimeSnapshot?.();
    const darwin=value?.schemaVersion===2;
    const keys = ['schemaVersion', 'clientId', 'coverage', 'pendingPreparation', 'unresolvedGenerations', 'unknown', 'fault',
      ...(darwin ? ['qualificationScope','purpose'] : [])];
    if (!value || !Object.isFrozen(value) || Reflect.ownKeys(value).length !== keys.length
      || !keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) || {}, 'value'))
      || ![1,2].includes(value.schemaVersion) || value.clientId !== clientId || client.clientId !== clientId
      || !(darwin ? value.coverage==='darwin-owned-handles' &&
        require('./darwin-owned-lifetime.cjs').authenticatedDarwinSnapshot(value,client,bundle) :
        ['windows-tree', 'leader-only'].includes(value.coverage))
      || (originalCoverage !== undefined && value.coverage !== originalCoverage)
      || !Number.isSafeInteger(value.unresolvedGenerations) || value.unresolvedGenerations < 0
      || !['pendingPreparation', 'unknown', 'fault'].every(key => typeof value[key] === 'boolean')
      || value.unknown || value.fault) throw new Error('ASSET_LIFETIME_UNCONFIRMED');
    return value;
  };
  const initial = evidence();
  originalCoverage = initial.coverage;
  if (initial.pendingPreparation || initial.unresolvedGenerations) throw new Error('ASSET_MONITOR_LATE_BINDING');
  if (hybridSource?.runtimeSource) hybridSource.client = client;
  if (leaseSources.has(bundle)) launchBindings.set(client, (command, args, env) => {
    if (retired || !spawnAuthorized) throw new Error('ASSET_LAUNCH_NOT_AUTHORIZED');
    evidence();
    const selected = leaseSources.get(bundle);
    selected.check?.();
    if (selected.runtimeSource && !selected.ready) throw new Error('ASSET_PREPARATION_NOT_READY');
    if (command !== selected.expectedCommand || args.length !== 0 ||
        Object.keys(env).length !== Object.keys(selected.expectedEnv).length ||
        !Object.entries(selected.expectedEnv).every(([k,v])=>env[k]===v)) throw new Error('ASSET_LAUNCH_BINDING_CHANGED');
    require('./tree-integrity.cjs').verifyInventorySync(selected.payload, selected.inventory);
    if (selected.runtimeSource && selected.runtimeSource.verifyRuntimeBeforeSpawn() !== true) throw new Error('HYBRID_RUNTIME_UNCONFIRMED');
    selected.check?.();
    return selected.source;
  });
  const binding = Object.freeze({client, clientId, bundle,
    retire() { retired = true; SidecarClient.retireDarwinAssets(client); },
    async beforeSpawn() {
      if (retired) throw new Error('ASSET_CLIENT_RETIRED');
      evidence(); await bundle.verify();
      if (retired) throw new Error('ASSET_CLIENT_RETIRED');
      evidence(); SidecarClient.authorizeDarwinAssets(client,bundle);spawnAuthorized = true; return true;
    },
    async release(originalClient, originalBundle) {
      if (!retired || originalClient !== client || originalBundle !== bundle) throw new Error('ASSET_LIFETIME_UNCONFIRMED');
      const value = evidence();
      // C1 can compact confirmed POSIX leaders. Zero records is NOT tree proof.
      // Only preparation denied before spawn authorization has a no-spawn outlet
      // on that producer; an authorized-but-cancelled race is retained conservatively.
      if (value.pendingPreparation || value.unresolvedGenerations !== 0
        || (spawnAuthorized && value.coverage !== 'windows-tree' &&
          !(value.schemaVersion===2 && require('./darwin-owned-lifetime.cjs').authenticatedDarwinSnapshot(value,client,bundle)))) throw new Error('ASSET_LIFETIME_UNCONFIRMED');
      if (value.schemaVersion===2) {
        // Share in-flight/successful cleanup only; retries revalidate above.
        darwinRelease ||= Promise.resolve().then(()=>bundle.release())
          .catch(error => { darwinRelease = null; throw error; });
        await darwinRelease;
      } else await bundle.release();
    },
  });
  return binding;
}
// Only Sidecar's private OS-spawn producer can turn this check into an observation.
function verifyManagedAssetLaunch(client, command, args, env) {
  return launchBindings.get(client)?.(command,args,env) || null;
}
module.exports = { getManagedAssetCoordinator, removeManagedTree, LEASE_LIMITS, prepareVoiceAssets, prepareHybridVoiceAssets, prepareProbeAssets, bindClientAssets, verifyManagedAssetLaunch };
