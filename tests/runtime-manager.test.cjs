const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const { RuntimeManager, validateZipEntry } = require('../apps/desktop/runtime-manager.cjs');
const { canonicalInventory } = require('../apps/desktop/tree-integrity.cjs');
const zipContents = new Map();
// All runtime validation callbacks in this file are MEMORY doubles, not native probe evidence.

async function zipWith(name, content) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(content), name, { mode: 0o100755 });
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  zipContents.set(buffer, {name, content});
  return buffer;
}
function manifestFor(buffer, hash = crypto.createHash('sha256').update(buffer).digest('hex')) {
  const {name, content} = zipContents.get(buffer);
  const inventory = canonicalInventory([{path: name, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex')}]);
  const binding = {modelId: 'fixture', archiveSha256: 'a'.repeat(64)};
  return {schemaVersion: 2, release: 'runtime-v1', artifacts: {'darwin-arm64': {
    url: 'https://github.com/kentlin/voice-practice/releases/download/runtime-v1/runtime.zip', sha256: hash,
    bytes: buffer.length, entrypoint: 'bin/voice-runtime', archive: 'zip',
    files: inventory.files, treeDigest: inventory.treeDigest,
    provenance: {sourceRevision: 'b'.repeat(40), sourceUrl: 'https://example.com/test-fixture', license: {spdx: 'MIT', url: 'https://example.com/license'}},
    modelBindings: {sttRoot: binding, onnxModel: {...binding, path: 'model.bin'}, onnxVoices: {...binding, path: 'voices.bin'}},
  }}};
}
function fetchBuffer(buffer) {
  return async () => {
    const response = new Response(buffer, {status: 200, headers: {'content-length': String(buffer.length)}});
    Object.defineProperty(response, 'url', {value: 'https://release-assets.githubusercontent.com/runtime.zip'});
    return response;
  };
}

test('installs verified zip atomically and records activation metadata', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime manager '));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'ok');
  const manager = new RuntimeManager({userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive), healthCheck: async entry => (await fs.readFile(entry, 'utf8')) === 'ok'});
  const result = await manager.install();
  assert.equal(result.state, 'installed');
  assert.equal(await fs.readFile(result.entrypoint, 'utf8'), 'ok');
  const metadata = JSON.parse(await fs.readFile(path.join(userData, 'runtime/current.json')));
  assert.equal(metadata.current.release, 'runtime-v1');
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.current.sha256, crypto.createHash('sha256').update(archive).digest('hex'));
  assert.deepEqual(Object.keys(metadata.current).sort(), ['kind', 'modelId', 'generation', 'release', 'platformKey',
    'directory', 'entrypoint', 'sha256', 'treeDigest', 'activatedAt'].sort());
  assert.equal(Object.hasOwn(metadata.current, 'identity'), false);
  assert.equal(metadata.previous, null);
  assert.equal((await manager.status()).state, 'installed');
});

test('failed same-release replacement preserves the active runtime', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime rollback '));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const original = await zipWith('bin/voice-runtime', 'working');
  const first = new RuntimeManager({
    userData,
    manifest: manifestFor(original),
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: fetchBuffer(original),
    healthCheck: async entry => (await fs.readFile(entry, 'utf8')) === 'working',
  });
  await first.install();

  const broken = await zipWith('bin/voice-runtime', 'broken');
  const replacement = new RuntimeManager({
    userData,
    manifest: manifestFor(broken),
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: fetchBuffer(broken),
    healthCheck: async () => false,
  });
  await assert.rejects(replacement.install(), /RUNTIME_HEALTH_CHECK_FAILED/);

  const status = await first.status();
  assert.equal(status.state, 'installed');
  assert.equal(await fs.readFile(status.entrypoint, 'utf8'), 'working');
});

