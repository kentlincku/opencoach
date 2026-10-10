'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { manifestDigest } = require('../apps/desktop/asset-manifest-trust.cjs');
const catalog = require('../resources/macos-model-packs.json');
const modulePath = path.resolve(__dirname, '../apps/desktop/macos-model-catalog.cjs');
const api = () => fs.existsSync(modulePath) ? require(modulePath) : {};
const clone = value => JSON.parse(JSON.stringify(value));
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const modelManifest = clone(catalog.modelManifest), capabilities = clone(catalog.capabilities);
  const trust = {
    schemaVersion: 2, mode: 'runtime-only', treeDigest: hash('synthetic runtime tree'), runtimeTreeDigest: hash('synthetic runtime subtree'),
    fileCount: 1, entrypoint: 'runtime/bin/voice-runtime', runtimeProfile: 'macos-mlx-kokoro-v1',
    modelManifestDigest: manifestDigest(modelManifest), capabilitiesDigest: manifestDigest(capabilities),
    modelBindings: clone(catalog.modelBindings),
    ...(catalog.sttChoices ? { sttChoices: clone(catalog.sttChoices) } : {}),
  };
  return { trust, modelManifest, capabilities };
}

function authorityModule(compiledTrust) {
  const file = path.resolve(__dirname, '../apps/desktop/asset-manifest-trust.cjs');
  const actual = createRequire(file);
  const context = { module: { exports: {} }, require: name => name === './bundled-voice-assets.cjs'
    ? { loadTrust: () => compiledTrust } : actual(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.module.exports;
}

test('the App runtime-only root can authorize only its exact model manifest digest', () => {
  const { trust, modelManifest } = fixture();
  const authority = authorityModule(trust); // MEMORY compiled-module boundary, not a native source proof.
  authority.authenticateAssetManifest(modelManifest, 'model');
  assert.equal(authority.manifestAuthority(modelManifest).authority, 'COMPILED_ROOT');
  const changed = clone(modelManifest); changed.release = 'different-release';
  assert.throws(() => authority.authenticateAssetManifest(changed, 'model'), /ASSET_MANIFEST_UNTRUSTED/);
});

test('a model root cannot authorize runtime downloads or authorize models when absent', () => {
  const { trust, modelManifest } = fixture();
  const runtime = { schemaVersion: 2, release: 'fixture-published', artifacts: {} };
  assert.throws(() => authorityModule(trust).authenticateAssetManifest(runtime, 'runtime'), /ASSET_MANIFEST_UNTRUSTED/);
  assert.throws(() => authorityModule(null).authenticateAssetManifest(modelManifest, 'model'), /ASSET_MANIFEST_UNTRUSTED/);
});

test('a model capability catalog is bound to both compiled digests and exact raw model roles', () => {
  assert.equal(typeof api().parseMacosModelCatalog, 'function', 'macOS catalog verification is required');
  const { trust, modelManifest, capabilities } = fixture();
  const parsed = api().parseMacosModelCatalog(capabilities, trust, modelManifest);
  assert.deepEqual(parsed.enabledLanguages, ['en']);
  assert.deepEqual(parsed.models.map(m => m.kind), ['stt', 'stt', 'stt', 'stt', 'tts']);
  assert.ok(Object.isFrozen(parsed.models));
  capabilities.models[0].id = 'mutated-input';
  assert.notEqual(parsed.models[0].id, 'mutated-input');
});

test('catalog changes cannot authorize themselves with a different model or capability digest', () => {
  assert.equal(typeof api().parseMacosModelCatalog, 'function');
  for (const which of ['capability', 'model']) {
    const { trust, modelManifest, capabilities } = fixture();
    if (which === 'capability') capabilities.models[0].languages = ['en', 'zh-TW'];
    else modelManifest.release = 'unreviewed-new-release';
    assert.throws(() => api().parseMacosModelCatalog(capabilities, trust, modelManifest), /MODEL_CATALOG_UNTRUSTED/);
  }
});

test('first-phase catalog cannot claim additional enabled product languages or wrong backend formats', () => {
  assert.equal(typeof api().parseMacosModelCatalog, 'function');
  for (const edit of [
    value => { value.enabledLanguages = ['en', 'zh-TW']; },
    value => { value.models[0].format = 'ctranslate2'; },
    value => { value.models[0].id = 'unknown-model'; },
    value => { value.extraAuthority = true; },
  ]) {
    const { trust, modelManifest, capabilities } = fixture(); edit(capabilities);
    // Unit-only expected root, to test semantic validation independently of hashing.
    trust.capabilitiesDigest = manifestDigest(capabilities);
    assert.throws(() => api().parseMacosModelCatalog(capabilities, trust, modelManifest), /MODEL_CATALOG_|INVALID_SPEECH/);
  }
});

test('a TTS role must point to an inventoried path in the exact admitted raw model', () => {
  assert.equal(typeof api().parseMacosModelCatalog, 'function');
  const { trust, modelManifest, capabilities } = fixture();
  trust.modelBindings.onnxVoices.path = 'different-voices.bin';
  assert.throws(() => api().parseMacosModelCatalog(capabilities, trust, modelManifest), /MODEL_CATALOG_BINDING/);
});
