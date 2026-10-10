'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {RuntimeManager} = require('../apps/desktop/runtime-manager.cjs');
const {ModelManager} = require('../apps/desktop/model-manager.cjs');
const {canonicalInventory} = require('../apps/desktop/tree-integrity.cjs');
const {LEASE_LIMITS} = require('../apps/desktop/managed-asset-lease.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Tiny synthetic files and in-memory HTTP streams only. No official model bytes,
// network calls, production trust roots, native probes or speech execution.
function rawFixture(values = {'config.json': '{}', 'weights.safetensors': 'tiny weights fixture'}) {
  const contents = Object.fromEntries(Object.entries(values).map(([name, data]) => [name, Buffer.from(data)]));
  const inventory = canonicalInventory(Object.entries(contents).map(([name, data]) => ({path: name, bytes: data.length, sha256: hash(data)})));
  const revision = hash('raw transport fixture source').slice(0, 40);
  const artifact = {transport: 'raw-files', bytes: inventory.totalBytes, entrypoint: inventory.files[0].path,
    files: inventory.files, treeDigest: inventory.treeDigest,
    sources: Object.fromEntries(inventory.files.map(file => [file.path, `https://huggingface.co/fixture/tiny-model/resolve/${revision}/${file.path}`])),
    provenance: {sourceRevision: revision, sourceUrl: 'https://huggingface.co/fixture/tiny-model',
      license: {spdx: 'MIT', url: 'https://example.test/fixture-license'}}};
  const manifest = {schemaVersion: 3, release: 'raw-fixture-v1', models: {'tiny-raw': {
    name: 'Tiny raw fixture', purpose: 'stt', license: artifact.provenance.license, artifacts: {'darwin-arm64': artifact}}}};
  return {manifest, artifact, contents};
}
function streamResponse(data, url, {headers = {'content-length': String(data.length)}, status = 200} = {}) {
  let offset = 0;
  const body = new ReadableStream({pull(controller) {
    if (offset === data.length) { controller.close(); return; }
    const end = Math.min(offset + 2, data.length);
    controller.enqueue(data.subarray(offset, end)); offset = end;
  }});
  const response = new Response(body, {status, headers});
  Object.defineProperty(response, 'url', {value: url});
  response.arrayBuffer = () => { throw new Error('WHOLE_FILE_BUFFER_FORBIDDEN'); };
  return response;
}
async function zipModelFixture(fixture) {
  const zip = new (require('yazl').ZipFile)();
  for (const [name, data] of Object.entries(fixture.contents)) zip.addBuffer(data, name, {mode: 0o100600});
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const {entrypoint, files, treeDigest, provenance} = fixture.artifact;
  const artifact = {url: 'https://github.com/fixture/assets/releases/download/test/model.zip', archive: 'zip',
    bytes: buffer.length, sha256: hash(buffer), entrypoint, files, treeDigest, provenance};
  const manifest = structuredClone(fixture.manifest);
  manifest.schemaVersion = 2; manifest.models['tiny-raw'].artifacts['darwin-arm64'] = artifact;
  return {manifest, buffer, artifact};
}
function fixtureFetch(fixture) {
  return async url => {
    const entry = Object.entries(fixture.artifact.sources).find(([, source]) => source === url);
    assert.ok(entry, 'fetch must use an exact fixture manifest source');
    return streamResponse(fixture.contents[entry[0]], url);
  };
}
async function setup(t, fixture = rawFixture()) {
  const appUserData = await fs.mkdtemp(path.join(syncFs.realpathSync(os.tmpdir()), 'raw-model-fixture-'));
  t.after(() => fs.rm(appUserData, {recursive: true, force: true}));
  const userData = path.join(appUserData, 'models', 'tiny-raw');
  const options = {appUserData, userData, manifest: fixture.manifest, artifactKind: 'model', modelId: 'tiny-raw',
    platform: 'darwin', arch: 'arm64', fetchImpl: fixtureFetch(fixture)};
  return {...fixture, options, appUserData, userData, metadataPath: path.join(userData, 'runtime', 'current.json'),
    generations: path.join(userData, 'runtime', 'generations')};
}

test('raw verification progress remains cancellable before activation metadata is committed', async t => {
  const f = await setup(t), phases = [];
  const manager = new RuntimeManager({ ...f.options, onProgress: progress => {
    phases.push(progress.phase);
    if (progress.phase === 'verifying') {
      assert.equal(progress.bytes, f.artifact.bytes);
      assert.equal(progress.total, f.artifact.bytes);
      assert.equal(syncFs.existsSync(f.metadataPath), false);
      assert.equal(manager.coordinator.snapshot().active, true);
      manager.cancel();
    }
  } });
  await assert.rejects(manager.install(), error => error.name === 'AbortError', 'verification phase must remain cancellable before activation');
  assert.equal(phases.at(-1), 'verifying');
  assert.equal(syncFs.existsSync(f.metadataPath), false);
  assert.equal(manager.coordinator.snapshot().pins, 0);
  assert.equal(manager.coordinator.snapshot().active, false);
});

test('raw redirects bound retries, require Location and cannot cross the GitHub source lane', async t => {
  for (const mode of ['loop', 'missing location', 'GitHub to HF']) {
    const fixture = rawFixture({'config.json': '{}'});
    if (mode === 'GitHub to HF') fixture.artifact.sources['config.json'] = 'https://github.com/fixture/assets/releases/download/test/config.json';
    const f = await setup(t, fixture);
    let calls = 0, closed = 0;
    const manager = new RuntimeManager({...f.options, fetchImpl: async url => {
      calls++;
      const location = mode === 'GitHub to HF' ? rawFixture().artifact.sources['config.json'] : url;
      const response = new Response(new ReadableStream({cancel() { closed++; }}), {
        status: 302, headers: mode === 'missing location' ? {} : {location},
      });
      Object.defineProperty(response, 'url', {value: url}); return response;
    }});
    await assert.rejects(manager.install(), mode === 'loop' ? /TOO_MANY_REDIRECTS/
      : mode === 'missing location' ? /REDIRECT_LOCATION_MISSING/ : /UNTRUSTED_ARTIFACT_URL/);
    assert.equal(calls, mode === 'loop' ? 6 : 1); assert.equal(closed, calls);
    assert.equal(manager.coordinator.snapshot().active, false);
    assert.deepEqual(await fs.readdir(f.generations), []);
  }
});

test('raw rejection waits for a Node-body close rather than releasing its original pin early', async t => {
  const f = await setup(t);
  let closeBody, notifyClosing;
  const closing = new Promise(resolve => { notifyClosing = resolve; });
  const body = new (require('node:stream').Readable)({read() {}, destroy(error, callback) {
    closeBody = () => { closeBody = undefined; callback(error); }; notifyClosing();
  }});
  const manager = new RuntimeManager({...f.options, fetchImpl: async url => ({url, status: 403, ok: false, body, headers: new Headers()})});
  const done = manager.install().then(value => ({value}), error => ({error}));
  t.after(async () => { closeBody?.(); await done; });
  await closing;
  assert.equal(manager.coordinator.snapshot().pins, 1); assert.equal(manager.coordinator.snapshot().active, true);
  closeBody();
  const outcome = await done;
  assert.match(outcome.error?.message, /DOWNLOAD_FAILED:403/);
  assert.equal(body.closed, true); assert.equal(manager.coordinator.snapshot().pins, 0);
  assert.equal(manager.coordinator.snapshot().active, false);
});

test('raw cancellation retains the shared ZIP admission and reservation until its response drains', async t => {
  const f = await setup(t);
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
  const entered = deferred(), fetched = deferred(), closing = deferred(), closed = deferred();
  let calls = 0;
  const raw = new RuntimeManager({...f.options, fetchImpl: async () => { calls++; entered.resolve(); return fetched.promise; }});
  const done = raw.install().then(value => ({value}), error => ({error}));
  t.after(async () => { fetched.resolve(streamResponse(f.contents['config.json'], f.artifact.sources['config.json'])); closed.resolve(); await done; });
  await entered.promise;
  assert.equal(raw.coordinator.snapshot().reservedBytes, f.artifact.bytes + LEASE_LIMITS.scratchBytes);
  const legacy = await zipModelFixture(f);
  const binding = {modelId: 'tiny-raw', archiveSha256: legacy.artifact.sha256};
  const runtimeArtifact = {...legacy.artifact, modelBindings: {sttRoot: binding,
    onnxModel: {...binding, path: 'config.json'}, onnxVoices: {...binding, path: 'weights.safetensors'}}};
  const zip = new RuntimeManager({userData: f.appUserData, manifest: {schemaVersion: 2, release: 'tiny-runtime-fixture', artifacts: {'darwin-arm64': runtimeArtifact}},
    platform: 'darwin', arch: 'arm64', healthCheck: async () => true, // MEMORY, never reached
    fetchImpl: async () => { throw new Error('ZIP_FETCH_MUST_NOT_START'); },
  });
  assert.equal(zip.coordinator, raw.coordinator);
  await assert.rejects(zip.install(), /INSTALL_ALREADY_RUNNING/);
  raw.cancel();
  await assert.rejects(new RuntimeManager(f.options).install(), /INSTALL_ALREADY_RUNNING/);
  const response = new Response(new ReadableStream({cancel() { closing.resolve(); return closed.promise; }}));
  Object.defineProperty(response, 'url', {value: f.artifact.sources['config.json']});
  fetched.resolve(response);
  await closing.promise;
  assert.equal(raw.coordinator.snapshot().active, true);
  assert.equal(raw.coordinator.snapshot().pins, 1);
  closed.resolve();
  const outcome = await done;
  assert.equal(outcome.error?.name, 'AbortError'); assert.equal(calls, 1);
  assert.deepEqual(raw.coordinator.snapshot(), {active: false, roots: 0, pins: 0, reservedBytes: 0, retained: []});
  assert.deepEqual(await fs.readdir(f.generations), []);
});

test('raw disk admission reserves file bytes plus bounded scratch without a fictitious archive copy', async t => {
  const f = await setup(t);
  let calls = 0;
  const manager = new RuntimeManager({...f.options, fetchImpl: async url => { calls++; return fixtureFetch(f)(url); }});
  const io = manager.coordinator.io.statfs;
  t.after(() => { manager.coordinator.io.statfs = io; });
  const reservation = f.artifact.bytes + LEASE_LIMITS.scratchBytes;
  manager.coordinator.io.statfs = () => {
    assert.equal(manager.coordinator.snapshot().reservedBytes, reservation);
    return {bsize: 1, bavail: LEASE_LIMITS.freeBytes + reservation - 1};
  };
  await assert.rejects(manager.install(), /DISK_FREE_RESERVE/);
  assert.equal(calls, 0); assert.equal(manager.coordinator.snapshot().active, false);
  await assert.rejects(fs.stat(f.generations), {code: 'ENOENT'});
  manager.coordinator.io.statfs = () => ({bsize: 1, bavail: LEASE_LIMITS.freeBytes + reservation});
  assert.equal((await manager.install()).state, 'installed');
  assert.equal(calls, f.artifact.files.length);
  assert.equal(manager.coordinator.snapshot().reservedBytes, 0);
});

test('raw final inventory refuses extra files, directories, links and hardlinks before publication', async t => {
  for (const kind of ['extra file', 'extra directory', 'symlink', 'hardlink']) {
    const f = await setup(t), first = new RuntimeManager(f.options), g1 = await first.install();
    const before = await fs.readFile(f.metadataPath);
    let calls = 0;
    const manager = new RuntimeManager({...f.options, fetchImpl: async url => {
      if (++calls === 2) {
        const generation = (await fs.readdir(f.generations)).find(value => value !== g1.generation);
        const payload = path.join(f.generations, generation, 'payload'), extra = path.join(payload, 'unexpected');
        if (kind === 'extra file') await fs.writeFile(extra, 'unlisted');
        if (kind === 'extra directory') await fs.mkdir(extra);
        if (kind === 'symlink') await fs.symlink(g1.entrypoint, extra);
        if (kind === 'hardlink') await fs.link(path.join(payload, 'config.json'), extra);
      }
      return fixtureFetch(f)(url);
    }});
    await assert.rejects(manager.install(), /INVENTORY|MANAGED_PATH_LINK/);
    assert.deepEqual(await fs.readFile(f.metadataPath), before);
    assert.deepEqual(await fs.readdir(f.generations), [g1.generation]);
    assert.equal((await first.status()).state, 'installed');
  }
});

test('raw activation tuples reject identity confusion without granting a pin', async t => {
  const f = await setup(t);
  const manager = new RuntimeManager(f.options), installed = await manager.install();
  const good = JSON.parse(await fs.readFile(f.metadataPath));
  for (const change of [
    x => { x.schemaVersion = 2; }, x => { x.current.identity = {kind: 'zip', archiveSha256: x.current.treeDigest}; },
    x => { x.current.sha256 = x.current.treeDigest; }, x => { delete x.current.identity; },
    x => { x.current.identity.extra = true; }, x => { x.current.identity.treeDigest = hash('other fixture'); },
    x => { x.current.identity.treeDigest = 'A'.repeat(64); }, x => { x.current.identity = []; },
    x => { x.current.treeDigest = x.current.identity.treeDigest = hash('another valid but untrusted tree'); },
    x => { x.current.kind = 'runtime'; }, x => { x.current.modelId = 'different-model'; },
    x => { x.current.entrypoint = 'missing.bin'; }, x => { x.current.activatedAt = '2026-99-01T00:00:00.000Z'; },
    x => { x.previous = structuredClone(x.current); x.previous.identity.kind = 'zip'; },
  ]) {
    const bad = structuredClone(good); change(bad);
    await fs.writeFile(f.metadataPath, JSON.stringify(bad));
    assert.equal((await manager.status()).state, 'unavailable');
    await assert.rejects(manager.pinCurrent({}), /UNTRUSTED_ACTIVATION_METADATA/);
    assert.equal(manager.coordinator.snapshot().pins, 0);
    assert.deepEqual(await fs.readFile(installed.entrypoint), f.contents['config.json']);
  }
  await fs.writeFile(f.metadataPath, JSON.stringify(good));
  assert.equal((await manager.status()).state, 'installed');
});

test('raw commit keeps the original before-versus-after cancellation boundary', async t => {
  const f = await setup(t), first = new RuntimeManager(f.options);
  const g1 = await first.install(), before = await fs.readFile(f.metadataPath);
  const pre = new RuntimeManager({...f.options, writeMetadata: (_file, _value, {commit}) => { pre.cancel(); commit(); }});
  await assert.rejects(pre.install(), error => error.name === 'AbortError');
  assert.deepEqual(await fs.readFile(f.metadataPath), before);
  const silent = new RuntimeManager({...f.options, writeMetadata: async () => {}});
  await assert.rejects(silent.install(), /METADATA_NOT_COMMITTED/);
  assert.deepEqual(await fs.readFile(f.metadataPath), before);
  let lateCommit;
  const post = new RuntimeManager({...f.options, writeMetadata: (_file, _value, {commit}) => {
    lateCommit = commit; commit(); post.cancel(); throw new Error('FIXTURE_AFTER_COMMIT');
  }});
  const g2 = await post.install();
  assert.equal(g2.state, 'installed'); assert.equal(g2.restartRequired, true);
  assert.equal(g2.warning, 'FIXTURE_AFTER_COMMIT');
  assert.equal((await first.status()).generation, g2.generation);
  const metadata = JSON.parse(await fs.readFile(f.metadataPath));
  assert.equal(metadata.schemaVersion, 3); assert.equal(metadata.previous.generation, g1.generation);
  assert.deepEqual(metadata.previous.identity, g1.identity);
  assert.throws(lateCommit, /METADATA_COMMIT_CLOSED/);
  assert.equal(post.controller, null);
});

test('raw pins retain the original typed generation across G2/G3 until the original owner releases', async t => {
  const f = await setup(t), first = new RuntimeManager(f.options), g1 = await first.install();
  const owner = {}, pinned = await first.pinCurrent(owner);
  const newer = rawFixture({'config.json': '{"fixture":"new"}', 'weights.safetensors': 'new tiny weights'});
  const second = new RuntimeManager({...f.options, manifest: newer.manifest, fetchImpl: fixtureFetch(newer)});
  const g2 = await second.install(), g3 = await second.install();
  assert.deepEqual(pinned.identity, g1.identity); assert.notDeepEqual(g2.identity, g1.identity);
  assert.equal((await second.status()).generation, g3.generation);
  assert.equal(await pinned.release({}), false);
  assert.deepEqual(await fs.readFile(pinned.entrypoint), f.contents['config.json']);
  assert.equal(await pinned.release(owner), true); assert.equal(await pinned.release(owner), false);
  await assert.rejects(fs.stat(g1.directory), {code: 'ENOENT'});
  assert.deepEqual(await fs.readFile(g2.entrypoint), newer.contents['config.json']);
  assert.equal(second.coordinator.snapshot().roots, 2);
  assert.equal(second.coordinator.snapshot().pins, 0);
});

for (const failure of ['bad hash', 'short', 'overlong', 'disconnected']) {
  test(`second raw file ${failure} preserves the exact committed G1`, async t => {
    const f = await setup(t);
    const first = new RuntimeManager(f.options), g1 = await first.install();
    const before = await fs.readFile(f.metadataPath);
    const progress = [];
    let calls = 0;
    const manager = new RuntimeManager({...f.options, onProgress: value => progress.push(value), fetchImpl: async url => {
      if (++calls === 1) return fixtureFetch(f)(url);
      const expected = f.contents['weights.safetensors'];
      if (failure === 'disconnected') {
        let pulled = false;
        const response = new Response(new ReadableStream({pull(controller) {
          if (pulled) controller.error(new Error('FIXTURE_CONNECTION_LOST'));
          else { pulled = true; controller.enqueue(expected.subarray(0, 1)); }
        }}));
        Object.defineProperty(response, 'url', {value: url}); return response;
      }
      const data = failure === 'bad hash' ? Buffer.alloc(expected.length, 0)
        : failure === 'short' ? expected.subarray(0, -1) : Buffer.concat([expected, Buffer.from('extra')]);
      return streamResponse(data, url, {headers: {}});
    }});
    const expectedError = {'bad hash': /SHA256_MISMATCH/, short: /BYTE_COUNT_MISMATCH/,
      overlong: /BYTE_COUNT_EXCEEDED/, disconnected: /FIXTURE_CONNECTION_LOST/}[failure];
    await assert.rejects(manager.install(), expectedError);
    assert.equal(calls, 2);
    assert.deepEqual(await fs.readFile(f.metadataPath), before);
    assert.deepEqual(await fs.readdir(f.generations), [g1.generation]);
    assert.equal((await first.status()).generation, g1.generation);
    assert.ok(progress.every(value => value.bytes <= f.artifact.bytes && value.total === f.artifact.bytes));
    assert.deepEqual(manager.coordinator.snapshot(), {active: false, roots: 1, pins: 0, reservedBytes: 0, retained: []});
  });
}

test('ModelManager cancellation during the first raw file never fetches the next file and can retry', async t => {
  const f = await setup(t);
  let cancel = true, calls = 0;
  const models = new ModelManager({userData: f.appUserData, manifest: f.manifest, platform: 'darwin', arch: 'arm64',
    fetchImpl: async url => { calls++; return fixtureFetch(f)(url); },
    onProgress: ({modelId}) => { assert.equal(modelId, 'tiny-raw'); if (cancel) models.cancel(modelId); },
  });
  await assert.rejects(models.install('tiny-raw'), error => error.name === 'AbortError');
  assert.equal(calls, 1);
  assert.equal(models.active.size, 0);
  assert.equal((await models.status('tiny-raw')).state, 'unavailable');
  assert.deepEqual(await fs.readdir(f.generations), []);
  cancel = false;
  assert.equal((await models.install('tiny-raw')).state, 'installed');
  assert.equal(calls, 3);
  const owner = {}, pin = await models.pinCurrent('tiny-raw', owner);
  assert.deepEqual(pin.identity, {kind: 'raw-files', treeDigest: f.artifact.treeDigest});
  assert.equal(await pin.release(owner), true);
});

test('cancellation inside the second raw stream leaves the old current generation intact', async t => {
  const f = await setup(t);
  const first = new RuntimeManager(f.options), g1 = await first.install();
  const before = await fs.readFile(f.metadataPath);
  let calls = 0;
  const manager = new RuntimeManager({...f.options, fetchImpl: async url => { calls++; return fixtureFetch(f)(url); },
    onProgress: ({bytes}) => { if (bytes > f.contents['config.json'].length) manager.cancel(); },
  });
  await assert.rejects(manager.install(), error => error.name === 'AbortError');
  assert.equal(calls, 2);
  assert.deepEqual(await fs.readFile(f.metadataPath), before);
  assert.deepEqual(await fs.readdir(f.generations), [g1.generation]);
  assert.equal((await first.status()).generation, g1.generation);
  assert.equal(manager.coordinator.snapshot().active, false);
  assert.equal(manager.coordinator.snapshot().pins, 0);
});

test('raw scratch keeps its exclusive non-executable inode through the verified rename', async t => {
  const f = await setup(t);
  const createWriteStream = syncFs.createWriteStream;
  let swapped = 0, calls = 0;
  t.after(() => { syncFs.createWriteStream = createWriteStream; });
  // Real filesystem/stream fault injection: swap the pathname after its writer
  // closes, retaining identical bytes so the final inventory alone cannot tell.
  syncFs.createWriteStream = (filename, options) => {
    const output = createWriteStream(filename, options);
    if (!swapped) output.once('close', () => {
      if (swapped++) return;
      assert.equal(options.flags, 'wx'); assert.equal(options.mode, 0o600);
      assert.notEqual(path.basename(path.dirname(filename)), 'payload');
      assert.equal(syncFs.statSync(filename).mode & 0o777, 0o600);
      syncFs.renameSync(filename, `${filename}.displaced`);
      syncFs.writeFileSync(filename, f.contents['config.json'], {flag: 'wx', mode: 0o600});
    });
    return output;
  };
  const manager = new RuntimeManager({...f.options, fetchImpl: async url => { calls++; return fixtureFetch(f)(url); }});
  await assert.rejects(manager.install(), /RAW_FILE_IDENTITY_CHANGED/);
  assert.equal(swapped, 1); assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(f.generations), []);
});

