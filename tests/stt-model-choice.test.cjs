'use strict';
// STT model choice: compiled allow-list (trust.sttChoices), catalog consistency,
// effective bindings, and the Main-owned preference. Spec: docs/contracts/stt-model-choice.md
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const bundled = require('../apps/desktop/bundled-voice-assets.cjs');
const { loadTrust, sttChoiceIds, resolveEffectiveBindings } = bundled;
const { parseMacosModelCatalog, parseWindowsModelCatalog } = require('../apps/desktop/macos-model-catalog.cjs');
const { manifestDigest } = require('../apps/desktop/asset-manifest-trust.cjs');
const pref = require('../apps/desktop/stt-model-preference.cjs');
const candidates = require('../docs/contracts/stt-tier-candidates.json');

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function baseTrust(platform = 'darwin') {
  return {
    schemaVersion: 2, mode: 'runtime-only', treeDigest: hash('t'), runtimeTreeDigest: hash('r'), fileCount: 1,
    entrypoint: platform === 'darwin' ? 'runtime/bin/voice-runtime' : 'runtime/bin/voice-runtime.exe',
    runtimeProfile: platform === 'darwin' ? 'macos-mlx-kokoro-v1' : 'windows-ct2-kokoro-cpu-v1',
    modelManifestDigest: hash('m'), capabilitiesDigest: hash('c'),
    modelBindings: {
      sttRoot: { modelId: 'stt-b', identity: { kind: 'raw-files', treeDigest: hash('b') } },
      onnxModel: { modelId: 'tts', identity: { kind: 'raw-files', treeDigest: hash('k') }, path: 'model.onnx' },
      onnxVoices: { modelId: 'tts', identity: { kind: 'raw-files', treeDigest: hash('k') }, path: 'voices.bin' },
    },
  };
}
const choice = (id, d = id) => ({ modelId: id, identity: { kind: 'raw-files', treeDigest: hash(d) } });

test('legacy trust without sttChoices is unchanged and allows only its single binding', () => {
  const trust = loadTrust(baseTrust(), 'darwin');
  assert.equal(Object.hasOwn(trust, 'sttChoices'), false);
  assert.deepEqual([...sttChoiceIds(trust)], ['stt-b']);
  assert.equal(resolveEffectiveBindings(trust, null), trust.modelBindings);
  assert.equal(resolveEffectiveBindings(trust, 'stt-b'), trust.modelBindings);
  assert.throws(() => resolveEffectiveBindings(trust, 'stt-a'), /STT_MODEL_NOT_ALLOWED/);
});

test('sttChoices is parsed, frozen and detached from the input', () => {
  const input = { ...baseTrust(), sttChoices: [choice('stt-a', 'a'), choice('stt-b', 'b')] };
  const trust = loadTrust(input, 'darwin');
  assert.deepEqual([...sttChoiceIds(trust)], ['stt-a', 'stt-b']);
  assert.ok(Object.isFrozen(trust.sttChoices) && Object.isFrozen(trust.sttChoices[0]) && Object.isFrozen(trust.sttChoices[0].identity));
  input.sttChoices[0].modelId = 'mutated';
  assert.equal(trust.sttChoices[0].modelId, 'stt-a');
});

test('effective bindings swap only sttRoot and never fall back to another tier', () => {
  const trust = loadTrust({ ...baseTrust(), sttChoices: [choice('stt-a', 'a'), choice('stt-b', 'b')] }, 'darwin');
  const chosen = resolveEffectiveBindings(trust, 'stt-a');
  assert.equal(chosen.sttRoot.modelId, 'stt-a');
  assert.equal(chosen.sttRoot.identity.treeDigest, hash('a'));
  assert.equal(chosen.onnxModel, trust.modelBindings.onnxModel);
  assert.ok(Object.isFrozen(chosen));
  for (const bad of ['stt-c', '', 'STT-A', 1, {}, ['stt-a']]) {
    assert.throws(() => resolveEffectiveBindings(trust, bad), /STT_MODEL_NOT_ALLOWED/);
  }
  assert.throws(() => resolveEffectiveBindings(loadTrust(null), 'stt-a'), /BUNDLED_RUNTIME_ONLY_REQUIRED/);
});

