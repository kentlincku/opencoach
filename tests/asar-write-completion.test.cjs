'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const child = path.join(__dirname, 'fixtures', 'asar-write-completion-child.cjs');

function runProbe(api, mode) {
  // Separate process per scenario: builtin-fs/ESM monkeypatches cannot leak to
  // other tests, even when the outer test runner enables concurrency.
  const result = spawnSync(process.execPath, [child, api, mode], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `child failed (${result.signal}):\n${result.stderr}\n${result.stdout}`);
  // Node 22.12 emits a require(ESM) ExperimentalWarning; preserve diagnostics.
  // Unhandled child failures are checked by exit status and the result contract.
  if (result.stderr) process.stderr.write(result.stderr);
  return JSON.parse(result.stdout.trim());
}

function assertGateExercised(result) {
  assert.equal(result.sharedInstance, true, 'root and electron-builder must use the same ASAR instance');
  assert.equal(result.cjsRequireSucceeded, true, 'both CommonJS consumers must load the shared ASAR');
  assert.equal(result.gateHits, 1);
  assert.equal(result.whileGated.writableFinished, false);
  assert.ok(result.whileGated.archiveSize < result.whileGated.expectedSize,
    'controlled gate must withhold actual archive bytes');
  assert.equal(result.whileGated.rawMatches, false);
  assert.equal(result.whileGated.extractedMatches, false);
}

for (const api of ['createPackage', 'createPackageFromStreams']) {
  test(`${api} waits for the delayed last output write to finish before resolving`, () => {
    const result = runProbe(api, 'finish');
    assertGateExercised(result);
    // Prove the fixture really completes a readable archive after gate release,
    // even on a buggy dependency that resolved before the write finished.
    assert.equal(result.state, 'fulfilled');
    assert.equal(result.afterClose.writableFinished, true);
    assert.equal(result.afterClose.archiveSize, result.afterClose.expectedSize);
    assert.equal(result.afterClose.rawMatches, true);
    assert.equal(result.afterClose.extractedMatches, true);
    assert.equal(result.whileGated.state, 'pending',
      `${api} resolved before output finish: ${JSON.stringify(result)}`);
    assert.deepEqual(result.atResolution, result.afterClose,
      'immediate readback at public promise resolution must contain every archive byte');
  });
}
