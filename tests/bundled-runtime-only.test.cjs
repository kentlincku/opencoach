'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bundleModule = require('../apps/desktop/bundled-voice-assets.cjs');
const { loadTrust } = bundleModule;
const { canonicalInventory } = require('../apps/desktop/tree-integrity.cjs');

const digest = value => createHash('sha256').update(value).digest('hex');
function runtimeOnlyTrust() {
  return {
    schemaVersion: 2,
    mode: 'runtime-only',
    treeDigest: digest('synthetic whole inventory'),
    runtimeTreeDigest: digest('synthetic runtime inventory'),
    fileCount: 1,
    entrypoint: 'runtime/bin/voice-runtime',
    runtimeProfile: 'macos-mlx-kokoro-v1',
    modelManifestDigest: digest('synthetic model manifest'),
    capabilitiesDigest: digest('synthetic model capabilities'),
    modelBindings: {
      sttRoot: { modelId: 'whisper-mlx', identity: { kind: 'raw-files', treeDigest: digest('synthetic whisper') } },
      onnxModel: { modelId: 'kokoro-fp16', identity: { kind: 'raw-files', treeDigest: digest('synthetic kokoro') }, path: 'model.onnx' },
      onnxVoices: { modelId: 'kokoro-fp16', identity: { kind: 'raw-files', treeDigest: digest('synthetic kokoro') }, path: 'voices.bin' },
    },
  };
}

test('macOS recognizes explicit runtime-only trust without treating it as absent', () => {
  const trusted = loadTrust(runtimeOnlyTrust(), 'darwin');
  assert.ok(trusted, 'runtime-only trust must be recognized rather than falling back to another source');
  assert.equal(trusted.mode, 'runtime-only');
  assert.equal(trusted.runtimeProfile, 'macos-mlx-kokoro-v1');
});

for (const [name, mutate] of [
  ['unknown version', value => { value.schemaVersion = 99; }],
  ['unknown field', value => { value.ignoreIntegrity = true; }],
  ['empty runtime inventory', value => { value.fileCount = 0; }],
  ['wrong entrypoint', value => { value.entrypoint = '/bin/sh'; }],
  ['unknown runtime profile', value => { value.runtimeProfile = 'arbitrary-runtime'; }],
  ['missing model digest', value => { delete value.modelManifestDigest; }],
  ['bad capability digest', value => { value.capabilitiesDigest = 'not-a-digest'; }],
  ['extra model role', value => { value.modelBindings.command = value.modelBindings.sttRoot; }],
  ['model path traversal', value => { value.modelBindings.onnxModel.path = '../model.onnx'; }],
  ['model identity confusion', value => { value.modelBindings.sttRoot.identity = { kind: 'zip', archiveSha256: digest('zip') }; }],
  ['unsafe model identifier', value => { value.modelBindings.sttRoot.modelId = '../other'; }],
]) {
  test(`runtime-only trust rejects ${name}`, () => {
    const value = runtimeOnlyTrust(); mutate(value);
    assert.throws(() => loadTrust(value, 'darwin'), /BUNDLED_|INVENTORY_|PATH|PORTABLE/);
  });
}

test('runtime-only mode does not reinterpret a Windows bundle', () => {
  assert.throws(() => loadTrust(runtimeOnlyTrust(), 'win32'), /BUNDLED_/);
});

test('runtime-only trust snapshots and freezes nested role identities', () => {
  const input = runtimeOnlyTrust();
  const trusted = loadTrust(input, 'darwin');
  assert.ok(trusted);
  assert.ok(Object.isFrozen(trusted));
  assert.ok(Object.isFrozen(trusted.modelBindings));
  assert.ok(Object.isFrozen(trusted.modelBindings.sttRoot.identity));
  input.modelBindings.sttRoot.modelId = 'changed-after-parse';
  assert.equal(trusted.modelBindings.sttRoot.modelId, 'whisper-mlx');
});

