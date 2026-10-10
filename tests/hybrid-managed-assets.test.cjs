'use strict';
// NON_NATIVE tiny bytes: real manifests, ModelManager, pins and filesystem copies.
// These fixtures never qualify a compiled App, download official models or infer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {ModelManager} = require('../apps/desktop/model-manager.cjs');
const {canonicalInventory} = require('../apps/desktop/tree-integrity.cjs');
const trustModule = require('../apps/desktop/asset-manifest-trust.cjs');
const bundled = require('../apps/desktop/bundled-voice-assets.cjs');
const managed = require('../apps/desktop/managed-asset-lease.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

async function fixture(t, {authenticate = true, alterTrust, install = true, withChoices = false} = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hybrid-managed-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { fs.rmSync(root, {recursive: true, force: true}); }
  });
  const userData = path.join(root, 'user-data');
  const resourcesPath = path.join(root, 'Tiny.app', 'Contents', 'Resources');
  const license = {spdx: 'MIT', url: 'https://example.test/tiny-fixture-license'};
  const contents = {
    'tiny-stt': {'config.json': Buffer.from('{}'), 'weights.safetensors': Buffer.from('tiny synthetic weights')},
    ...(withChoices ? {'tiny-stt-alt': {'config.json': Buffer.from('{"alt":1}'), 'weights.npz': Buffer.from('alternate tier weights')}} : {}),
    'tiny-kokoro': {'model.onnx': Buffer.from('tiny synthetic onnx'), 'voices.bin': Buffer.from('tiny synthetic voices')},
  };
  const artifacts = Object.fromEntries(Object.entries(contents).map(([id, files]) => {
    const inventory = canonicalInventory(Object.entries(files).map(([relative, bytes]) => ({path: relative, bytes: bytes.length, sha256: hash(bytes)})));
    const revision = hash('synthetic source revision').slice(0, 40);
    return [id, {transport: 'raw-files', bytes: inventory.totalBytes, entrypoint: inventory.files[0].path,
      files: inventory.files, treeDigest: inventory.treeDigest,
      sources: Object.fromEntries(inventory.files.map(file => [file.path, `https://huggingface.co/fixture/${id}/resolve/${revision}/${file.path}`])),
      provenance: {sourceRevision: revision, sourceUrl: `https://huggingface.co/fixture/${id}`, license}}];
  }));
  const manifest = {schemaVersion: 3, release: 'hybrid-fixture-v1', models: Object.fromEntries(Object.entries(artifacts).map(([id, artifact]) =>
    [id, {name: id, purpose: 'synthetic model data', license, artifacts: {'darwin-arm64': artifact}}]))};
  if (authenticate) trustModule.authenticateAssetManifest(manifest, 'model', {testOnlyTrustedDigests: [trustModule.manifestDigest(manifest)]});
  let downloads = 0;
  const models = new ModelManager({userData, manifest, platform: 'darwin', arch: 'arm64', fetchImpl: async url => {
    downloads++;
    for (const [id, artifact] of Object.entries(artifacts)) {
      const file = artifact.files.find(file => artifact.sources[file.path] === url);
      if (file) {
        const response = new Response(contents[id][file.path]);
        Object.defineProperty(response, 'url', {value: url});
        return response;
      }
    }
    throw Error('UNEXPECTED_FIXTURE_DOWNLOAD');
  }});
  const installed = {};
  if (install) for (const id of Object.keys(artifacts)) installed[id] = await models.install(id);
  // Inert script; a separately labelled loader seam may execute it with Node.
  const runtimeBytes = Buffer.from("process.stdin.resume(); console.log('{\"event\":\"ready\"}');\n");
  const runtime = canonicalInventory([{path: 'bin/voice-runtime', bytes: runtimeBytes.length, sha256: hash(runtimeBytes)}]);
  const whole = canonicalInventory(runtime.files.map(file => ({...file, path: `runtime/${file.path}`})));
  const command = path.join(resourcesPath, 'voice-assets', 'runtime', 'bin', 'voice-runtime');
  fs.mkdirSync(path.dirname(command), {recursive: true});
  fs.writeFileSync(command, runtimeBytes, {mode: 0o600});
  fs.writeFileSync(path.join(resourcesPath, 'voice-assets-inventory.json'), JSON.stringify({files: whole.files}));
  const rawBinding = id => ({modelId: id, identity: {kind: 'raw-files', treeDigest: artifacts[id].treeDigest}});
  const runtimeTrust = {schemaVersion: 2, mode: 'runtime-only', treeDigest: whole.treeDigest, runtimeTreeDigest: runtime.treeDigest,
    fileCount: whole.fileCount, entrypoint: 'runtime/bin/voice-runtime', runtimeProfile: 'macos-mlx-kokoro-v1',
    modelManifestDigest: trustModule.manifestDigest(manifest), capabilitiesDigest: hash('synthetic capabilities'),
    modelBindings: {sttRoot: rawBinding('tiny-stt'), onnxModel: {...rawBinding('tiny-kokoro'), path: 'model.onnx'},
      onnxVoices: {...rawBinding('tiny-kokoro'), path: 'voices.bin'}},
    ...(withChoices ? {sttChoices: [rawBinding('tiny-stt'), rawBinding('tiny-stt-alt')]} : {})};
  alterTrust?.(runtimeTrust);
  const nativeRuntime = await bundled.prepareBundledRuntimeAssets({resourcesPath, platform: 'darwin', trust: runtimeTrust});
  return {root, cleanups, userData, resourcesPath, command, models, manifest, artifacts, contents, installed,
    runtimeTrust, nativeRuntime, downloads: () => downloads};
}

function prepare(t, f) {
  const lease = managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models);
  // Keep unexpected acceptance observable without an unhandled rejected copy.
  lease.work.catch(() => {});
  f.cleanups.push(async () => { lease.cancel(); await lease.release(); });
  return lease;
}

