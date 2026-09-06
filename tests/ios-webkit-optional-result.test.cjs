const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../apps/ios/Tests/VoicePracticeXCTests');
const bridgeTests = fs.readFileSync(path.join(root, 'ScriptBridgeHandlerTests.swift'), 'utf8');
const navigationTests = fs.readFileSync(path.join(root, 'ScriptBridgeHandlerNavigationTests.swift'), 'utf8');

test('WebKit test evaluation uses an explicitly optional callback continuation', () => {
  assert.match(bridgeTests, /func evaluateJavaScriptAllowingNil\(_ script: String\) async throws -> Any\?/);
  assert.match(bridgeTests, /CheckedContinuation<Any\?, Error>/);
  assert.match(bridgeTests, /evaluateJavaScript\(script, completionHandler:/);
  assert.match(bridgeTests, /continuation.resume\(returning: value\)/);
  assert.match(bridgeTests, /continuation.resume\(throwing: error\)/);
  for (const source of [bridgeTests, navigationTests]) {
    assert.doesNotMatch(source, /await \w+\.evaluateJavaScript\(/, 'async overlay must not unwrap JavaScript undefined');
  }
});

test('navigation polling and undefined-returning UI actions use the nil-safe path', () => {
  assert.match(navigationTests, /evaluateJavaScriptAllowingNil\("window\._lastBridgeResult"\)/);
  assert.match(bridgeTests, /evaluateJavaScriptAllowingNil\("document\.getElementById\('apiBaseUrl'\)\.focus\(\);"\)/);
  assert.match(bridgeTests, /evaluateJavaScriptAllowingNil\(script\)/);
});

test('native regression checks cover undefined, null, values and JS errors without skips', () => {
  const start = bridgeTests.indexOf('func testOptionalJavaScriptResultsAndErrors');
  assert.notEqual(start, -1);
  const source = bridgeTests.slice(start, bridgeTests.indexOf('override func setUp', start));
  for (const expression of ['undefined', 'null', '7', "throw new Error('expected-test-error')"]) {
    assert.ok(source.includes(`evaluateJavaScriptAllowingNil("${expression}")`));
  }
  assert.doesNotMatch(source, /XCTSkip/);
});

test('zoom verification checks effective scale without assuming WebKit internal bounds', () => {
  assert.doesNotMatch(bridgeTests, /XCTAssertEqual\(view.scrollView.minimumZoomScale, view.scrollView.maximumZoomScale/);
  assert.match(bridgeTests, /XCTAssertEqual\(view.scrollView.zoomScale, 1, accuracy: 0.001\)/);
  assert.match(bridgeTests, /XCTAssertEqual\(initialScale, 1\)/);
  assert.match(bridgeTests, /XCTAssertEqual\(focusedScale, 1\)/);
  assert.match(bridgeTests, /XCTAssertNil\(view.scrollView.delegate\?\.viewForZooming/);
});
