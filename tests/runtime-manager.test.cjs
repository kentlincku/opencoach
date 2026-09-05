const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const { RuntimeManager, validateZipEntry } = require('../apps/desktop/runtime-manager.cjs');

async function zipWith(name, content) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(content), name, { mode: 0o100755 });
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function manifestFor(buffer, hash = crypto.createHash('sha256').update(buffer).digest('hex')) {
  return {schemaVersion: 1, release: 'runtime-v1', artifacts: {'darwin-arm64': {
    url: 'https://github.com/kentlin/voice-practice/releases/download/runtime-v1/runtime.zip', sha256: hash,
    bytes: buffer.length, entrypoint: 'bin/voice-runtime', archive: 'zip',
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
  const manager = new RuntimeManager({userData, manifest: manifestFor(archive, '0'.repeat(64)), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive)});
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
  const manager = new RuntimeManager({userData, manifest: manifestFor(archive), platform: 'darwin', arch: 'arm64', fetchImpl});
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

test('archive entry validation rejects zip-slip and symlink entries', () => {
  assert.throws(() => validateZipEntry({fileName: '../evil', externalFileAttributes: 0}), /UNSAFE_ARCHIVE_ENTRY/);
  assert.throws(() => validateZipEntry({fileName: '/evil', externalFileAttributes: 0}), /UNSAFE_ARCHIVE_ENTRY/);
  assert.throws(() => validateZipEntry({fileName: 'link', externalFileAttributes: 0o120777 << 16}), /SYMLINK/);
});

test('packaged app selects valid embedded runtime when userData has no installed cache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime embedded '));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const resourcesPath = path.join(root, 'resources');
  const runtimeDir = path.join(resourcesPath, 'runtime');
  await fs.mkdir(runtimeDir, {recursive: true});

  const fixtureFiles = {
    'voice-runtime': Buffer.from('embedded-runtime-binary'),
    '_internal/default.metallib': Buffer.from('metal-default'),
    '_internal/mlx.metallib': Buffer.from('metal-root'),
    '_internal/mlx/lib/mlx.metallib': Buffer.from('metal-lib'),
  };
  for (const [relative, bytes] of Object.entries(fixtureFiles)) {
    const target = path.join(runtimeDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { mode: relative === 'voice-runtime' ? 0o755 : 0o600 });
  }
  const binContent = fixtureFiles['voice-runtime'];
  const binHash = crypto.createHash('sha256').update(binContent).digest('hex');
  const binPath = path.join(runtimeDir, 'voice-runtime');
  const files = Object.fromEntries(Object.entries(fixtureFiles).sort(([a], [b]) => a.localeCompare(b)).map(([relative, bytes]) => [relative, {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }]));
  const treeFrame = Object.entries(files).map(([relative, entry]) => `${relative}\0${entry.bytes}\0${entry.sha256}\n`).join('');

  const metadata = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    entrypoint: 'voice-runtime',
    bytes: binContent.length,
    sha256: binHash,
    fileCount: Object.keys(files).length,
    treeSha256: crypto.createHash('sha256').update(treeFrame).digest('hex'),
    files,
  };
  await fs.writeFile(path.join(runtimeDir, 'metadata.json'), JSON.stringify(metadata));

  const { resolveEmbeddedRuntime } = require('../apps/desktop/runtime-manager.cjs');
  const embedded = await resolveEmbeddedRuntime({resourcesPath, platform: 'darwin', arch: 'arm64'});
  assert.equal(embedded?.state, 'embedded');
  assert.equal(embedded?.entrypoint, binPath);
});

test('embedded runtime rejects path escape, tampered hash or size mismatch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime invalid embedded '));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const resourcesPath = path.join(root, 'resources');
  const runtimeDir = path.join(resourcesPath, 'runtime');
  await fs.mkdir(runtimeDir, {recursive: true});

  const { resolveEmbeddedRuntime } = require('../apps/desktop/runtime-manager.cjs');

  // Traversal entrypoint in metadata
  await fs.writeFile(path.join(runtimeDir, 'metadata.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'darwin-arm64',
    entrypoint: '../../escape-bin',
    bytes: 10,
    sha256: '0'.repeat(64),
  }));
  const escapeRes = await resolveEmbeddedRuntime({resourcesPath, platform: 'darwin', arch: 'arm64'});
  assert.equal(escapeRes, null);

  // Tampered hash
  const binContent = Buffer.from('real-content');
  await fs.writeFile(path.join(runtimeDir, 'voice-runtime'), binContent);
  await fs.writeFile(path.join(runtimeDir, 'metadata.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'darwin-arm64',
    entrypoint: 'voice-runtime',
    bytes: binContent.length,
    sha256: 'wronghash'.padEnd(64, '0'),
  }));
  const tamperedRes = await resolveEmbeddedRuntime({resourcesPath, platform: 'darwin', arch: 'arm64'});
  assert.equal(tamperedRes, null);
});