test('sttChoices must include the default binding with the same identity', () => {
  assert.throws(() => loadTrust({ ...baseTrust(), sttChoices: [choice('stt-a', 'a')] }, 'darwin'), /BUNDLED_TRUST_INVALID/);
  assert.throws(() => loadTrust({ ...baseTrust(), sttChoices: [choice('stt-a', 'a'), choice('stt-b', 'different')] }, 'darwin'), /BUNDLED_TRUST_INVALID/);
});

test('malformed sttChoices are rejected', () => {
  const ok = () => [choice('stt-a', 'a'), choice('stt-b', 'b')];
  const cases = {
    empty: [],
    notArray: { 0: choice('stt-b', 'b') },
    duplicate: [choice('stt-b', 'b'), choice('stt-b', 'b')],
    extraField: [{ ...choice('stt-b', 'b'), path: 'x' }],
    badId: [choice('../x'), choice('stt-b', 'b')],
    badKind: [{ modelId: 'stt-b', identity: { kind: 'zip', treeDigest: hash('b') } }],
    badDigest: [{ modelId: 'stt-b', identity: { kind: 'raw-files', treeDigest: 'abc' } }],
    tooMany: [...Array.from({ length: bundled.MAX_STT_CHOICES }, (_, i) => choice(`s${i}`)), choice('stt-b', 'b')],
  };
  const sparse = ok(); sparse.length = 3;
  cases.sparse = sparse;
  const decorated = ok(); decorated.extra = 1;
  cases.decorated = decorated;
  for (const [name, value] of Object.entries(cases)) {
    assert.throws(() => loadTrust({ ...baseTrust(), sttChoices: value }, 'darwin'), /BUNDLED_TRUST_INVALID/, name);
  }
  const accessor = ok();
  Object.defineProperty(accessor, '0', { get() { throw new Error('getter executed'); }, enumerable: true });
  assert.throws(() => loadTrust({ ...baseTrust(), sttChoices: accessor }, 'darwin'), /BUNDLED_TRUST_INVALID/);
});

function catalogFixture(platformKey) {
  const models = candidates.models[platformKey];
  const ids = Object.values(candidates.tiers[platformKey].en);
  const source = platformKey === 'darwin-arm64' ? require('../resources/macos-model-packs.json') : require('../resources/windows-model-packs.json');
  const ttsId = source.modelBindings.onnxModel.modelId;
  const modelManifest = { schemaVersion: 3, release: 'stt-choice-test', models: { ...clone(models), [ttsId]: clone(source.modelManifest.models[ttsId]) } };
  const sttTemplate = source.capabilities.models.find(model => model.kind === 'stt');
  const ttsCapability = source.capabilities.models.find(model => model.kind === 'tts');
  const capabilities = { ...clone(source.capabilities), models: [...ids.map(id => ({ ...clone(sttTemplate), id })), clone(ttsCapability)] };
  const identity = id => ({ kind: 'raw-files', treeDigest: models[id].artifacts[platformKey].treeDigest });
  const defaultId = source.modelBindings.sttRoot.modelId;
  const platform = platformKey === 'darwin-arm64' ? 'darwin' : 'win32';
  const trust = {
    ...baseTrust(platform), modelManifestDigest: manifestDigest(modelManifest), capabilitiesDigest: manifestDigest(capabilities),
    modelBindings: { ...clone(source.modelBindings), sttRoot: { modelId: defaultId, identity: identity(defaultId) } },
    sttChoices: ids.map(id => ({ modelId: id, identity: identity(id) })),
  };
  return { trust, modelManifest, capabilities, ids, defaultId, parse: platform === 'darwin' ? parseMacosModelCatalog : parseWindowsModelCatalog };
}

