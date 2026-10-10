'use strict';
// Schema/HMAC fixtures only. A valid observation schema is NOT native proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash, randomUUID} = require('node:crypto');
const observation = require('../apps/desktop/asset-source-observation.cjs');
const hash = text => createHash('sha256').update(text).digest('hex');

function hybrid(coverage = 'darwin-owned-handles') {
  const modelManifest = hash('synthetic model manifest');
  const raw = (role, tree) => ({role, sourceKind: 'raw-model', manifestDigest: modelManifest,
    identity: {kind: 'raw-files', treeDigest: tree}, treeDigest: tree,
    fileCount: 2, totalBytes: 12, sourceGeneration: `g-${hash(`synthetic ${tree} generation`)}`});
  return {version: 3, status: 'SOURCE_BOUND', authority: 'NON_NATIVE_TEST_ROOT', clientId: randomUUID(),
    generation: randomUUID(), pid: 123, coverage,
    ...(coverage === 'darwin-owned-handles' ? {qualificationScope: 'DARWIN_KERNEL_NO_FORK_RUNTIME_V1'} : {}),
    assets: [{role: 'runtime', sourceKind: 'bundled-runtime', manifestDigest: hash('synthetic runtime-only trust'),
      treeDigest: hash('synthetic runtime inventory'), fileCount: 1, totalBytes: 20},
    raw('sttRoot', hash('synthetic STT')), raw('onnxModel', hash('synthetic TTS')), raw('onnxVoices', hash('synthetic TTS'))],
    dispatch: null};
}

for (const coverage of ['darwin-owned-handles', 'leader-only', 'windows-tree']) {
  test(`v3 ${coverage} schema keeps bundled runtime distinct from typed raw model generations`, async () => {
    const value = hybrid(coverage);
    assert.doesNotThrow(() => observation.validateSource(value));
    const identity = {launchNonce: 'hybrid-fixture-launch', mainPid: 123, webContentsId: 17};
    const authority = observation.createAssetSourceAuthority({...identity, observe: () => value}, 'synthetic-test-secret');
    const consumer = observation.createAssetSourceConsumer(identity, 'synthetic-test-secret');
    try {
      const source = await consumer.read(command => authority(command, identity.webContentsId));
      assert.deepEqual(source, value);
      assert.equal(observation.authenticatedSource(source, identity), true);
      assert.equal(observation.authenticatedSource({...source}, identity), false);
      assert.equal(observation.authenticatedSource(JSON.parse(JSON.stringify(source)), identity), false);
      assert.equal(observation.authenticatedSource(source, {...identity, webContentsId: 18}), false);
      assert.ok(Object.isFrozen(source) && Object.isFrozen(source.assets));
      assert.ok(source.assets.every(Object.isFrozen));
      assert.ok(Object.isFrozen(source.assets[1].identity));
      assert.equal(Object.hasOwn(source.assets[0], 'sourceGeneration'), false);
      assert.ok(source.assets.every(asset => !Object.hasOwn(asset, 'archiveSha256')));
    } finally { consumer.dispose(); }
  });
}

for (const [name, mutate] of [
  ['runtime fake ZIP digest', value => { value.assets[0].archiveSha256 = hash('fake archive'); }],
  ['runtime fake generation', value => { value.assets[0].sourceGeneration = `g-${hash('fake generation')}`; }],
  ['runtime raw identity', value => { value.assets[0].identity = value.assets[1].identity; }],
  ['runtime missing source kind', value => { delete value.assets[0].sourceKind; }],
  ['model archive digest', value => { value.assets[1].archiveSha256 = value.assets[1].treeDigest; }],
  ['model absent generation', value => { delete value.assets[1].sourceGeneration; }],
  ['model UUID generation', value => { value.assets[1].sourceGeneration = randomUUID(); }],
  ['model legacy identity', value => { value.assets[1].identity = {kind: 'zip', archiveSha256: value.assets[1].treeDigest}; }],
  ['model untyped identity', value => { value.assets[1].identity = value.assets[1].treeDigest; }],
  ['identity extra field', value => { value.assets[1].identity.archiveSha256 = value.assets[1].treeDigest; }],
  ['identity mismatched tree', value => { value.assets[1].identity.treeDigest = hash('foreign model'); }],
  ['model digest from another authority', value => { value.assets[2].manifestDigest = hash('different manifest'); }],
  ['source kind exchanged', value => { value.assets[0].sourceKind = 'raw-model'; }],
  ['model kind exchanged', value => { value.assets[1].sourceKind = 'bundled-runtime'; }],
  ['role order exchanged', value => { [value.assets[1], value.assets[2]] = [value.assets[2], value.assets[1]]; }],
  ['duplicate role', value => { value.assets[3].role = 'onnxModel'; }],
  ['missing role', value => { value.assets.pop(); }],
  ['zero file count', value => { value.assets[0].fileCount = 0; }],
  ['fractional byte count', value => { value.assets[1].totalBytes = 0.5; }],
  ['bad tree digest', value => { value.assets[0].treeDigest = 'not-a-digest'; }],
  ['v2 used for raw assets', value => { value.version = 2; value.qualificationScope = 'R55_FIRST_PARTY_FIXED_GRAPH'; }],
  ['legacy scope on hybrid', value => { value.qualificationScope = 'R55_FIRST_PARTY_FIXED_GRAPH'; }],
  ['self-declared unknown scope', value => { value.qualificationScope = 'SELF_DECLARED_NO_FORK'; }],
  ['missing Darwin scope', value => { delete value.qualificationScope; }],
  ['scope without Darwin handles', value => { value.coverage = 'leader-only'; }],
  ['source proof carrying lifetime flags', value => { value.pendingPreparation = false; }],
  ['unknown dispatch', value => { value.dispatch = {method: 'shell.exec', nativeRequestId: randomUUID(), intentId: null}; }],
]) {
  test(`v3 rejects ${name}`, () => {
    const value = hybrid(); mutate(value);
    assert.throws(() => observation.validateSource(value), /ASSET_OBSERVATION_SCHEMA/);
  });
}

