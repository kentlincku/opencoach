'use strict';
// App-bundled voice assets (R56 local macOS app; Windows x64 local app). Trust comes ONLY from the
// compiled digests in bundled-voice-trust.cjs (inside the asar); the inventory
// JSON in Resources is data and is accepted only if it hashes to those digests.
// Every file is then streamed and hashed (no symlinks, hardlinks, unlisted or
// missing files) before the runtime may spawn; the runtime subtree is
// re-verified synchronously immediately before spawn.
const fs = require('node:fs');
const path = require('node:path');
const { validateInventory, verifyInventory, verifyInventorySync, ASSET_LIMITS } = require('./tree-integrity.cjs');

const ROLE_KEYS = Object.freeze({ sttRoot: 'VOICE_MLX_WHISPER_MODEL', onnxModel: 'VOICE_KOKORO_ONNX_MODEL', onnxVoices: 'VOICE_KOKORO_ONNX_VOICES' });
// Per-platform bundle shape. The entrypoint and the backend enums are fixed here
// (Main-owned), never taken from the trust file beyond an exact match.
const PLATFORMS = Object.freeze({
  darwin: Object.freeze({
    entrypoint: 'runtime/bin/voice-runtime',
    roles: ROLE_KEYS,
    enums: Object.freeze({ VOICE_STT_BACKEND: 'mlx-whisper', VOICE_TTS_BACKEND: 'kokoro-onnx', VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu' }),
  }),
  // Windows x64: faster-whisper + Kokoro ONNX. No fixed device: the runtime's
  // accelerator policy tries the bundled CUDA libraries first and falls back to CPU.
  win32: Object.freeze({
    entrypoint: 'runtime/bin/voice-runtime.exe',
    roles: Object.freeze({ ...ROLE_KEYS, sttRoot: 'VOICE_FASTER_WHISPER_MODEL' }),
    enums: Object.freeze({ VOICE_STT_BACKEND: 'faster-whisper', VOICE_TTS_BACKEND: 'kokoro-onnx', VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu', VOICE_ACCELERATOR: 'auto' }),
  }),
});
function platformShape(platform = process.platform) {
  const shape = PLATFORMS[platform];
  if (!shape) throw new Error('BUNDLED_PLATFORM_UNSUPPORTED');
  return shape;
}

// Runtime-only (schemaVersion 2) admission: one fixed entrypoint + profile per
// platform. Windows W1 is CPU only; a CUDA profile is NOT admitted here.
const RUNTIME_ONLY_PROFILES = Object.freeze({
  darwin: Object.freeze({ entrypoint: 'runtime/bin/voice-runtime', runtimeProfile: 'macos-mlx-kokoro-v1' }),
  win32: Object.freeze({ entrypoint: 'runtime/bin/voice-runtime.exe', runtimeProfile: 'windows-ct2-kokoro-cpu-v1' }),
});

function exactTrustFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length
      || !keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) || {}, 'value'))) {
    throw new Error('BUNDLED_TRUST_INVALID');
  }
}

const MAX_STT_CHOICES = 16;
function trustedIdentity(value, sha) {
  exactTrustFields(value, ['kind', 'treeDigest']);
  if (value.kind !== 'raw-files' || typeof value.treeDigest !== 'string' || !sha.test(value.treeDigest)) throw new Error('BUNDLED_TRUST_INVALID');
  return Object.freeze({ kind: 'raw-files', treeDigest: value.treeDigest });
}
function trustedModelId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value) || value === '.' || value === '..') throw new Error('BUNDLED_TRUST_INVALID');
  return value;
}