test('tampered activation metadata cannot select an arbitrary executable', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime tampered metadata '));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'ok');
  const manager = new RuntimeManager({userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive), healthCheck: async () => true});
  await manager.install();
  const metadataPath = path.join(userData, 'runtime/current.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  const attackerDir = path.join(userData, '..', `attacker-${crypto.randomUUID()}`);
  t.after(() => fs.rm(attackerDir, {recursive: true, force: true}));
  await fs.mkdir(attackerDir, {recursive: true});
  await fs.writeFile(path.join(attackerDir, 'run-me'), 'malicious');
  metadata.current.directory = attackerDir;
  metadata.current.entrypoint = 'run-me';
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  assert.equal((await manager.status()).state, 'unavailable');
});

test('metadata activation failure restores the previous same-release runtime', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime atomic activation '));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const original = await zipWith('bin/voice-runtime', 'working');
  const first = new RuntimeManager({userData, manifest: manifestFor(original), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(original), healthCheck: async () => true});
  await first.install();
  const replacementArchive = await zipWith('bin/voice-runtime', 'replacement');
  const replacement = new RuntimeManager({
    userData,
    manifest: manifestFor(replacementArchive),
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: fetchBuffer(replacementArchive),
    healthCheck: async () => true,
    writeMetadata: async () => { throw new Error('SIMULATED_METADATA_FAILURE'); },
  });
  await assert.rejects(replacement.install(), /SIMULATED_METADATA_FAILURE/);
  const status = await first.status();
  assert.equal(status.state, 'installed');
  assert.equal(await fs.readFile(status.entrypoint, 'utf8'), 'working');
});

test('cancellation after health check never activates the staged runtime', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime cancel activation '));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'ok');
  let manager;
  manager = new RuntimeManager({
    userData,
    manifest: manifestFor(archive),
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: fetchBuffer(archive),
    healthCheck: async () => { manager.cancel(); return true; },
  });
  await assert.rejects(manager.install(), error => error?.name === 'AbortError');
  assert.equal((await manager.status()).state, 'unavailable');
});

test('hash mismatch leaves no active or partial runtime', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime bad hash '));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'bad');
  const manager = new RuntimeManager({userData, manifest: manifestFor(archive, '0'.repeat(64)), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive), healthCheck: async () => true}); // MEMORY gate
  await assert.rejects(manager.install(), /SHA256_MISMATCH/);
  assert.equal((await manager.status()).state, 'unavailable');
});

test('stream aborts as soon as downloaded bytes exceed the signed manifest size', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime oversized '));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const expected = await zipWith('bin/voice-runtime', 'ok');
  const oversized = Buffer.concat([expected, Buffer.alloc(1024)]);
  let largestProgress = 0;
  const fetchImpl = async () => {
    const response = new Response(oversized, {status: 200});
    Object.defineProperty(response, 'url', {value: 'https://release-assets.githubusercontent.com/runtime.zip'});
    return response;
  };
  const manager = new RuntimeManager({
    userData,
    manifest: manifestFor(expected),
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl,
    onProgress: ({bytes}) => { largestProgress = Math.max(largestProgress, bytes); },
    healthCheck: async () => true, // MEMORY gate; download must reject before this
  });
  await assert.rejects(manager.install(), /BYTE_COUNT_EXCEEDED/);
  assert.ok(largestProgress <= expected.length);
  assert.equal((await manager.status()).state, 'unavailable');
});

test('rejects an untrusted redirect before contacting its destination', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime redirect '));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'ok');
  const requested = [];
  const fetchImpl = async url => {
    requested.push(String(url));
    return new Response(null, {status: 302, headers: {location: 'https://evil.example/runtime.zip'}});
  };
  const manager = new RuntimeManager({userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl, healthCheck: async () => true}); // MEMORY gate
  await assert.rejects(manager.install(), /UNTRUSTED_ARTIFACT_URL/);
  assert.equal(requested.length, 1);
});

