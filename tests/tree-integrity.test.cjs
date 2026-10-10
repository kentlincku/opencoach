const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { scanFiles, digestFiles, verifyFiles } = require('../apps/desktop/tree-integrity.cjs');
const { canonicalInventory, validateInventory, ASSET_LIMITS } = require('../apps/desktop/tree-integrity.cjs');
const { verifyInventory, verifyInventorySync } = require('../apps/desktop/tree-integrity.cjs');

test('v2 cancellation before entry rejects without touching nonexistent payload', async () => {
  const controller = new AbortController(); controller.abort();
  const trusted = canonicalInventory([{path: 'a', bytes: 0, sha256: hash('')}]);
  await assert.rejects(verifyInventory('/missing-s2-payload', trusted, {signal: controller.signal}), /ABORT/);
});

test('v2 cancellation during streaming closes its handle and retains payload', async t => {
  const root = fixture(t), data = Buffer.alloc(150000, 7);
  write(root, 'a', data);
  const trusted = canonicalInventory([{path: 'a', bytes: data.length, sha256: hash(data)}]);
  const controller = new AbortController();
  const originalOpen = fs.promises.open;
  let reads = 0, closes = 0;
  t.after(() => { fs.promises.open = originalOpen; });
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = async (...args) => { const result = await read(...args); reads++; controller.abort(); return result; };
    handle.close = async () => { closes++; return close(); };
    return handle;
  };
  await assert.rejects(verifyInventory(root, trusted, {signal: controller.signal}), /ABORT/);
  assert.equal(reads, 1); assert.equal(closes, 1);
  assert.equal(fs.statSync(path.join(root, 'a')).size, data.length);
});

test('v2 async verifier streams trusted exact payload and rejects changed extra missing and inner metadata', async t => {
  assert.equal(typeof verifyInventory, 'function');
  const root = fixture(t);
  const contents = Buffer.alloc(150000, 42);
  write(root, 'bin/A', contents); write(root, 'empty', '');
  const files = [{path: 'bin/A', bytes: contents.length, sha256: hash(contents)}, {path: 'empty', bytes: 0, sha256: hash('')}];
  const trusted = canonicalInventory(files);
  const originalOpen = fs.promises.open;
  let active = 0, peak = 0;
  const lengths = [];
  t.after(() => { fs.promises.open = originalOpen; });
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args); active++; peak = Math.max(peak, active);
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = async (...args) => { lengths.push(args[2]); return read(...args); };
    handle.close = async () => { try { return await close(); } finally { active--; } };
    return handle;
  };
  const promise = verifyInventory(root, trusted);
  assert.ok(promise instanceof Promise);
  assert.deepEqual(await promise, trusted);
  assert.equal(peak, 1); assert.equal(active, 0);
  assert.ok(lengths.length >= 3 && lengths.every(n => n <= 65536));
  for (const data of [Buffer.alloc(contents.length, 41), 'short']) {
    write(root, 'bin/A', data); await assert.rejects(verifyInventory(root, trusted), /FILE_MISMATCH/);
  }
  write(root, 'bin/A', contents);
  for (const name of ['extra', 'manifest.json']) {
    write(root, name, JSON.stringify({files: [], treeDigest: hash('rewritten')}));
    await assert.rejects(verifyInventory(root, trusted), /UNLISTED/);
    fs.unlinkSync(path.join(root, name));
  }
  fs.mkdirSync(path.join(root, 'extra-dir'));
  await assert.rejects(verifyInventory(root, trusted), /UNLISTED/);
  fs.rmdirSync(path.join(root, 'extra-dir'));
  fs.unlinkSync(path.join(root, 'empty'));
  await assert.rejects(verifyInventory(root, trusted), /COUNT_MISMATCH/);
  write(root, 'empty', '');
  await assert.rejects(verifyInventory(root, {...trusted, treeDigest: hash('changed')}), /DIGEST/);
  const outside = fixture(t); write(outside, 'file', contents);
  fs.unlinkSync(path.join(root, 'bin/A')); fs.symlinkSync(path.join(outside, 'file'), path.join(root, 'bin/A'));
  await assert.rejects(verifyInventory(root, trusted), /LINK/);
  fs.unlinkSync(path.join(root, 'bin/A')); write(root, 'bin/A', contents);
  fs.symlinkSync(root, path.join(outside, 'linked'), 'junction');
  await assert.rejects(verifyInventory(path.join(outside, 'linked'), trusted), /LINK/);
  assert.equal(active, 0);
});

