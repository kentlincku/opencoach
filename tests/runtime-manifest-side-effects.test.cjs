'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {artifactIdentity, parseArtifact, parseRuntimeManifest, parseModelManifest, ASSET_LIMITS} = require('../apps/desktop/runtime-manifest.cjs');
const {canonicalInventory} = require('../apps/desktop/tree-integrity.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');

// Synthetic metadata only: these URLs are never fetched and confer no authority.
function rawArtifact() {
  const files = [{path: 'config.json', bytes: 2, sha256: hash('{}')}];
  const inventory = canonicalInventory(files);
  const revision = hash('raw side-effects fixture source').slice(0, 40);
  return {transport: 'raw-files', bytes: inventory.totalBytes, entrypoint: 'config.json',
    files, treeDigest: inventory.treeDigest,
    sources: {'config.json': `https://huggingface.co/fixture/tiny-model/resolve/${revision}/config.json`},
    provenance: {sourceRevision: revision, sourceUrl: 'https://huggingface.co/fixture/tiny-model',
      license: {spdx: 'MIT', url: 'https://example.test/fixture-license'}}};
}

test('raw identity with modelBindings rejects a nested source getter without reading it', () => {
  const input = rawArtifact();
  input.modelBindings = {};
  const source = input.sources['config.json'];
  let reads = 0;
  Object.defineProperty(input.sources, 'config.json', {enumerable: true, get() { reads++; return source; }});
  assert.throws(() => artifactIdentity(input));
  assert.equal(reads, 0, 'rejecting a mixed raw identity must not serialize its source getter');
});

function proxyProbe() {
  let traps = 0;
  return {
    wrap: value => new Proxy(value, Object.fromEntries([
      'get', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'has',
    ].map(name => [name, (...args) => { traps++; return Reflect[name](...args); }]))),
    assertUntouched: () => assert.equal(traps, 0, 'rejection must not invoke Proxy traps'),
  };
}

for (const mixed of [false, true]) {
  test(`identity rejects a Proxy transport value without traps (modelBindings=${mixed})`, () => {
    const input = rawArtifact(), probe = proxyProbe();
    input.transport = probe.wrap({kind: 'raw-files'});
    if (mixed) input.modelBindings = {};
    assert.throws(() => artifactIdentity(input));
    probe.assertUntouched();
  });
}

function getterProbe(target, key) {
  const value = Object.getOwnPropertyDescriptor(target, key)?.value;
  let reads = 0;
  Object.defineProperty(target, key, {enumerable: true, configurable: true, get() { reads++; return value; }});
  return () => assert.equal(reads, 0, 'rejection must not invoke getters');
}

for (const [location, target] of [
  ['inventory', input => [input.files[0], 'sha256']],
  ['license', input => [input.provenance.license, 'spdx']],
  ['binding', input => [input.modelBindings, 'sttRoot']],
]) {
  test(`mixed raw identity rejects a nested ${location} getter without reading it`, () => {
    const input = rawArtifact(); input.modelBindings = {};
    const untouched = getterProbe(...target(input));
    assert.throws(() => artifactIdentity(input));
    untouched();
  });
}

for (const [location, target] of [
  ['sources', input => [input, 'sources']],
  ['files', input => [input, 'files']],
  ['file', input => [input.files, 0]],
  ['license', input => [input.provenance, 'license']],
  ['modelBindings', input => [input, 'modelBindings']],
]) {
  test(`mixed raw identity rejects a nested ${location} Proxy without traps`, () => {
    const input = rawArtifact(), probe = proxyProbe(); input.modelBindings = {};
    const [parent, key] = target(input); parent[key] = probe.wrap(parent[key]);
    assert.throws(() => artifactIdentity(input));
    probe.assertUntouched();
  });
}

for (const field of ['modelBindings', 'archive', 'sha256', 'url', 'unknown']) {
  test(`raw identity with forbidden ${field} never reads a nested source`, () => {
    for (const transport of ['raw-files', 'zip', null]) {
      const input = rawArtifact(); input.transport = transport; input[field] = {};
      const untouched = getterProbe(input.sources, 'config.json');
      assert.throws(() => artifactIdentity(input));
      untouched();
    }
  });
}