for (const platformKey of ['darwin-arm64', 'win32-x64-cpu']) {
  test(`${platformKey}: catalog admits all four pinned tiers and reports choices`, () => {
    const f = catalogFixture(platformKey);
    const parsed = f.parse(f.capabilities, f.trust, f.modelManifest);
    assert.deepEqual([...parsed.sttChoices], f.ids);
    assert.equal(parsed.defaultSttModelId, f.defaultId);
    assert.equal(parsed.models.length, 5);
  });

  test(`${platformKey}: catalog rejects a listed model that is not in the allow-list, and a missing choice`, () => {
    const extra = catalogFixture(platformKey);
    extra.trust.sttChoices = extra.trust.sttChoices.filter(c => c.modelId === extra.defaultId);
    assert.throws(() => extra.parse(extra.capabilities, extra.trust, extra.modelManifest), /MODEL_CATALOG_BINDING/);
    const missing = catalogFixture(platformKey);
    const drop = missing.ids.find(id => id !== missing.defaultId);
    delete missing.modelManifest.models[drop];
    missing.capabilities.models = missing.capabilities.models.filter(m => m.id !== drop);
    missing.trust.modelManifestDigest = manifestDigest(missing.modelManifest);
    missing.trust.capabilitiesDigest = manifestDigest(missing.capabilities);
    assert.throws(() => missing.parse(missing.capabilities, missing.trust, missing.modelManifest), /MODEL_CATALOG_BINDING/);
  });

  test(`${platformKey}: a choice whose tree digest differs from the manifest is rejected`, () => {
    const f = catalogFixture(platformKey);
    const index = f.trust.sttChoices.findIndex(c => c.modelId !== f.defaultId);
    f.trust.sttChoices[index] = { modelId: f.trust.sttChoices[index].modelId, identity: { kind: 'raw-files', treeDigest: hash('tampered') } };
    assert.throws(() => f.parse(f.capabilities, f.trust, f.modelManifest), /MODEL_CATALOG_BINDING/);
  });
}

test('legacy single-binding catalog (shipped catalog reduced to its default STT) still parses unchanged', () => {
  for (const [file, parse, platform, key] of [['../resources/macos-model-packs.json', parseMacosModelCatalog, 'darwin', 'darwin-arm64'],
    ['../resources/windows-model-packs.json', parseWindowsModelCatalog, 'win32', 'win32-x64-cpu']]) {
    const catalog = clone(require(file));
    const keep = new Set([catalog.modelBindings.sttRoot.modelId, catalog.modelBindings.onnxModel.modelId]);
    catalog.modelManifest.models = Object.fromEntries(Object.entries(catalog.modelManifest.models).filter(([id]) => keep.has(id)));
    catalog.capabilities.models = catalog.capabilities.models.filter(model => keep.has(model.id));
    const trust = { ...baseTrust(platform), modelManifestDigest: manifestDigest(catalog.modelManifest),
      capabilitiesDigest: manifestDigest(catalog.capabilities), modelBindings: clone(catalog.modelBindings) };
    const parsed = parse(catalog.capabilities, trust, catalog.modelManifest);
    assert.deepEqual([...parsed.sttChoices], [catalog.modelBindings.sttRoot.modelId], key);
  }
});

test('shipped catalogs carry exactly the pinned four tiers per platform and the existing default', () => {
  for (const [file, key] of [['../resources/macos-model-packs.json', 'darwin-arm64'], ['../resources/windows-model-packs.json', 'win32-x64-cpu']]) {
    const catalog = require(file);
    const tiers = candidates.tiers[key].en;
    assert.deepEqual(catalog.sttChoices.map(c => c.modelId), ['ultrafast', 'fast', 'balanced', 'accurate'].map(t => tiers[t]));
    for (const c of catalog.sttChoices) {
      assert.equal(c.identity.treeDigest, catalog.modelManifest.models[c.modelId].artifacts[key].treeDigest);
      assert.equal(catalog.modelManifest.models[c.modelId].artifacts[key].treeDigest, candidates.models[key][c.modelId].artifacts[key].treeDigest);
    }
    assert.ok(catalog.sttChoices.some(c => c.modelId === catalog.modelBindings.sttRoot.modelId));
  }
});

