const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const { parseModelManifest, ModelManager } = require('../apps/desktop/model-manager.cjs');
const { digestFiles } = require('../apps/desktop/tree-integrity.cjs');

async function makeZip() { const z = new yazl.ZipFile(); z.addBuffer(Buffer.from('model'), 'weights/model.bin'); z.addBuffer(Buffer.from('voices'), 'weights/voices.bin'); z.end(); const out=[]; for await (const c of z.outputStream) out.push(c); return Buffer.concat(out); }
function manifest(buffer) {
  const modelHash = crypto.createHash('sha256').update('model').digest('hex');
  const voicesHash = crypto.createHash('sha256').update('voices').digest('hex');
  const files = [
    {path: 'weights/model.bin', bytes: 5, sha256: modelHash},
    {path: 'weights/voices.bin', bytes: 6, sha256: voicesHash},
  ];
  const license = {spdx: 'Apache-2.0', url: 'https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE'};
  const integrity = {fileCount: files.length, treeDigest: digestFiles(files)};
  return {schemaVersion: 1, release: 'models-v1', models: {kokoro: {name: 'Kokoro', purpose: 'Speech synthesis', revision: 'v1', license, assets: [
    {...files[0], role: 'onnx', license}, {...files[1], role: 'voices', license},
  ], artifacts: {
  'darwin-arm64': {url: 'https://github.com/kentlin/voice-practice/releases/download/models-v1/kokoro.zip', sha256: crypto.createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length, entrypoint: 'weights/model.bin', archive: 'zip', files, ...integrity},
  'win32-x64-cpu': {url: 'https://github.com/kentlin/voice-practice/releases/download/models-v1/kokoro.zip', sha256: crypto.createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length, entrypoint: 'weights/model.bin', archive: 'zip', files, ...integrity},
}}}}; }

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

test('model manager installs Windows x64 CPU model artifact atomically', async t => {
  const archive = await makeZip();
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'model manager win ')); t.after(() => fs.rm(userData, {recursive:true, force:true}));
  const fetchImpl = async () => { const r = new Response(archive, {headers:{'content-length': String(archive.length)}}); Object.defineProperty(r, 'url', {value:'https://release-assets.githubusercontent.com/model.zip'}); return r; };
  const manager = new ModelManager({userData, manifest: manifest(archive), platform:'win32', arch:'x64', flavor:'cpu', fetchImpl});
  const installed = await manager.install('kokoro');
  assert.equal(await fs.readFile(installed.entrypoint, 'utf8'), 'model');
  assert.equal((await manager.status('kokoro')).state, 'installed');
});