test('hybrid preparation synchronously owns a models-only private snapshot; App runtime stays in place', async t => {
  assert.equal(typeof managed.prepareHybridVoiceAssets, 'function', 'hybrid preparation API is required');
  const f = await fixture(t);
  const runtimeStat = fs.statSync(f.command);
  const downloads = f.downloads();
  const lease = prepare(t, f);
  for (const key of ['command', 'trustedVoice', 'root', 'payload', 'tempRoot', 'cacheRoot', 'work', 'cancel', 'verify', 'release']) {
    assert.ok(Object.hasOwn(lease, key), `synchronous owner is missing ${key}`);
  }
  assert.ok(lease.work instanceof Promise);
  assert.equal(lease.command, f.command);
  assert.equal(fs.existsSync(lease.root), false, 'registration and reservation precede asynchronous file work');
  assert.equal(f.models.coordinator.snapshot().active, true);
  assert.equal(f.models.coordinator.snapshot().pins, 1);
  const total = Object.values(f.artifacts).reduce((sum, artifact) => sum + artifact.bytes, 0);
  assert.equal(f.models.coordinator.snapshot().reservedBytes, total + managed.LEASE_LIMITS.scratchBytes);
  assert.equal(await lease.work, lease);
  assert.equal(await lease.verify(), true);
  assert.equal(f.models.coordinator.snapshot().active, false);
  assert.equal(f.models.coordinator.snapshot().pins, 1, 'source pins drain; private snapshot remains owned');
  assert.deepEqual(fs.readdirSync(lease.payload), ['models']);
  assert.equal(f.downloads(), downloads, 'preparation never downloads or installs');
  assert.equal(fs.statSync(f.command).ino, runtimeStat.ino);
  assert.equal(lease.trustedVoice.VOICE_MLX_WHISPER_MODEL, path.join(lease.payload, 'models', 'tiny-stt'));
  assert.equal(lease.trustedVoice.VOICE_KOKORO_ONNX_MODEL, path.join(lease.payload, 'models', 'tiny-kokoro', 'model.onnx'));
  assert.equal(lease.trustedVoice.VOICE_KOKORO_ONNX_VOICES, path.join(lease.payload, 'models', 'tiny-kokoro', 'voices.bin'));
  for (const [id, artifact] of Object.entries(f.artifacts)) for (const file of artifact.files) {
    const source = path.join(f.installed[id].directory, file.path);
    const target = path.join(lease.payload, 'models', id, file.path);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source));
    assert.notEqual(fs.statSync(target).ino, fs.statSync(source).ino, 'model snapshot must not hardlink installed data');
    assert.equal(fs.statSync(target).nlink, 1);
    assert.equal(fs.statSync(source).nlink, 1);
    assert.equal(fs.statSync(target).mode & 0o777, 0o400, 'models are data, never executable');
  }
  await lease.release();
  assert.equal(f.models.coordinator.snapshot().pins, 0);
  assert.equal(fs.existsSync(lease.root), false);
  assert.equal(fs.existsSync(f.command), true, 'lease does not own App runtime deletion');
});

test('hybrid requires the original branded runtime capability before acquiring any model pin', async t => {
  const f = await fixture(t);
  const baseline = f.models.coordinator.snapshot();
  let calls = 0, getters = 0;
  f.models.pinCurrent = () => { calls++; throw Error('MUST_NOT_PIN'); };
  const getter = {};
  Object.defineProperty(getter, 'command', {get() { getters++; return f.command; }});
  for (const nativeRuntime of [null, {}, {...f.nativeRuntime}, Object.freeze({...f.nativeRuntime}), getter,
    {...f.nativeRuntime, authority: 'COMPILED_ROOT'}]) {
    assert.throws(() => prepare(t, {...f, nativeRuntime}), /HYBRID_RUNTIME_SOURCE_REQUIRED/);
  }
  assert.equal(getters, 0);
  assert.equal(calls, 0);
  assert.deepEqual(f.models.coordinator.snapshot(), baseline);
});

for (const mode of ['no-root', 'copied-manifest', 'digest-mismatch']) {
  test(`hybrid manifest admission rejects ${mode} before registration`, async t => {
    const f = await fixture(t, {authenticate: mode !== 'no-root',
      alterTrust: mode === 'digest-mismatch' ? trust => { trust.modelManifestDigest = hash('wrong manifest'); } : undefined});
    if (mode === 'copied-manifest') f.models.manifest = Object.freeze({...f.models.manifest});
    const baseline = f.models.coordinator.snapshot();
    assert.throws(() => prepare(t, f), mode === 'digest-mismatch' ? /HYBRID_MODEL_MANIFEST_MISMATCH/ : /HYBRID_MODEL_MANIFEST_UNTRUSTED/);
    assert.deepEqual(f.models.coordinator.snapshot(), baseline);
  });
}

for (const [name, alterTrust, expected] of [
  ['wrong raw tree identity', trust => { trust.modelBindings.sttRoot.identity.treeDigest = hash('other raw tree'); }, /MODEL_BINDING_MISMATCH:sttRoot/],
  ['unknown model ID', trust => { trust.modelBindings.sttRoot.modelId = 'not-in-manifest'; }, /MODEL_BINDING_MISMATCH:sttRoot/],
  ['uninventoried file path', trust => { trust.modelBindings.onnxModel.path = 'other.onnx'; }, /MODEL_BINDING_PATH_MISSING:onnxModel/],
]) {
  test(`hybrid rejects ${name} in an authenticated runtime binding`, async t => {
    const f = await fixture(t, {alterTrust});
    const baseline = f.models.coordinator.snapshot();
    assert.throws(() => prepare(t, f), expected);
    assert.deepEqual(f.models.coordinator.snapshot(), baseline);
  });
}

