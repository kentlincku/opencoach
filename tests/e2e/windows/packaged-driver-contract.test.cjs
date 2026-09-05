'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertTrustedDebugTarget, isProviderErrorReply, isExpectedChallengeReply } = require('../../../scripts/windows-product-e2e.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('UI driver script exists and has zero external dependencies', () => {
  const driverPath = path.join(ROOT, 'scripts', 'windows-product-e2e.cjs');
  assert.ok(fs.existsSync(driverPath), 'scripts/windows-product-e2e.cjs must exist');

  const content = read('scripts/windows-product-e2e.cjs');

  // Verify only built-in modules are required
  const requires = content.match(/require\(['"]([^'"]+)['"]\)/g) || [];
  for (const req of requires) {
    assert.match(
      req,
      /require\(['"](node:http|http|node:path|path|node:fs|fs|\.\/)['"]\)/,
      `Driver must not require external packages: ${req}`,
    );
  }

  // Uses native global WebSocket
  assert.match(content, /new WebSocket\(/);
});

test('PowerShell verifier contains required parameter switches and lifecycle cleanup', () => {
  const psScriptPath = path.join(ROOT, 'scripts', 'verify-windows-product-e2e.ps1');
  assert.ok(fs.existsSync(psScriptPath), 'scripts/verify-windows-product-e2e.ps1 must exist');

  const content = read('scripts/verify-windows-product-e2e.ps1');

  // Verify parameter switches
  assert.match(content, /\[switch\]\$ContractOnly/);
  assert.match(content, /\[switch\]\$LiveLocalLlm/);
  assert.match(content, /\[switch\]\$CoreProduct/);
  assert.match(content, /\[switch\]\$Resilience/);
  assert.match(content, /\[switch\]\$AuthContracts/);

  // Verify isolated temp directory and finally cleanup
  assert.match(content, /\[System\.IO\.Path\]::GetTempPath\(\)/);
  assert.match(content, /finally\s*\{/);
  assert.match(content, /Stop-TestProcessTree/);
  assert.match(content, /taskkill(?:\.exe)?.*\/PID.*\/T.*\/F/i);
  assert.match(content, /Remove-Item.*\$tempUserData/);
});

test('R4 rework: driver cannot fabricate product state or emit unasserted pass markers', () => {
  const driver = read('scripts/windows-product-e2e.cjs');
  assert.doesNotMatch(driver, /box\.innerHTML\s*=\s*['"`][\s\S]*Accuracy:/, 'driver must not inject a shadowing score');
  assert.doesNotMatch(driver, /LOCAL_PROVIDER_CREDENTIAL_READS=0/, 'runtime credential count cannot be claimed without instrumentation');
  assert.match(driver, /if\s*\(\s*!errSeen\s*\)\s*\{?\s*throw\b/, 'error redaction marker requires a positive assertion');
  assert.match(driver, /Network\.emulateNetworkConditions/, 'offline gate must actually emulate offline network conditions');
  const verifier = read('scripts/verify-windows-product-e2e.ps1');
  assert.match(verifier, /SECOND_INSTANCE_EXIT_OK/);
  assert.doesNotMatch(verifier, /SECOND_INSTANCE_FOCUS_OK/, 'focus marker requires an observable focus assertion');
});

test('R4 rework: lesson file round-trip and restart persistence are observable', () => {
  const driver = read('scripts/windows-product-e2e.cjs');
  assert.match(driver, /DOM\.setFileInputFiles|setFileInputFiles/, 'import must exercise the file input');
  assert.match(driver, /Page\.setDownloadBehavior|Browser\.setDownloadBehavior/, 'export must exercise a real download');
  assert.match(driver, /RestartCheck[\s\S]*vp_completed_lessons/, 'restart check must verify lesson progress persistence');
  const coreBlock = driver.slice(driver.indexOf('// 3. Core Product Workflows'), driver.indexOf('// 4. Resilience'));
  assert.doesNotMatch(coreBlock, /\bsaveLessonEditor\s*\(/, 'driver must not bypass file import through editor internals');
  assert.doesNotMatch(coreBlock, /\bapplyLessonLibrary\s*\(/, 'driver must not mutate lesson state directly');
  for (const marker of [
    'LESSON_EXPORT_DOWNLOAD_OK',
    'LESSON_IMPORT_REPLACE_OK',
    'LESSON_IMPORT_MERGE_OK',
    'LESSON_IMPORT_INVALID_REJECTED',
    'LESSON_IMPORT_DUPLICATE_REJECTED',
    'LESSON_IMPORT_OVERSIZE_REJECTED',
  ]) assert.match(coreBlock, new RegExp(marker));
});

test('R4 rework: debugger port, target ownership and process tree cleanup fail closed', () => {
  const verifier = read('scripts/verify-windows-product-e2e.ps1');
  assert.doesNotMatch(verifier, /Get-Random\s+-Minimum\s+52000/);
  assert.match(verifier, /TcpListener/);
  assert.match(verifier, /Assert-DebugPortOwnedByProcess/);
  assert.match(verifier, /taskkill(?:\.exe)?[\s\S]*\/T[\s\S]*\/F/i);

  const driver = read('scripts/windows-product-e2e.cjs');
  assert.match(driver, /UNTRUSTED_DEBUG_TARGET_URL/);
  assert.match(driver, /apps\/web\/index\.html/);
  assert.match(driver, /UNTRUSTED_DEBUG_WEBSOCKET_URL/);
  assert.match(driver, /DevTools target list exceeds 256 KiB/);
  assert.match(driver, /DevTools target list request timed out/);
});

test('R4 rework: verifier mode selection and overall status cannot overclaim', () => {
  const verifier = read('scripts/verify-windows-product-e2e.ps1');
  assert.match(verifier, /elseif\s*\(\$AuthContracts\)\s*\{\s*\$mode\s*=\s*["']AuthContracts["']/);
  assert.match(verifier, /Multiple verification modes were selected/);
  assert.match(verifier, /\$LiveLocalLlm\s+-or\s+\$CoreProduct\s+-or\s+\$mode\s+-eq\s*["']All["']/);
  const overallIndex = verifier.indexOf('Overall Lane Status: AUTOMATED_SELECTED_GATES_PASS');
  assert.ok(overallIndex >= 0);
  assert.match(verifier, /if\s*\(\$mode\s*-eq\s*["']All["']\)[\s\S]*Overall Lane Status: AUTOMATED_SELECTED_GATES_PASS/);
  assert.match(verifier, /NOT_RUN: F-03,F-05,F-09,F-15,F-17,F-21,F-22/);
  assert.match(verifier, /NATIVE_VOICE_UNAVAILABLE/);
  assert.doesNotMatch(verifier, /AUTOMATED_PASS_MANUAL_AUTH_PENDING/);
  assert.match(verifier, /NOT_EVALUATED_BY_PARTIAL_MODE/);
  assert.doesNotMatch(verifier, /PRODUCT COMPLETENESS VERIFICATION:\s*PASSED/);
  const driver = read('scripts/windows-product-e2e.cjs');
  assert.match(driver, /vp_e2e_expect_llama_restart/);
});

test('NativeVoice is exclusive and always rebuilds the packaged application from ExpectedCodeSha', () => {
  const verifier = read('scripts/verify-windows-product-e2e.ps1');
  assert.match(verifier, /if \(\$NativeVoice\) \{ 'NativeVoice' \}/);
  assert.match(verifier, /\$requiresFreshPackage\s*=.*'All'.*'NativeVoice'/s);
  assert.match(verifier, /if \(\$requiresFreshPackage -and -not \[string\]::IsNullOrWhiteSpace\(\$ExecutablePath\)\)/);
  assert.match(verifier, /if \(\$requiresFreshPackage\) \{[\s\S]*?npm run pack:win/);
});

test('R4 rework: live llama lane uses visible controls and rejects error bubbles', () => {
  const driver = read('scripts/windows-product-e2e.cjs');
  const liveBlock = driver.slice(driver.indexOf('// 2. Live Local LLM Verification'), driver.indexOf('// 3. Core Product Workflows'));
  assert.doesNotMatch(liveBlock, /\bopenSettingsModal\s*\(/);
  assert.doesNotMatch(liveBlock, /\bfetchModelsFromProvider\s*\(/);
  assert.doesNotMatch(liveBlock, /\bsaveSettings\s*\(/);
  assert.doesNotMatch(liveBlock, /\bsendManualText\s*\(/);
  assert.match(liveBlock, /MISSING_VISIBLE_SETTINGS_TRIGGER/);
  assert.match(liveBlock, /isExpectedChallengeReply/);
  assert.match(liveBlock, /VP_E2E_CHAT_1_OK/);
  assert.match(liveBlock, /VP_E2E_CHAT_2_OK/);
});

test('debug target validation binds both page and websocket to the packaged loopback target', () => {
  const driver = read('scripts/windows-product-e2e.cjs');
  assert.match(driver, /absolute path suppressed/);
  assert.doesNotMatch(driver, /Target URL: \$\{target\.url\}/);
  assert.doesNotThrow(() => assertTrustedDebugTarget({
    url: 'file:///C:/Program%20Files/Voice/resources/app.asar/apps/web/index.html',
    wsUrl: 'ws://127.0.0.1:54321/devtools/page/abc',
  }, 54321));
  assert.throws(() => assertTrustedDebugTarget({
    url: 'file:///C:/Program%20Files/Voice/resources/app.asar/apps/web/index.html',
    wsUrl: 'ws://127.0.0.1:54322/devtools/page/abc',
  }, 54321), /UNTRUSTED_DEBUG_WEBSOCKET_URL/);
  assert.throws(() => assertTrustedDebugTarget({
    url: 'https://example.test/apps/web/index.html',
    wsUrl: 'ws://127.0.0.1:54321/devtools/page/abc',
  }, 54321), /UNTRUSTED_DEBUG_TARGET_URL/);
});

test('live reply classifier rejects product error bubbles without logging response text', () => {
  assert.equal(isProviderErrorReply('Could not connect to local provider: timeout'), true);
  assert.equal(isProviderErrorReply('MODEL_REQUIRED: choose a model'), true);
  assert.equal(isProviderErrorReply('Here is a short English reply.'), false);
});

test('live reply challenge requires a positive model-controlled token', () => {
  assert.equal(isExpectedChallengeReply('VP_E2E_CHAT_1_OK', 'VP_E2E_CHAT_1_OK'), true);
  assert.equal(isExpectedChallengeReply('Model "ornith-9b" was not found', 'VP_E2E_CHAT_1_OK'), false);
  assert.equal(isExpectedChallengeReply('A different non-empty reply', 'VP_E2E_CHAT_1_OK'), false);
});

test('restart and resilience lanes reject error bubbles and resilience uses visible controls', () => {
  const driver = read('scripts/windows-product-e2e.cjs');
  const restartBlock = driver.slice(driver.indexOf("if (mode === 'RestartCheck')"), driver.indexOf('// 2. Live Local LLM Verification'));
  const resilienceBlock = driver.slice(driver.indexOf('// 4. Resilience & Lifecycles'), driver.indexOf("console.log('\\n[E2E] All requested tests passed successfully.')"));
  assert.match(restartBlock, /isExpectedChallengeReply/);
  assert.match(restartBlock, /VP_E2E_RESTART_OK/);
  assert.match(resilienceBlock, /isExpectedChallengeReply/);
  assert.match(resilienceBlock, /VP_E2E_RECOVERY_OK/);
  assert.match(resilienceBlock, /MISSING_VISIBLE_SETTINGS_TRIGGER/);
  assert.doesNotMatch(resilienceBlock, /\bopenSettingsModal\s*\(/);
  assert.doesNotMatch(resilienceBlock, /\btestApiConnection\s*\(/);
  assert.doesNotMatch(resilienceBlock, /\bsaveSettings\s*\(/);
  assert.doesNotMatch(resilienceBlock, /\bsendManualText\s*\(/);
});

test('full verifier rebuilds and validates packaging and required markers', () => {
  const verifier = read('scripts/verify-windows-product-e2e.ps1');
  assert.match(verifier, /\[Parameter\(Mandatory\s*=\s*\$true\)\]\[string\]\$ExpectedCodeSha/);
  assert.match(verifier, /git\s+rev-parse\s+HEAD/);
  assert.match(verifier, /git\s+status\s+--porcelain/);
  assert.match(verifier, /CODE_TESTED_SHA=/);
  assert.match(verifier, /does not match ExpectedCodeSha/);
  assert.match(verifier, /worktree must be clean/i);
  assert.match(verifier, /Removing existing dist to prevent stale-binary evidence/);
  assert.match(verifier, /npm run pack:win/);
  assert.match(verifier, /verify-windows-package\.ps1/);
  assert.match(verifier, /requires a fresh package from the checked-out source/);
  assert.match(verifier, /Assert-RequiredMarkers/);
  assert.match(verifier, /missing required marker/);
  assert.match(verifier, /Restart driver/);
});

test('Driver and verifier emit all required product markers', () => {
  const driver = read('scripts/windows-product-e2e.cjs');
  const verifier = read('scripts/verify-windows-product-e2e.ps1');
  const combined = driver + '\n' + verifier;

  const requiredMarkers = [
    'DRIVER_CONNECT_OK',
    'PACKAGED_APP_TITLE_OK',
    'APP_SHELL_DOM_OK',
    'LLAMACPP_UI_MODELS_OK',
    'LLAMACPP_UI_CHAT_1_OK',
    'LLAMACPP_UI_CHAT_2_OK',
    'LLAMACPP_UI_RESTART_OK',
    'RENDERER_DIRECT_FETCHES=0',
    'LOCAL_PROVIDER_RUNTIME_CREDENTIAL_READS=NOT_INSTRUMENTED',
    'LOCAL_PROVIDER_NO_SECRET_CONTRACT_OK',
    'BUILTIN_LESSONS_OK',
    'LESSON_IMPORT_EXPORT_ROUNDTRIP_OK',
    'LESSON_PROGRESS_PERSISTENCE_OK',
    'SHADOWING_FIXTURE_SCORE_OK',
    'OFFLINE_BUNDLED_UI_OK',
    'INVALID_PORT_ERROR_UI_OK',
    'AUTH_CONTRACTS_OK',
    'AUTOMATED_SELECTED_GATES_PASS',
  ];

  for (const marker of requiredMarkers) {
    assert.match(combined, new RegExp(marker), `Must declare marker: ${marker}`);
  }
});