test('raw rename refuses an occupied data-file destination rather than replacing a link', async t => {
  const f = await setup(t);
  const sentinel = path.join(f.appUserData, 'sentinel.bin');
  await fs.writeFile(sentinel, 'must not change');
  let calls = 0;
  const manager = new RuntimeManager({...f.options, fetchImpl: async url => {
    if (++calls === 1) {
      const [generation] = await fs.readdir(f.generations);
      await fs.symlink(sentinel, path.join(f.generations, generation, 'payload', 'config.json'));
    }
    return fixtureFetch(f)(url);
  }});
  await assert.rejects(manager.install(), /RAW_DESTINATION_EXISTS|MANAGED_PATH_LINK/);
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must not change');
  assert.deepEqual(await fs.readdir(f.generations), []);
});

test('raw materialization refuses a swapped generation root and retains nodes it does not own', async t => {
  const f = await setup(t);
  let displaced, replacementRoot, calls = 0;
  const manager = new RuntimeManager({...f.options, fetchImpl: async url => {
    if (++calls === 1) {
      const [generation] = await fs.readdir(f.generations);
      replacementRoot = path.join(f.generations, generation);
      displaced = path.join(f.appUserData, 'displaced-owned-generation');
      await fs.rename(replacementRoot, displaced);
      await fs.mkdir(path.join(replacementRoot, 'payload'), {recursive: true});
      await fs.writeFile(path.join(replacementRoot, 'not-owned.marker'), 'retain this foreign node');
    }
    return fixtureFetch(f)(url);
  }});
  await assert.rejects(manager.install(), /RAW_GENERATION_CHANGED/);
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(f.metadataPath), {code: 'ENOENT'});
  assert.equal((await fs.stat(displaced)).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(replacementRoot, 'not-owned.marker'), 'utf8'), 'retain this foreign node');
  assert.equal(manager.coordinator.snapshot().active, false);
  assert.equal(manager.coordinator.snapshot().pins, 0);
  assert.equal(manager.coordinator.snapshot().retained[0].error, 'CLEANUP_OWNERSHIP_CHANGED');
});

