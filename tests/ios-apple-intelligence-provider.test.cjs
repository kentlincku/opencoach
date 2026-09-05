const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
const contentView = fs.readFileSync(path.join(__dirname, '../apps/ios/VoicePractice/App/ContentView.swift'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, '../apps/ios/Sources/VoicePracticeCore/VoiceWebBridge.swift'), 'utf8');
const appleService = fs.readFileSync(path.join(__dirname, '../apps/ios/Sources/VoicePracticeCore/AppleFoundationModelService.swift'), 'utf8');
const project = fs.readFileSync(path.join(__dirname, '../apps/ios/VoicePractice.xcodeproj/project.pbxproj'), 'utf8');

const APPLE_PROVIDER = 'apple-foundation-models';

test('shared UI declares Apple Intelligence as an iOS-native-only provider', () => {
  assert.match(html, /id="appleIntelligenceProviderOption"[^>]*value="apple-foundation-models"[^>]*(?:hidden[^>]*disabled|disabled[^>]*hidden)/);
  assert.match(html, /Apple Intelligence（本機）/);
  assert.match(contentView, /appleFoundationModels:\s*true/);
  assert.match(html, /APPLE_MODEL_NATIVE_BRIDGE_REQUIRED/);
});

test('Apple provider hides endpoint credential and arbitrary model controls', () => {
  assert.match(html, /id="modelGroup"/);
  const loadSource = html.slice(html.indexOf('async function loadProviderIntoForm'), html.indexOf('function invalidateModelDiscovery'));
  assert.match(loadSource, /apiBaseUrlGroup[^\n]*isAppleFoundationModel[^\n]*"none"/);
  assert.match(loadSource, /apiKeyGroup[^\n]*isAppleFoundationModel[^\n]*"none"/);
  assert.match(loadSource, /modelGroup[^\n]*isAppleFoundationModel[^\n]*"none"/);
  assert.match(loadSource, /appleIntelligenceStatus[^\n]*isAppleFoundationModel[^\n]*"block"/);
});

test('Apple chat payload omits Base URL API key and model name', () => {
  const requestSource = html.slice(html.indexOf('async function requestProviderChat'), html.indexOf('function populateModelSelect'));
  const appleStart = requestSource.indexOf('if (providerId === APPLE_FOUNDATION_MODEL_PROVIDER_ID)');
  const appleBranchSource = requestSource.slice(appleStart);
  const appleEnd = appleBranchSource.indexOf('if (!model ||');
  const appleBranch = appleBranchSource.slice(0, appleEnd);
  assert.notEqual(appleStart, -1);
  assert.notEqual(appleEnd, -1);
  assert.match(appleBranch, /operation:\s*"apple\.chat"/);
  assert.match(appleBranch, /messages:\s*boundedMessages/);
  assert.match(appleBranch, /conversationMessages\.slice\(-12\)/);
  assert.doesNotMatch(appleBranch, /baseUrl\s*[,}:]/);
  assert.doesNotMatch(appleBranch, /apiKey\s*[,}:]/);
  assert.doesNotMatch(appleBranch, /model\s*[,}:]/);
});

test('native bridge exposes only typed Apple operations and cancel', () => {
  for (const operation of ['apple.status', 'apple.chat', 'apple.cancel']) {
    assert.match(bridge, new RegExp(`"${operation.replace('.', '\\.') }"`));
  }
  assert.match(contentView, /cancelAppleFoundationModelRequests/);
  assert.match(html, /cancelAppleFoundationModelRequests/);
});

test('Apple service uses the public GenerationOptions initializer for response limits', () => {
  assert.match(appleService, /GenerationOptions\(\s*maximumResponseTokens:\s*maxTokens\s*\)/);
  assert.doesNotMatch(appleService, /options\.maximumResponseTokens\s*=/);
});

test('Apple service and tests are members of both app and XCTest builds', () => {
  assert.match(project, /AppleFoundationModelService\.swift in Sources/);
  assert.match(project, /AppleFoundationModelServiceTests\.swift in Sources/);
  assert.equal((project.match(/AppleFoundationModelService\.swift in Sources/g) || []).length, 3);
  assert.equal((project.match(/AppleFoundationModelServiceTests\.swift in Sources/g) || []).length, 2);
});

test('ordinary Browser and Electron keep Apple provider hidden and never route to Foundation Models', () => {
  assert.match(html, /appleOption\.hidden\s*=\s*!nativeAppleAvailable/);
  assert.match(html, /appleOption\.disabled\s*=\s*!nativeAppleAvailable/);
  assert.match(html, /window\.voiceNativeBridge\?\.appleFoundationModels\s*===\s*true/);
  assert.doesNotMatch(html, /window\.electronAPI[^\n]*apple/i);
});

test('Apple unavailability is actionable and does not silently switch provider', () => {
  assert.match(html, /APPLE_MODEL_UNSUPPORTED_DEVICE/);
  assert.match(html, /APPLE_INTELLIGENCE_DISABLED/);
  assert.match(html, /APPLE_MODEL_NOT_READY/);
  assert.match(html, /APPLE_MODEL_UNSUPPORTED_LOCALE/);
  assert.match(html, /請改選 OpenAI-compatible/);
  const statusFunction = html.slice(html.indexOf('function appleAvailabilityMessage'), html.indexOf('function configureAppleFoundationModelProviderOption'));
  assert.doesNotMatch(statusFunction, /localStorage\.setItem\(["']vp_provider/);
});