test('preference: default when unset, stored choice when allowed, error (no fallback) when not allowed', () => {
  const allowed = ['stt-a', 'stt-b'];
  assert.deepEqual({ ...pref.selectedSttModel({ preference: { stt: {} }, language: 'en', allowed, defaultId: 'stt-b' }) },
    { modelId: 'stt-b', source: 'default' });
  assert.deepEqual({ ...pref.selectedSttModel({ preference: { stt: { en: 'stt-a' } }, language: 'en', allowed, defaultId: 'stt-b' }) },
    { modelId: 'stt-a', source: 'preference' });
  assert.throws(() => pref.selectedSttModel({ preference: { stt: { en: 'gone' } }, language: 'en', allowed, defaultId: 'stt-b' }), /STT_MODEL_NOT_ALLOWED/);
  assert.throws(() => pref.setSttPreference({ stt: {} }, 'en', 'gone', allowed), /STT_MODEL_NOT_ALLOWED/);
  assert.throws(() => pref.setSttPreference({ stt: {} }, 'EN!', 'stt-a', allowed), /INVALID_LANGUAGE_TAG/);
  assert.deepEqual(pref.setSttPreference({ stt: { ja: 'x' } }, 'en', 'stt-a', allowed).stt, { ja: 'x', en: 'stt-a' });
});

test('preference file: round trip, 0600, random exclusive temp, nothing left behind', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-pref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(pref.readPreference(dir), { schemaVersion: 1, stt: {} });
  pref.writePreference(dir, { schemaVersion: 1, stt: { en: 'stt-a' } });
  assert.deepEqual(pref.readPreference(dir), { schemaVersion: 1, stt: { en: 'stt-a' } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, pref.FILE)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), [pref.FILE]);
  assert.throws(() => pref.writePreference(dir, { schemaVersion: 1, stt: { en: '../evil' } }), /STT_PREFERENCE_INVALID/);
  assert.deepEqual(pref.readPreference(dir).stt, { en: 'stt-a' }, 'a rejected write leaves the old file intact');
});

test('preference file that exists but is invalid is reported, never treated as unset', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-pref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, pref.FILE);
  const invalid = ['{not json', '[]', JSON.stringify({ schemaVersion: 2, stt: {} }),
    JSON.stringify({ schemaVersion: 1, stt: { en: 'UPPER' } }), JSON.stringify({ schemaVersion: 1, stt: { 'bad lang': 'x' } }),
    JSON.stringify({ schemaVersion: 1, stt: {}, extra: 1 }), JSON.stringify({ schemaVersion: 1, stt: { en: 'x'.repeat(pref.MAX_BYTES) } })];
  for (const text of invalid) {
    fs.writeFileSync(file, text);
    assert.throws(() => pref.readPreference(dir), /STT_PREFERENCE_INVALID/, text.slice(0, 40));
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => pref.readPreference(dir), /STT_PREFERENCE_UNREADABLE/);
  fs.rmdirSync(file);
  if (process.platform !== 'win32') {
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, stt: { en: 'stt-a' } }));
    fs.symlinkSync(target, file);
    assert.throws(() => pref.readPreference(dir), /STT_PREFERENCE_UNREADABLE/, 'symlinks are not followed');
  }
});

test('preference lookup ignores inherited keys', () => {
  const allowed = ['stt-b'];
  for (const language of ['__proto__', 'constructor', 'toString']) {
    assert.equal(pref.selectedSttModel({ preference: { stt: {} }, language, allowed, defaultId: 'stt-b' }).source, 'default');
  }
});
