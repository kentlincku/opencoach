'use strict';
// Windows W1 runtime-only stage/pack tooling. NON_NATIVE: tiny synthetic files only;
// no electron-builder run, no App launch. Packaging itself is verified by the parent on Windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const sha = b => createHash('sha256').update(b).digest('hex');
const pack = () => require('../scripts/win-pack-model-packs.cjs');
const catalog = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/windows-model-packs.json'), 'utf8'));
const runtimeFiles = () => [
  { path: 'runtime/bin/voice-runtime.exe', bytes: 3, sha256: sha('exe') },
  { path: 'runtime/bin/_internal/ctranslate2/ctranslate2.dll', bytes: 3, sha256: sha('dll') },
];

test('Windows stage metadata derives win32 schema2 trust and is accepted by the Windows catalog parser', () => {
  const m = pack().deriveStageMetadata(catalog(), runtimeFiles());
  assert.equal(m.trust.entrypoint, 'runtime/bin/voice-runtime.exe');
  assert.equal(m.trust.runtimeProfile, 'windows-ct2-kokoro-cpu-v1');
  assert.equal(m.trust.schemaVersion, 2);
  const { parseWindowsModelCatalog } = require('../apps/desktop/macos-model-catalog.cjs');
  assert.equal(parseWindowsModelCatalog(m.capabilities, m.trust, m.modelManifest).platformKey, 'win32-x64-cpu');
  const compiled = pack().compiledTrustBytes(m.trust).toString('utf8');
  assert.match(compiled, /windows-ct2-kokoro-cpu-v1/);
  // The macOS deriver is unchanged and refuses a Windows runtime tree.
  assert.throws(() => require('../scripts/macos-pack-model-packs.cjs').deriveStageMetadata(catalog(), runtimeFiles()));
});

const SILERO_PATH = 'runtime/bin/_internal/voice_practice_speech_vendor/faster_whisper/assets/silero_vad_v6.onnx';
const SILERO_SHA = '4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2';

test('Windows stage metadata admits the pinned faster-whisper Silero VAD runtime asset', () => {
  const m = pack().deriveStageMetadata(catalog(), [...runtimeFiles(), { path: SILERO_PATH, bytes: 1245151, sha256: SILERO_SHA }]);
  assert.equal(m.trust.fileCount, 3);
});

for (const [name, extra] of [
  ['a Silero VAD with a different hash', { path: SILERO_PATH, bytes: 1245151, sha256: sha('other') }],
  ['the Silero hash at another path', { path: 'runtime/bin/_internal/silero_vad_v6.onnx', bytes: 1245151, sha256: SILERO_SHA }],
  ['an embedded CTranslate2 model', { path: 'runtime/models/stt/model.bin', bytes: 1, sha256: sha('m') }],
  ['an embedded Kokoro model', { path: 'runtime/bin/_internal/kokoro-v1.0.fp16.onnx', bytes: 1, sha256: sha('k') }],
  ['an embedded voices pack', { path: 'runtime/voices-v1.0.bin', bytes: 1, sha256: sha('v') }],
  ['a CUDA library', { path: 'runtime/bin/_internal/cublasLt64_13.dll', bytes: 1, sha256: sha('c') }],
  ['a wheel-bundled cuDNN', { path: 'runtime/bin/_internal/ctranslate2/cudnn64_9.dll', bytes: 1, sha256: sha('d') }],
  ['a non-runtime file', { path: 'models/x.bin', bytes: 1, sha256: sha('x') }],
]) {
  test(`Windows stage metadata refuses ${name}`, () => {
    assert.throws(() => pack().deriveStageMetadata(catalog(), [...runtimeFiles(), extra]), /MODEL_PACK_|BUNDLED_/);
  });
}

