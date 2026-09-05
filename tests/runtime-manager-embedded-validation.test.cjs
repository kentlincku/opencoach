const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadRuntimeManagerWithoutOptionalZipDependency() {
  const originalLoad = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'yauzl') return {};
      return originalLoad.call(this, request, parent, isMain);
    };
    return require('../apps/desktop/runtime-manager.cjs');
  } finally {
    Module._load = originalLoad;
  }
}

test('runtime startup uses strict embedded metadata, size and hash validation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-embedded-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  await fs.mkdir(runtimeDir);
  const files = {
    'voice-runtime': Buffer.from('runtime-binary'),
    '_internal/default.metallib': Buffer.from('metal-default'),
    '_internal/mlx.metallib': Buffer.from('metal-root'),
    '_internal/mlx/lib/mlx.metallib': Buffer.from('metal-lib'),
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(runtimeDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { mode: relative === 'voice-runtime' ? 0o755 : 0o600 });
  }
  await fs.chmod(path.join(runtimeDir, 'voice-runtime'), 0o755);
  const entries = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([relative, bytes]) => [relative, {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }]));
  const treeFrame = Object.entries(entries).map(([relative, entry]) => `${relative}\0${entry.bytes}\0${entry.sha256}\n`).join('');
  const binary = files['voice-runtime'];
  const metadata = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    entrypoint: 'voice-runtime',
    bytes: binary.length,
    sha256: crypto.createHash('sha256').update(binary).digest('hex'),
  };
  await fs.writeFile(path.join(runtimeDir, 'metadata.json'), JSON.stringify(metadata));

  const { resolveEmbeddedRuntime } = loadRuntimeManagerWithoutOptionalZipDependency();
  assert.equal(
    await resolveEmbeddedRuntime({ resourcesPath: root, platform: 'darwin', arch: 'arm64' }),
    null,
    'Embedded onedir runtime without a complete tree manifest must fail closed'
  );

  metadata.files = entries;
  metadata.fileCount = Object.keys(entries).length;
  metadata.treeSha256 = crypto.createHash('sha256').update(treeFrame).digest('hex');
  await fs.writeFile(path.join(runtimeDir, 'metadata.json'), JSON.stringify(metadata));
  const accepted = await resolveEmbeddedRuntime({ resourcesPath: root, platform: 'darwin', arch: 'arm64' });
  assert.equal(accepted?.sha256, metadata.sha256);

  const incomplete = { ...metadata };
  delete incomplete.sha256;
  await fs.writeFile(path.join(runtimeDir, 'metadata.json'), JSON.stringify(incomplete));
  assert.equal(await resolveEmbeddedRuntime({ resourcesPath: root, platform: 'darwin', arch: 'arm64' }), null);

  await fs.writeFile(path.join(runtimeDir, 'metadata.json'), JSON.stringify({ ...metadata, schemaVersion: 2 }));
  assert.equal(await resolveEmbeddedRuntime({ resourcesPath: root, platform: 'darwin', arch: 'arm64' }), null);
});