for (const mixed of [false, true]) {
  test(`identity rejects its own transport accessor unread (modelBindings=${mixed})`, () => {
    for (const enumerable of [false, true]) {
      const input = rawArtifact(); if (mixed) input.modelBindings = {};
      const untouched = getterProbe(input, 'transport');
      Object.defineProperty(input, 'transport', {enumerable});
      assert.throws(() => artifactIdentity(input));
      untouched();
    }
  });

  test(`identity rejects a top-level Proxy before inspecting transport (modelBindings=${mixed})`, () => {
    const input = rawArtifact(), probe = proxyProbe(); if (mixed) input.modelBindings = {};
    assert.throws(() => artifactIdentity(probe.wrap(input)));
    probe.assertUntouched();
    const revoked = Proxy.revocable(input, {}); revoked.revoke();
    assert.throws(() => artifactIdentity(revoked.proxy), /INVALID_RAW_DATA/);
  });

  test(`invalid transport cannot run toJSON (modelBindings=${mixed})`, () => {
    const input = rawArtifact(); if (mixed) input.modelBindings = {};
    let calls = 0;
    input.transport = {toJSON() { calls++; return 'raw-files'; }};
    assert.throws(() => artifactIdentity(input));
    assert.equal(calls, 0);
  });
}

function hostileMetadata(effect) {
  let input = rawArtifact(), check = () => {};
  const probe = proxyProbe();
  let calls = 0;
  if (effect === 'source getter') check = getterProbe(input.sources, 'config.json');
  if (effect === 'transport getter') check = getterProbe(input, 'transport');
  if (effect === 'nested Proxy') input.sources = probe.wrap(input.sources);
  if (effect === 'top-level Proxy') input = probe.wrap(input);
  if (effect === 'toJSON') input.toJSON = () => { calls++; throw new Error('SERIALIZATION_MUST_NOT_RUN'); };
  if (effect === 'cycle') input.cycle = input;
  return {input, assertUntouched() { check(); probe.assertUntouched(); assert.equal(calls, 0); }};
}
const effects = ['source getter', 'transport getter', 'nested Proxy', 'top-level Proxy', 'toJSON', 'cycle'];

for (const kind of ['runtime', 'model']) {
  test(`parseArtifact rejects unsupported ${kind} versions before inspecting metadata`, () => {
    const versionProbe = proxyProbe();
    const versions = [0, 1, 4, -1, 2.5, '2', '3', null, NaN, Infinity, 2n, Symbol('version'), {}, versionProbe.wrap({})];
    if (kind === 'runtime') versions.push(3);
    for (const version of versions) {
      for (const effect of effects) {
        const value = hostileMetadata(effect);
        assert.throws(() => parseArtifact(value.input, kind, version), {message: 'UNSUPPORTED_SCHEMA_VERSION'}, effect);
        value.assertUntouched();
      }
    }
    versionProbe.assertUntouched();
  });
}

test('parseArtifact rejects invalid kinds before checking schema or inspecting metadata', () => {
  const kindProbe = proxyProbe();
  for (const kind of ['unknown', 'raw-files', null, 3, {}, kindProbe.wrap({})]) {
    for (const version of [2, 3, 4]) {
      for (const effect of effects) {
        const value = hostileMetadata(effect);
        assert.throws(() => parseArtifact(value.input, kind, version), {message: 'INVALID_ARTIFACT_KIND'}, effect);
        value.assertUntouched();
      }
    }
  }
  kindProbe.assertUntouched();
});

function zipArtifact(kind = 'model') {
  const {entrypoint, files, treeDigest, provenance} = rawArtifact();
  const value = {url: 'https://github.com/fixture/assets/releases/download/test/tiny.zip',
    sha256: hash('synthetic archive'), bytes: 20, archive: 'zip', entrypoint, files, treeDigest, provenance};
  if (kind === 'runtime') {
    const binding = {modelId: 'tiny-model', archiveSha256: hash('synthetic model archive')};
    value.modelBindings = {sttRoot: {...binding}, onnxModel: {...binding, path: entrypoint}, onnxVoices: {...binding, path: entrypoint}};
  }
  return value;
}

for (const kind of ['runtime', 'model']) {
  test(`v2 ${kind} still returns a frozen ZIP identity after full artifact parsing`, () => {
    const input = zipArtifact(kind), parsed = parseArtifact(input, kind, 2);
    assert.deepEqual(parsed, input);
    for (const value of [input, parsed]) {
      const identity = artifactIdentity(value);
      assert.deepEqual(identity, {kind: 'zip', archiveSha256: input.sha256});
      assert.ok(Object.isFrozen(identity));
    }
    assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.files[0]));
    assert.deepEqual(parseArtifact(input, kind), parsed);
    if (kind === 'runtime') assert.deepEqual(parseArtifact(input), parsed);
  });
}