test('hybrid cannot mix a model-v2 ZIP manifest even when its inventory and manifest digest match', async t => {
  const f = await fixture(t, {install: false});
  const zipManifest = JSON.parse(JSON.stringify(f.manifest));
  zipManifest.schemaVersion = 2;
  for (const [id, model] of Object.entries(zipManifest.models)) {
    const zip = new (require('yazl').ZipFile)();
    for (const [name, bytes] of Object.entries(f.contents[id])) zip.addBuffer(bytes, name);
    zip.end();
    const chunks = []; for await (const chunk of zip.outputStream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), raw = model.artifacts['darwin-arm64'];
    model.artifacts['darwin-arm64'] = {archive: 'zip', url: `https://github.com/fixture/models/releases/download/test/${id}.zip`,
      sha256: hash(bytes), bytes: bytes.length, entrypoint: raw.entrypoint, files: raw.files, treeDigest: raw.treeDigest, provenance: raw.provenance};
  }
  const digest = trustModule.manifestDigest(zipManifest);
  trustModule.authenticateAssetManifest(zipManifest, 'model', {testOnlyTrustedDigests: [digest]});
  const models = new ModelManager({...f.models.options, manifest: zipManifest});
  const nativeRuntime = await bundled.prepareBundledRuntimeAssets({resourcesPath: f.resourcesPath, platform: 'darwin',
    trust: {...f.runtimeTrust, modelManifestDigest: digest}});
  assert.throws(() => prepare(t, {...f, models, nativeRuntime}), /HYBRID_RAW_MODELS_REQUIRED/);
  assert.equal(models.coordinator.snapshot().pins, 0);
});

test('hybrid does not reinterpret its Mac runtime as a Windows speech profile', async t => {
  const f = await fixture(t);
  f.models.options.platform = 'win32'; f.models.options.arch = 'x64';
  assert.throws(() => prepare(t, f), /UNSUPPORTED_HYBRID_SPEECH_PLATFORM/);
  assert.equal(f.models.coordinator.snapshot().pins, 0);
});

for (const [name, mutate] of [
  ['ZIP identity with the same digest text', source => ({...source, identity: {kind: 'zip', archiveSha256: source.treeDigest}})],
  ['wrong raw identity', source => ({...source, identity: {kind: 'raw-files', treeDigest: hash('different raw source')}})],
  ['untyped legacy sha256', source => ({...source, identity: undefined, sha256: source.treeDigest})],
  ['extra identity discriminator data', source => ({...source, identity: {...source.identity, archiveSha256: source.treeDigest}})],
  ['mismatched tree digest', source => ({...source, treeDigest: hash('different tree summary')})],
  ['wrong model ID', source => ({...source, modelId: 'foreign-model'})],
  ['runtime tuple in a model role', source => ({...source, kind: 'runtime'})],
  ['wrong source platform', source => ({...source, platformKey: 'win32-x64-cpu'})],
  ['raw identity carrying a legacy archive field', source => ({...source, sha256: source.treeDigest})],
  ['wrong source entrypoint', source => ({...source, entrypoint: path.join(source.directory, 'unlisted')})],
  ['generation not bound to its payload', source => ({...source, generation: `g-${hash('foreign generation')}`})],
]) {
  test(`hybrid refuses ${name} returned by a pinned model source`, async t => {
    const f = await fixture(t);
    const original = f.models.pinCurrent.bind(f.models);
    let acquired = 0, released = 0;
    f.models.pinCurrent = async (id, owner) => {
      const source = await original(id, owner); acquired++;
      return Object.freeze({...mutate(source), release: async originalOwner => {
        assert.equal(originalOwner, owner);
        assert.equal(await source.release({}), false, 'foreign token cannot release a pinned source');
        const result = await source.release(originalOwner); if (result) released++;
        return result;
      }});
    };
    const lease = prepare(t, f);
    await assert.rejects(lease.work, /ASSET_BINDING_CHANGED/);
    assert.equal(acquired, 1, 'reject the bad source before pinning another model');
    assert.equal(released, 1);
    assert.equal(f.models.coordinator.snapshot().active, false);
    assert.equal(f.models.coordinator.snapshot().pins, 1, 'only the registered private lease remains');
    await lease.release();
    assert.equal(f.models.coordinator.snapshot().pins, 0);
  });
}

test('hybrid shares install admission and holds original source pins through complete snapshot verification', async t => {
  const f = await fixture(t), entered = gate(), held = gate();
  const coordinator = f.models.coordinator;
  const makeManager = f.models._manager.bind(f.models);
  const pinCurrent = f.models.pinCurrent.bind(f.models);
  const sourceOwners = [], releases = [];
  let lease;
  f.models._manager = id => {
    const manager = makeManager(id), status = manager.status.bind(manager);
    manager.status = async () => {
      if (id === 'tiny-stt') {
        assert.equal(coordinator.snapshot().pins, 2, 'source is pinned before its async verification starts');
        entered.resolve(); await held.promise;
      }
      return status();
    };
    return manager;
  };
  f.models.pinCurrent = async (id, owner) => {
    const source = await pinCurrent(id, owner); sourceOwners.push(owner);
    return Object.freeze({...source, release: async originalOwner => {
      assert.equal(originalOwner, owner);
      assert.equal(coordinator.snapshot().active, true, 'source release precedes transaction finish');
      const expected = canonicalInventory(Object.entries(f.artifacts).flatMap(([modelId, artifact]) =>
        artifact.files.map(file => ({...file, path: `models/${modelId}/${file.path}`}))));
      require('../apps/desktop/tree-integrity.cjs').verifyInventorySync(lease.payload, expected);
      assert.equal(await source.release({}), false);
      releases.push(id);
      return source.release(originalOwner);
    }});
  };
  lease = prepare(t, f);
  try {
    await Promise.race([entered.promise, lease.work]);
    const snapshot = coordinator.snapshot();
    assert.equal(snapshot.pins, 2);
    assert.throws(() => managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models), /INSTALL_ALREADY_RUNNING/);
    await assert.rejects(new ModelManager({...f.models.options}).install('tiny-kokoro'), /INSTALL_ALREADY_RUNNING/);
    assert.equal(fs.existsSync(path.join(lease.payload, 'models')), false, 'copy waits for the pinned source verifier');
    assert.deepEqual(coordinator.snapshot(), snapshot, 'rejected installers cannot alter the original reservation');
  } finally { held.resolve(); }
  await lease.work;
  assert.deepEqual(releases, ['tiny-stt', 'tiny-kokoro']);
  assert.equal(sourceOwners[0], sourceOwners[1]);
  assert.equal(coordinator.snapshot().pins, 1);
  const originalDirectory = lease.trustedVoice.VOICE_MLX_WHISPER_MODEL;
  await new ModelManager({...f.models.options}).install('tiny-stt');
  assert.equal(lease.trustedVoice.VOICE_MLX_WHISPER_MODEL, originalDirectory, 'a later installation does not hot-swap the live session');
  assert.equal(await lease.verify(), true);
});