// Optional sttChoices (STT model choice): the compiled allow-list of STT packs the
// user may select. Absent = legacy single binding (modelBindings.sttRoot only).
// When present it must be a dense ordinary array of unique {modelId, identity},
// and modelBindings.sttRoot (the default) must equal one entry exactly.
function trustedSttChoices(input, sttRoot, sha) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
      || input.length < 1 || input.length > MAX_STT_CHOICES
      || Reflect.ownKeys(input).length !== input.length + 1) throw new Error('BUNDLED_TRUST_INVALID');
  const seen = new Set();
  const choices = Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('BUNDLED_TRUST_INVALID');
    const choice = descriptor.value;
    exactTrustFields(choice, ['modelId', 'identity']);
    const modelId = trustedModelId(choice.modelId);
    if (seen.has(modelId)) throw new Error('BUNDLED_TRUST_INVALID');
    seen.add(modelId);
    return Object.freeze({ modelId, identity: trustedIdentity(choice.identity, sha) });
  });
  const fallback = choices.find(choice => choice.modelId === sttRoot.modelId);
  if (!fallback || fallback.identity.treeDigest !== sttRoot.identity.treeDigest) throw new Error('BUNDLED_TRUST_INVALID');
  return Object.freeze(choices);
}

function runtimeOnlyTrust(input, platform) {
  const base = ['schemaVersion', 'mode', 'treeDigest', 'runtimeTreeDigest', 'fileCount', 'entrypoint',
    'runtimeProfile', 'modelManifestDigest', 'capabilitiesDigest', 'modelBindings'];
  const fields = Object.hasOwn(input, 'sttChoices') ? [...base, 'sttChoices'] : base;
  exactTrustFields(input, fields);
  const sha = /^[0-9a-f]{64}$/;
  const expected = Object.hasOwn(RUNTIME_ONLY_PROFILES, platform) ? RUNTIME_ONLY_PROFILES[platform] : null;
  if (!expected || input.mode !== 'runtime-only'
      || input.entrypoint !== expected.entrypoint
      || input.runtimeProfile !== expected.runtimeProfile
      || !Number.isSafeInteger(input.fileCount) || input.fileCount <= 0 || input.fileCount > ASSET_LIMITS.maxFiles
      || !['treeDigest', 'runtimeTreeDigest', 'modelManifestDigest', 'capabilitiesDigest']
        .every(key => typeof input[key] === 'string' && sha.test(input[key]))) {
    throw new Error('BUNDLED_TRUST_INVALID');
  }
  const roles = Object.keys(ROLE_KEYS);
  exactTrustFields(input.modelBindings, roles);
  const modelBindings = Object.freeze(Object.fromEntries(roles.map(role => {
    const binding = input.modelBindings[role];
    exactTrustFields(binding, role === 'sttRoot' ? ['modelId', 'identity'] : ['modelId', 'identity', 'path']);
    if (typeof binding.modelId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(binding.modelId)
        || binding.modelId === '.' || binding.modelId === '..') throw new Error('BUNDLED_TRUST_INVALID');
    exactTrustFields(binding.identity, ['kind', 'treeDigest']);
    if (binding.identity.kind !== 'raw-files' || typeof binding.identity.treeDigest !== 'string'
        || !sha.test(binding.identity.treeDigest)) throw new Error('BUNDLED_TRUST_INVALID');
    const identity = Object.freeze({ kind: 'raw-files', treeDigest: binding.identity.treeDigest });
    return [role, Object.freeze({ modelId: binding.modelId, identity,
      ...(role === 'sttRoot' ? {} : { path: require('./tree-integrity.cjs').assertPortablePath(binding.path) }) })];
  })));
  const sttChoices = fields.includes('sttChoices') ? trustedSttChoices(input.sttChoices, modelBindings.sttRoot, sha) : null;
  return Object.freeze(Object.fromEntries(fields.map(key => [key,
    key === 'modelBindings' ? modelBindings : key === 'sttChoices' ? sttChoices : input[key]])));
}

// Allowed STT model IDs, in trust order (legacy trust: only the single binding).
function sttChoiceIds(trust) {
  return Object.freeze(trust.sttChoices ? trust.sttChoices.map(choice => choice.modelId) : [trust.modelBindings.sttRoot.modelId]);
}