test('raw install rejects v2 metadata before downloading and never migrates or deletes its ZIP generation', async t => {
  const f = await setup(t);
  const legacy = await zipModelFixture(f);
  const previous = new RuntimeManager({...f.options, manifest: legacy.manifest,
    fetchImpl: async () => streamResponse(legacy.buffer, legacy.artifact.url)});
  const g1 = await previous.install();
  const before = await fs.readFile(f.metadataPath);
  let downloads = 0;
  const raw = new RuntimeManager({...f.options, fetchImpl: async url => { downloads++; return fixtureFetch(f)(url); }});
  assert.equal((await raw.status()).state, 'unavailable');
  await assert.rejects(raw.pinCurrent({}), /UNTRUSTED_ACTIVATION_METADATA/);
  await assert.rejects(raw.install(), /UNTRUSTED_ACTIVATION_METADATA/);
  assert.equal(downloads, 0);
  assert.deepEqual(await fs.readFile(f.metadataPath), before);
  assert.deepEqual(await fs.readdir(f.generations), [g1.generation]);
  assert.equal((await previous.status()).state, 'installed');
  assert.equal(previous.coordinator.snapshot().active, false);
});

test('a second-file header refusal drains the response and preserves G1 byte-for-byte', async t => {
  const f = await setup(t);
  const first = new RuntimeManager(f.options);
  const g1 = await first.install();
  const before = await fs.readFile(f.metadataPath);
  for (const [status, headers, error] of [
    [200, {'content-length': '999'}, /CONTENT_LENGTH_MISMATCH/],
    [200, {'content-length': 'garbage'}, /CONTENT_LENGTH_MISMATCH/],
    [403, {}, /DOWNLOAD_FAILED:403/],
  ]) {
    let calls = 0, cancelled = 0;
    const replacement = new RuntimeManager({...f.options, fetchImpl: async url => {
      if (++calls === 1) return fixtureFetch(f)(url);
      const response = new Response(new ReadableStream({cancel() { cancelled++; }}), {status, headers});
      Object.defineProperty(response, 'url', {value: url}); return response;
    }});
    await assert.rejects(replacement.install(), error);
    assert.equal(calls, 2); assert.equal(cancelled, 1);
    assert.deepEqual(await fs.readFile(f.metadataPath), before);
    assert.deepEqual(await fs.readdir(f.generations), [g1.generation]);
    assert.equal((await first.status()).generation, g1.generation);
    assert.equal(replacement.coordinator.snapshot().active, false);
    assert.equal(replacement.coordinator.snapshot().pins, 0);
  }
});