function memoryClient(coverage = 'windows-tree') {
  // MEMORY lifetime only: never native Darwin proof or a real process tree.
  const client = {clientId: require('node:crypto').randomUUID()};
  client.assetLifetimeSnapshot = () => Object.freeze({schemaVersion: 1, clientId: client.clientId, coverage,
    pendingPreparation: false, unresolvedGenerations: 0, unknown: false, fault: false});
  return client;
}
function launchEnvironment(lease) {
  return require('../apps/desktop/sidecar-environment.cjs').buildPackagedSidecarEnvironment({
    tempRoot: lease.tempRoot, cacheRoot: lease.cacheRoot, trustedVoice: lease.trustedVoice, platform: 'darwin', arch: 'arm64'});
}

test('hybrid source registration binds only the original lease/client to a discriminated v3 proof', async t => {
  const f = await fixture(t), lease = prepare(t, f), client = memoryClient();
  const binding = managed.bindClientAssets(client, lease); // registration may precede await
  const env = launchEnvironment(lease);
  assert.throws(() => managed.verifyManagedAssetLaunch(client, lease.command, [], env), /ASSET_LAUNCH_NOT_AUTHORIZED/);
  await lease.work;
  assert.ok(Object.isFrozen(lease), 'captured paths and work cannot be overwritten');
  assert.ok(Object.isFrozen(lease.trustedVoice));
  await binding.beforeSpawn();
  const proof = managed.verifyManagedAssetLaunch(client, lease.command, [], env);
  assert.equal(proof.version, 3);
  assert.equal(proof.authority, 'NON_NATIVE_TEST_ROOT');
  const runtime = bundled.describeBundledRuntimeSource(f.nativeRuntime);
  assert.deepEqual(proof.assets[0], {role: 'runtime', sourceKind: 'bundled-runtime',
    manifestDigest: trustModule.manifestDigest(runtime.trust), treeDigest: runtime.inventory.treeDigest,
    fileCount: runtime.inventory.fileCount, totalBytes: runtime.inventory.totalBytes});
  for (const [i, role] of ['sttRoot', 'onnxModel', 'onnxVoices'].entries()) {
    const {modelId, identity} = f.runtimeTrust.modelBindings[role], artifact = f.artifacts[modelId];
    assert.deepEqual(proof.assets[i + 1], {role, sourceKind: 'raw-model',
      manifestDigest: trustModule.manifestDigest(f.models.manifest), identity,
      treeDigest: artifact.treeDigest, fileCount: artifact.files.length, totalBytes: artifact.bytes,
      sourceGeneration: f.installed[modelId].generation});
    assert.ok(Object.isFrozen(proof.assets[i + 1].identity));
  }
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.assets) && proof.assets.every(Object.isFrozen));
  assert.equal(JSON.stringify(proof).includes('archiveSha256'), false);
  assert.equal(JSON.stringify(proof).includes(f.root), false);
  assert.equal(Object.hasOwn(proof.assets[0], 'sourceGeneration'), false);
  assert.equal(managed.verifyManagedAssetLaunch(memoryClient(), lease.command, [], env), null, 'foreign client has no producer binding');
  const copied = {...lease}, other = memoryClient();
  const copiedBinding = managed.bindClientAssets(other, copied);
  await copiedBinding.beforeSpawn();
  assert.equal(managed.verifyManagedAssetLaunch(other, lease.command, [], env), null, 'copied lease data cannot acquire source authority');
  binding.retire();
  await assert.rejects(binding.release(other, lease), /ASSET_LIFETIME_UNCONFIRMED/);
  await assert.rejects(binding.release(client, copied), /ASSET_LIFETIME_UNCONFIRMED/);
  assert.equal(f.models.coordinator.snapshot().pins, 1);
  await binding.release(client, lease);
  assert.equal(f.models.coordinator.snapshot().pins, 0);
});

for (const root of ['runtime', 'models']) {
  test(`hybrid final same-stack launch rejects ${root} bytes changed after async verification`, async t => {
    const f = await fixture(t), lease = prepare(t, f);
    await lease.work;
    const client = memoryClient(), binding = managed.bindClientAssets(client, lease);
    await binding.beforeSpawn();
    const target = root === 'runtime' ? f.command : lease.trustedVoice.VOICE_KOKORO_ONNX_MODEL;
    const original = fs.readFileSync(target), changed = Buffer.from(original); changed[0] ^= 1;
    fs.chmodSync(target, 0o600); fs.writeFileSync(target, changed);
    assert.throws(() => managed.verifyManagedAssetLaunch(client, lease.command, [], launchEnvironment(lease)), /INVENTORY_/);
    fs.writeFileSync(target, original);
    assert.equal(managed.verifyManagedAssetLaunch(client, lease.command, [], launchEnvironment(lease)).version, 3);
    binding.retire(); await binding.release(client, lease);
  });
}

