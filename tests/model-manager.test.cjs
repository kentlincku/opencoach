const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const { parseModelManifest, ModelManager } = require('../apps/desktop/model-manager.cjs');

async function makeZip() { const z = new yazl.ZipFile(); z.addBuffer(Buffer.from('model'), 'weights/model.bin'); z.end(); const out=[]; for await (const c of z.outputStream) out.push(c); return Buffer.concat(out); }
function manifest(buffer) {
  // Tiny test-only bytes, not a production model or release manifest.
  const payload = Buffer.from('model');
  const inventory = require('../apps/desktop/tree-integrity.cjs').canonicalInventory([
    {path: 'weights/model.bin', bytes: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex')},
  ]);
  const license = {spdx: 'Apache-2.0', url: 'https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE'};
  return {schemaVersion: 2, release: 'models-v2', models: {kokoro: {
    name: 'Kokoro', purpose: 'Speech synthesis', license,
    artifacts: {'darwin-arm64': {
      url: 'https://github.com/kentlin/voice-practice/releases/download/models-v2/kokoro.zip',
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length,
      entrypoint: 'weights/model.bin', archive: 'zip', files: inventory.files, treeDigest: inventory.treeDigest,
      provenance: {sourceRevision: '1'.repeat(40), sourceUrl: 'https://github.com/kentlin/voice-practice', license},
    }},
  }}};
}

test('model-kind install validates v2 files without probing or executing the model', async t => {
  const archive = await makeZip();
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'model-kind-v2-'));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  let probes = 0;
  const manager = new ModelManager({userData, manifest: manifest(archive), platform: 'darwin', arch: 'arm64',
    fetchImpl: async () => new Response(archive),
    healthCheck: () => { probes++; throw new Error('MODEL_EXECUTION_FORBIDDEN'); },
  });
  const installed = await manager.install('kokoro');
  assert.equal(installed.state, 'installed');
  assert.equal(probes, 0);
  assert.equal(await fs.readFile(installed.entrypoint, 'utf8'), 'model');
  await fs.writeFile(installed.entrypoint, 'tampered');
  assert.equal((await manager.status('kokoro')).state, 'unavailable');
  const legacy = manifest(archive); legacy.schemaVersion = 1;
  assert.throws(() => parseModelManifest(legacy), /LEGACY_REINSTALL_REQUIRED/);
  const wrongKind = manifest(archive); wrongKind.models.kokoro.artifacts['darwin-arm64'].modelBindings = {};
  assert.throws(() => parseModelManifest(wrongKind));
});

test('model manifest requires integrity and license metadata', async () => {
  const archive = await makeZip();
  assert.equal(parseModelManifest(manifest(archive)).models.kokoro.license.spdx, 'Apache-2.0');
  const bad = manifest(archive); bad.models.kokoro.artifacts['darwin-arm64'].sha256 = 'bad';
  assert.throws(() => parseModelManifest(bad));
  const noLicense = manifest(archive); delete noLicense.models.kokoro.license;
  assert.throws(() => parseModelManifest(noLicense));
});

test('model manager installs only trusted manifest selection atomically', async t => {
  const archive = await makeZip();
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'model manager ')); t.after(() => fs.rm(userData, {recursive:true, force:true}));
  const fetchImpl = async () => { const r = new Response(archive, {headers:{'content-length': String(archive.length)}}); Object.defineProperty(r, 'url', {value:'https://release-assets.githubusercontent.com/model.zip'}); return r; };
  const manager = new ModelManager({userData, manifest: manifest(archive), platform:'darwin', arch:'arm64', fetchImpl});
  const installed = await manager.install('kokoro');
  assert.equal(await fs.readFile(installed.entrypoint, 'utf8'), 'model');
  assert.equal((await manager.status('kokoro')).state, 'installed');
  await assert.rejects(manager.install('renderer-supplied-model'), /UNKNOWN_MODEL/);
});