test('raw fetch rejects a silently followed redirect even to an allowed final host', async t => {
  const f = await setup(t, rawFixture({'config.json': '{}'}));
  const source = f.artifact.sources['config.json'];
  const cache = source.replace('/fixture/tiny-model/resolve/', '/api/resolve-cache/models/fixture/tiny-model/');
  const manager = new RuntimeManager({...f.options, fetchImpl: async () => streamResponse(f.contents['config.json'], cache)});
  await assert.rejects(manager.install(), /RAW_RESPONSE_URL_MISMATCH/);
  assert.deepEqual(await fs.readdir(f.generations), []);
});

test('raw redirect rejection happens before the forbidden destination is contacted', async t => {
  const f = await setup(t);
  const source = f.artifact.sources['config.json'];
  const cache = source.replace('/fixture/tiny-model/resolve/', '/api/resolve-cache/models/fixture/tiny-model/');
  const cdn = `https://us.aws.cdn.hf.co/xet-bridge-us/${hash('fixture-object').slice(0, 24)}/${hash('fixture-content')}?fixture=signed`;
  for (const location of [
    cache.replace('/config.json', '/nested/../config.json'),
    cdn.replace('cdn.hf.co', 'cdn.%68f.co'),
    cache.replace(f.artifact.provenance.sourceRevision, hash('other fixture revision').slice(0, 40)),
    cache.replace('tiny-model', 'other-model'), cache.replace('config.json', 'weights.safetensors'),
    'https://evil.test/file', cdn.replace('us.aws.cdn.hf.co', 'us.aws.cdn.hf.co.evil.test'),
    cdn.replace('us.aws.cdn.hf.co', 'cas-bridge.xethub.hf.co'), cdn.replace('us.aws.cdn.hf.co', 'cdn-lfs.huggingface.co'),
    cdn.replace('/xet-bridge-us/', '/arbitrary/'), cdn.replace('https:', 'http:'),
    cdn.replace('hf.co', 'hf.co:444'), cdn.replace('https://', 'https://user:pass@'), cdn + '#fragment',
    'file:///etc/passwd', 'data:text/plain,fixture', 'https://github.com/fixture/assets/releases/download/test/file',
  ]) {
    const calls = [];
    const manager = new RuntimeManager({...f.options, fetchImpl: async url => {
      calls.push(url);
      const response = new Response(null, {status: 302, headers: {location}});
      Object.defineProperty(response, 'url', {value: url}); return response;
    }});
    await assert.rejects(manager.install(), /RAW|URL|HTTPS/, location);
    assert.deepEqual(calls, [source], location);
    assert.deepEqual(await fs.readdir(f.generations), []);
  }
});