test('hybrid async beforeSpawn revalidates the App root as well as its private model payload', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  await lease.work;
  const client = memoryClient(), binding = managed.bindClientAssets(client, lease);
  fs.appendFileSync(f.command, 'changed runtime');
  await assert.rejects(binding.beforeSpawn(), /INVENTORY_/);
  binding.retire(); await binding.release(client, lease);
});

test('hybrid launch stays bound to the exact command, empty args and allowlisted environment', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  await lease.work;
  const client = memoryClient(), binding = managed.bindClientAssets(client, lease), env = launchEnvironment(lease);
  await binding.beforeSpawn();
  for (const [command, args, environment] of [
    [path.join(lease.payload, 'runtime', 'bin', 'voice-runtime'), [], env],
    [lease.command, ['--other-runtime'], env],
    [lease.command, [], {...env, VOICE_MLX_WHISPER_MODEL: f.installed['tiny-stt'].directory}],
    [lease.command, [], {...env, PATH: '/untrusted'}],
    [lease.command, [], Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'HF_HUB_OFFLINE'))],
  ]) assert.throws(() => managed.verifyManagedAssetLaunch(client, command, args, environment), /ASSET_LAUNCH_BINDING_CHANGED/);
  lease.cancel();
  assert.throws(() => managed.verifyManagedAssetLaunch(client, lease.command, [], env), /ASSET_PREPARATION_ABORTED/);
  binding.retire(); await binding.release(client, lease);
});

test('hybrid retirement never accepts a self-declared Darwin scope or leader-only coverage', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  await lease.work;
  const client = memoryClient('leader-only'), originalSnapshot = client.assetLifetimeSnapshot;
  const binding = managed.bindClientAssets(client, lease);
  await binding.beforeSpawn(); binding.retire();
  await assert.rejects(binding.release(client, lease), /ASSET_LIFETIME_UNCONFIRMED/);
  const leader = originalSnapshot();
  client.assetLifetimeSnapshot = () => Object.freeze({...leader, schemaVersion: 2, coverage: 'darwin-owned-handles',
    qualificationScope: 'DARWIN_KERNEL_NO_FORK_RUNTIME_V1', purpose: 'hybrid-speech'});
  await assert.rejects(binding.release(client, lease), /ASSET_LIFETIME_UNCONFIRMED/);
  assert.equal(f.models.coordinator.snapshot().pins, 1);
  assert.equal(fs.existsSync(lease.payload), true);
  // fixture cleanup is not production retirement evidence
});

test('hybrid binds each lease to one original client until retirement, never a replacement owner', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  await lease.work;
  const original = memoryClient(), binding = managed.bindClientAssets(original, lease);
  assert.throws(() => managed.bindClientAssets(memoryClient(), lease), /ASSET_CLIENT_OWNER_MISMATCH/);
  assert.throws(() => managed.bindClientAssets(original, lease), /ASSET_CLIENT_OWNER_MISMATCH/);
  const successorLease = prepare(t, f);
  await successorLease.work;
  assert.throws(() => managed.bindClientAssets(original, successorLease), /ASSET_CLIENT_OWNER_MISMATCH/,
    'a new lease cannot replace the original client launch binding');
  await binding.beforeSpawn();
  assert.equal(managed.verifyManagedAssetLaunch(original, lease.command, [], launchEnvironment(lease)).version, 3);
  binding.retire();
  assert.throws(() => managed.bindClientAssets(memoryClient(), lease), /ASSET_CLIENT_OWNER_MISMATCH/);
  await binding.release(original, lease);
});

for (const failure of ['false', 'throw']) {
  test(`hybrid source-release ${failure} retains its original handle, drains peers and finishes admission`, async t => {
    const f = await fixture(t), pinCurrent = f.models.pinCurrent.bind(f.models);
    let fail = true;
    const released = [];
    f.models.pinCurrent = async (id, owner) => {
      const source = await pinCurrent(id, owner);
      return Object.freeze({...source, release: async originalOwner => {
        assert.equal(originalOwner, owner);
        if (id === 'tiny-stt' && fail) {
          if (failure === 'throw') throw Error('FIXTURE_SOURCE_RELEASE_FAILED');
          return false;
        }
        const result = await source.release(originalOwner);
        assert.equal(result, true, 'successful source handles are never released twice');
        released.push(id); return result;
      }});
    };
    const lease = prepare(t, f);
    try {
      await assert.rejects(lease.work, failure === 'throw' ? /FIXTURE_SOURCE_RELEASE_FAILED/ : /ASSET_SOURCE_PIN_OWNER_MISMATCH/);
      assert.equal(f.models.coordinator.snapshot().active, false);
      assert.equal(f.models.coordinator.snapshot().pins, 2, 'failed source pin and private snapshot remain owned');
      assert.deepEqual(released, ['tiny-kokoro'], 'one bad source does not abandon other original handles');
      await assert.rejects(lease.release());
      assert.equal(f.models.coordinator.snapshot().pins, 2);
    } finally { fail = false; }
    await lease.release();
    assert.deepEqual(released, ['tiny-kokoro', 'tiny-stt']);
    assert.equal(f.models.coordinator.snapshot().pins, 0);
    assert.equal(fs.existsSync(lease.root), false);
  });
}

