const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const yazl = require('yazl');
const {RuntimeManager} = require('../apps/desktop/runtime-manager.cjs');
const {ModelManager} = require('../apps/desktop/model-manager.cjs');
const {canonicalInventory} = require('../apps/desktop/tree-integrity.cjs');

async function fixture(t) {
  // macOS: /var is a symlink to /private/var; realpathSync avoids MANAGED_PATH_LINK in assertManagedPath
  const userData = await fs.mkdtemp(path.join(require('node:fs').realpathSync(os.tmpdir()), 'b2-shared-'));
  t.after(() => fs.rm(userData, {recursive: true, force: true}));
  const zip = new yazl.ZipFile(); zip.addBuffer(Buffer.from('tiny'), 'asset.bin'); zip.end();
  const chunks = []; for await (const chunk of zip.outputStream) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const inventory = canonicalInventory([{path: 'asset.bin', bytes: 4, sha256: hash('tiny')}]);
  const license = {spdx: 'MIT', url: 'https://example.com/license'};
  const artifact = {url: 'https://github.com/kentlin/voice-practice/releases/download/test/tiny.zip', bytes: archive.length,
    sha256: hash(archive), archive: 'zip', entrypoint: 'asset.bin', files: inventory.files, treeDigest: inventory.treeDigest,
    provenance: {sourceRevision: 'a'.repeat(40), sourceUrl: 'https://example.com/source', license}};
  const binding = {modelId: 'tiny', archiveSha256: artifact.sha256};
  const manifest = {schemaVersion: 2, release: 'test', artifacts: {'darwin-arm64': {...artifact,
    modelBindings: {sttRoot: binding, onnxModel: {...binding, path: 'asset.bin'}, onnxVoices: {...binding, path: 'asset.bin'}}}}};
  const modelManifest = {schemaVersion: 2, release: 'test', models: {tiny: {name: 'tiny', purpose: 'fixture', license, artifacts: {'darwin-arm64': artifact}}}};
  const options = {userData, manifest, platform: 'darwin', arch: 'arm64', fetchImpl: async () => new Response(archive), healthCheck: async () => true};
  return {userData, options, modelManifest, archive, artifact};
}

test('original constructor identity and coverage cannot be replaced by evidence-mutation MEMORY double', async () => {
  const {bindClientAssets}=require('../apps/desktop/managed-asset-lease.cjs');
  let coverage='leader-only', id='original', removed=0;
  const client={clientId:'original',assetLifetimeSnapshot:()=>Object.freeze({schemaVersion:1,clientId:id,coverage,pendingPreparation:false,unresolvedGenerations:0,unknown:false,fault:false})};
  const bundle={verify:async()=>true,release:async()=>{removed++;}};
  const assets=bindClientAssets(client,bundle);
  await assets.beforeSpawn(); assets.retire();
  id='other'; await assert.rejects(assets.release(client,bundle),/ASSET_LIFETIME_UNCONFIRMED/);
  id='original';client.clientId='other';await assert.rejects(assets.release(client,bundle),/ASSET_LIFETIME_UNCONFIRMED/);
  client.clientId='original';coverage='windows-tree';
  await assert.rejects(assets.release(client,bundle),/ASSET_LIFETIME_UNCONFIRMED/);
  assert.equal(removed,0);
  id='other';assert.throws(()=>bindClientAssets(client,bundle),/ASSET_LIFETIME_UNCONFIRMED/,'constructor identity must agree before binding');
});

test('runtime and fresh model managers share admission, immutable model pins and synchronous reservations', async t => {
  const f = await fixture(t);
  let proceed, entered;
  const reached = new Promise(resolve => {entered = resolve;});
  const blocked = new Promise(resolve => {proceed = resolve;});
  const runtime = new RuntimeManager({...f.options, healthCheck: async () => {entered(); await blocked; return true;}});
  const models = new ModelManager({...f.options, manifest: f.modelManifest});
  assert.equal(models.coordinator, runtime.coordinator);
  const pending = runtime.install();
  const snapshot = runtime.coordinator.snapshot();
  assert.equal(snapshot.pins, 1);
  assert.equal(snapshot.reservedBytes, f.archive.length + 4 + 4 * 1024 ** 2);
  await reached;
  await assert.rejects(new ModelManager({...f.options, manifest: f.modelManifest}).install('tiny'), /INSTALL_ALREADY_RUNNING/);
  proceed(); await pending;
  const g1 = await models.install('tiny');
  const owner = {}; const pinned = await models.pinCurrent('tiny', owner);
  await models.install('tiny');
  const g3 = await new ModelManager({...f.options, manifest: f.modelManifest}).install('tiny');
  assert.notEqual(g1.directory, g3.directory);
  assert.equal(await fs.readFile(g1.entrypoint, 'utf8'), 'tiny');
  assert.equal(await pinned.release({}), false);
  assert.equal(await pinned.release(owner), true);
  await assert.rejects(fs.stat(g1.directory), {code: 'ENOENT'});
});

