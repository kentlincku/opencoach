const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseRuntimeManifest, selectRuntimeArtifact } = require('../apps/desktop/runtime-manifest.cjs');

const good = () => ({schemaVersion: 1, release: '0.2.0-beta.1', artifacts: {
  'darwin-arm64': {url: 'https://github.com/kentlin/voice-practice/releases/download/runtime-v1/voice-runtime.zip', sha256: 'a'.repeat(64), bytes: 42, entrypoint: 'bin/voice-runtime', archive: 'zip'},
  'win32-x64-cpu': {url: 'https://github.com/kentlin/voice-practice/releases/download/runtime-v1/voice-runtime.zip', sha256: 'b'.repeat(64), bytes: 43, entrypoint: 'voice-runtime.exe', archive: 'zip'},
}});

test('accepts trusted manifest and selects known artifact', () => {
  const manifest = parseRuntimeManifest(good());
  assert.equal(selectRuntimeArtifact(manifest, 'darwin', 'arm64').bytes, 42);
  assert.equal(selectRuntimeArtifact(manifest, 'win32', 'x64', 'cpu').bytes, 43);
  assert.equal(selectRuntimeArtifact(manifest, 'win32', 'x64').entrypoint, 'voice-runtime.exe');
});

for (const [name, mutate] of [
  ['unknown schema', m => { m.schemaVersion = 2; }],
  ['http URL', m => { m.artifacts['darwin-arm64'].url = 'http://github.com/a/b/releases/download/v/a.zip'; }],
  ['untrusted host', m => { m.artifacts['darwin-arm64'].url = 'https://evil.example/a.zip'; }],
  ['bad hash', m => { m.artifacts['darwin-arm64'].sha256 = 'A'.repeat(64); }],
  ['zero bytes', m => { m.artifacts['darwin-arm64'].bytes = 0; }],
  ['absolute entrypoint', m => { m.artifacts['darwin-arm64'].entrypoint = '/tmp/x'; }],
  ['traversal entrypoint', m => { m.artifacts['darwin-arm64'].entrypoint = 'bin/../x'; }],
  ['unknown platform key', m => { m.artifacts['linux-x64'] = m.artifacts['darwin-arm64']; }],
]) test(`rejects ${name}`, () => { const m = good(); mutate(m); assert.throws(() => parseRuntimeManifest(m)); });

test('rejects selection of an unknown runtime platform', () => assert.throws(() => selectRuntimeArtifact(parseRuntimeManifest(good()), 'linux', 'x64')));

test('clean repo packaging check refuses build when dist/voice-runtime is missing', async () => {
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  const emptyTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-repo-test-'));
  try {
    assert.throws(() => checkMacOsRuntime(emptyTempDir), /MISSING_EMBEDDED_RUNTIME/);
  } finally {
    fs.rmSync(emptyTempDir, { recursive: true, force: true });
  }
});

function bindTreeMetadata(metadata) {
  const sortedFiles = Object.fromEntries(Object.entries(metadata.files).sort(([a], [b]) => a.localeCompare(b)));
  metadata.files = sortedFiles;
  metadata.fileCount = Object.keys(sortedFiles).length;
  const frame = Object.entries(sortedFiles)
    .map(([relative, entry]) => `${relative}\0${entry.bytes}\0${entry.sha256}\n`)
    .join('');
  metadata.treeSha256 = crypto.createHash('sha256').update(frame).digest('hex');
  return metadata;
}

