'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const yazl = require('yazl');
const { ModelManager } = require('../apps/desktop/model-manager.cjs');
const { canonicalInventory } = require('../apps/desktop/tree-integrity.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, fallback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-model-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zip = new yazl.ZipFile(); zip.addBuffer(Buffer.from('synthetic weights'), 'weights.bin'); zip.end();
  const chunks = []; for await (const chunk of zip.outputStream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const inventory = canonicalInventory([{ path: 'weights.bin', bytes: Buffer.byteLength('synthetic weights'), sha256: hash('synthetic weights') }]);
  const license = { spdx: 'MIT', url: 'https://example.com/license' };
  const artifact = { url: 'https://github.com/example/models/releases/download/fixture/model.zip', archive: 'zip',
    sha256: hash(bytes), bytes: bytes.length, entrypoint: 'weights.bin', files: inventory.files, treeDigest: inventory.treeDigest,
    provenance: { sourceRevision: 'a'.repeat(40), sourceUrl: 'https://example.com/source', license } };
  const manifest = { schemaVersion: 2, release: 'fixture', models: { fixture: { name: 'Synthetic fixture', purpose: 'test', license, artifacts: { 'darwin-arm64': artifact } } } };
  const manager = new ModelManager({ userData: root, manifest, platform: 'darwin', arch: 'arm64', onProgress: fallback,
    fetchImpl: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }) });
  return { manager, size: bytes.length };
}

test('a model install captures its own progress callback without mutating manager defaults', async t => {
  const general = [], scoped = [];
  const fallback = progress => general.push(progress);
  const { manager, size } = await fixture(t, fallback);
  await manager.install('fixture', progress => scoped.push(progress));
  assert.ok(scoped.length > 0, 'the original install action must receive its own progress');
  assert.equal(scoped.at(-1).modelId, 'fixture');
  assert.equal(scoped.at(-1).bytes, size);
  assert.equal(general.length, 0);
  assert.equal(manager.options.onProgress, fallback);
});

test('invalid per-install callback is rejected before download admission', async t => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.install('fixture', 'not-a-function'), /INVALID_MODEL_PROGRESS_CALLBACK/);
  assert.equal(manager.active.size, 0);
});
