'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function runtimeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-product-runtime-'));
  const source = path.join(root, 'Voice Practice.app', 'Contents', 'Resources', 'runtime');
  await fsp.mkdir(path.join(source, '_internal', 'mlx', 'lib'), { recursive: true });
  const files = {
    'voice-runtime': Buffer.from('launcher'),
    '_internal/mlx/lib/mlx.metallib': Buffer.from('metal'),
    '_internal/mlx.metallib': Buffer.from('metal'),
    '_internal/default.metallib': Buffer.from('metal'),
  };
  for (const [relative, bytes] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await fsp.writeFile(path.join(source, relative), bytes, { mode: relative === 'voice-runtime' ? 0o755 : 0o600 });
  }
  const entries = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([relative, bytes]) => [relative, { bytes: bytes.length, sha256: hash(bytes) }]));
  const treeSha256 = hash(Object.entries(entries).map(([relative, entry]) => `${relative}\0${entry.bytes}\0${entry.sha256}\n`).join(''));
  await fsp.writeFile(path.join(source, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 1, platform: 'darwin-arm64', entrypoint: 'voice-runtime',
    bytes: files['voice-runtime'].length, sha256: hash(files['voice-runtime']),
    fileCount: Object.keys(entries).length, treeSha256, files: entries,
  }, null, 2)}\n`);
  return { root, source, treeSha256 };
}

test('packaged child environment is deny-by-default and uses only validated product paths', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac-env-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, 'userData', 'runtime-temp');
  const model = path.join(root, 'userData', 'models', 'whisper');
  await fsp.mkdir(model, { recursive: true });
  const { buildPackagedRuntimeEnvironment, validateProductModelPath } = require('../apps/desktop/macos-runtime-security.cjs');
  const verifiedModel = validateProductModelPath(model, path.join(root, 'userData'));
  const env = buildPackagedRuntimeEnvironment({
    parentEnv: {
      PATH: '/usr/bin:/bin', HOME: '/Users/test', LANG: 'en_US.UTF-8',
      PYTHONPATH: '/evil', PYTHONHOME: '/evil', NODE_OPTIONS: '--require=/evil',
      ELECTRON_RUN_AS_NODE: '1', VOICE_RUNTIME_FAKE: '1', VOICE_RUNTIME_DEBUG: '1',
      VOICE_MLX_WHISPER_MODEL: '/evil-model', DYLD_LIBRARY_PATH: '/evil-lib',
    },
    tempRoot,
    verifiedModels: { mlxWhisper: verifiedModel },
    offline: true,
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'HF_HUB_OFFLINE', 'HOME', 'LANG', 'PATH', 'TEMP', 'TMP', 'TMPDIR',
    'TRANSFORMERS_OFFLINE', 'VOICE_MLX_WHISPER_MODEL', 'VOICE_RUNTIME_TEMP_DIR',
  ].sort());
  assert.equal(env.VOICE_MLX_WHISPER_MODEL, model);
  assert.equal(env.VOICE_RUNTIME_TEMP_DIR, tempRoot);
  for (const key of ['PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'VOICE_RUNTIME_FAKE', 'VOICE_RUNTIME_DEBUG', 'DYLD_LIBRARY_PATH']) {
    assert.equal(env[key], undefined, `${key} must not be inherited`);
  }
});

test('runtime snapshot is private, complete, revalidated, and safely removable', async t => {
  const fixture = await runtimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const userData = path.join(fixture.root, 'userData');
  const { createVerifiedRuntimeSnapshot, removeVerifiedRuntimeSnapshot } = require('../apps/desktop/macos-runtime-security.cjs');
  const snapshot = createVerifiedRuntimeSnapshot({ sourceDirectory: fixture.source, userData });
  assert.ok(snapshot.directory.startsWith(path.join(userData, 'runtime-snapshots') + path.sep));
  assert.equal(snapshot.treeSha256, fixture.treeSha256);
  if (process.platform !== 'win32') assert.equal(fs.statSync(snapshot.directory).mode & 0o077, 0);
  await fsp.writeFile(path.join(fixture.source, 'voice-runtime'), 'tampered source');
  assert.equal(await fsp.readFile(snapshot.entrypoint, 'utf8'), 'launcher');
  removeVerifiedRuntimeSnapshot(snapshot, userData);
  assert.equal(fs.existsSync(snapshot.directory), false);
  assert.throws(() => removeVerifiedRuntimeSnapshot({ directory: fixture.root }, userData), /REFUSE_UNSAFE_RUNTIME_SNAPSHOT_DELETE/);
});

test('runtime validator binds deterministic complete fileset root', async t => {
  const fixture = await runtimeFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const { validateEmbeddedRuntimeDirectory } = require('../apps/desktop/embedded-runtime-validator.cjs');
  const valid = validateEmbeddedRuntimeDirectory(fixture.source, { expectedPlatform: 'darwin-arm64', requireTree: true });
  assert.equal(valid.treeSha256, fixture.treeSha256);
  const metadataPath = path.join(fixture.source, 'metadata.json');
  const metadata = JSON.parse(await fsp.readFile(metadataPath));
  metadata.treeSha256 = '0'.repeat(64);
  await fsp.writeFile(metadataPath, JSON.stringify(metadata));
  assert.throws(() => validateEmbeddedRuntimeDirectory(fixture.source, { expectedPlatform: 'darwin-arm64', requireTree: true }), /RUNTIME_TREE_HASH_MISMATCH/);
});

test('macOS package driver and verifier bind exact clean SHA, fresh canonical dist, unique archives and provenance', () => {
  const runtimeBuilder = read('scripts/build-macos-runtime.sh');
  const driver = read('scripts/build-and-verify-macos-package.sh');
  const verifier = read('scripts/verify-macos-package.mjs');
  assert.doesNotMatch(runtimeBuilder, /BUILD_VENV:-/);
  assert.match(runtimeBuilder, /mktemp -d/);
  assert.match(runtimeBuilder, /cp -RL/);
  assert.match(runtimeBuilder, /Materializing internal symlinks/);
  assert.match(driver, /git rev-parse --show-toplevel/);
  assert.match(driver, /EXPECTED_CODE_SHA/);
  assert.match(driver, /CANONICAL_DIST/);
  assert.match(driver, /REFUSE_UNSAFE_DIST_DELETE/);
  assert.match(driver, /-L "\$CANONICAL_DIST"/);
  assert.match(driver, /SOURCE_SHA\.txt/);
  assert.match(verifier, /EXACTLY_ONE_DMG_REQUIRED/);
  assert.match(verifier, /EXACTLY_ONE_ZIP_REQUIRED/);
  assert.match(verifier, /artifact.*sha256.*bytes.*mtime/si);
  assert.match(verifier, /checkPackagedMacOsRuntime/);
  assert.match(verifier, /SOURCE_SHA_MISMATCH/);
  assert.match(verifier, /ditto/);
  assert.match(verifier, /hdiutil/);
  assert.match(verifier, /-readonly/);
  assert.match(verifier, /ZIP_RUNTIME_MISMATCH/);
  assert.match(verifier, /DMG_RUNTIME_MISMATCH/);
});

test('packaged UI verifier forbids parent environment injection and PID substring discovery', () => {
  const driver = read('scripts/macos-packaged-voice-e2e.cjs');
  assert.doesNotMatch(driver, /const env = \{ \.\.\.process\.env \}/);
  assert.doesNotMatch(driver, /ps', \['-axo', 'pid=,command='/);
  assert.doesNotMatch(driver, /assertRuntimeCleanup|existingRuntimePids/);
  assert.match(driver, /'\/bin\/ps', \['-p', String\(pid\)/);
  assert.match(driver, /startToken/);
  assert.match(driver, /processGeneration/);
  assert.match(driver, /MISSING_VISIBLE_STOP_TRIGGER/);
  assert.match(driver, /CANCEL_TEMP_FILES_BEFORE/);
  assert.match(driver, /RECOVERY_TTS_INVALID/);
  assert.match(driver, /OMLX_ERROR_BUBBLE/);
  assert.match(driver, /auto/i);
  assert.match(driver, /const omlxOnly = process\.argv\.includes\('--omlx-only'\)/);
  assert.match(driver, /INVALID_OMLX_ONLY_FLAGS/);
  assert.match(driver, /if \(!omlxOnly\)[\s\S]*PACKAGED_APP_NATIVE_HEALTH_OK/);
});
