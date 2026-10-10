'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareBundledVoiceAssets, authenticateInventory, loadTrust } = require('../apps/desktop/bundled-voice-assets.cjs');
const { canonicalInventory } = require('../apps/desktop/tree-integrity.cjs');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const FILES = {
  'runtime/bin/voice-runtime': '#!/bin/sh\n',
  'runtime/bin/_internal/lib.dylib': 'lib',
  'models/whisper/config.json': '{}',
  'models/whisper/weights.safetensors': 'w',
  'models/kokoro/kokoro-v1.0.fp16.onnx': 'onnx',
  'models/kokoro/voices-v1.0.bin': 'voices',
};

function fixture(t) {
  const res = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bundled-')));
  t.after(() => fs.rmSync(res, { recursive: true, force: true }));
  const root = path.join(res, 'voice-assets');
  for (const [rel, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const files = Object.entries(FILES).map(([p, b]) => ({ path: p, bytes: Buffer.byteLength(b), sha256: sha(b) }));
  fs.writeFileSync(path.join(res, 'voice-assets-inventory.json'), JSON.stringify({ files }));
  const whole = canonicalInventory(files);
  const runtime = canonicalInventory(files.filter(f => f.path.startsWith('runtime/')).map(f => ({ ...f, path: f.path.slice(8) })));
  const trust = { schemaVersion: 1, treeDigest: whole.treeDigest, runtimeTreeDigest: runtime.treeDigest, fileCount: files.length,
    entrypoint: 'runtime/bin/voice-runtime',
    roles: { sttRoot: 'models/whisper', onnxModel: 'models/kokoro/kokoro-v1.0.fp16.onnx', onnxVoices: 'models/kokoro/voices-v1.0.bin' } };
  return { res, root, files, trust };
}

test('committed build carries no bundled trust root (null => existing managed path)', () => {
  assert.equal(loadTrust(), null);
});

test('intact bundle verifies and yields absolute role paths inside the bundle', async t => {
  const { res, root, trust } = fixture(t);
  const assets = await prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' });
  assert.equal(assets.command, path.join(root, 'runtime', 'bin', 'voice-runtime'));
  assert.equal(assets.trustedVoice.VOICE_MLX_WHISPER_MODEL, path.join(root, 'models', 'whisper'));
  assert.equal(assets.trustedVoice.VOICE_KOKORO_ONNX_MODEL, path.join(root, 'models', 'kokoro', 'kokoro-v1.0.fp16.onnx'));
  assert.equal(assets.fileCount, 6);
  assert.equal(assets.verifyRuntimeBeforeSpawn(), true);
});

test('tampered file content is rejected', async t => {
  const { res, root, trust } = fixture(t);
  fs.writeFileSync(path.join(root, 'models/kokoro/voices-v1.0.bin'), 'voicez'); // same size, different bytes
  await assert.rejects(prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' }), /INVENTORY_FILE_MISMATCH/);
});

test('extra unlisted file is rejected', async t => {
  const { res, root, trust } = fixture(t);
  fs.writeFileSync(path.join(root, 'runtime/bin/_internal/evil.py'), 'x');
  await assert.rejects(prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' }), /INVENTORY_UNLISTED_FILE/);
});

test('missing file is rejected', async t => {
  const { res, root, trust } = fixture(t);
  fs.unlinkSync(path.join(root, 'models/whisper/config.json'));
  await assert.rejects(prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' }), /INVENTORY_COUNT_MISMATCH/);
});

test('symlink inside the bundle is rejected', async t => {
  const { res, root, trust } = fixture(t);
  const target = path.join(root, 'models/whisper/weights.safetensors');
  fs.renameSync(target, target + '.real');
  fs.symlinkSync(target + '.real', target);
  await assert.rejects(prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' }), /INVENTORY_LINK|MANAGED_PATH_LINK|INVENTORY_UNLISTED_FILE/);
});

test('hardlinked file is rejected', async t => {
  const { res, root, trust } = fixture(t);
  fs.linkSync(path.join(root, 'models/whisper/config.json'), path.join(res, 'outside-link'));
  await assert.rejects(prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' }), /INVENTORY_HARDLINK/);
});

test('inventory JSON edited to match tampered bytes is rejected by the compiled digest', async t => {
  const { res, root, files, trust } = fixture(t);
  fs.writeFileSync(path.join(root, 'runtime/bin/voice-runtime'), '#!/bin/sh\nevil\n');
  const forged = files.map(f => f.path === 'runtime/bin/voice-runtime' ? { ...f, bytes: 15, sha256: sha('#!/bin/sh\nevil\n') } : f);
  fs.writeFileSync(path.join(res, 'voice-assets-inventory.json'), JSON.stringify({ files: forged }));
  await assert.rejects(prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' }), /INVENTORY_DIGEST_MISMATCH/);
});

test('runtime file tampered after launch verification is caught before spawn', async t => {
  const { res, root, trust } = fixture(t);
  const assets = await prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' });
  fs.writeFileSync(path.join(root, 'runtime/bin/_internal/lib.dylib'), 'LIB');
  assert.throws(() => assets.verifyRuntimeBeforeSpawn(), /INVENTORY_FILE_MISMATCH|FILE/);
});

test('symlinked inventory JSON is refused', { skip: process.platform === 'win32' && 'symlink creation needs Developer Mode on Windows' }, async t => {
  const { res, trust } = fixture(t);
  const inv = path.join(res, 'voice-assets-inventory.json');
  fs.renameSync(inv, inv + '.real'); fs.symlinkSync(inv + '.real', inv);
  await assert.rejects(prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'darwin' }), /ELOOP|EMLINK|symbolic|BUNDLED_INVENTORY/i);
});

test('malformed trust roots are refused', () => {
  const ok = { schemaVersion: 1, treeDigest: 'a'.repeat(64), runtimeTreeDigest: 'b'.repeat(64), fileCount: 1, entrypoint: 'runtime/bin/voice-runtime',
    roles: { sttRoot: 'models/w', onnxModel: 'models/k/m', onnxVoices: 'models/k/v' } };
  assert.equal(loadTrust(ok, 'darwin'), ok);
  for (const bad of [
    { ...ok, entrypoint: '/bin/sh' },
    { ...ok, treeDigest: 'nothex' },
    { ...ok, roles: { ...ok.roles, sttRoot: '../etc' } },
    { ...ok, roles: { ...ok.roles, sttRoot: '/abs' } },
    { ...ok, roles: { sttRoot: 'models/w' } },
  ]) assert.throws(() => loadTrust(bad, 'darwin'), /BUNDLED_TRUST_INVALID/);
});

test('trust naming an unlisted role path is refused', t => {
  const { files, trust } = fixture(t);
  assert.throws(() => authenticateInventory({ files }, { ...trust, roles: { ...trust.roles, onnxModel: 'models/kokoro/other.onnx' } }), /BUNDLED_ROLE_UNLISTED/);
});

test('win32 bundle: .exe entrypoint, faster-whisper role and accelerator auto', async t => {
  const res = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bundled-win-')));
  t.after(() => fs.rmSync(res, { recursive: true, force: true }));
  const body = { 'runtime/bin/voice-runtime.exe': 'MZ', 'runtime/bin/_internal/ctranslate2.dll': 'dll',
    'models/whisper/model.bin': 'w', 'models/whisper/tokenizer.json': '{}',
    'models/kokoro/kokoro-v1.0.fp16.onnx': 'onnx', 'models/kokoro/voices-v1.0.bin': 'voices' };
  const root = path.join(res, 'voice-assets');
  for (const [rel, b] of Object.entries(body)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), b); }
  const files = Object.entries(body).map(([p, b]) => ({ path: p, bytes: Buffer.byteLength(b), sha256: sha(b) }));
  fs.writeFileSync(path.join(res, 'voice-assets-inventory.json'), JSON.stringify({ files }));
  const trust = { schemaVersion: 1, treeDigest: canonicalInventory(files).treeDigest,
    runtimeTreeDigest: canonicalInventory(files.filter(f => f.path.startsWith('runtime/')).map(f => ({ ...f, path: f.path.slice(8) }))).treeDigest,
    fileCount: files.length, entrypoint: 'runtime/bin/voice-runtime.exe',
    roles: { sttRoot: 'models/whisper', onnxModel: 'models/kokoro/kokoro-v1.0.fp16.onnx', onnxVoices: 'models/kokoro/voices-v1.0.bin' } };
  assert.equal(loadTrust(trust, 'win32'), trust);
  assert.throws(() => loadTrust(trust, 'darwin'), /BUNDLED_TRUST_INVALID/);
  assert.throws(() => loadTrust({ ...trust, entrypoint: 'runtime/bin/voice-runtime' }, 'win32'), /BUNDLED_TRUST_INVALID/);
  assert.throws(() => loadTrust(trust, 'linux'), /BUNDLED_TRUST_INVALID/);
  const assets = await prepareBundledVoiceAssets({ resourcesPath: res, trust, platform: 'win32' });
  assert.equal(assets.command, path.join(root, 'runtime', 'bin', 'voice-runtime.exe'));
  assert.deepEqual(Object.keys(assets.trustedVoice).sort(), ['VOICE_ACCELERATOR', 'VOICE_FASTER_WHISPER_MODEL', 'VOICE_KOKORO_EXECUTION_PROVIDER',
    'VOICE_KOKORO_ONNX_MODEL', 'VOICE_KOKORO_ONNX_VOICES', 'VOICE_STT_BACKEND', 'VOICE_TTS_BACKEND']);
  assert.equal(assets.trustedVoice.VOICE_STT_BACKEND, 'faster-whisper');
  assert.equal(assets.trustedVoice.VOICE_ACCELERATOR, 'auto');
  assert.equal(assets.trustedVoice.VOICE_FASTER_WHISPER_MODEL, path.join(root, 'models', 'whisper'));
});
