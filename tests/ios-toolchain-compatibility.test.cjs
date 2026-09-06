const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Apple model XCTest imports the core module only when that module exists', () => {
  const source = read('apps/ios/Tests/VoicePracticeXCTests/AppleFoundationModelServiceTests.swift');
  assert.match(source, /#if canImport\(VoicePracticeCore\)\s+@testable import VoicePracticeCore\s+#endif/);
});

test('native speech keeps Swift 6-only delegate annotations out of the Swift 5 build', () => {
  const source = read('apps/ios/VoicePractice/App/NativeSpeechService.swift');
  assert.match(source, /public final class NativeSpeechService: NSObject\s*\{/);
  assert.match(source, /#if compiler\(>=6\.0\)\s+extension NativeSpeechService: @preconcurrency AVSpeechSynthesizerDelegate\s*\{\}\s+#else\s+extension NativeSpeechService: AVSpeechSynthesizerDelegate\s*\{\}\s+#endif/);
  assert.match(source, /@MainActor\s+public final class NativeSpeechService/);
});