test('Windows pack configuration is NSIS (+dir), unsigned, replaces resource arrays and ships only manifests + runtime', () => {
  const tmp = fs.realpathSync(os.tmpdir()), stage = path.join(tmp, 'win-stage'), out = path.join(tmp, 'win-out');
  const plan = pack().packConfiguration(stage, out, { nsis: true });
  assert.deepEqual(plan.targetNames, ['dir', 'nsis']);
  const c = plan.config;
  assert.equal(c.publish, null);
  assert.equal(c.win.signAndEditExecutable, false);
  assert.equal(c.win.target.map(t => t.target).join(), 'dir,nsis');
  assert.equal(c.beforePack, null); assert.equal(c.afterPack, null); assert.equal(c.afterSign, null);
  assert.deepEqual(c.extraResources, [{ from: path.join(stage, 'resources/manifests'), to: 'manifests', filter: ['*.json'] }]);
  assert.deepEqual(c.win.extraResources.map(r => r.to), ['voice-assets', 'voice-assets-inventory.json']);
  assert.equal(c.mac, undefined);
  assert.equal(c.portable, undefined);
  assert.deepEqual(pack().packConfiguration(stage, out, { nsis: false }).targetNames, ['dir']);
});

test('Windows pack CLI requires absolute stage, receipt hash and output; rejects unknown flags', () => {
  const p = pack();
  const abs = process.platform === 'win32' ? 'C:\\x\\stage' : '/x/stage';
  const out = process.platform === 'win32' ? 'C:\\x\\out' : '/x/out';
  assert.deepEqual(p.parseCli(['--stage', abs, '--stage-receipt-sha256', 'a'.repeat(64), '--output', out, '--nsis']),
    { stage: abs, stageReceiptSha256: 'a'.repeat(64), output: out, nsis: true });
  assert.throws(() => p.parseCli(['--stage', 'rel', '--stage-receipt-sha256', 'a'.repeat(64), '--output', out]), /MODEL_PACK_/);
  assert.throws(() => p.parseCli(['--stage', abs, '--stage-receipt-sha256', 'a'.repeat(64), '--output', out, '--dmg']), /MODEL_PACK_CLI_OPTION/);
});

test('Windows stage verification binds receipt hash, trust bytes, inventory and the runtime tree', t => {
  const p = pack();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'win-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
  write('resources/voice-assets/runtime/bin/voice-runtime.exe', 'exe');
  write('resources/voice-assets/runtime/bin/_internal/ctranslate2/ctranslate2.dll', 'dll');
  const files = runtimeFiles();
  const meta = p.deriveStageMetadata(catalog(), files);
  write('resources/voice-assets-inventory.json', JSON.stringify({ files }));
  write('resources/manifests/model-manifest.json', JSON.stringify(meta.modelManifest));
  write('resources/manifests/speech-model-capabilities.json', JSON.stringify(meta.capabilities));
  write('trust.json', JSON.stringify(meta.trust));
  write('bundled-voice-trust.cjs', p.compiledTrustBytes(meta.trust));
  const source = { commit: 'c'.repeat(40), gitTree: 'd'.repeat(40), treeSha256: 'e'.repeat(64) };
  write('source.json', JSON.stringify(source));
  const receipt = p.stageReceipt({ root, source, metadata: meta, runtimeInput: { commit: source.commit } });
  write('receipt.json', JSON.stringify(receipt));
  const receiptSha = sha(fs.readFileSync(path.join(root, 'receipt.json')));
  const ok = p.verifyStage(root, receiptSha, source, { catalog: catalog(), sourceManifests: false });
  assert.equal(ok.trust.runtimeProfile, 'windows-ct2-kokoro-cpu-v1');
  assert.throws(() => p.verifyStage(root, 'f'.repeat(64), source, { catalog: catalog(), sourceManifests: false }), /MODEL_PACK_STAGE_RECEIPT_HASH/);
  fs.appendFileSync(path.join(root, 'resources/voice-assets/runtime/bin/voice-runtime.exe'), 'x');
  assert.throws(() => p.verifyStage(root, receiptSha, source, { catalog: catalog(), sourceManifests: false }), /INVENTORY|MISMATCH/);
});