test('a rejected raw response closes its unread stream before transaction cleanup', async t => {
  const f = await setup(t);
  let cancelled = 0, calls = 0;
  const response = new Response(new ReadableStream({cancel() { cancelled++; }}), {status: 200});
  Object.defineProperty(response, 'url', {value: 'https://evil.test/weights.safetensors'});
  const manager = new RuntimeManager({...f.options, fetchImpl: async () => { calls++; return response; }});
  await assert.rejects(manager.install(), /UNTRUSTED_RAW_MODEL_URL/);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1, 'unread network bodies remain owned until closed');
  assert.equal(manager.coordinator.snapshot().pins, 0);
  assert.equal(manager.coordinator.snapshot().active, false);
  assert.deepEqual(await fs.readdir(f.generations), []);
});

test('raw downloads follow only the observed per-source official redirect lanes', async t => {
  const fixture = rawFixture({'config.json': '{}', 'weights.safetensors': 'tiny weights', 'voices.bin': 'tiny voices'});
  fixture.artifact.sources['voices.bin'] = 'https://github.com/fixture/assets/releases/download/test/voices.bin';
  const f = await setup(t, fixture);
  const revision = f.artifact.provenance.sourceRevision;
  const destinations = {
    'config.json': `https://huggingface.co/api/resolve-cache/models/fixture/tiny-model/${revision}/config.json?fixture=cache`,
    'weights.safetensors': `https://us.aws.cdn.hf.co/xet-bridge-us/${hash('fixture-object').slice(0, 24)}/${hash('fixture-content')}?fixture-signed-query=not-a-credential`,
    'voices.bin': 'https://release-assets.githubusercontent.com/github-production-release-asset/123/12345678-1234-1234-1234-123456789abc?fixture=release',
  };
  const requested = [];
  const {validateRawModelUrl} = require('../apps/desktop/runtime-manifest.cjs');
  const manager = new RuntimeManager({...f.options, fetchImpl: async (url, options) => {
    requested.push(url);
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers, undefined);
    const initial = Object.entries(f.artifact.sources).find(([, source]) => source === url);
    if (initial) {
      const destination = destinations[initial[0]];
      assert.equal(validateRawModelUrl(destination, url), destination);
      const location = initial[0] === 'config.json' ? destination.replace('https://huggingface.co', '') : destination;
      const response = new Response(null, {status: 307, headers: {location}});
      Object.defineProperty(response, 'url', {value: url}); return response;
    }
    const [name] = Object.entries(destinations).find(([, destination]) => destination === url);
    return streamResponse(f.contents[name], url);
  }});
  const installed = await manager.install();
  assert.equal(installed.state, 'installed');
  assert.deepEqual(requested, f.artifact.files.flatMap(file => [f.artifact.sources[file.path], destinations[file.path]]));
  assert.deepEqual((await manager.status()).identity, installed.identity);
});