test('disk refusal counts unknown sparse legacy bytes, uncertain free space and unsafe creation paths; retry remains possible', async t => {
  const f = await fixture(t); const manager = new RuntimeManager(f.options);
  await fs.mkdir(path.join(f.userData, 'models'));
  const unknown = path.join(f.userData, 'models', 'legacy');
  await fs.writeFile(unknown, ''); await fs.truncate(unknown, 32 * 1024 ** 3);
  await assert.rejects(manager.install(), /DISK_BUDGET/);
  assert.equal((await fs.stat(unknown)).size, 32 * 1024 ** 3);
  await fs.truncate(unknown, 1);
  const original = manager.coordinator.io.statfs;
  manager.coordinator.io.statfs = () => ({bavail: 0, bsize: 4096});
  await assert.rejects(manager.install(), /DISK_FREE_RESERVE/);
  manager.coordinator.io.statfs = () => {throw new Error('UNCERTAIN_DISK');};
  await assert.rejects(manager.install(), /DISK_UNAVAILABLE/);
  manager.coordinator.io.statfs = original;
  await fs.mkdir(path.join(f.userData, 'runtime'), {recursive: true});
  const generations = path.join(f.userData, 'runtime/generations');
  await fs.writeFile(generations, 'blocked');
  await assert.rejects(manager.install(), /ENOTDIR|NOT_DIRECTORY/);
  assert.equal(await fs.readFile(generations, 'utf8'), 'blocked');
  await fs.rm(generations);
  assert.equal((await manager.install()).state, 'installed');
  assert.equal((await fs.stat(unknown)).size, 1);
});

test('rejected pinned candidate retains reservation across cleanup failure and retry, bounded roots and tokens', async t => {
  const f = await fixture(t); const owner = {}; const pins = [];
  let entry;
  const manager = new RuntimeManager({...f.options, healthCheck: async (file, context) => {
    entry = file;
    for (let i = 0; i < 127; i++) pins.push(context.pin(owner));
    assert.throws(() => context.pin(owner), /PIN_LIMIT/);
    return false;
  }});
  await assert.rejects(manager.install(), /RUNTIME_HEALTH_CHECK_FAILED/);
  assert.equal(manager.coordinator.snapshot().pins, 127);
  assert.ok(manager.coordinator.snapshot().reservedBytes > 0);
  const remove = manager.coordinator.io.remove;
  manager.coordinator.io.remove = () => {throw new Error('CLEANUP_BUSY');};
  for (const pin of pins) await pin.release(owner);
  assert.equal(await fs.readFile(entry, 'utf8'), 'tiny');
  assert.equal(manager.coordinator.snapshot().retained[0].error, 'CLEANUP_BUSY');
  manager.coordinator.io.remove = remove;
  await manager.coordinator.retryCleanup();
  assert.equal(manager.coordinator.snapshot().reservedBytes, 0);
  await assert.rejects(fs.stat(entry), {code: 'ENOENT'});
  const held = [];
  const rejected = new RuntimeManager({...f.options, healthCheck: async (_file, context) => {held.push(context.pin(owner)); throw new Error('UNKNOWN_NATIVE_AUTHORITY');}});
  for (let i = 0; i < 32; i++) await assert.rejects(rejected.install(), /UNKNOWN_NATIVE_AUTHORITY/);
  await assert.rejects(rejected.install(), /OWNED_ROOT_LIMIT/);
  assert.equal(rejected.coordinator.snapshot().roots, 32);
  for (const pin of held) await pin.release(owner);
  assert.equal(rejected.coordinator.snapshot().roots, 0);
});

test('cleanup never deletes a possibly published candidate even when an injected writer violates its gate contract', async t => {
  const f = await fixture(t); let candidate;
  const manager = new RuntimeManager({...f.options, writeMetadata: async (filename, value) => {
    candidate = value.current.directory;
    // Deliberately invalid host writer: direct write instead of the required commit().
    await fs.writeFile(filename, JSON.stringify(value)); throw new Error('AMBIGUOUS_WRITER_FAILURE');
  }});
  await assert.rejects(manager.install(), /AMBIGUOUS_WRITER_FAILURE/);
  assert.equal(await fs.readFile(path.join(candidate, 'asset.bin'), 'utf8'), 'tiny');
  assert.equal(manager.coordinator.snapshot().retained[0].error, 'CLEANUP_METADATA_REFERENCED');
  await manager.coordinator.retryCleanup();
  assert.equal(await fs.readFile(path.join(candidate, 'asset.bin'), 'utf8'), 'tiny');
});