test('v3 own-data validation never runs model identity accessors', () => {
  let reads = 0;
  for (const [object, key] of [
    [hybrid(), 'coverage'], [hybrid().assets[0], 'sourceKind'], [hybrid().assets[1].identity, 'kind'],
  ]) {
    const value = hybrid();
    Object.defineProperty(object, key, {enumerable: true, get() { reads++; return 'untrusted'; }});
    if (key === 'sourceKind') value.assets[0] = object;
    if (key === 'kind') value.assets[1].identity = object;
    assert.throws(() => observation.validateSource(key === 'coverage' ? object : value), /ASSET_OBSERVATION_SCHEMA/);
  }
  assert.equal(reads, 0);
});

test('v1 and v2 ZIP observation contracts keep their exact fields and scopes', () => {
  for (const version of [1, 2]) {
    const value = hybrid(version === 2 ? 'darwin-owned-handles' : 'leader-only');
    value.version = version;
    if (version === 2) value.qualificationScope = 'R55_FIRST_PARTY_FIXED_GRAPH';
    value.assets = value.assets.map(asset => ({role: asset.role, manifestDigest: asset.manifestDigest,
      archiveSha256: hash(`synthetic ZIP ${asset.role}`), treeDigest: asset.treeDigest,
      fileCount: asset.fileCount, totalBytes: asset.totalBytes, sourceGeneration: `g-${hash(`ZIP generation ${asset.role}`)}`}));
    assert.doesNotThrow(() => observation.validateSource(value));
    const rawField = JSON.parse(JSON.stringify(value)); rawField.assets[0].sourceKind = 'bundled-runtime';
    assert.throws(() => observation.validateSource(rawField), /ASSET_OBSERVATION_SCHEMA/);
    const missingArchive = JSON.parse(JSON.stringify(value)); delete missingArchive.assets[0].archiveSha256;
    assert.throws(() => observation.validateSource(missingArchive), /ASSET_OBSERVATION_SCHEMA/);
    if (version === 2) {
      value.qualificationScope = 'DARWIN_KERNEL_NO_FORK_RUNTIME_V1';
      assert.throws(() => observation.validateSource(value), /ASSET_OBSERVATION_SCHEMA/);
    }
  }
  assert.doesNotThrow(() => observation.validateSource(observation.missingSource('NO_MANAGED_LAUNCH')));
  assert.throws(() => observation.validateSource({version: 3, status: 'NOT_PROVEN', reason: 'NO_MANAGED_LAUNCH'}), /ASSET_OBSERVATION_SCHEMA/);
});

test('v3 reader retains HMAC/challenge protection for a schema-valid substituted raw identity', async () => {
  const value = hybrid('leader-only');
  const identity = {launchNonce: 'hybrid-hmac-test', mainPid: 123, webContentsId: 17};
  const authority = observation.createAssetSourceAuthority({...identity, observe: () => value}, 'synthetic-test-secret');
  const consumer = observation.createAssetSourceConsumer(identity, 'synthetic-test-secret');
  try {
    await assert.rejects(consumer.read(command => {
      const signed = JSON.parse(JSON.stringify(authority(command, 17)));
      const asset = signed.observation.assets[1];
      asset.treeDigest = hash('substituted bytes'); asset.identity.treeDigest = asset.treeDigest;
      return signed;
    }), /ASSET_OBSERVATION_SIGNATURE/);
    await assert.rejects(consumer.read(command => ({...authority(command, 17), challenge: hash('old challenge')})), /ASSET_OBSERVATION_AUTHORITY/);
    const source = await consumer.read(command => authority(command, 17));
    assert.equal(observation.authenticatedSource(source, identity), true);
  } finally { consumer.dispose(); }
});
