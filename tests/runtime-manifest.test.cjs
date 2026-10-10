const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRuntimeManifest, selectRuntimeArtifact, parseArtifact, parseModelManifest } = require('../apps/desktop/runtime-manifest.cjs');
const { canonicalInventory, ASSET_LIMITS } = require('../apps/desktop/tree-integrity.cjs');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const { resolveModelBindings } = require('../apps/desktop/runtime-manifest.cjs');

test('binding resolver requires exact trusted model platform archive and inventoried role file', () => {
  assert.equal(typeof resolveModelBindings, 'function');
  const runtime = artifact();
  const model = (id, data) => {
    const a = artifact(); delete a.modelBindings;
    a.sha256 = hash(`${data} fixture`);
    a.files = [{path: 'model.onnx', bytes: 1, sha256: hash('m')}, {path: 'voices.bin', bytes: 1, sha256: hash('v')}];
    a.entrypoint = 'model.onnx'; a.treeDigest = canonicalInventory(a.files).treeDigest;
    return [id, {name: id, purpose: data, license: a.provenance.license, artifacts: {'win32-x64-cpu': a}}];
  };
  const manifest = {schemaVersion: 2, release: 'tiny', models: Object.fromEntries([model('faster-whisper', 'stt'), model('kokoro-onnx', 'tts')])};
  const resolved = resolveModelBindings(runtime, manifest, 'win32-x64-cpu');
  assert.deepEqual(resolved, runtime.modelBindings);
  assert.ok(Object.isFrozen(resolved.onnxModel));
  for (const mutate of [m => { delete m.models['faster-whisper']; },
    m => { m.models['kokoro-onnx'].artifacts['win32-x64-cpu'].sha256 = hash('different'); },
    m => { delete m.models['kokoro-onnx'].artifacts['win32-x64-cpu']; }]) {
    const m = structuredClone(manifest); mutate(m);
    assert.throws(() => resolveModelBindings(runtime, m, 'win32-x64-cpu'), /BINDING/);
  }
  const wrongPath = structuredClone(runtime); wrongPath.modelBindings.onnxVoices.path = 'absent.bin';
  assert.throws(() => resolveModelBindings(wrongPath, manifest, 'win32-x64-cpu'), /BINDING/);
  assert.throws(() => resolveModelBindings(runtime, manifest, 'linux-x64'), /PLATFORM/);
  const a = artifact(); delete a.modelBindings;
  assert.throws(() => resolveModelBindings(a, manifest, 'win32-x64-cpu'));
});
// Tiny synthetic contract data, not release/model trust metadata.
const artifact = () => ({url: 'https://github.com/fixture/assets/releases/download/test/tiny.zip',
  sha256: hash('tiny archive fixture'), bytes: 20, archive: 'zip', entrypoint: 'bin/runtime.exe',
  files: [{path: 'bin/runtime.exe', bytes: 1, sha256: hash('x')}],
  treeDigest: canonicalInventory([{path: 'bin/runtime.exe', bytes: 1, sha256: hash('x')}]).treeDigest,
  provenance: {sourceRevision: hash('fixture source'), sourceUrl: 'https://example.test/fixture', license: {spdx: 'MIT', url: 'https://example.test/license'}},
  modelBindings: {sttRoot: {modelId: 'faster-whisper', archiveSha256: hash('stt fixture')},
    onnxModel: {modelId: 'kokoro-onnx', archiveSha256: hash('tts fixture'), path: 'model.onnx'},
    onnxVoices: {modelId: 'kokoro-onnx', archiveSha256: hash('tts fixture'), path: 'voices.bin'}}});