test('hybrid release joins held preparation and concurrent callers share one original cleanup', async t => {
  const f = await fixture(t), entered = gate(), held = gate();
  const pinCurrent = f.models.pinCurrent.bind(f.models);
  f.models.pinCurrent = async (...args) => {
    const source = await pinCurrent(...args); entered.resolve(); await held.promise; return source;
  };
  const lease = prepare(t, f);
  let released = false;
  try {
    await Promise.race([entered.promise, lease.work]);
    lease.cancel();
    const first = lease.release().then(() => { released = true; });
    const second = lease.release();
    const both = Promise.all([first, second]); both.catch(() => {});
    await new Promise(setImmediate);
    assert.equal(released, false);
    assert.equal(f.models.coordinator.snapshot().pins, 2);
    assert.equal(f.models.coordinator.snapshot().active, true);
    held.resolve();
    await assert.rejects(lease.work, /ASSET_PREPARATION_ABORTED/);
    await both;
    assert.equal(f.models.coordinator.snapshot().pins, 0);
    assert.equal(f.models.coordinator.snapshot().active, false);
    assert.equal(fs.existsSync(lease.root), false);
  } finally { held.resolve(); }
});

for (const installedIds of [[], ['tiny-stt']]) {
  test(`hybrid missing required models (${installedIds.join(',') || 'none'} installed) never creates source proof or downloads`, async t => {
    const f = await fixture(t, {install: false});
    for (const id of installedIds) await f.models.install(id);
    const downloads = f.downloads(), lease = prepare(t, f);
    await assert.rejects(lease.work, /UNTRUSTED_ACTIVATION_METADATA/);
    assert.equal(f.downloads(), downloads);
    assert.equal(f.models.coordinator.snapshot().active, false);
    assert.equal(f.models.coordinator.snapshot().pins, 1);
    await lease.release();
    assert.equal(f.models.coordinator.snapshot().pins, 0);
    assert.equal(fs.existsSync(lease.root), false);
  });
}

test('an in-flight model install excludes hybrid preparation on the same app-root coordinator', async t => {
  const f = await fixture(t, {install: false}), entered = gate(), held = gate();
  const fetch = f.models.options.fetchImpl;
  f.models.options.fetchImpl = async (...args) => { entered.resolve(); await held.promise; return fetch(...args); };
  const pending = f.models.install('tiny-stt'); pending.catch(() => {});
  try {
    await Promise.race([pending, entered.promise]);
    const snapshot = f.models.coordinator.snapshot();
    assert.throws(() => managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models), /INSTALL_ALREADY_RUNNING/);
    assert.deepEqual(f.models.coordinator.snapshot(), snapshot);
  } finally { held.resolve(); }
  assert.equal((await pending).state, 'installed');
});

test('hybrid pre-work cancellation removes only the registered uncreated snapshot', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  lease.cancel();
  await assert.rejects(lease.work, /ASSET_PREPARATION_ABORTED/);
  assert.equal(fs.existsSync(lease.root), false);
  assert.equal(f.models.coordinator.snapshot().pins, 1);
  await lease.release();
  assert.equal(f.models.coordinator.snapshot().pins, 0);
  assert.equal(fs.existsSync(f.command), true);
  for (const source of Object.values(f.installed)) assert.equal(fs.existsSync(source.directory), true);
});

test('hybrid reservation obeys the shared free-space floor without taking source pins', async t => {
  const f = await fixture(t), original = f.models.coordinator.io.statfs;
  f.models.coordinator.io.statfs = () => ({bavail: 0, bsize: 4096});
  try {
    const lease = prepare(t, f);
    await assert.rejects(lease.work, /DISK_FREE_RESERVE/);
    assert.equal(f.models.coordinator.snapshot().pins, 1);
    assert.equal(f.models.coordinator.snapshot().active, false);
    await lease.release();
  } finally { f.models.coordinator.io.statfs = original; }
  const retry = prepare(t, f); await retry.work;
  assert.equal(await retry.verify(), true);
});

test('hybrid cleanup retains changed ownership and retries with the original snapshot identity only', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  await lease.work;
  const backup = `${lease.root}-owned-backup`;
  fs.renameSync(lease.root, backup); fs.mkdirSync(lease.root, {mode: 0o700});
  try {
    await assert.rejects(lease.release(), /ASSET_CLEANUP_FAILED/);
    const retained = f.models.coordinator.snapshot().retained.find(record => record.root === lease.root);
    assert.equal(retained.error, 'CLEANUP_OWNERSHIP_CHANGED');
    assert.ok(retained.reservation > 0);
    assert.equal(fs.existsSync(lease.root), true, 'replacement directory must not be deleted');
  } finally { fs.rmdirSync(lease.root); fs.renameSync(backup, lease.root); }
  await lease.release();
  assert.equal(fs.existsSync(lease.root), false);
});

test('hybrid retirement waits for every original pending/unknown/fault generation obligation', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  await lease.work;
  const client = memoryClient(), snapshot = client.assetLifetimeSnapshot;
  const binding = managed.bindClientAssets(client, lease);
  await binding.beforeSpawn(); binding.retire();
  for (const change of [{pendingPreparation: true}, {unresolvedGenerations: 1}, {unknown: true}, {fault: true},
    {clientId: require('node:crypto').randomUUID()}]) {
    client.assetLifetimeSnapshot = () => Object.freeze({...snapshot(), ...change});
    await assert.rejects(binding.release(client, lease), /ASSET_LIFETIME_UNCONFIRMED/);
    assert.equal(f.models.coordinator.snapshot().pins, 1);
  }
  client.assetLifetimeSnapshot = snapshot;
  await binding.release(client, lease);
  assert.equal(f.models.coordinator.snapshot().pins, 0);
});