// Effective bindings for one launch. selectedSttModelId must be an allowed choice;
// there is no fallback to another tier. null/undefined selects the trust default.
function resolveEffectiveBindings(trust, selectedSttModelId) {
  if (!trust || trust.schemaVersion !== 2) throw new Error('BUNDLED_RUNTIME_ONLY_REQUIRED');
  if (selectedSttModelId === undefined || selectedSttModelId === null
      || selectedSttModelId === trust.modelBindings.sttRoot.modelId) return trust.modelBindings;
  const choice = typeof selectedSttModelId === 'string' && trust.sttChoices
    ? trust.sttChoices.find(item => item.modelId === selectedSttModelId) : null;
  if (!choice) throw new Error('STT_MODEL_NOT_ALLOWED');
  return Object.freeze({ ...trust.modelBindings, sttRoot: choice });
}

function loadTrust(trust = require('./bundled-voice-trust.cjs'), platform = process.platform) {
  if (trust === null || trust === undefined) return null;
  if (typeof trust !== 'object' || Array.isArray(trust)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(trust))) throw new Error('BUNDLED_TRUST_INVALID');
  const version = Object.getOwnPropertyDescriptor(trust, 'schemaVersion');
  if (!version || !Object.hasOwn(version, 'value')) throw new Error('BUNDLED_TRUST_INVALID');
  if (version.value === 2) return runtimeOnlyTrust(trust, platform);
  if (version.value !== 1) throw new Error('BUNDLED_TRUST_INVALID');
  const shape = PLATFORMS[platform];
  if (!shape) throw new Error('BUNDLED_TRUST_INVALID');
  const sha = /^[0-9a-f]{64}$/;
  if (!sha.test(trust.treeDigest) || !sha.test(trust.runtimeTreeDigest) || trust.entrypoint !== shape.entrypoint
      || !Number.isSafeInteger(trust.fileCount) || !trust.roles || Object.keys(trust.roles).sort().join() !== Object.keys(ROLE_KEYS).sort().join()) {
    throw new Error('BUNDLED_TRUST_INVALID');
  }
  for (const value of Object.values(trust.roles)) {
    if (typeof value !== 'string' || !value.startsWith('models/') || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('BUNDLED_TRUST_INVALID');
  }
  return trust;
}