// Tiny raw contract fixtures; these URLs are never contacted by this test.
const rawArtifact = () => {
  const files = [{path: 'config.json', bytes: 2, sha256: hash('{}')},
    {path: 'weights.safetensors', bytes: 3, sha256: hash('raw')}];
  const revision = hash('tiny raw source fixture').slice(0, 40);
  return {transport: 'raw-files', bytes: 5, entrypoint: 'config.json', files,
    treeDigest: canonicalInventory(files).treeDigest,
    sources: Object.fromEntries(files.map(file => [file.path,
      `https://huggingface.co/fixture/tiny-model/resolve/${revision}/${file.path}`])),
    provenance: {sourceRevision: revision, sourceUrl: 'https://huggingface.co/fixture/tiny-model',
      license: {spdx: 'MIT', url: 'https://example.test/fixture-license'}}};
};
const rawManifest = () => {
  const a = rawArtifact();
  return {schemaVersion: 3, release: 'tiny-raw-fixture', models: {'tiny-raw-model': {
    name: 'Tiny raw fixture', purpose: 'stt', license: a.provenance.license, artifacts: {'darwin-arm64': a}}}};
};

test('v3 model manifest parses frozen raw inventory and exact source mapping without ZIP fields', () => {
  const input = rawManifest();
  const parsed = parseModelManifest(input);
  assert.deepEqual(parsed, input);
  const a = parsed.models['tiny-raw-model'].artifacts['darwin-arm64'];
  for (const value of [parsed, parsed.models, parsed.models['tiny-raw-model'], a, a.files, a.files[0], a.sources, a.provenance]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.deepEqual(parseArtifact(rawArtifact(), 'model', 3), a);
  for (const name of ['url', 'sha256', 'archive', 'modelBindings']) assert.equal(Object.hasOwn(a, name), false);
});

test('raw initial sources are pinned official HTTPS URLs, separate from legacy ZIP policy', () => {
  const {validateRawModelUrl, validateUrl} = require('../apps/desktop/runtime-manifest.cjs');
  const a = rawArtifact();
  const source = a.sources['config.json'];
  const github = 'https://github.com/fixture/assets/releases/download/test/config.json';
  assert.equal(typeof validateRawModelUrl, 'function');
  assert.equal(validateRawModelUrl(source), source);
  assert.equal(validateRawModelUrl(github), github);
  assert.throws(() => validateUrl(source), /UNTRUSTED_ARTIFACT_URL/);
  for (const url of [
    source.replace('/resolve/', '/blob/'), source.replace(a.provenance.sourceRevision, 'main'),
    source.replace(a.provenance.sourceRevision, a.provenance.sourceRevision.slice(0, 7)),
    source.replace(a.provenance.sourceRevision, a.provenance.sourceRevision.toUpperCase()),
    source.replace('https:', 'http:'), source.replace('https:', 'file:'), 'data:text/plain,model',
    source.replace('huggingface.co', 'huggingface.co.evil.test'), source.replace('huggingface.co', 'evil.test'),
    source.replace('huggingface.co', 'huggingface.co:444'), source.replace('huggingface.co', 'user@huggingface.co'),
    source.replace('huggingface.co', 'user:pass@huggingface.co'), source + '#fragment', source + '#',
    source + '?revision=main', source.replace('config.json', '../config.json'),
    source.replace('config.json', '%2e%2e/config.json'), source.replace('config.json', 'sub%2fconfig.json'),
    source.replace('config.json', 'sub\\\\config.json'), source.replace('config.json', 'CON'),
    'https://cas-bridge.xethub.hf.co/arbitrary', 'https://github.com/fixture/assets/blob/main/config.json',
  ]) {
    const bad = rawManifest(); bad.models['tiny-raw-model'].artifacts['darwin-arm64'].sources['config.json'] = url;
    assert.throws(() => parseModelManifest(bad), undefined, url);
    assert.throws(() => validateRawModelUrl(url), undefined, url);
  }
});

test('artifactIdentity discriminates frozen ZIP archive hashes from raw inventory digests', () => {
  const {artifactIdentity} = require('../apps/desktop/runtime-manifest.cjs');
  assert.equal(typeof artifactIdentity, 'function');
  const zip = artifact(); const raw = rawArtifact();
  const archiveIdentity = artifactIdentity(zip);
  const rawIdentity = artifactIdentity(raw);
  assert.deepEqual(archiveIdentity, {kind: 'zip', archiveSha256: zip.sha256});
  assert.deepEqual(rawIdentity, {kind: 'raw-files', treeDigest: raw.treeDigest});
  assert.ok(Object.isFrozen(archiveIdentity)); assert.ok(Object.isFrozen(rawIdentity));
  assert.equal(Object.hasOwn(rawIdentity, 'archiveSha256'), false);
  for (const bad of [null, {}, {...raw, transport: 'zip'}, {...raw, sha256: raw.treeDigest},
    {...raw, treeDigest: hash('not this inventory')}, {...zip, transport: 'raw-files'}, {...zip, sha256: 'not-a-hash'}]) {
    assert.throws(() => artifactIdentity(bad));
  }
});

test('v3 parsing and identity never promote fixture metadata to compiled production authority', () => {
  const {authenticateAssetManifest, manifestAuthority, manifestDigest, inheritManifestAuthority} = require('../apps/desktop/asset-manifest-trust.cjs');
  const input = rawManifest();
  assert.equal(manifestAuthority(parseModelManifest(input)), null);
  assert.throws(() => authenticateAssetManifest(input, 'model'), /ASSET_MANIFEST_UNTRUSTED/);
  authenticateAssetManifest(input, 'model', {testOnlyTrustedDigests: [manifestDigest(input)]});
  const parsed = inheritManifestAuthority(input, parseModelManifest(input));
  assert.equal(manifestAuthority(parsed).authority, 'NON_NATIVE_TEST_ROOT');
  assert.equal(manifestAuthority(structuredClone(parsed)), null);
});

test('v3 raw JSON boundaries reject proxies before invoking their traps', () => {
  const {artifactIdentity} = require('../apps/desktop/runtime-manifest.cjs');
  let traps = 0;
  const wrap = value => new Proxy(value, Object.fromEntries(['get', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'].map(name => [name,
    (...args) => { traps++; return Reflect[name](...args); }])));
  assert.throws(() => parseModelManifest(wrap(rawManifest())));
  for (const field of ['artifact', 'files', 'file', 'sources', 'provenance']) {
    let a = rawArtifact();
    if (field === 'artifact') a = wrap(a);
    else if (field === 'file') a.files[0] = wrap(a.files[0]);
    else a[field] = wrap(a[field]);
    assert.throws(() => parseArtifact(a, 'model', 3));
    assert.throws(() => artifactIdentity(a));
  }
  assert.equal(traps, 0);
});

