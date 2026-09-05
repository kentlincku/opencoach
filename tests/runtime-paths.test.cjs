const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtimeLayout, resolveActivatedEntrypoint } = require('../apps/desktop/runtime-paths.cjs');

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