test('released hybrid lease cannot regain authority from recreated identical model bytes', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  await lease.work; await lease.release();
  assert.equal(f.models.coordinator.snapshot().pins, 0);
  for (const [id, files] of Object.entries(f.contents)) for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(lease.payload, 'models', id, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes);
  }
  await assert.rejects(lease.verify(), /ASSET_PREPARATION_RELEASED/);
  const client = memoryClient(), binding = managed.bindClientAssets(client, lease);
  await assert.rejects(binding.beforeSpawn(), /ASSET_PREPARATION_RELEASED/);
  assert.throws(() => managed.verifyManagedAssetLaunch(client, lease.command, [], launchEnvironment(lease)), /ASSET_LAUNCH_NOT_AUTHORIZED/);
});

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('HYBRID_FIXTURE_DEADLINE')), 4000); })]); }
  finally { clearTimeout(timer); }
}
function sidecarBoundary(t, f, lease) {
  // Real Sidecar code + inert owned Node processes. Only executable loading and
  // the platform view are MEMORY seams; no compiled/native source is created.
  const vm = require('node:vm'), cp = require('node:child_process');
  const filename = path.join(__dirname, '../apps/desktop/sidecar-client.cjs');
  const req = require('node:module').createRequire(filename);
  const children = [], launches = [];
  const context = {module: {exports: {}}, console, Buffer, setTimeout, clearTimeout,
    process: {platform: 'darwin', arch: 'arm64', execPath: process.execPath, env: process.env},
    require: name => name === 'node:child_process' ? {...cp, spawn(command, args, options) {
      launches.push({command, args: [...args], env: {...options.env}});
      const child = cp.spawn(process.execPath, [command, ...args], options);
      const closed = new Promise(resolve => child.once('close', resolve));
      children.push({child, closed}); return child;
    }} : req(name)};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, {filename});
  const {SidecarClient} = context.module.exports;
  const client = new SidecarClient({command: lease.command, env: launchEnvironment(lease), trackAssetLifetime: true,
    lifetimePurpose: 'hybrid-speech', nativeRuntime: f.nativeRuntime, stopGraceMs: 30, stopKillWaitMs: 300});
  const binding = managed.bindClientAssets(client, lease);
  client.beforeSpawn = () => binding.beforeSpawn();
  f.cleanups.push(async () => {
    binding.retire();
    try { await bounded(client.stop()); }
    finally {
      for (const {child, closed} of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await bounded(closed);
        assert.throws(() => process.kill(child.pid, 0), {code: 'ESRCH'});
        t.diagnostic(`inert-fixture pid=${child.pid} reaped=true; not native runtime evidence`);
      }
    }
  });
  return {client, binding, SidecarClient, children, launches};
}

test('real Sidecar consumes v3 only at actual spawn, keeps original generation source and refuses leader-only retirement', async t => {
  const f = await fixture(t), lease = prepare(t, f);
  await lease.work;
  const h = sidecarBoundary(t, f, lease);
  assert.equal(h.SidecarClient.observeManagedAssets(h.client).status, 'NOT_PROVEN');
  await bounded(h.client.start());
  const source = h.SidecarClient.observeManagedAssets(h.client);
  const contract = require('../apps/desktop/asset-source-observation.cjs');
  contract.validateSource(source);
  assert.equal(source.version, 3);
  assert.equal(source.authority, 'NON_NATIVE_TEST_ROOT');
  assert.equal(source.coverage, 'leader-only');
  assert.equal(source.pid, h.children[0].child.pid);
  assert.equal(h.launches[0].command, f.command);
  assert.deepEqual(h.launches[0].args, []);
  assert.equal(h.launches[0].env.VOICE_KOKORO_ONNX_MODEL, lease.trustedVoice.VOICE_KOKORO_ONNX_MODEL);
  assert.equal(h.SidecarClient.observeManagedAssets({...h.client}).reason, 'NO_MANAGED_LAUNCH');
  const generation = h.client.processGeneration;
  h.client.processGeneration = require('node:crypto').randomUUID();
  assert.equal(h.SidecarClient.observeManagedAssets(h.client).reason, 'SOURCE_NOT_CURRENT');
  h.client.processGeneration = generation;
  const identity = {launchNonce: 'real-sidecar-tiny-hybrid', mainPid: process.pid, webContentsId: 17};
  const authority = contract.createAssetSourceAuthority({...identity, observe: () => h.SidecarClient.observeManagedAssets(h.client)}, 'test-secret');
  const consumer = contract.createAssetSourceConsumer(identity, 'test-secret');
  try {
    const received = await consumer.read(command => authority(command, 17));
    assert.equal(received.generation, generation);
    assert.equal(contract.authenticatedSource(received, identity), true);
    assert.equal(contract.authenticatedSource({...received}, identity), false);
  } finally { consumer.dispose(); }
  await bounded(h.client.cancel());
  assert.equal(h.SidecarClient.observeManagedAssets(h.client).reason, 'SOURCE_NOT_CURRENT');
  assert.equal(f.models.coordinator.snapshot().pins, 1);
  await bounded(h.client.start());
  assert.notEqual(h.client.processGeneration, generation);
  assert.equal(h.SidecarClient.observeManagedAssets(h.client).assets, source.assets, 'same lease survives ordinary Stop/restart');
  h.binding.retire(); await bounded(h.client.stop());
  await assert.rejects(h.binding.release(h.client, lease), /ASSET_LIFETIME_UNCONFIRMED/);
  assert.equal(f.models.coordinator.snapshot().pins, 1);
  assert.equal(fs.existsSync(lease.payload), true);
});