test('v3 raw descriptors reject non-JSON prototypes and accessors before reading them', () => {
  let reads = 0;
  for (const change of [
    a => { Object.setPrototypeOf(a.files[0], {inherited: true}); },
    a => { Object.setPrototypeOf(a.files, {map: Array.prototype.map}); },
    a => { Object.setPrototypeOf(a.sources, {inherited: 'https://example.test'}); },
    a => { Object.defineProperty(a.files[0], 'sha256', {enumerable: true, get() { reads++; return hash('{}'); }}); },
    a => { Object.defineProperty(a.sources, 'config.json', {enumerable: true, get() { reads++; return rawArtifact().sources['config.json']; }}); },
    a => { Object.defineProperty(a, 'hidden', {value: true}); },
    a => { a.files.hidden = true; }, a => { delete a.files[0]; },
    a => { a[Symbol('unknown')] = true; },
  ]) {
    const a = rawArtifact(); change(a);
    assert.throws(() => parseArtifact(a, 'model', 3));
    const m = rawManifest(); m.models['tiny-raw-model'].artifacts['darwin-arm64'] = a;
    assert.throws(() => parseModelManifest(m));
  }
  assert.equal(reads, 0, 'raw validation must not invoke user-defined getters');
});

test('v3 raw exact fields preserve v1 empty and v2 ZIP version separation', () => {
  for (const change of [
    a => { a.transport = 'zip'; }, a => { a.archive = 'zip'; }, a => { a.sha256 = a.treeDigest; },
    a => { a.url = a.sources['config.json']; }, a => { a.modelBindings = {}; }, a => { a.extra = true; },
    a => { a.bytes++; }, a => { a.bytes = 0; }, a => { a.bytes = Number.MAX_SAFE_INTEGER + 1; },
    a => { a.files[0].bytes = -1; }, a => { a.files[0].bytes = 1.5; },
    a => { a.files[0].sha256 = 'A'.repeat(64); }, a => { a.treeDigest = hash('wrong'); },
    a => { a.entrypoint = 'missing.bin'; }, a => { a.files[0].path = '../config.json'; },
    a => { a.files[1].path = 'CONFIG.json'; }, a => { a.files[0].unknown = true; },
    a => { delete a.sources['config.json']; }, a => { a.sources['other.bin'] = a.sources['config.json']; },
    a => { a.provenance.sourceRevision = 'model-files-v1.1'; }, a => { a.provenance.license.extra = true; },
  ]) {
    const a = rawArtifact(); change(a); assert.throws(() => parseArtifact(a, 'model', 3));
  }
  const m = rawManifest();
  assert.throws(() => parseModelManifest({...m, schemaVersion: 2}));
  assert.throws(() => parseArtifact(rawArtifact(), 'model'));
  assert.throws(() => parseArtifact(rawArtifact(), 'runtime', 3));
  const zip = artifact(); delete zip.modelBindings;
  m.models['tiny-raw-model'].artifacts['darwin-arm64'] = zip;
  assert.throws(() => parseModelManifest(m));
  assert.deepEqual(parseArtifact(zip, 'model'), zip);
  for (const schemaVersion of [1, 2, 3]) assert.deepEqual(parseModelManifest({schemaVersion, release: 'fixture', models: {}}).models, {});
});

