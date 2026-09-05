'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Windows product completeness matrix document exists and declares valid schema', () => {
  const matrixPath = path.join(ROOT, 'docs', 'testing', 'windows-product-completeness-matrix.md');
  assert.ok(fs.existsSync(matrixPath), 'Matrix document must exist at docs/testing/windows-product-completeness-matrix.md');

  const content = read('docs/testing/windows-product-completeness-matrix.md');

  // Verify status model definitions
  const requiredStatuses = [
    'LINUX_CONTRACT_PASS',
    'PRIOR_FIXED_SHA_EVIDENCE',
    'MANUAL_PROVIDER_LOGIN_NOT_RUN',
    'MANUAL_HARDWARE_NOT_RUN',
    'UNAVAILABLE_ACCURATELY_DISABLED',
    'NOT_RUN',
  ];

  for (const status of requiredStatuses) {
    assert.match(content, new RegExp(status), `Matrix must define and use status ${status}`);
  }

  // The matrix must not claim overall acceptance before a rebuilt Windows rerun.
  assert.match(
    content,
    /INTEGRATED_CODE_LINUX_CONTRACT_PASS_WINDOWS_RERUN_REQUIRED/,
    'Overall status must remain pending until a rebuilt Windows product rerun',
  );
  assert.doesNotMatch(content, /自動化總覆蓋數:.*%/);
});

test('Matrix inventories all visible App Shell and Navigation surfaces', () => {
  const content = read('docs/testing/windows-product-completeness-matrix.md');
  assert.match(content, /F-01.*主視窗與單一實例.*LINUX_CONTRACT_PASS/);
  assert.match(content, /F-02.*自由對話／關卡分頁.*#tabBtnFree.*#tabBtnLesson/);
  assert.match(content, /F-03.*教練角色選擇.*#coachCard/);
  assert.match(content, /F-04.*同源PWA資產.*#offlineStatus/);
  assert.match(content, /F-05.*連線狀態徽章.*#headerConnBadge/);
});

test('Matrix inventories local model providers and distinguishes live from manual auth', () => {
  const content = read('docs/testing/windows-product-completeness-matrix.md');
  assert.match(content, /F-06.*llama\.cpp.*127\.0\.0\.1:8080.*NOT_RUN: integration SHA Windows live rerun required/);
  assert.match(content, /F-11.*OpenAI／Gemini API Key.*MANUAL_PROVIDER_LOGIN_NOT_RUN/);
  assert.match(content, /F-12.*ChatGPT／Codex.*MANUAL_PROVIDER_LOGIN_NOT_RUN/);
  assert.match(content, /F-13.*Grok／SuperGrok.*MANUAL_PROVIDER_LOGIN_NOT_RUN/);
  assert.match(content, /F-13a.*retired Google browser account login、Claude\/Copilot subscription.*UNAVAILABLE_ACCURATELY_DISABLED/);
});

test('Matrix inventories curriculum, lesson library and progress tracking', () => {
  const content = read('docs/testing/windows-product-completeness-matrix.md');
  assert.match(content, /F-15a.*內建7大關卡檢視與選擇.*#lessonListContainer/);
  assert.match(content, /F-15.*課程JSON編輯.*#lessonJsonEditor/);
  assert.match(content, /F-16.*Merge／Replace匯入與匯出.*#lessonImportFile/);
  assert.match(content, /F-17a.*恢復範例課程.*restoreDefaultLessons/);
  assert.match(content, /F-17.*關卡進度.*completeCurrentLesson/);
});

test('Matrix inventories shadowing, conversation input, and resilience', () => {
  const content = read('docs/testing/windows-product-completeness-matrix.md');
  assert.match(content, /F-18.*文字輸入.*#userTextInput.*sendManualText/);
  assert.match(content, /F-19.*文字比對評分.*startShadowing.*#shadowResultBox/);
  assert.match(content, /F-20.*faster-whisper runtime.*NOT_RUN: Windows package and model artifacts required/);
  assert.match(content, /F-24.*NSIS／Portable.*NOT_RUN: Windows runner required/);
  assert.match(content, /F-25.*DPAPI live smoke.*NOT_RUN: Windows runner required/);
});

test('R6 provider surface exposes only capability-gated ChatGPT and Grok subscriptions', () => {
  const html = read('apps/web/index.html');
  for (const provider of ['chatgpt-subscription', 'grok-subscription']) {
    assert.match(
      html,
      new RegExp(`<option(?=[^>]*value=["']${provider}["'])(?=[^>]*disabled)[^>]*>`),
      `${provider} must start disabled until the trusted Main broker advertises capability`,
    );
  }
  assert.doesNotMatch(html, /value=["'](?:claude|copilot)-subscription["']/);
  assert.doesNotMatch(html, /googleGeminiOAuthGroup/);
  const checklist = read('docs/testing/windows-manual-auth-checklist.md');
  assert.match(checklist, /ChatGPT／Codex subscription/);
  assert.match(checklist, /Grok／SuperGrok subscription/);
  assert.match(checklist, /retired Google browser account login.*不支援/);
  assert.match(checklist, /Claude／GitHub Copilot subscription.*不支援/);
});

test('HTML source contains the corresponding UI entry points referenced in the matrix', () => {
  const html = read('apps/web/index.html');

  // Verify critical DOM elements exist in HTML
  assert.match(html, /id="tabBtnFree"/);
  assert.match(html, /id="tabBtnLesson"/);
  assert.match(html, /id="coachCard"/);
  assert.match(html, /id="headerConnBadge"/);
  assert.match(html, /id="userTextInput"/);
  assert.match(html, /id="startBtn"/);
  assert.match(html, /id="lessonManagerModal"/);
  assert.match(html, /id="lessonJsonEditor"/);
  assert.match(html, /id="lessonImportMode"/);
  assert.match(html, /id="settingsModal"/);
  assert.match(html, /id="providerSelect"/);
  assert.match(html, /id="apiBaseUrl"/);
  assert.match(html, /id="apiKey"/);
  assert.match(html, /id="modelSelect"/);
  assert.doesNotMatch(html, /id="googleGeminiOAuthGroup"/);
});
