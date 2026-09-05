const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yazl = require('yazl');

const {
  canonicalManifestDigest,
  parseRuntimeManifest,
} = require('../apps/desktop/runtime-manifest.cjs');
const runtimeManifestModule = require('../apps/desktop/runtime-manifest.cjs');
const { parseModelManifest, ModelManager } = require('../apps/desktop/model-manager.cjs');
const { RuntimeManager } = require('../apps/desktop/runtime-manager.cjs');
const { buildPackagedSidecarEnvironment } = require('../apps/desktop/sidecar-environment.cjs');
const { digestFiles } = require('../apps/desktop/tree-integrity.cjs');

async function zipFiles(files) {
  const zip = new yazl.ZipFile();
  for (const [name, value] of Object.entries(files)) zip.addBuffer(Buffer.from(value), name);
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const file = (assetPath, value) => ({path: assetPath, bytes: Buffer.byteLength(value), sha256: hash(value)});
function fetchBuffer(buffer) {
  return async () => {
    const response = new Response(buffer, {headers: {'content-length': String(buffer.length)}});
    Object.defineProperty(response, 'url', {value: 'https://release-assets.githubusercontent.com/assets.zip'});
    return response;
  };
}

function runtimeManifest(archive, files) {
  return {schemaVersion: 1, release: 'runtime-v2', artifacts: {'darwin-arm64': {
    url: 'https://github.com/kentlin/voice-practice/releases/download/runtime-v2/runtime.zip',
    sha256: hash(archive), bytes: archive.length, entrypoint: 'bin/voice-runtime', archive: 'zip',
    files, fileCount: files.length, treeDigest: digestFiles(files),
  }}};
}

function modelManifest(archive, files) {
  return {schemaVersion: 1, release: 'models-v2', models: {kokoro: {
    name: 'Kokoro', purpose: 'Speech synthesis', revision: 'kokoro-82m-v1.0-onnx',
    license: {spdx: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0'},
    assets: [
      {...files[0], role: 'onnx', license: {spdx: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0'}},
      {...files[1], role: 'voices', license: {spdx: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0'}},
    ],
    artifacts: {'win32-x64-cpu': {
      url: 'https://github.com/kentlin/voice-practice/releases/download/models-v2/kokoro.zip',
      sha256: hash(archive), bytes: archive.length, entrypoint: files[0].path, archive: 'zip',
      files, fileCount: files.length, treeDigest: digestFiles(files),
    }},
  }}};
}

test('published manifests require a digest embedded in the application trust root', async () => {
  assert.equal(runtimeManifestModule.TRUSTED_MANIFEST_DIGESTS, undefined, 'production trust roots must not be mutable through module exports');
  const archive = await zipFiles({'bin/voice-runtime': 'runtime'});
  const input = runtimeManifest(archive, [file('bin/voice-runtime', 'runtime')]);
  assert.match(canonicalManifestDigest(input), /^[0-9a-f]{64}$/);
  assert.throws(() => parseRuntimeManifest(input, {requireTrusted: true}), /UNTRUSTED_RUNTIME_MANIFEST/);
  const digest = canonicalManifestDigest(input);
  assert.equal(parseRuntimeManifest(input, {requireTrusted: true, trustedDigests: new Set([digest])}).release, 'runtime-v2');
  assert.equal(parseRuntimeManifest({schemaVersion: 1, release: 'unpublished', artifacts: {}}, {requireTrusted: true}).release, 'unpublished');
  assert.throws(() => parseRuntimeManifest({schemaVersion: 1, release: 'unpublished', artifacts: {'darwin-arm64': input.artifacts['darwin-arm64']}}, {requireTrusted: true}), /UNPUBLISHED_MANIFEST_MUST_BE_EMPTY/);
  assert.throws(() => parseRuntimeManifest({schemaVersion: 1, release: 'unpublished', artifacts: {'darwin-arm64': input.artifacts['darwin-arm64']}}), /UNPUBLISHED_MANIFEST_MUST_BE_EMPTY/);
});

test('runtime launch uses a private copy and revalidates the exact copy before spawn', async t => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-launch-'));
  t.after(() => fsp.rm(userData, {recursive: true, force: true}));
  const files = [file('bin/voice-runtime', 'runtime')];
  const archive = await zipFiles({'bin/voice-runtime': 'runtime'});
  const manager = new RuntimeManager({userData, manifest: runtimeManifest(archive, files), platform: 'darwin', arch: 'arm64', fetchImpl: fetchBuffer(archive), healthCheck: async () => true});
  await manager.install();
  const launch = await manager.prepareLaunch();
  assert.notEqual(path.dirname(launch.entrypoint), path.join(userData, 'runtime', 'runtime-v2', 'darwin-arm64', 'bin'));
  await fsp.writeFile(path.join(userData, 'runtime', 'runtime-v2', 'darwin-arm64', 'bin', 'voice-runtime'), 'source-tamper');
  assert.doesNotThrow(() => launch.verify());
  await fsp.writeFile(launch.entrypoint, 'snapshot-tamper');
  assert.throws(() => launch.verify(), /FILE_MISMATCH/);
  await launch.cleanup();
  assert.equal(fs.existsSync(launch.directory), false);
});

test('Kokoro manifest verifies ONNX and voices metadata and propagates trusted asset paths', async t => {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'kokoro-assets-'));
  t.after(() => fsp.rm(userData, {recursive: true, force: true}));
  const files = [file('kokoro-v1.0.onnx', 'onnx'), file('voices-v1.0.bin', 'voices')];
  const archive = await zipFiles({'kokoro-v1.0.onnx': 'onnx', 'voices-v1.0.bin': 'voices'});
  const manifest = modelManifest(archive, files);
  const parsed = parseModelManifest(manifest);
  assert.equal(parsed.models.kokoro.revision, 'kokoro-82m-v1.0-onnx');
  const missingVoices = structuredClone(manifest);
  missingVoices.models.kokoro.assets.pop();
  assert.throws(() => parseModelManifest(missingVoices), /KOKORO_REQUIRED_ASSET_MISSING/);
  const missingTreeDigest = structuredClone(manifest);
  delete missingTreeDigest.models.kokoro.artifacts['win32-x64-cpu'].treeDigest;
  assert.throws(() => parseModelManifest(missingTreeDigest), /ARTIFACT_TREE_INTEGRITY_REQUIRED/);
  const forgedTreeDigest = structuredClone(manifest);
  forgedTreeDigest.models.kokoro.artifacts['win32-x64-cpu'].treeDigest = '0'.repeat(64);
  const forgedManager = new ModelManager({userData, manifest: forgedTreeDigest, platform: 'win32', arch: 'x64', flavor: 'cpu', fetchImpl: fetchBuffer(archive)});
  await assert.rejects(forgedManager.install('kokoro'), /ARTIFACT_TREE_DIGEST_MISMATCH/);
  const manager = new ModelManager({userData, manifest, platform: 'win32', arch: 'x64', flavor: 'cpu', fetchImpl: fetchBuffer(archive)});
  await manager.install('kokoro');
  const prepared = await manager.prepareAssets('kokoro');
  assert.equal(path.basename(prepared.assets.onnx), 'kokoro-v1.0.onnx');
  assert.equal(path.basename(prepared.assets.voices), 'voices-v1.0.bin');
  assert.equal(prepared.revision, 'kokoro-82m-v1.0-onnx');
  assert.doesNotThrow(() => prepared.verify());
  await prepared.cleanup();
});

test('packaged sidecar environment ignores parent Python and VOICE injection', () => {
  const parent = {
    PATH: 'safe-path', SYSTEMROOT: 'safe-root', WINDIR: 'safe-win', TEMP: 'attacker-temp',
    PYTHONPATH: 'evil-python', PYTHONHOME: 'evil-home', VOICE_RUNTIME_FAKE: '1',
    VOICE_STT_BACKEND: 'evil', VOICE_KOKORO_ONNX_MODEL: 'evil-model',
    VOICE_KOKORO_EXECUTION_PROVIDER: 'cuda', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require evil',
  };
  const env = buildPackagedSidecarEnvironment({parent, tempRoot: 'trusted-temp', trustedVoice: {
    VOICE_STT_BACKEND: 'faster-whisper', VOICE_TTS_BACKEND: 'kokoro-onnx',
    VOICE_KOKORO_ONNX_MODEL: 'trusted-model', VOICE_KOKORO_ONNX_VOICES: 'trusted-voices',
    VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu',
  }});
  assert.deepEqual(Object.keys(env).sort(), [
    'SYSTEMROOT', 'TEMP', 'TMP', 'VOICE_KOKORO_EXECUTION_PROVIDER', 'VOICE_KOKORO_ONNX_MODEL',
    'VOICE_KOKORO_ONNX_VOICES', 'VOICE_RUNTIME_TEMP_DIR', 'VOICE_STT_BACKEND', 'VOICE_TTS_BACKEND', 'WINDIR',
  ].sort());
  assert.equal(env.VOICE_KOKORO_ONNX_MODEL, 'trusted-model');
  assert.equal(env.VOICE_RUNTIME_TEMP_DIR, 'trusted-temp');
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.VOICE_RUNTIME_FAKE, undefined);
  assert.equal(env.PATH, undefined);
  assert.equal(env.TEMP, 'trusted-temp');
  assert.equal(env.TMP, 'trusted-temp');
});