const good = () => ({schemaVersion: 2, release: '0.2.0-beta.1', artifacts: {
  'darwin-arm64': artifact(), 'win32-x64-cpu': artifact(),
}});

test('accepts trusted manifest and selects known artifact', () => {
  const manifest = parseRuntimeManifest(good());
  assert.equal(selectRuntimeArtifact(manifest, 'darwin', 'arm64').bytes, 20);
});

for (const [name, mutate] of [
  ['unknown schema', m => { m.schemaVersion = 3; }],
  ['http URL', m => { m.artifacts['darwin-arm64'].url = 'http://github.com/a/b/releases/download/v/a.zip'; }],
  ['untrusted host', m => { m.artifacts['darwin-arm64'].url = 'https://evil.example/a.zip'; }],
  ['bad hash', m => { m.artifacts['darwin-arm64'].sha256 = 'A'.repeat(64); }],
  ['zero bytes', m => { m.artifacts['darwin-arm64'].bytes = 0; }],
  ['absolute entrypoint', m => { m.artifacts['darwin-arm64'].entrypoint = '/tmp/x'; }],
  ['traversal entrypoint', m => { m.artifacts['darwin-arm64'].entrypoint = 'bin/../x'; }],
  ['unknown platform key', m => { m.artifacts['linux-x64'] = m.artifacts['darwin-arm64']; }],
]) test(`rejects ${name}`, () => { const m = good(); mutate(m); assert.throws(() => parseRuntimeManifest(m)); });

test('rejects selection of an unknown runtime platform', () => assert.throws(() => selectRuntimeArtifact(parseRuntimeManifest(good()), 'linux', 'x64')));

