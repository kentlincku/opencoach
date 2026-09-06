const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const summaryModule = import('../scripts/summarize-ios-test-failure.mjs');

test('iOS summary prioritizes actual XCTest failures over long successful build output', async () => {
  const { summarizeIosFailure } = await summaryModule;
  const log = `${'Compile and link successful\n'.repeat(500)}Test case 'BridgeTests.testReady()' failed on 'Simulator' (3 seconds).\n** TEST FAILED **\n`;
  const result = summarizeIosFailure(log);
  assert.match(result, /BridgeTests\.testReady/);
  assert.ok(Buffer.byteLength(result) <= 3000);
});

test('iOS summary extracts structured xcresult failures with test identity', async () => {
  const { summarizeIosFailure } = await summaryModule;
  const result = summarizeIosFailure('Build completed', {
    issues: { testFailureSummaries: { _values: [{
      testCaseName: { _value: 'BridgeTests.testLoad()' },
      message: { _value: 'XCTAssertTrue failed - expected ready' },
    }] } },
  });
  assert.match(result, /BridgeTests\.testLoad/);
  assert.match(result, /expected ready/);
});

test('iOS summary retains terminal launch failures and removes personal path prefixes', async () => {
  const { summarizeIosFailure } = await summaryModule;
  const result = summarizeIosFailure(`${'Register app metadata\n'.repeat(1000)}Failed to launch /Users/example/Library/Developer/App.app: connection interrupted\n`);
  assert.match(result, /Failed to launch/);
  assert.match(result, /connection interrupted/);
  assert.doesNotMatch(result, /\/Users\/example/);
});

test('iOS summary excludes CrashReporter build paths and prioritizes actionable terminal failures', async () => {
  const { summarizeIosFailure } = await summaryModule;
  const compileLines = Array.from({ length: 60 }, (_, i) =>
    `CompileSwift normal arm64 /Users/runner/work/opencoach/opencoach/Sources/CrashReporter${i}.swift`);
  const crashLines = Array.from({ length: 60 }, (_, i) => `Previous helper process ${i} crashed during setup`);
  const result = summarizeIosFailure([
    ...compileLines, ...crashLines,
    "Test case 'BridgeTests.testReady()' failed on 'Simulator' (3 seconds).",
    'error: XCTAssertTrue failed - expected ready',
    'Failed to launch App.app: connection interrupted',
  ].join('\n'), {
    issues: { errorSummaries: { _values: [{ message: { _value: 'Structured XCTest diagnostic' } }] } },
  });
  assert.match(result, /Failed to launch App\.app/);
  assert.match(result, /BridgeTests\.testReady/);
  assert.match(result, /error: XCTAssertTrue failed - expected ready/);
  assert.ok(result.startsWith('iOS test failure:\nStructured XCTest diagnostic\n'));
  assert.doesNotMatch(result, /CompileSwift|CrashReporter\d+\.swift/);
  assert.ok(Buffer.byteLength(result) <= 3000);
  assert.match(summarizeIosFailure('Build completed\nTest runner crashed unexpectedly\nCleanup completed'), /Test runner crashed unexpectedly/);
});

test('iOS summary has a byte limit, Unicode safety and bounded final-tail fallback', async () => {
  const { summarizeIosFailure } = await summaryModule;
  const result = summarizeIosFailure(`error: ${'測試'.repeat(3000)}`);
  assert.ok(Buffer.byteLength(result) <= 3000);
  assert.doesNotMatch(result, /\uFFFD/);
  assert.match(summarizeIosFailure(`${'old output\n'.repeat(1000)}terminal diagnostic marker`), /terminal diagnostic marker/);
});

test('iOS fallback keeps the terminal marker within a UTF-8 byte budget', async () => {
  const { summarizeIosFailure } = await summaryModule;
  for (const text of ['測試', '測試🧪']) {
    const result = summarizeIosFailure(`${text.repeat(3000)}TERMINAL_MARKER`);
    assert.ok(result.endsWith('TERMINAL_MARKER'));
    assert.ok(result.startsWith('iOS test failure:\n'));
    assert.ok(Buffer.byteLength(result) <= 3000);
    assert.doesNotMatch(result, /\uFFFD/);
    assert.equal(Buffer.from(result).toString('utf8'), result);
  }
});

test('iOS workflow preserves exit 65 when diagnostic commands fail under errexit', () => {
  const { spawnSync } = require('node:child_process');
  const { tmpdir } = require('node:os');
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/ios-beta.yml'), 'utf8');
  const simulatorStep = workflow.split('      - name: Test iOS App on Simulator\n')[1]
    .split('      - name: Verify Bundled Web Resources in App\n')[0];
  const failureBlock = simulatorStep.slice(simulatorStep.indexOf('          if [ "$status" -ne 0 ]; then'))
    .replace(/^          /gm, '');
  assert.ok(failureBlock.startsWith('if [ "$status" -ne 0 ]; then'));
  const temp = fs.mkdtempSync(path.join(tmpdir(), 'ios-failure-workflow-'));
  try {
    fs.writeFileSync(path.join(temp, 'xcrun'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(temp, 'node'), '#!/bin/bash\nprintf "mock XCTest diagnostic\\n"\nexit "$SUMMARY_STATUS"\n', { mode: 0o755 });
    for (const summaryStatus of ['0', '1']) {
      const run = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nstatus=65\n${failureBlock}`], {
        env: { ...process.env, PATH: temp, RUNNER_TEMP: temp, SUMMARY_STATUS: summaryStatus },
        encoding: 'utf8',
      });
      assert.equal(run.error, undefined);
      assert.equal(run.status, 65, `summarizer exit ${summaryStatus}: ${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout, /::error .*xcodebuild failed:/);
      assert.match(run.stdout, /xcresult extraction failed/);
      assert.match(run.stdout, summaryStatus === '0' ? /mock XCTest diagnostic/ : /summary unavailable/i);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('iOS workflow captures explicit xcresult and uses bounded summary before exiting failure', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/ios-beta.yml'), 'utf8');
  assert.match(workflow, /-resultBundlePath "\$RUNNER_TEMP\/opencoach-ios\.xcresult"/);
  assert.match(workflow, /xcresulttool get --path "\$RUNNER_TEMP\/opencoach-ios\.xcresult" --format json/);
  assert.match(workflow, /node scripts\/summarize-ios-test-failure\.mjs/);
  assert.match(workflow, /status=\$\{PIPESTATUS\[0\]\}/);
  assert.match(workflow, /exit "\$status"/);
  assert.doesNotMatch(workflow, /output\+=\$\(tail -n 100/);
});