async function makeRuntimeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-runtime-check-'));
  const runtimeDir = path.join(root, 'dist', 'voice-runtime');
  await fsp.mkdir(runtimeDir, { recursive: true });
  const binary = Buffer.from('verified macOS runtime');
  const binaryPath = path.join(runtimeDir, 'voice-runtime');
  await fsp.writeFile(binaryPath, binary, { mode: 0o755 });
  await fsp.chmod(binaryPath, 0o755);
  const metallib = Buffer.from('verified mlx metal library');
  const metallibPaths = [
    '_internal/mlx/lib/mlx.metallib',
    '_internal/mlx.metallib',
    '_internal/default.metallib',
  ];
  for (const relativePath of metallibPaths) {
    await fsp.mkdir(path.dirname(path.join(runtimeDir, relativePath)), { recursive: true });
    await fsp.writeFile(path.join(runtimeDir, relativePath), metallib);
  }
  const metallibEntry = {
    bytes: metallib.length,
    sha256: crypto.createHash('sha256').update(metallib).digest('hex'),
  };
  const metadata = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    entrypoint: 'voice-runtime',
    bytes: binary.length,
    sha256: crypto.createHash('sha256').update(binary).digest('hex'),
    files: {
      'voice-runtime': { bytes: binary.length, sha256: crypto.createHash('sha256').update(binary).digest('hex') },
      ...Object.fromEntries(metallibPaths.map(relativePath => [relativePath, metallibEntry])),
    },
  };
  bindTreeMetadata(metadata);
  await fsp.writeFile(path.join(runtimeDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return { root, runtimeDir, binaryPath, metadata };
}

test('macOS runtime preflight rejects a complete manifest that omits the entire MLX output directory', async t => {
  const fixture = await makeRuntimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  await fsp.rm(path.join(fixture.runtimeDir, '_internal'), { recursive: true, force: true });
  for (const relativePath of Object.keys(fixture.metadata.files)) {
    if (relativePath.startsWith('_internal/')) delete fixture.metadata.files[relativePath];
  }
  bindTreeMetadata(fixture.metadata);
  await fsp.writeFile(path.join(fixture.runtimeDir, 'metadata.json'), JSON.stringify(fixture.metadata));
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  assert.throws(() => checkMacOsRuntime(fixture.root), /MISSING_REQUIRED_RUNTIME_FILE/);
});

test('macOS runtime preflight validates metadata, size, hash and executable entrypoint', async t => {
  const fixture = await makeRuntimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  const result = checkMacOsRuntime(fixture.root);
  assert.equal(result.platform, 'darwin-arm64');
  assert.equal(result.bytes, fixture.metadata.bytes);
  assert.equal(result.sha256, fixture.metadata.sha256);
  assert.equal(result.entrypoint, fixture.binaryPath);
});

for (const [name, mutate, expected] of [
  ['invalid metadata JSON', async f => fsp.writeFile(path.join(f.runtimeDir, 'metadata.json'), '{'), /INVALID_RUNTIME_METADATA/],
  ['wrong platform', async f => { f.metadata.platform = 'win32-x64'; await fsp.writeFile(path.join(f.runtimeDir, 'metadata.json'), JSON.stringify(f.metadata)); }, /RUNTIME_PLATFORM_MISMATCH/],
  ['size mismatch', async f => { f.metadata.bytes += 1; await fsp.writeFile(path.join(f.runtimeDir, 'metadata.json'), JSON.stringify(f.metadata)); }, /RUNTIME_SIZE_MISMATCH/],
  ['hash mismatch', async f => { f.metadata.sha256 = '0'.repeat(64); await fsp.writeFile(path.join(f.runtimeDir, 'metadata.json'), JSON.stringify(f.metadata)); }, /RUNTIME_HASH_MISMATCH/],
  ['non-executable entrypoint', async f => fsp.chmod(f.binaryPath, 0o644), /RUNTIME_NOT_EXECUTABLE/],
  ['entrypoint traversal', async f => { f.metadata.entrypoint = '../escape'; await fsp.writeFile(path.join(f.runtimeDir, 'metadata.json'), JSON.stringify(f.metadata)); }, /INVALID_RUNTIME_ENTRYPOINT/],
  ['missing metadata.files', async f => { delete f.metadata.files; await fsp.writeFile(path.join(f.runtimeDir, 'metadata.json'), JSON.stringify(f.metadata)); }, /MISSING_RUNTIME_TREE_MANIFEST/],
  ['null metadata.files', async f => { f.metadata.files = null; await fsp.writeFile(path.join(f.runtimeDir, 'metadata.json'), JSON.stringify(f.metadata)); }, /MISSING_RUNTIME_TREE_MANIFEST/],
  ['empty metadata.files', async f => { f.metadata.files = {}; await fsp.writeFile(path.join(f.runtimeDir, 'metadata.json'), JSON.stringify(f.metadata)); }, /MISSING_RUNTIME_TREE_MANIFEST/],
]) {
  test(`macOS runtime preflight rejects ${name}`, async t => {
    if (process.platform === 'win32' && name === 'non-executable entrypoint') {
      t.skip('Windows does not enforce POSIX executable mode bits');
      return;
    }
    const fixture = await makeRuntimeFixture();
    t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
    await mutate(fixture);
    const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
    assert.throws(() => checkMacOsRuntime(fixture.root), expected);
  });
}

test('macOS runtime preflight rejects a symlinked parent directory escaping runtime root', async t => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation requires an optional OS privilege');
    return;
  }
  const fixture = await makeRuntimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const outside = path.join(fixture.root, 'outside');
  await fsp.mkdir(outside);
  const escaped = Buffer.from('outside executable');
  const escapedPath = path.join(outside, 'voice-runtime');
  await fsp.writeFile(escapedPath, escaped, { mode: 0o755 });
  await fsp.chmod(escapedPath, 0o755);
  await fsp.symlink(path.relative(fixture.runtimeDir, outside), path.join(fixture.runtimeDir, 'bin'));
  fixture.metadata.entrypoint = 'bin/voice-runtime';
  fixture.metadata.bytes = escaped.length;
  fixture.metadata.sha256 = crypto.createHash('sha256').update(escaped).digest('hex');
  await fsp.writeFile(path.join(fixture.runtimeDir, 'metadata.json'), JSON.stringify(fixture.metadata));
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  assert.throws(() => checkMacOsRuntime(fixture.root), /INVALID_RUNTIME_ENTRYPOINT/);
});