test('directory preparation failure does not leave install permanently running', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime retry '));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const userData = path.join(root, 'user-data');
  await fs.writeFile(userData, 'not a directory');
  const archive = await zipWith('bin/voice-runtime', 'ok');
  const manager = new RuntimeManager({
    userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64',
    fetchImpl: fetchBuffer(archive), healthCheck: async () => true,
  });

  await assert.rejects(manager.install(), /ENOTDIR/);
  await fs.rm(userData);
  await fs.mkdir(userData);

  const result = await manager.install();
  assert.equal(result.state, 'installed');
});

test('v2 runtime trust gate verifies exact bytes before callback and status rejects rewritten cache', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'b-runtime-trust-'));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'ok');
  const options = {userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive)};
  let calls = 0;
  const manager = new RuntimeManager({...options, healthCheck: async () => { calls++; return true; }}); // MEMORY gate
  const installed = await manager.install();
  assert.equal((await manager.status()).state, 'installed');
  await fs.writeFile(installed.entrypoint, 'NO');
  assert.equal((await manager.status()).state, 'unavailable');
  await fs.writeFile(installed.entrypoint, 'ok');
  await fs.writeFile(path.join(installed.directory, 'inner.json'), '{}');
  assert.equal((await manager.status()).state, 'unavailable');
  await fs.rm(path.join(installed.directory, 'inner.json'));
  await fs.rm(installed.entrypoint);
  assert.equal((await manager.status()).state, 'unavailable');
  await fs.writeFile(installed.entrypoint, 'ok');
  const bad = manifestFor(archive);
  bad.artifacts['darwin-arm64'].files = [{path: 'bin/voice-runtime', bytes: 2, sha256: '0'.repeat(64)}];
  bad.artifacts['darwin-arm64'].treeDigest = canonicalInventory(bad.artifacts['darwin-arm64'].files).treeDigest;
  await assert.rejects(new RuntimeManager({...options, manifest: bad, healthCheck: async () => { calls++; return true; }}).install());
  assert.equal(calls, 1, 'invalid payload must not reach MEMORY gate');
  assert.equal((await manager.status()).state, 'installed');
  await assert.rejects(new RuntimeManager(options).install(), /RUNTIME_VALIDATION_REQUIRED/);
  await fs.writeFile(path.join(userData, 'runtime/current.json'), Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  assert.equal((await manager.status()).state, 'unavailable');
});

test('shared transaction installs immutable G1/G2/G3 and only original pin owner permits retention cleanup', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-generations-'));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'original bytes');
  const options = {userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive), healthCheck: async () => true};
  const first = new RuntimeManager(options);
  const g1 = await first.install();
  assert.match(g1.generation, /^g-[0-9a-f]{64}$/);
  const owner = {};
  const pinned = await first.pinCurrent(owner);
  const second = new RuntimeManager(options);
  assert.equal(first.coordinator, second.coordinator);
  const g2 = await second.install();
  const g3 = await new RuntimeManager(options).install();
  assert.equal(new Set([g1.directory, g2.directory, g3.directory]).size, 3);
  assert.equal(await fs.readFile(pinned.entrypoint, 'utf8'), 'original bytes');
  assert.equal(await pinned.release({}), false);
  assert.equal(await fs.readFile(g1.entrypoint, 'utf8'), 'original bytes');
  assert.equal(await pinned.release(owner), true);
  assert.equal(await pinned.release(), false, 'consumed token never accepts an absent owner');
  await assert.rejects(fs.stat(g1.directory), {code: 'ENOENT'});
  assert.equal(await fs.readFile(g2.entrypoint, 'utf8'), 'original bytes');
  assert.equal((await second.status()).directory, g3.directory);
});