async function makeRuntimeOnlyFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-runtime-only-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const relative = 'runtime/bin/voice-runtime';
  const command = path.join(root, 'voice-assets', relative);
  await fs.mkdir(path.dirname(command), { recursive: true });
  const bytes = Buffer.from('synthetic runtime binary; never execute this fixture');
  await fs.writeFile(command, bytes, { mode: 0o600 });
  const files = [{ path: relative, bytes: bytes.length, sha256: digest(bytes) }];
  const whole = canonicalInventory(files);
  const runtime = canonicalInventory(files.map(file => ({ ...file, path: file.path.slice('runtime/'.length) })));
  const trust = { ...runtimeOnlyTrust(), treeDigest: whole.treeDigest, runtimeTreeDigest: runtime.treeDigest, fileCount: files.length };
  await fs.writeFile(path.join(root, 'voice-assets-inventory.json'), JSON.stringify({ files }));
  return { root, command, trust };
}

test('runtime-only preparation verifies an App runtime without requiring installed models', async t => {
  assert.equal(typeof bundleModule.prepareBundledRuntimeAssets, 'function', 'runtime-only preparation is required');
  const fixture = await makeRuntimeOnlyFixture(t);
  const prepared = await bundleModule.prepareBundledRuntimeAssets({ resourcesPath: fixture.root, platform: 'darwin', trust: fixture.trust });
  assert.equal(prepared.command, fixture.command);
  assert.equal(prepared.runtimeProfile, 'macos-mlx-kokoro-v1');
  assert.equal(prepared.verifyRuntimeBeforeSpawn(), true);
  assert.ok(Object.isFrozen(prepared));
  assert.equal(bundleModule.authenticatedBundledRuntimeSource(prepared), null, 'injected test trust is never native production authority');
  assert.equal(bundleModule.describeBundledRuntimeSource(prepared).authority, 'NON_NATIVE_TEST_ROOT');
  assert.equal(bundleModule.describeBundledRuntimeSource({ ...prepared }), null, 'copied data is not a runtime source capability');
});

test('runtime-only final verification rejects same-size edits before spawn', async t => {
  assert.equal(typeof bundleModule.prepareBundledRuntimeAssets, 'function');
  const fixture = await makeRuntimeOnlyFixture(t);
  const prepared = await bundleModule.prepareBundledRuntimeAssets({ resourcesPath: fixture.root, platform: 'darwin', trust: fixture.trust });
  const data = await fs.readFile(fixture.command); data[0] ^= 1;
  await fs.writeFile(fixture.command, data);
  assert.throws(() => prepared.verifyRuntimeBeforeSpawn(), /INVENTORY_/);
});

test('runtime-only mode rejects hidden bundled model files outside its inventory', async t => {
  assert.equal(typeof bundleModule.prepareBundledRuntimeAssets, 'function');
  const fixture = await makeRuntimeOnlyFixture(t);
  await fs.mkdir(path.join(fixture.root, 'voice-assets/models'));
  await fs.writeFile(path.join(fixture.root, 'voice-assets/models/unlisted.bin'), 'not admitted');
  await assert.rejects(bundleModule.prepareBundledRuntimeAssets({ resourcesPath: fixture.root, platform: 'darwin', trust: fixture.trust }), /INVENTORY_/);
});

test('legacy full-bundle preparation cannot misinterpret runtime-only readiness', async t => {
  const fixture = await makeRuntimeOnlyFixture(t);
  await assert.rejects(bundleModule.prepareBundledVoiceAssets({ resourcesPath: fixture.root, platform: 'darwin', trust: fixture.trust }), /BUNDLED_RUNTIME_ONLY_REQUIRES_MODELS/);
});

test('trust parsing does not execute schema accessors', () => {
  let called = false;
  const input = runtimeOnlyTrust();
  Object.defineProperty(input, 'schemaVersion', { enumerable: true, get() { called = true; return 2; } });
  assert.throws(() => loadTrust(input, 'darwin'), /BUNDLED_TRUST_INVALID/);
  assert.equal(called, false);
});