test('v3 model still returns a frozen raw identity with no synthetic archive hash', () => {
  const input = rawArtifact(), parsed = parseArtifact(input, 'model', 3);
  assert.deepEqual(parsed, input);
  for (const value of [input, parsed]) {
    const identity = artifactIdentity(value);
    assert.deepEqual(identity, {kind: 'raw-files', treeDigest: input.treeDigest});
    assert.ok(Object.isFrozen(identity));
  }
  for (const value of [parsed, parsed.files, parsed.files[0], parsed.sources, parsed.provenance, parsed.provenance.license]) {
    assert.ok(Object.isFrozen(value));
  }
});

test('ZIP identity never reads an inherited transport discriminator', () => {
  const input = zipArtifact(), original = Object.getOwnPropertyDescriptor(Object.prototype, 'transport');
  let reads = 0;
  Object.defineProperty(Object.prototype, 'transport', {configurable: true, get() { reads++; return 'raw-files'; }});
  try {
    assert.deepEqual(artifactIdentity(input), {kind: 'zip', archiveSha256: input.sha256});
    assert.equal(reads, 0);
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'transport', original);
    else delete Object.prototype.transport;
  }
});

test('v1 empty, v2 ZIP and v3 raw model manifests retain their version boundaries', () => {
  for (const schemaVersion of [1, 2]) {
    assert.deepEqual(parseRuntimeManifest({schemaVersion, release: 'fixture', artifacts: {}}).artifacts, {});
  }
  for (const schemaVersion of [1, 2, 3]) {
    assert.deepEqual(parseModelManifest({schemaVersion, release: 'fixture', models: {}}).models, {});
  }
  const runtime = {schemaVersion: 2, release: 'fixture', artifacts: {'darwin-arm64': zipArtifact('runtime')}};
  assert.deepEqual(parseRuntimeManifest(runtime), runtime);
  assert.throws(() => parseRuntimeManifest({...runtime, schemaVersion: 1}), /LEGACY_REINSTALL_REQUIRED/);
  assert.throws(() => parseRuntimeManifest({...runtime, schemaVersion: 3}), /UNSUPPORTED_SCHEMA_VERSION/);
  for (const [schemaVersion, artifact] of [[2, zipArtifact()], [3, rawArtifact()]]) {
    const model = {name: 'Tiny fixture', purpose: 'stt', license: artifact.provenance.license, artifacts: {'darwin-arm64': artifact}};
    const manifest = {schemaVersion, release: 'fixture', models: {'tiny-model': model}};
    assert.deepEqual(parseModelManifest(manifest), manifest);
    assert.throws(() => parseModelManifest({...manifest, schemaVersion: 1}), /LEGACY_REINSTALL_REQUIRED/);
    assert.throws(() => parseModelManifest({...manifest, schemaVersion: schemaVersion === 2 ? 3 : 2}));
  }
});

test('supported identity lanes still apply boundedMetadata before accepting artifacts', () => {
  for (const [input, kind, version] of [[rawArtifact(), 'model', 3], [zipArtifact(), 'model', 2], [zipArtifact('runtime'), 'runtime', 2]]) {
    input.provenance.license.spdx = 'x'.repeat(ASSET_LIMITS.maxMetadataBytes);
    assert.throws(() => parseArtifact(input, kind, version), {message: 'METADATA_LIMIT'});
    assert.throws(() => artifactIdentity(input), {message: 'METADATA_LIMIT'});
  }
});

test('identity validation still rejects untrusted sources and forged inventory or archive fields', () => {
  for (const mutate of [
    input => { input.sources['config.json'] = 'https://evil.test/config.json'; },
    input => { input.sources['config.json'] = input.sources['config.json'].replace(input.provenance.sourceRevision, 'main'); },
    input => { input.treeDigest = hash('different inventory'); },
    input => { input.sources['extra.json'] = input.sources['config.json']; },
    input => { input.sha256 = input.treeDigest; },
    input => { input.archive = 'zip'; },
  ]) {
    const input = rawArtifact(); mutate(input);
    assert.throws(() => artifactIdentity(input));
    assert.throws(() => parseArtifact(input, 'model', 3));
  }
  for (const mutate of [
    input => { input.url = rawArtifact().sources['config.json']; },
    input => { input.sha256 = 'not-a-hash'; },
    input => { input.treeDigest = hash('different inventory'); },
    input => { input.transport = 'raw-files'; },
  ]) {
    const input = zipArtifact(); mutate(input);
    assert.throws(() => artifactIdentity(input));
    assert.throws(() => parseArtifact(input, 'model', 2));
  }
});