test('two raw files commit one typed activation only after sequential bounded data streams', async t => {
  const f = await setup(t);
  const requested = [], progress = [];
  let commits = 0, probes = 0;
  const manager = new RuntimeManager({...f.options,
    healthCheck: async () => { probes++; throw new Error('MODEL_PROBE_FORBIDDEN'); },
    onProgress: value => progress.push(value),
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers, undefined);
      assert.ok(options.signal instanceof AbortSignal);
      await assert.rejects(fs.stat(f.metadataPath), {code: 'ENOENT'});
      const [generation] = await fs.readdir(f.generations);
      const payload = path.join(f.generations, generation, 'payload');
      if (requested.length) assert.deepEqual(await fs.readFile(path.join(payload, 'config.json')), f.contents['config.json']);
      requested.push(url);
      return fixtureFetch(f)(url);
    },
    writeMetadata: async (filename, value, {commit}) => {
      commits++;
      assert.equal(requested.length, f.artifact.files.length);
      for (const file of f.artifact.files) {
        assert.deepEqual(await fs.readFile(path.join(value.current.directory, file.path)), f.contents[file.path]);
        assert.equal((await fs.stat(path.join(value.current.directory, file.path))).mode & 0o777, 0o600);
      }
      await assert.rejects(fs.stat(filename), {code: 'ENOENT'});
      assert.ok(Object.isFrozen(value.current.identity));
      commit();
    },
  });
  const installed = await manager.install();
  assert.equal(installed.state, 'installed'); assert.equal(installed.restartRequired, true);
  assert.equal(commits, 1); assert.equal(probes, 0);
  assert.deepEqual(requested, f.artifact.files.map(file => f.artifact.sources[file.path]));
  const identity = {kind: 'raw-files', treeDigest: f.artifact.treeDigest};
  const metadata = JSON.parse(await fs.readFile(f.metadataPath));
  assert.equal(metadata.schemaVersion, 3); assert.equal(metadata.previous, null);
  assert.deepEqual(metadata.current.identity, identity);
  assert.equal(Object.hasOwn(metadata.current, 'sha256'), false);
  assert.deepEqual((await fs.readdir(path.dirname(installed.directory))).sort(), ['payload']);
  const owner = {}, pinned = await manager.pinCurrent(owner);
  for (const result of [installed, await manager.status(), pinned]) {
    assert.deepEqual(result.identity, identity); assert.ok(Object.isFrozen(result.identity));
    assert.equal(Object.hasOwn(result, 'sha256'), false);
  }
  assert.equal(await pinned.release(owner), true);
  assert.ok(progress.length > f.artifact.files.length, 'tiny chunk streams exercise cumulative progress');
  assert.equal(progress.at(-1).bytes, f.artifact.bytes);
  for (let i = 0; i < progress.length; i++) {
    assert.equal(progress[i].total, f.artifact.bytes);
    assert.ok(progress[i].bytes <= f.artifact.bytes);
    if (i) assert.ok(progress[i].bytes >= progress[i - 1].bytes);
  }
  assert.deepEqual(manager.coordinator.snapshot(), {active: false, roots: 1, pins: 0, reservedBytes: 0, retained: []});
});