test('status() re-validates Windows runtime tree and returns unavailable on corruption', async t => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-win-tree-'));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));

  // Create a minimal PE x64 binary for voice-runtime.exe
  const pe = Buffer.alloc(128);
  pe.write('MZ', 0, 'ascii');
  pe.writeUInt32LE(64, 0x3c);
  pe.write('PE\0\0', 64, 'ascii');
  pe.writeUInt16LE(0x8664, 68);

  const dataContent = Buffer.from('payload-data');
  const exeHash = crypto.createHash('sha256').update(pe).digest('hex');
  const dataHash = crypto.createHash('sha256').update(dataContent).digest('hex');

  const files = [
    { path: 'payload.dat', bytes: dataContent.length, sha256: dataHash },
    { path: 'voice-runtime.exe', bytes: pe.length, sha256: exeHash },
  ].sort((a, b) => a.path.localeCompare(b.path));

  const treeHasher = crypto.createHash('sha256');
  for (const f of files) treeHasher.update(`${f.path}:${f.bytes}:${f.sha256}\n`);
  const digest = treeHasher.digest('hex');

  const treeManifest = JSON.stringify({
    schemaVersion: 1,
    platform: 'win32-x64-cpu',
    entrypoint: 'voice-runtime.exe',
    treeDigest: digest,
    fileCount: files.length,
    files,
  });

  const zip = new yazl.ZipFile();
  zip.addBuffer(pe, 'voice-runtime.exe', { mode: 0o100755 });
  zip.addBuffer(dataContent, 'payload.dat', { mode: 0o100644 });
  zip.addBuffer(Buffer.from(treeManifest), 'runtime-manifest.json', { mode: 0o100644 });
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  const archiveHash = crypto.createHash('sha256').update(archive).digest('hex');

  const manifest = {
    schemaVersion: 1,
    release: 'runtime-v1',
    artifacts: {
      'win32-x64-cpu': {
        url: 'https://github.com/kentlin/voice-practice/releases/download/runtime-v1/runtime-win32.zip',
        sha256: archiveHash,
        bytes: archive.length,
        entrypoint: 'voice-runtime.exe',
        archive: 'zip',
        files,
        fileCount: files.length,
        treeDigest: digest,
      },
    },
  };

  const manager = new RuntimeManager({
    userData,
    manifest,
    platform: 'win32',
    arch: 'x64',
    flavor: 'cpu',
    fetchImpl: fetchBuffer(archive),
    healthCheck: async () => true,
  });

  const installResult = await manager.install();
  assert.equal(installResult.state, 'installed');

  // Verify status is installed
  const statusOk = await manager.status();
  assert.equal(statusOk.state, 'installed');

  // Corrupt payload.dat and forge the self-describing internal manifest to match.
  // The trusted outer fileset must still reject the replacement bytes.
  const payloadPath = path.join(statusOk.directory, 'payload.dat');
  const forgedData = Buffer.from('corrupted-payload-data');
  await fs.writeFile(payloadPath, forgedData);
  const forgedFiles = [
    {path: 'payload.dat', bytes: forgedData.length, sha256: crypto.createHash('sha256').update(forgedData).digest('hex')},
    files[1],
  ];
  const forgedHasher = crypto.createHash('sha256');
  for (const item of forgedFiles) forgedHasher.update(`${item.path}:${item.bytes}:${item.sha256}\n`);
  await fs.writeFile(path.join(statusOk.directory, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1, platform: 'win32-x64-cpu', entrypoint: 'voice-runtime.exe',
    treeDigest: forgedHasher.digest('hex'), fileCount: forgedFiles.length, files: forgedFiles,
  }));

  // Verify status detects corruption and returns unavailable
  const statusCorrupted = await manager.status();
  assert.equal(statusCorrupted.state, 'unavailable');
  assert.equal(statusCorrupted.reason, 'RUNTIME_TREE_CORRUPTED');
});