test('v2 sync and async verifiers reject an arbitrary ancestor symlink before canonicalization', async t => {
  const base = fixture(t);
  const real = path.join(base, 'real');
  const alias = path.join(base, 'alias');
  fs.mkdirSync(real);
  write(real, 'asset', 'payload');
  fs.symlinkSync(real, alias, 'dir');
  const trusted = canonicalInventory([{ path: 'asset', bytes: 7, sha256: hash('payload') }]);

  assert.deepEqual(verifyInventorySync(real, trusted), trusted);
  await assert.doesNotReject(verifyInventory(real, trusted));
  assert.throws(() => verifyInventorySync(alias, trusted), /LINK/);
  await assert.rejects(verifyInventory(alias, trusted), /LINK/);
});

test('v2 canonical inventory frames and sorts ASCII with derived counts and bounded metadata', () => {
  assert.equal(typeof canonicalInventory, 'function');
  const files = ['a/z', 'Z', 'a/A', '_'].map((path, i) => ({path, bytes: i, sha256: hash(String(i))}));
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : 1);
  const expectedDigest = hash(sorted.map(f => `${f.path}:${f.bytes}:${f.sha256}\n`).join(''));
  assert.deepEqual(canonicalInventory(files), {files: sorted, fileCount: 4, totalBytes: 6, treeDigest: expectedDigest});
  assert.equal(validateInventory(files, expectedDigest).treeDigest, expectedDigest);
  assert.throws(() => validateInventory(files, hash('wrong')), /DIGEST/);
  assert.equal(ASSET_LIMITS.maxFiles, 4096);
  assert.equal(ASSET_LIMITS.maxTotalBytes, 8 * 1024 ** 3);
  assert.equal(ASSET_LIMITS.maxMetadataBytes, 4 * 1024 ** 2);
  const file = (path, bytes = 0) => ({path, bytes, sha256: hash('')});
  for (const p of ['../x', '/x', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a:b', 'a b', '語音', 'a\n', 'a.', 'CON', 'nul.txt', 'COM1.bin', 'LPT9', 'a/'.repeat(120)+'b', 'a'.repeat(101)]) {
    assert.throws(() => canonicalInventory([file(p)]), undefined, p);
  }
  for (const files of [[], [file('a'), file('a')], [file('A'), file('a')], [file('a'), file('a/b')],
    [file('A/x'), file('a/y')], [file('a', -1)], [file('a', '0')], [file('a', 0.5)],
    [file('a', Number.MAX_SAFE_INTEGER+1)], [file('a', ASSET_LIMITS.maxTotalBytes), file('b', 1)],
    Array.from({length: 4097}, (_, i) => file(`f${i}`)), [{...file('a'), extra: true}],
    [{...file('a'), sha256: 'A'.repeat(64)}]]) assert.throws(() => canonicalInventory(files));
  assert.equal(canonicalInventory([file('ok', ASSET_LIMITS.maxTotalBytes)]).totalBytes, ASSET_LIMITS.maxTotalBytes);
  const boundary = `${'a'.repeat(100)}/${'b'.repeat(100)}/${'c'.repeat(38)}`;
  assert.equal(canonicalInventory([file(boundary)]).fileCount, 1);
  assert.equal(canonicalInventory(Array.from({length: 4096}, (_, i) => file(`f${i}`))).fileCount, 4096);
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c5a-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, name, contents) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}
const expectedFiles = () => [
  { path: 'a/nested.bin', bytes: Buffer.byteLength('語音'), sha256: hash('語音') },
  { path: 'z.bin', bytes: 0, sha256: hash('') },
];

test('tree scan and fingerprint are deterministic across roots and creation order', t => {
  const first = fixture(t);
  const second = fixture(t);
  write(first, 'z.bin', '');
  write(first, 'a/nested.bin', '語音');
  write(second, 'a/nested.bin', '語音');
  write(second, 'z.bin', '');
  const expected = expectedFiles();
  const expectedDigest = hash(expected.map(f => `${f.path}:${f.bytes}:${f.sha256}\n`).join(''));
  for (const root of [first, second]) {
    assert.deepEqual(scanFiles(root), expected);
    assert.equal(digestFiles(scanFiles(root)), expectedDigest);
    assert.deepEqual(verifyFiles(root, expected), { files: expected, fileCount: 2, treeDigest: expectedDigest });
  }
  assert.notEqual(digestFiles([...expected].reverse()), expectedDigest, 'digest consumes canonical caller order');
  assert.deepEqual(expected, expectedFiles(), 'verification does not mutate expectations');
});

