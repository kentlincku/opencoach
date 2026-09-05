const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function treeDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(`${file.path}:${file.bytes}:${file.sha256}\n`);
  return hash.digest('hex');
}

function writeMinimalPeX64(filename) {
  const pe = Buffer.alloc(128);
  pe.write('MZ', 0, 'ascii');
  pe.writeUInt32LE(64, 0x3c);
  pe.write('PE\0\0', 64, 'ascii');
  pe.writeUInt16LE(0x8664, 68);
  fs.writeFileSync(filename, pe);
}

test('Windows runtime checker rejects changed, missing, and unlisted files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-runtime-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'voice-runtime.exe');
  const data = path.join(root, 'runtime.dat');
  writeMinimalPeX64(exe);
  fs.writeFileSync(data, 'verified-runtime-data');

  const files = [
    { path: 'runtime.dat', bytes: fs.statSync(data).size, sha256: sha256(fs.readFileSync(data)) },
    { path: 'voice-runtime.exe', bytes: fs.statSync(exe).size, sha256: sha256(fs.readFileSync(exe)) },
  ].sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'win32-x64-cpu',
    entrypoint: 'voice-runtime.exe',
    treeDigest: treeDigest(files),
    fileCount: files.length,
    files,
  }));

  const { checkWindowsRuntime } = await import(`${pathToFileURL(path.resolve('scripts/check-windows-runtime.mjs')).href}?test=${Date.now()}`);
  assert.equal(checkWindowsRuntime(root).treeDigest, treeDigest(files));

  fs.writeFileSync(data, 'tampered-runtime-data');
  assert.throws(() => checkWindowsRuntime(root), /RUNTIME_TREE_(?:FILE|DIGEST)_MISMATCH/);
  fs.writeFileSync(data, 'verified-runtime-data');
  fs.writeFileSync(path.join(root, 'unlisted.bin'), 'not-in-manifest');
  assert.throws(() => checkWindowsRuntime(root), /RUNTIME_TREE_(?:FILE_COUNT|UNLISTED_FILE|DIGEST)_MISMATCH/);
  fs.rmSync(path.join(root, 'unlisted.bin'));
  fs.rmSync(data);
  assert.throws(() => checkWindowsRuntime(root), /RUNTIME_TREE_(?:FILE_COUNT|MISSING_FILE|DIGEST)_MISMATCH/);
});