test('candidate validation uses original MEMORY pins, strict true and post-callback inventory', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-candidate-'));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'ok');
  const options = {userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive)};
  const stable = new RuntimeManager({...options, healthCheck: async () => true});
  const g1 = await stable.install();
  let held, candidate;
  const owner = {};
  const rejected = new RuntimeManager({...options, healthCheck: async (entry, context) => {
    candidate = entry;
    assert.equal(context.authority, 'MEMORY');
    held = context.pin(owner); // synchronous before any await, not native termination proof
    assert.equal(held.directory, path.dirname(path.dirname(entry)));
    return 'truthy is not validation';
  }});
  await assert.rejects(rejected.install(), /RUNTIME_HEALTH_CHECK_FAILED/);
  assert.equal(await fs.readFile(candidate, 'utf8'), 'ok');
  assert.equal((await stable.status()).directory, g1.directory);
  assert.equal(await held.release({}), false);
  assert.equal(await held.release(owner), true);
  await assert.rejects(fs.stat(candidate), {code: 'ENOENT'});
  const rewrite = new RuntimeManager({...options, healthCheck: async entry => {
    await fs.writeFile(entry, 'NO'); return true;
  }});
  await assert.rejects(rewrite.install(), /INVENTORY/);
  assert.equal((await stable.status()).directory, g1.directory);
});

test('metadata commit is the cancellation boundary, including injected writer failure after rename', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-commit-'));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'ok');
  const options = {userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive), healthCheck: async () => true};
  const stable = new RuntimeManager(options);
  const g1 = await stable.install();
  const before = await fs.readFile(path.join(userData, 'runtime/current.json'));
  let pre;
  pre = new RuntimeManager({...options, writeMetadata: async (_file, _value, gate) => { pre.cancel(); await gate.commit(); }});
  await assert.rejects(pre.install(), error => error.name === 'AbortError');
  assert.deepEqual(await fs.readFile(path.join(userData, 'runtime/current.json')), before);
  const silent = new RuntimeManager({...options, writeMetadata: async () => {}});
  await assert.rejects(silent.install(), /METADATA_NOT_COMMITTED/);
  let post, lateCommit;
  post = new RuntimeManager({...options, writeMetadata: async (_file, _value, gate) => {
    lateCommit = gate.commit;
    await gate.commit(); post.cancel(); throw new Error('AFTER_RENAME');
  }});
  const g2 = await post.install();
  assert.equal(g2.state, 'installed');
  assert.equal(g2.restartRequired, true);
  assert.equal(g2.warning, 'AFTER_RENAME');
  assert.equal((await stable.status()).directory, g2.directory);
  assert.equal(await fs.readFile(g1.entrypoint, 'utf8'), 'ok');
  assert.throws(lateCommit, /METADATA_COMMIT_CLOSED/);
  assert.equal((await post.install()).state, 'installed', 'old operation cannot retain controller ownership');
});

test('strict metadata tuple rejects malformed fields without throwing or granting pins', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-metadata-'));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const archive = await zipWith('bin/voice-runtime', 'ok');
  const manager = new RuntimeManager({userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive), healthCheck: async () => true});
  await manager.install();
  const filename = path.join(userData, 'runtime/current.json');
  const good = JSON.parse(await fs.readFile(filename));
  for (const change of [x => {x.schemaVersion = 1;}, x => {x.current.kind = 'model';}, x => {x.current.directory = {};},
    x => {x.current.generation = '../escape';}, x => {x.current.treeDigest = '0'.repeat(64);},
    x => {x.current.extra = true;}, x => {x.previous = {directory: []};},
    x => {x.current.activatedAt = '2026-99-99T99:99:99.000Z';}]) {
    const bad = structuredClone(good); change(bad);
    await fs.writeFile(filename, JSON.stringify(bad));
    assert.equal((await manager.status()).state, 'unavailable');
    await assert.rejects(manager.pinCurrent({}));
  }
});

test('archive entry validation rejects zip-slip and symlink entries', () => {
  assert.throws(() => validateZipEntry({fileName: '../evil', externalFileAttributes: 0}), /UNSAFE_ARCHIVE_ENTRY/);
  assert.throws(() => validateZipEntry({fileName: '/evil', externalFileAttributes: 0}), /UNSAFE_ARCHIVE_ENTRY/);
  assert.throws(() => validateZipEntry({fileName: 'link', externalFileAttributes: 0o120777 << 16}), /SYMLINK/);
});