test('v2 trust policy preserves empty unavailable states and rejects nonempty legacy', () => {
  const {url, sha256, bytes, archive, entrypoint} = artifact();
  assert.throws(() => parseRuntimeManifest({schemaVersion: 1, release: 'test', artifacts: {'win32-x64-cpu': {url, sha256, bytes, archive, entrypoint}}}), /LEGACY/);
  for (const schemaVersion of [1, 2]) assert.deepEqual(parseRuntimeManifest({schemaVersion, release: 'test', artifacts: {}}).artifacts, {});
  const result = parseRuntimeManifest(good());
  assert.ok(Object.isFrozen(result.artifacts['darwin-arm64'].files[0]));
  assert.ok(Object.isFrozen(result.artifacts['darwin-arm64'].modelBindings.sttRoot));
});

test('v2 parser enforces exact artifact inventory provenance binding fields and bounds', () => {
  assert.equal(typeof parseArtifact, 'function');
  for (const mutate of [
    a => { delete a.files; }, a => { a.files = []; }, a => { a.extra = true; },
    a => { a.treeDigest = hash('wrong'); }, a => { a.entrypoint = 'missing.exe'; },
    a => { a.bytes = ASSET_LIMITS.maxTotalBytes+1; }, a => { a.provenance.sourceRevision = 'main'; },
    a => { a.provenance.sourceUrl = 'http://example.test/x'; }, a => { a.provenance.extra = 1; },
    a => { a.provenance.license.extra = 1; }, a => { a.provenance.license.spdx = ''; },
    a => { a.provenance.license.url = 'https://user:pass@example.test/x'; },
    a => { delete a.modelBindings; }, a => { a.modelBindings.sttRoot.path = 'x'; },
    a => { a.modelBindings.onnxModel.path = '../escape'; }, a => { a.modelBindings.extra = {}; },
    a => { a.modelBindings.sttRoot.modelId = 'BAD ID'; }, a => { a.modelBindings.sttRoot.archiveSha256 = 'A'.repeat(64); },
    a => { a.files[0].extra = 1; }, a => { a.url += 'x'.repeat(2048); },
  ]) { const a = artifact(); mutate(a); assert.throws(() => parseArtifact(a, 'runtime')); }
  assert.throws(() => parseArtifact(artifact(), 'unknown'));
  for (const release of ['../bad', 'CON', 'bad.', 'x'.repeat(101)]) assert.throws(() => parseRuntimeManifest({...good(), release}));
  assert.throws(() => parseRuntimeManifest({...good(), extra: true}));
  assert.throws(() => parseRuntimeManifest({...good(), release: 'x'.repeat(ASSET_LIMITS.maxMetadataBytes)}), /LIMIT/);
});

test('model artifact kind is inventory-only and cannot require or carry runtime bindings', () => {
  assert.equal(typeof parseModelManifest, 'function');
  const a = artifact(); delete a.modelBindings;
  const m = {schemaVersion: 2, release: 'fixture', models: {'kokoro-onnx': {
    name: 'Tiny model fixture', purpose: 'tts', license: {spdx: 'MIT', url: 'https://example.test/license'}, artifacts: {'win32-x64-cpu': a}}}};
  const parsed = parseModelManifest(m);
  assert.equal(parsed.models['kokoro-onnx'].artifacts['win32-x64-cpu'].entrypoint, 'bin/runtime.exe');
  assert.ok(!Object.hasOwn(parseArtifact(a, 'model'), 'modelBindings'));
  assert.throws(() => parseArtifact(a, 'runtime'));
  assert.throws(() => parseArtifact(artifact(), 'model'));
  assert.throws(() => parseModelManifest({...m, schemaVersion: 1}), /LEGACY/);
  for (const schemaVersion of [1, 2]) assert.deepEqual(parseModelManifest({schemaVersion, release: 'test', models: {}}).models, {});
  for (const mutate of [x => { x.extra = 1; }, x => { x.models['kokoro-onnx'].extra = 1; },
    x => { x.models['kokoro-onnx'].license.extra = 1; }, x => { x.models.CON = x.models['kokoro-onnx']; }]) {
    const x = structuredClone(m); mutate(x); assert.throws(() => parseModelManifest(x));
  }
});