function readInventory(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > ASSET_LIMITS.maxMetadataBytes) throw new Error('BUNDLED_INVENTORY_LIMIT');
    const buffer = Buffer.alloc(stat.size + 1);
    let n = 0, count;
    while (n < buffer.length && (count = fs.readSync(fd, buffer, n, buffer.length - n, n))) n += count;
    if (n !== stat.size) throw new Error('BUNDLED_INVENTORY_CHANGED');
    return JSON.parse(buffer.subarray(0, n).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

// Pure: trusted inventories for the whole tree and the runtime subtree.
function authenticateInventory(input, trust) {
  if (!Array.isArray(input?.files)) throw new Error('BUNDLED_INVENTORY_INVALID');
  const whole = validateInventory(input.files, trust.treeDigest); // throws INVENTORY_DIGEST_MISMATCH
  if (whole.fileCount !== trust.fileCount) throw new Error('BUNDLED_INVENTORY_COUNT');
  const runtimeFiles = whole.files.filter(f => f.path.startsWith('runtime/')).map(f => ({ ...f, path: f.path.slice('runtime/'.length) }));
  const runtime = validateInventory(runtimeFiles, trust.runtimeTreeDigest);
  const listed = new Set(whole.files.map(f => f.path));
  if (!listed.has(trust.entrypoint)) throw new Error('BUNDLED_ENTRYPOINT_UNLISTED');
  if (trust.schemaVersion === 2) {
    if (whole.files.some(file => !file.path.startsWith('runtime/'))) throw new Error('BUNDLED_RUNTIME_ONLY_INVENTORY');
  } else {
    for (const rel of Object.values(trust.roles)) {
      if (!listed.has(rel) && !whole.files.some(f => f.path.startsWith(rel + '/'))) throw new Error('BUNDLED_ROLE_UNLISTED');
    }
  }
  return { whole, runtime };
}

const runtimeSources = new WeakMap();

// The override is a unit-test source, never native authority. Production callers
// omit it so the admitted root comes only from the code inside the App asar.
async function prepareBundledRuntimeAssets(options = {}) {
  const { resourcesPath, platform = process.platform, signal } = options;
  const overridden = Object.hasOwn(options, 'trust');
  const trust = loadTrust(overridden ? options.trust : undefined, platform);
  if (!trust) return null;
  if (trust.schemaVersion !== 2 || trust.mode !== 'runtime-only') throw new Error('BUNDLED_RUNTIME_ONLY_REQUIRED');
  const assetRoot = path.join(resourcesPath, 'voice-assets');
  const inventories = authenticateInventory(readInventory(path.join(resourcesPath, 'voice-assets-inventory.json')), trust);
  await verifyInventory(assetRoot, inventories.whole, { signal });
  const real = fs.realpathSync(assetRoot);
  const command = path.join(real, ...trust.entrypoint.split('/'));
  const verifyRuntimeBeforeSpawn = () => {
    verifyInventorySync(real, inventories.whole);
    return true;
  };
  const source = Object.freeze({
    authority: overridden ? 'NON_NATIVE_TEST_ROOT' : 'COMPILED_ROOT',
    command,
    root: path.join(real, 'runtime'),
    inventory: inventories.runtime,
    trust,
    verifyRuntimeBeforeSpawn,
  });
  const prepared = Object.freeze({
    command, root: source.root, assetRoot: real,
    runtimeProfile: trust.runtimeProfile,
    modelManifestDigest: trust.modelManifestDigest,
    capabilitiesDigest: trust.capabilitiesDigest,
    modelBindings: trust.modelBindings,
    verifyRuntimeBeforeSpawn,
  });
  runtimeSources.set(prepared, source);
  return prepared;
}

function describeBundledRuntimeSource(prepared) {
  return runtimeSources.get(prepared) || null;
}

function authenticatedBundledRuntimeSource(prepared) {
  const source = runtimeSources.get(prepared);
  return source?.authority === 'COMPILED_ROOT' ? source : null;
}

// Returns null when this build carries no bundled assets (trust absent).
async function prepareBundledVoiceAssets({ resourcesPath, platform = process.platform, trust = loadTrust(undefined, platform), signal } = {}) {
  if (!trust) return null;
  if (trust.schemaVersion === 2) throw new Error('BUNDLED_RUNTIME_ONLY_REQUIRES_MODELS');
  const shape = platformShape(platform);
  const root = path.join(resourcesPath, 'voice-assets');
  const inventories = authenticateInventory(readInventory(path.join(resourcesPath, 'voice-assets-inventory.json')), trust);
  const verified = await verifyInventory(root, inventories.whole, { signal });
  const real = fs.realpathSync(root);
  const trustedVoice = { ...shape.enums };
  for (const [role, key] of Object.entries(shape.roles)) trustedVoice[key] = path.join(real, ...trust.roles[role].split('/'));
  return Object.freeze({
    root: real,
    command: path.join(real, ...trust.entrypoint.split('/')),
    trustedVoice: Object.freeze(trustedVoice),
    treeDigest: verified.treeDigest,
    fileCount: verified.fileCount,
    verifyRuntimeBeforeSpawn() { verifyInventorySync(path.join(real, 'runtime'), inventories.runtime); return true; },
  });
}

module.exports = { prepareBundledVoiceAssets, authenticateInventory, loadTrust, ROLE_KEYS, PLATFORMS, RUNTIME_ONLY_PROFILES,
  sttChoiceIds, resolveEffectiveBindings, MAX_STT_CHOICES,
  prepareBundledRuntimeAssets, describeBundledRuntimeSource, authenticatedBundledRuntimeSource };