test('verification rejects changed bytes, changed content, missing and unlisted files', t => {
  const root = fixture(t);
  write(root, 'a.bin', 'abcd');
  const expected = scanFiles(root);
  for (const changed of ['abce', 'longer']) {
    write(root, 'a.bin', changed);
    assert.throws(() => verifyFiles(root, expected), /FILESET_FILE_MISMATCH:a.bin/);
  }
  write(root, 'a.bin', 'abcd');
  write(root, 'extra.bin', 'extra');
  assert.throws(() => verifyFiles(root, expected), /FILESET_COUNT_MISMATCH/);
  fs.unlinkSync(path.join(root, 'extra.bin'));
  fs.renameSync(path.join(root, 'a.bin'), path.join(root, 'renamed.bin'));
  assert.throws(() => verifyFiles(root, expected), /FILESET_PATH_MISMATCH/);
  fs.unlinkSync(path.join(root, 'renamed.bin'));
  assert.throws(() => verifyFiles(root, expected), /FILESET_COUNT_MISMATCH/);
});

test('verification rejects absent expectations and malformed file metadata', t => {
  const root = fixture(t);
  write(root, 'a.bin', 'data');
  for (const expected of [null, undefined, {}, []]) {
    assert.throws(() => verifyFiles(root, expected), /FILESET_EXPECTATION_MISSING/);
  }
  for (const entry of [null, {}, { path: 'other.bin' }]) {
    assert.throws(() => verifyFiles(root, [entry]), /FILESET_PATH_MISMATCH/);
  }
  for (const change of [{ bytes: '4' }, { bytes: -1 }, { sha256: 'invalid' }, { sha256: null }]) {
    assert.throws(() => verifyFiles(root, [{ ...scanFiles(root)[0], ...change }]), /FILESET_FILE_MISMATCH/);
  }
});

test('exclusions match exact relative file paths, not directory prefixes', t => {
  const root = fixture(t);
  write(root, 'a/nested.bin', '語音');
  write(root, 'z.bin', '');
  write(root, 'manifest.json', 'metadata');
  const exclude = new Set(['manifest.json', 'a']);
  assert.deepEqual(scanFiles(root, { exclude }), expectedFiles());
  assert.equal(verifyFiles(root, expectedFiles(), { exclude }).fileCount, 2);
  write(root, 'manifest.json', 'updated metadata');
  assert.deepEqual(scanFiles(root, { exclude }), expectedFiles());
});

test('tree rejects file, directory and dangling symlinks even when excluded', t => {
  const root = fixture(t);
  const outside = fixture(t);
  write(outside, 'outside.bin', 'outside');
  const link = path.join(root, 'link');
  for (const [target, type] of [
    [path.join(outside, 'outside.bin'), 'file'], [outside, 'junction'], [path.join(outside, 'missing'), 'file'],
  ]) {
    fs.symlinkSync(target, link, type);
    const options = { exclude: new Set(['link']) };
    assert.throws(() => scanFiles(root, options), /FILESET_SYMLINK_FORBIDDEN:link/);
    assert.throws(() => verifyFiles(root, [{ path: 'dummy' }], options), /FILESET_SYMLINK_FORBIDDEN:link/);
    fs.unlinkSync(link);
  }
});

test('tree rejects special files before exclusion', { skip: process.platform === 'win32' ? 'FIFO requires POSIX' : false }, t => {
  const root = fixture(t);
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  assert.throws(() => scanFiles(root, { exclude: new Set(['pipe']) }), /FILESET_SPECIAL_FILE_FORBIDDEN:pipe/);
});

test('empty tree has a deterministic empty digest but cannot satisfy missing expectations', t => {
  const root = fixture(t);
  assert.deepEqual(scanFiles(root), []);
  assert.equal(digestFiles([]), hash(''));
  assert.throws(() => verifyFiles(root, []), /FILESET_EXPECTATION_MISSING/);
});