async function makeTreeRuntimeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-tree-runtime-check-'));
  const runtimeDir = path.join(root, 'dist', 'voice-runtime');
  await fsp.mkdir(path.join(runtimeDir, '_internal', 'site-packages'), { recursive: true });

  const launcher = Buffer.from('launcher binary content');
  const launcherPath = path.join(runtimeDir, 'voice-runtime');
  await fsp.writeFile(launcherPath, launcher, { mode: 0o755 });
  await fsp.chmod(launcherPath, 0o755);

  const internalLib = Buffer.from('internal lib dylib content');
  const internalLibPath = path.join(runtimeDir, '_internal', 'libcore.dylib');
  await fsp.writeFile(internalLibPath, internalLib, { mode: 0o644 });

  const pyc = Buffer.from('compiled pyc bytecode');
  const pycPath = path.join(runtimeDir, '_internal', 'site-packages', 'module.pyc');
  await fsp.writeFile(pycPath, pyc, { mode: 0o644 });

  const metallib = Buffer.from('tree fixture metallib');
  const metallibPaths = [
    '_internal/mlx/lib/mlx.metallib',
    '_internal/mlx.metallib',
    '_internal/default.metallib',
  ];
  for (const relativePath of metallibPaths) {
    await fsp.mkdir(path.dirname(path.join(runtimeDir, relativePath)), { recursive: true });
    await fsp.writeFile(path.join(runtimeDir, relativePath), metallib);
  }

  const files = {
    'voice-runtime': { bytes: launcher.length, sha256: crypto.createHash('sha256').update(launcher).digest('hex') },
    '_internal/libcore.dylib': { bytes: internalLib.length, sha256: crypto.createHash('sha256').update(internalLib).digest('hex') },
    '_internal/site-packages/module.pyc': { bytes: pyc.length, sha256: crypto.createHash('sha256').update(pyc).digest('hex') },
    ...Object.fromEntries(metallibPaths.map(relativePath => [relativePath, {
      bytes: metallib.length,
      sha256: crypto.createHash('sha256').update(metallib).digest('hex'),
    }])),
  };

  const metadata = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    entrypoint: 'voice-runtime',
    bytes: launcher.length,
    sha256: crypto.createHash('sha256').update(launcher).digest('hex'),
    files,
  };
  bindTreeMetadata(metadata);
  await fsp.writeFile(path.join(runtimeDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);

  return { root, runtimeDir, launcherPath, internalLibPath, pycPath, metadata };
}

test('macOS runtime tree preflight passes with valid onedir tree manifest', async t => {
  const fixture = await makeTreeRuntimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  const result = checkMacOsRuntime(fixture.root);
  assert.equal(result.fileCount, 6);
  assert.equal(result.platform, 'darwin-arm64');
});

test('macOS runtime tree preflight rejects tampered _internal file', async t => {
  const fixture = await makeTreeRuntimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  // Write different content of the exact same length to trigger hash mismatch
  const tampered = Buffer.alloc(26, 0x42);
  await fsp.writeFile(fixture.internalLibPath, tampered);
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  assert.throws(() => checkMacOsRuntime(fixture.root), /RUNTIME_HASH_MISMATCH/);
});

test('macOS runtime tree preflight rejects deleted _internal file', async t => {
  const fixture = await makeTreeRuntimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  await fsp.unlink(fixture.pycPath);
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  assert.throws(() => checkMacOsRuntime(fixture.root), /MISSING_RUNTIME_FILE/);
});

test('macOS runtime tree preflight rejects unlisted file on disk', async t => {
  const fixture = await makeTreeRuntimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(fixture.runtimeDir, '_internal', 'injected_trojan.py'), 'print("pwned")');
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  assert.throws(() => checkMacOsRuntime(fixture.root), /UNLISTED_RUNTIME_FILE/);
});

test('macOS runtime tree preflight rejects symlink in _internal tree', async t => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation requires an optional OS privilege');
    return;
  }
  const fixture = await makeTreeRuntimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  await fsp.unlink(fixture.pycPath);
  await fsp.symlink('/etc/passwd', fixture.pycPath);
  const { checkMacOsRuntime } = await import('../scripts/check-macos-runtime.mjs');
  assert.throws(() => checkMacOsRuntime(fixture.root), /INVALID_RUNTIME_FILE_TYPE/);
});
