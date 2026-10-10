const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtimeLayout, resolveActivatedEntrypoint } = require('../apps/desktop/runtime-paths.cjs');
const { assertManagedPath } = require('../apps/desktop/runtime-paths.cjs');
const fs = require('node:fs');
const os = require('node:os');

test('managed paths reject root, ancestor, leaf links and missing or escaped candidates', t => {
  assert.equal(typeof assertManagedPath, 'function');
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 's2-path-'));
  t.after(() => fs.rmSync(owned, {recursive: true, force: true}));
  const root = path.join(owned, '語音 Space');
  fs.mkdirSync(path.join(root, 'nested'), {recursive: true});
  const file = path.join(root, 'nested', 'data'); fs.writeFileSync(file, 'x');
  assert.equal(assertManagedPath(root, file), file);
  assert.equal(assertManagedPath(root, root), root);
  assert.throws(() => assertManagedPath(root, owned), /ESCAPE/);
  assert.throws(() => assertManagedPath(root, root+'-other/data'), /ESCAPE/);
  assert.throws(() => assertManagedPath(root, path.join(root, 'missing')), /ENOENT/);
  fs.symlinkSync(root, path.join(owned, 'root-link'), 'junction');
  assert.throws(() => assertManagedPath(path.join(owned, 'root-link'), path.join(owned, 'root-link', 'nested', 'data')), /LINK/);
  assert.throws(() => assertManagedPath(path.join(owned, 'root-link', 'nested'), path.join(owned, 'root-link', 'nested', 'data')), /LINK/);
  fs.symlinkSync(file, path.join(root, 'leaf-link'), 'file');
  assert.throws(() => assertManagedPath(root, path.join(root, 'leaf-link')), /LINK/);
  fs.symlinkSync(path.join(root, 'absent'), path.join(root, 'dangling'), 'file');
  assert.throws(() => assertManagedPath(root, path.join(root, 'dangling')), /LINK/);
  assert.throws(() => assertManagedPath(file, file), /DIRECTORY/);
});

test('runtime paths remain beneath unicode and spaced userData', () => {
  const base = path.resolve('/tmp', '語音 Practice');
  const layout = runtimeLayout(base, '0.2.0-beta.1', 'darwin-arm64');
  assert.equal(layout.root, path.join(base, 'runtime'));
  assert.ok(layout.versionDir.startsWith(layout.root + path.sep));
  assert.ok(layout.partial.endsWith('.partial'));
  assert.ok(layout.metadata.endsWith('current.json'));
});

test('activated entrypoint resolves only within runtime directory', () => {
  const base = path.resolve('/tmp', 'Voice Practice', 'runtime', 'v1', 'win32-x64-cpu');
  assert.equal(resolveActivatedEntrypoint(base, 'bin/voice-runtime.exe'), path.join(base, 'bin', 'voice-runtime.exe'));
  assert.throws(() => resolveActivatedEntrypoint(base, '../evil.exe'));
  assert.throws(() => resolveActivatedEntrypoint(base, '/evil.exe'));
});