for (const mutation of ['runtime', 'models', 'command', 'args', 'env']) {
  test(`actual Sidecar spawn is denied after post-verification ${mutation} mutation`, async t => {
    const f = await fixture(t), lease = prepare(t, f);
    await lease.work;
    const h = sidecarBoundary(t, f, lease);
    h.client.beforeSpawn = async () => {
      await h.binding.beforeSpawn();
      if (mutation === 'runtime' || mutation === 'models') {
        const file = mutation === 'runtime' ? f.command : lease.trustedVoice.VOICE_KOKORO_ONNX_MODEL;
        const bytes = fs.readFileSync(file); bytes[0] ^= 1;
        fs.chmodSync(file, 0o600); fs.writeFileSync(file, bytes);
      } else if (mutation === 'command') h.client.command = process.execPath;
      else if (mutation === 'args') h.client.args = ['--inspect'];
      else h.client.env.HF_HUB_OFFLINE = '0';
      return true;
    };
    await assert.rejects(bounded(h.client.start()), /INVENTORY_|ASSET_LAUNCH_BINDING_CHANGED/);
    assert.equal(h.launches.length, 0, 'last synchronous gate must run before the OS boundary');
    assert.equal(h.SidecarClient.observeManagedAssets(h.client).status, 'NOT_PROVEN');
    h.binding.retire(); await bounded(h.client.stop());
    await assert.rejects(h.binding.release(h.client, lease), /ASSET_LIFETIME_UNCONFIRMED/, 'authorized-but-cancelled leader race is deliberately retained');
    assert.equal(f.models.coordinator.snapshot().pins, 1);
  });
}

test('hybrid detects same-size source mutation after pin verification and releases its source owner', async t => {
  const f = await fixture(t);
  const original = f.models.pinCurrent.bind(f.models);
  f.models.pinCurrent = async (...args) => {
    const source = await original(...args);
    const file = path.join(source.directory, f.artifacts[args[0]].files[0].path);
    const bytes = fs.readFileSync(file); bytes[0] ^= 1;
    fs.writeFileSync(file, bytes);
    return source;
  };
  const lease = prepare(t, f);
  await assert.rejects(lease.work, /INVENTORY_FILE_MISMATCH|ASSET_COPY_SOURCE_CHANGED/);
  assert.equal(f.models.coordinator.snapshot().pins, 1);
  assert.equal(f.models.coordinator.snapshot().active, false);
});

test('STT choice: the snapshot contains only the selected STT pack plus TTS; others are never copied', async t => {
  const f = await fixture(t, {withChoices: true});
  const lease = managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models, {sttModelId: 'tiny-stt-alt'});
  lease.work.catch(() => {});
  f.cleanups.push(async () => { lease.cancel(); await lease.release(); });
  await lease.work;
  const listed = fs.readdirSync(path.join(lease.payload, 'models')).sort();
  assert.deepEqual(listed, ['tiny-kokoro', 'tiny-stt-alt']);
  assert.equal(lease.trustedVoice.VOICE_MLX_WHISPER_MODEL, path.join(lease.payload, 'models', 'tiny-stt-alt'));
  await lease.verify();
});

test('STT choice: default (no selection) keeps the legacy snapshot; an unlisted selection is refused before any work', async t => {
  const f = await fixture(t, {withChoices: true});
  assert.throws(() => managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models, {sttModelId: 'not-allowed'}), /STT_MODEL_NOT_ALLOWED/);
  assert.equal(f.models.coordinator.snapshot().pins, 0, 'refusal happens before any pin or reservation');
  const lease = prepare(t, f);
  await lease.work;
  assert.deepEqual(fs.readdirSync(path.join(lease.payload, 'models')).sort(), ['tiny-kokoro', 'tiny-stt']);
});

test('model remove: refuses protected ids and pinned (in-use) snapshots; removes an idle install completely', async t => {
  const f = await fixture(t, {withChoices: true});
  const modelRoot = id => path.join(f.userData, 'models', id);
  assert.ok(fs.existsSync(modelRoot('tiny-stt-alt')));
  await assert.rejects(f.models.remove('tiny-kokoro', {protectedIds: ['tiny-kokoro']}), /MODEL_IN_USE/);
  // Design: a lease copies the selected pack into its own snapshot, then releases the
  // install pin. Removing the install directory therefore cannot break a running
  // sidecar; the in-use guard is Main's protectedIds (tested in macos-model-main).
  const lease = managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models, {sttModelId: 'tiny-stt-alt'});
  lease.work.catch(() => {});
  await lease.work;
  assert.deepEqual({...await f.models.remove('tiny-stt-alt')}, {removed: true});
  assert.equal(fs.existsSync(modelRoot('tiny-stt-alt')), false);
  await lease.verify(); // the snapshot is intact and still hash-verifies
  assert.ok(fs.existsSync(path.join(lease.payload, 'models', 'tiny-stt-alt')));
  lease.cancel(); await lease.release();
  await f.models.install('tiny-stt-alt');
  // The non-selected tier was never pinned by this lease and can be removed.
  assert.deepEqual({...await f.models.remove('tiny-stt')}, {removed: true});
  assert.equal(fs.existsSync(modelRoot('tiny-stt')), false);
  assert.equal((await f.models.status('tiny-stt')).state !== 'installed', true);
  assert.deepEqual({...await f.models.remove('tiny-stt')}, {removed: false}, 'second remove is a no-op');
  await assert.rejects(f.models.remove('not-in-manifest'), /UNKNOWN_MODEL/);
  // Reinstall after removal works through the normal verified path.
  await f.models.install('tiny-stt');
  assert.equal((await f.models.status('tiny-stt')).state, 'installed');
});

test('model remove refuses while an install or preparation holds the coordinator', async t => {
  const f = await fixture(t, {withChoices: true});
  const lease = managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models, {sttModelId: 'tiny-stt-alt'});
  lease.work.catch(() => {});
  f.cleanups.push(async () => { lease.cancel(); await lease.release(); });
  // Preparation is synchronous-owned: the coordinator is active until work settles.
  await assert.rejects(f.models.remove('tiny-stt'), /INSTALL_ALREADY_RUNNING/);
  await lease.work;
});
