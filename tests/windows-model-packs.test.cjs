'use strict';
// Windows W1 (CPU only): runtime-only trust, catalog, hybrid lease profile.
// NON_NATIVE: tiny synthetic bytes and real managers; no App, no inference.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const CATALOG_FILE = path.join(ROOT, 'resources/windows-model-packs.json');
const { manifestDigest } = require('../apps/desktop/asset-manifest-trust.cjs');
const bundled = require('../apps/desktop/bundled-voice-assets.cjs');
const { canonicalInventory } = require('../apps/desktop/tree-integrity.cjs');
const trustModule = require('../apps/desktop/asset-manifest-trust.cjs');
const { ModelManager } = require('../apps/desktop/model-manager.cjs');
const managed = require('../apps/desktop/managed-asset-lease.cjs');
const { selectPackagedSpeechProfile } = require('../apps/desktop/packaged-speech-profile.cjs');
const { buildPackagedSidecarEnvironment } = require('../apps/desktop/sidecar-environment.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const catalog = () => JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));

function winTrust(c = catalog()) {
  return { schemaVersion: 2, mode: 'runtime-only', treeDigest: hash('w tree'), runtimeTreeDigest: hash('w runtime'),
    fileCount: 1, entrypoint: 'runtime/bin/voice-runtime.exe', runtimeProfile: 'windows-ct2-kokoro-cpu-v1',
    modelManifestDigest: manifestDigest(c.modelManifest), capabilitiesDigest: manifestDigest(c.capabilities),
    modelBindings: clone(c.modelBindings), ...(c.sttChoices ? { sttChoices: clone(c.sttChoices) } : {}) };
}

test('Windows catalog pins the official faster-whisper small.en revision and the macOS Kokoro fp16 bytes', () => {
  const c = catalog();
  const mac = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/macos-model-packs.json'), 'utf8'));
  assert.equal(c.capabilities.platformKey, 'win32-x64-cpu');
  assert.equal(c.capabilities.runtimeProfile, 'windows-ct2-kokoro-cpu-v1');
  assert.deepEqual(c.capabilities.enabledLanguages, ['en']);
  const stt = c.modelManifest.models['faster-whisper-small-en'].artifacts['win32-x64-cpu'];
  const rev = 'd1d751a5f8271d482d14ca55d9e2deeebbae577f';
  assert.deepEqual(stt.files.map(f => [f.path, f.bytes, f.sha256]), [
    ['config.json', 2657, '666a9605530ac1f61fa8177f3702b4dacec9966749e42610839fcc32661d5fae'],
    ['model.bin', 483545366, '62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a'],
    ['tokenizer.json', 2128466, '929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df'],
    ['vocabulary.txt', 422309, 'ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf']]);
  for (const f of stt.files) assert.equal(stt.sources[f.path], `https://huggingface.co/Systran/faster-whisper-small.en/resolve/${rev}/${f.path}`);
  assert.equal(stt.treeDigest, canonicalInventory(stt.files).treeDigest);
  assert.deepEqual(c.modelManifest.models['kokoro-v1-fp16'].artifacts['win32-x64-cpu'],
    mac.modelManifest.models['kokoro-v1-fp16'].artifacts['darwin-arm64']);
  assert.deepEqual(Object.keys(c.modelManifest.models['kokoro-v1-fp16'].artifacts), ['win32-x64-cpu']);
});

test('win32 runtime-only trust is admitted only with the exact .exe entrypoint and Windows CPU profile', () => {
  const trusted = bundled.loadTrust(winTrust(), 'win32');
  assert.equal(trusted.runtimeProfile, 'windows-ct2-kokoro-cpu-v1');
  for (const mutate of [t => { t.entrypoint = 'runtime/bin/voice-runtime'; }, t => { t.runtimeProfile = 'macos-mlx-kokoro-v1'; },
    t => { t.runtimeProfile = 'windows-ct2-kokoro-cuda-v1'; }, t => { t.entrypoint = 'runtime/bin/VOICE-RUNTIME.EXE'; }]) {
    const t = winTrust(); mutate(t);
    assert.throws(() => bundled.loadTrust(t, 'win32'), /BUNDLED_TRUST_INVALID/);
  }
  // Cross-platform confusion stays closed in both directions.
  assert.throws(() => bundled.loadTrust(winTrust(), 'darwin'), /BUNDLED_TRUST_INVALID/);
  const mac = { ...winTrust(), entrypoint: 'runtime/bin/voice-runtime', runtimeProfile: 'macos-mlx-kokoro-v1' };
  assert.equal(bundled.loadTrust(mac, 'darwin').runtimeProfile, 'macos-mlx-kokoro-v1');
  assert.throws(() => bundled.loadTrust(mac, 'win32'), /BUNDLED_TRUST_INVALID/);
  assert.throws(() => bundled.loadTrust(winTrust(), 'linux'), /BUNDLED_TRUST_INVALID/);
});

test('Windows catalog parser binds both compiled digests and rejects the macOS catalog', () => {
  const { parseWindowsModelCatalog, parseMacosModelCatalog } = require('../apps/desktop/macos-model-catalog.cjs');
  const c = catalog();
  const parsed = parseWindowsModelCatalog(c.capabilities, winTrust(c), c.modelManifest);
  assert.equal(parsed.platformKey, 'win32-x64-cpu');
  assert.deepEqual(parsed.models.map(m => m.kind), ['stt', 'stt', 'stt', 'stt', 'tts']);
  const changed = clone(c.capabilities); changed.models[0].languages = ['en', 'ja'];
  assert.throws(() => parseWindowsModelCatalog(changed, winTrust(c), c.modelManifest), /MODEL_CATALOG_/);
  const mac = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/macos-model-packs.json'), 'utf8'));
  assert.throws(() => parseWindowsModelCatalog(mac.capabilities, winTrust(c), mac.modelManifest), /MODEL_CATALOG_/);
  assert.throws(() => parseMacosModelCatalog(c.capabilities, winTrust(c), c.modelManifest), /BUNDLED_TRUST_INVALID|MODEL_CATALOG_/);
});

test('Windows hybrid speech profile is fixed CPU int8 faster-whisper and refuses CUDA/auto', () => {
  const p = selectPackagedSpeechProfile('win32', 'x64', { hybrid: true });
  assert.deepEqual(p.enums, { VOICE_TTS_BACKEND: 'kokoro-onnx', VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu', VOICE_STT_BACKEND: 'faster-whisper',
    VOICE_FASTER_WHISPER_DEVICE: 'cpu', VOICE_FASTER_WHISPER_COMPUTE_TYPE: 'int8', VOICE_ACCELERATOR: 'cpu' });
  const env = { VOICE_STT_BACKEND: 'faster-whisper', VOICE_ACCELERATOR: 'cuda' };
  assert.throws(() => buildPackagedSidecarEnvironment({ parent: {}, tempRoot: 'C:\\t', trustedVoice: env, platform: 'win32', arch: 'x64', hybrid: true }),
    /INVALID_SIDECAR_ENV_VALUE:VOICE_ACCELERATOR/);
  // Legacy schema1 bundled profile and darwin profile are unchanged.
  assert.equal(selectPackagedSpeechProfile('win32', 'x64', { bundled: true }).enums.VOICE_ACCELERATOR, 'auto');
  assert.equal(selectPackagedSpeechProfile('win32', 'x64').enums.VOICE_ACCELERATOR, undefined);
  assert.equal(selectPackagedSpeechProfile('darwin', 'arm64', { hybrid: true }).enums.VOICE_STT_BACKEND, 'mlx-whisper');
});

async function hybridFixture(t, { flavor } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'win-hybrid-'));
  const cleanups = [];
  t.after(async () => { try { for (const c of cleanups.reverse()) await c(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  const license = { spdx: 'MIT', url: 'https://example.test/license' };
  const contents = {
    'tiny-ct2': { 'config.json': Buffer.from('{}'), 'model.bin': Buffer.from('tiny ct2'), 'tokenizer.json': Buffer.from('{}'), 'vocabulary.txt': Buffer.from('a') },
    'tiny-kokoro': { 'model.onnx': Buffer.from('tiny onnx'), 'voices.bin': Buffer.from('tiny voices') },
  };
  const artifacts = Object.fromEntries(Object.entries(contents).map(([id, files]) => {
    const inv = canonicalInventory(Object.entries(files).map(([p, b]) => ({ path: p, bytes: b.length, sha256: hash(b) })));
    const rev = hash('rev').slice(0, 40);
    return [id, { transport: 'raw-files', bytes: inv.totalBytes, entrypoint: 'config.json' in files ? 'config.json' : inv.files[0].path,
      files: inv.files, treeDigest: inv.treeDigest,
      sources: Object.fromEntries(inv.files.map(f => [f.path, `https://huggingface.co/fixture/${id}/resolve/${rev}/${f.path}`])),
      provenance: { sourceRevision: rev, sourceUrl: `https://huggingface.co/fixture/${id}`, license } }];
  }));
  const manifest = { schemaVersion: 3, release: 'win-fixture', models: Object.fromEntries(Object.entries(artifacts).map(([id, a]) =>
    [id, { name: id, purpose: 'synthetic', license, artifacts: { 'win32-x64-cpu': a } }])) };
  trustModule.authenticateAssetManifest(manifest, 'model', { testOnlyTrustedDigests: [trustModule.manifestDigest(manifest)] });
  const models = new ModelManager({ userData: path.join(root, 'ud'), manifest, platform: 'win32', arch: 'x64',
    ...(flavor ? { flavor } : {}), fetchImpl: async url => {
      for (const [id, a] of Object.entries(artifacts)) {
        const f = a.files.find(file => a.sources[file.path] === url);
        if (f) { const r = new Response(contents[id][f.path]); Object.defineProperty(r, 'url', { value: url }); return r; }
      }
      throw Error('UNEXPECTED');
    } });
  if (!flavor || flavor === 'cpu') for (const id of Object.keys(artifacts)) await models.install(id);
  const resourcesPath = path.join(root, 'App', 'resources');
  const exe = Buffer.from('MZ synthetic');
  const runtime = canonicalInventory([{ path: 'bin/voice-runtime.exe', bytes: exe.length, sha256: hash(exe) }]);
  const whole = canonicalInventory(runtime.files.map(f => ({ ...f, path: 'runtime/' + f.path })));
  fs.mkdirSync(path.join(resourcesPath, 'voice-assets/runtime/bin'), { recursive: true });
  fs.writeFileSync(path.join(resourcesPath, 'voice-assets/runtime/bin/voice-runtime.exe'), exe);
  fs.writeFileSync(path.join(resourcesPath, 'voice-assets-inventory.json'), JSON.stringify({ files: whole.files }));
  const b = id => ({ modelId: id, identity: { kind: 'raw-files', treeDigest: artifacts[id].treeDigest } });
  const trust = { schemaVersion: 2, mode: 'runtime-only', treeDigest: whole.treeDigest, runtimeTreeDigest: runtime.treeDigest,
    fileCount: 1, entrypoint: 'runtime/bin/voice-runtime.exe', runtimeProfile: 'windows-ct2-kokoro-cpu-v1',
    modelManifestDigest: trustModule.manifestDigest(manifest), capabilitiesDigest: hash('caps'),
    modelBindings: { sttRoot: b('tiny-ct2'), onnxModel: { ...b('tiny-kokoro'), path: 'model.onnx' }, onnxVoices: { ...b('tiny-kokoro'), path: 'voices.bin' } } };
  const nativeRuntime = await bundled.prepareBundledRuntimeAssets({ resourcesPath, platform: 'win32', trust });
  return { models, nativeRuntime, cleanups };
}

test('win32-x64 hybrid lease uses the win32-x64-cpu key and the fixed CPU faster-whisper environment', async t => {
  const f = await hybridFixture(t);
  const lease = managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models);
  lease.work.catch(() => {});
  f.cleanups.push(async () => { lease.cancel(); await lease.release(); });
  await lease.work;
  assert.equal(await lease.verify(), true);
  assert.equal(lease.trustedVoice.VOICE_FASTER_WHISPER_MODEL, path.join(lease.payload, 'models', 'tiny-ct2'));
  assert.equal(lease.trustedVoice.VOICE_KOKORO_ONNX_MODEL, path.join(lease.payload, 'models', 'tiny-kokoro', 'model.onnx'));
  assert.equal(lease.trustedVoice.VOICE_FASTER_WHISPER_DEVICE, 'cpu');
  assert.equal(lease.trustedVoice.VOICE_FASTER_WHISPER_COMPUTE_TYPE, 'int8');
  assert.equal(lease.trustedVoice.VOICE_ACCELERATOR, 'cpu');
  assert.equal(lease.trustedVoice.VOICE_MLX_WHISPER_MODEL, undefined);
});

test('win32 hybrid refuses a non-CPU flavor before pinning any model', async t => {
  const f = await hybridFixture(t, { flavor: 'cuda' });
  assert.throws(() => managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models), /UNSUPPORTED_HYBRID_SPEECH_PLATFORM/);
  assert.equal(f.models.coordinator.snapshot().pins, 0);
});

test('win32 hybrid release keeps the reviewed windows-tree rule: authorized spawn without windows-tree is retained', async t => {
  const f = await hybridFixture(t);
  const lease = managed.prepareHybridVoiceAssets(f.nativeRuntime, f.models);
  lease.work.catch(() => {});
  f.cleanups.push(async () => { lease.cancel(); await lease.release(); });
  await lease.work;
  for (const [coverage, extra, ok] of [['windows-tree', {}, true], ['leader-only', {}, false],
    ['windows-tree', { unknown: true }, false], ['windows-tree', { fault: true }, false]]) {
    let snap = Object.freeze({ schemaVersion: 1, clientId: 'c', coverage, pendingPreparation: false, unresolvedGenerations: 0, unknown: false, fault: false });
    const client = { clientId: 'c', assetLifetimeSnapshot: () => snap };
    let released = 0;
    const bundle = { verify: async () => true, release: async () => { released++; } };
    const binding = managed.bindClientAssets(client, bundle);
    await binding.beforeSpawn();
    snap = Object.freeze({ ...snap, ...extra });
    binding.retire();
    if (ok) { await binding.release(client, bundle); assert.equal(released, 1); }
    else { await assert.rejects(binding.release(client, bundle), /ASSET_LIFETIME_UNCONFIRMED/); assert.equal(released, 0); }
  }
});
