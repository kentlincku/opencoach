const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
const iosRoot = path.join(__dirname, '../apps/ios');
const readIos = file => fs.readFileSync(path.join(iosRoot, file), 'utf8');

test('UIKit app tests are excluded from SwiftPM and core handler stays portable', () => {
  const tests = readIos('Tests/VoicePracticeXCTests/ScriptBridgeHandlerTests.swift');
  assert.match(tests, /#if os\(iOS\) && !SWIFT_PACKAGE\s+func testNativeSpeech/);
  const core = readIos('Sources/VoicePracticeCore/ScriptBridgeHandler.swift');
  const portableCore = core.replace(/#if os\(iOS\) && !SWIFT_PACKAGE[\s\S]*?#endif/g, '');
  assert.doesNotMatch(portableCore, /NativeSpeechService|nativeSpeech|stopNativeSpeech|import UIKit/);
  const project = readIos('VoicePractice.xcodeproj/project.pbxproj');
  assert.equal((project.match(/NativeSpeechService.swift in Sources/g) || []).length, 3);
  assert.equal((project.match(/ContentView.swift in Sources/g) || []).length, 3);
});

test('speech callbacks preserve document URL trust as well as generation checks', () => {
  const handler = readIos('VoicePractice/App/ScriptBridgeHandler.swift');
  const speechBranch = handler.slice(handler.indexOf('if let operation ='), handler.indexOf('let response = await bridge.handleMessage'));
  assert.equal((speechBranch.match(/self.isTrustedDocument\(url: deliveryUrl\)/g) || []).length, 2);
  assert.equal((speechBranch.match(/== messageUrl.standardizedFileURL.resolvingSymlinksInPath\(\)/g) || []).length, 2);
});

test('shared settings caption remains discoverable by the packaged desktop verifier', () => {
  const verifier = fs.readFileSync(path.join(__dirname, '../scripts/macos-packaged-voice-e2e.cjs'), 'utf8');
  assert.ok(html.includes('onclick="openSettingsModal()">⚙️ 設定</button>'));
  assert.ok(verifier.includes("visibleButton('設定', 'MISSING_VISIBLE_SETTINGS_TRIGGER')"));
});

test('shared fallback routes only speech-capable iOS to native playback without cloud fallback', async () => {
  const fallback = html.slice(html.indexOf('function playFallbackWebSpeech('), html.indexOf('async function synthesizeBrowserSpeech('));
  for (const nativeSpeech of [true, false, undefined, 'true']) {
    let nativeCalls = 0;
    const context = vm.createContext({
      window: { voiceNativeBridge: { nativeSpeech, providerOperation() {} } },
      voicePlaybackToken: 1,
      playNativeSpeech: async () => { nativeCalls++; return false; },
    });
    vm.runInContext(fallback, context);
    assert.equal(await context.playFallbackWebSpeech('Hello.', 1), false);
    assert.equal(nativeCalls, nativeSpeech === true ? 1 : 0);
  }
});

test('shared Stop reaches native speech and invalidates pending playback', async () => {
  const stop = html.slice(html.indexOf('function stopCurrentVoicePlayback('), html.indexOf('function cleanTextForTTS('));
  const calls = [];
  const context = vm.createContext({
    window: {
      voiceNativeBridge: { nativeSpeech: true, stopSpeech: async () => { calls.push('native'); } },
      speechSynthesis: { cancel() { calls.push('web'); } },
    },
    voicePlaybackToken: 1,
    currentAudioObj: { pause() { calls.push('pause'); }, removeAttribute() {}, load() {} },
    currentPlaybackResolve: value => calls.push(value),
  });
  vm.runInContext(stop, context);
  context.stopCurrentVoicePlayback();
  assert.equal(context.voicePlaybackToken, 2);
  assert.equal(context.currentAudioObj, null);
  assert.equal(context.currentPlaybackResolve, null);
  assert.deepEqual(calls, ['pause', 'native', 'web', false]);
});

test('iOS native scale, voice bounds and device-only inference safeguards remain explicit', () => {
  const content = readIos('VoicePractice/App/ContentView.swift');
  const service = readIos('VoicePractice/App/NativeSpeechService.swift');
  const appleTests = readIos('Tests/VoicePracticeXCTests/AppleFoundationModelServiceTests.swift');
  assert.match(content, /maximum-scale=1, user-scalable=no/);
  assert.match(content, /viewForZooming\(in scrollView: UIScrollView\) -> UIView\? \{ nil \}/);
  assert.match(content, /document.hidden[^\n]*window.stopConversation\(\)/);
  assert.match(html, /\.native-ios-app input[^\n]*font-size: 16px !important/);
  assert.match(service, /text.utf8.count <= 12000/);
  assert.match(service, /CFBooleanGetTypeID\(\)/);
  assert.match(service, /rate.isFinite, \(0.6...1.4\).contains\(rate\)/);
  assert.match(service, /guard utterance === value else \{ return \}/);
  assert.match(service, /SPEECH_START_TIMEOUT/);
  assert.match(appleTests, /#if os\(iOS\) && !targetEnvironment\(simulator\)/);
  assert.match(appleTests, /APPLE_MODEL_DEVICE_TURN_2/);
  assert.match(appleTests, /throw XCTSkip\("System model unavailable:/);
});

const source = html.slice(html.indexOf('async function playNativeSpeech('), html.indexOf('function playFallbackWebSpeech('));
function fixture() {
  const calls = [], states = [], statuses = [], stops = [], elements = {};
  const context = vm.createContext({
    isRunning: false,
    voicePlaybackToken: 1,
    nativeSpeechPreviewToken: null,
    shadowingInProgress: false,
    currentAudioObj: null,
    currentPlaybackResolve: null,
    subscriptionLoginState: null,
    activeSettingsProvider: 'test',
    invalidateModelDiscovery() {},
    setTimeout() {},
    cleanTextForTTS: text => text,
    getTtsMode: () => 'system',
    startListeningTurn() { states.push('listening'); },
    window: {
      VoiceTtsPreference: { shouldUseModelTts: () => false },
      voiceNativeBridge: { nativeSpeech: true, stopSpeech: async () => { stops.push('stop'); }, speak(payload, started) {
        return new Promise((resolve, reject) => calls.push({ payload, started, resolve, reject }));
      } },
    },
    localStorage: { getItem(key) { return ({ vp_nativeSpeechVoice: 'saved.voice', vp_nativeSpeechRate: '0.8' })[key]; } },
    document: { getElementById(key) {
      return elements[key] ||= { value: key === 'nativeSpeechVoice' ? 'preview.voice' : '1.2', style: {}, replaceChildren() {} };
    } },
    setTTSEngineStatus(text) { statuses.push(text); },
    updateCoachUI(state) { states.push(state); },
  });
  context.voiceRuntime = { kind: 'browser', cancel: () => context.stopCurrentVoicePlayback() };
  vm.runInContext(source, context);
  vm.runInContext(html.slice(html.indexOf('function stopCurrentVoicePlayback('), html.indexOf('function cleanTextForTTS(')), context);
  vm.runInContext(html.slice(html.indexOf('function playFallbackWebSpeech('), html.indexOf('async function synthesizeBrowserSpeech(')), context);
  vm.runInContext(html.slice(html.indexOf('async function speakReply('), html.indexOf('function appendChat(')), context);
  vm.runInContext(html.slice(html.indexOf('async function closeSettingsModal('), html.indexOf('document.addEventListener("keydown"')), context);
  return { context, calls, states, statuses, stops, elements };
}

for (const action of ['closeSettingsModal', 'stopNativeSpeechPreview']) {
  test(`${action} preserves conversation speech and resumes listening`, async () => {
    const { context, calls, states, stops } = fixture();
    context.isRunning = true;
    const pending = context.speakReply('Conversation.');
    calls[0].started({ voiceName: 'Conversation Voice' });
    const token = context.voicePlaybackToken;
    const stopCount = stops.length;
    await context[action]();
    assert.equal(context.voicePlaybackToken, token);
    assert.equal(stops.length, stopCount);
    assert.equal(states.at(-1), 'speaking');
    assert.equal(context.isRunning, true);
    calls[0].resolve({ finished: true });
    assert.equal(await pending, true);
    assert.equal(states.at(-1), 'listening');
  });

  test(`${action} cancels only its speaking preview and clears speaking UI`, async () => {
    const { context, calls, states, stops } = fixture();
    const pending = context.previewNativeSpeech();
    calls[0].started({ voiceName: 'Preview Voice' });
    const stopCount = stops.length;
    await context[action]();
    assert.equal(stops.length, stopCount + 1);
    assert.equal(states.at(-1), 'idle');
    const settledStates = [...states];
    calls[0].reject(new Error('SPEECH_CANCELLED'));
    await pending;
    assert.deepEqual(states, settledStates);
    await context[action]();
    assert.equal(stops.length, stopCount + 1, 'completed preview no longer owns cancellation');
    assert.deepEqual(states, settledStates);
  });
}

test('stale preview controls and completion cannot cancel or reset newer conversation', async () => {
  const { context, calls, states, stops } = fixture();
  const preview = context.previewNativeSpeech();
  calls[0].started({ voiceName: 'Preview Voice' });
  context.isRunning = true;
  const conversation = context.speakReply('New conversation.');
  calls[1].started({ voiceName: 'Conversation Voice' });
  const token = context.voicePlaybackToken;
  const stopCount = stops.length;
  await context.closeSettingsModal();
  context.stopNativeSpeechPreview();
  calls[0].resolve({ finished: true });
  await preview;
  assert.equal(context.voicePlaybackToken, token);
  assert.equal(stops.length, stopCount);
  assert.equal(states.at(-1), 'speaking');
  calls[1].resolve({ finished: true });
  assert.equal(await conversation, true);
  assert.equal(states.at(-1), 'listening');
});
test('native speech uses saved voice and speed, reporting success only after completion', async () => {
  const { context, calls, states } = fixture();
  let started = false;
  const pending = context.playNativeSpeech('Hello.', 1, () => { started = true; });
  assert.equal(calls[0].payload.voiceId, 'saved.voice');
  assert.equal(calls[0].payload.rate, 0.8);
  assert.equal(started, false);
  calls[0].started({ voiceName: 'English Voice' });
  assert.equal(started, true);
  assert.deepEqual(states, ['speaking']);
  calls[0].resolve({ finished: true });
  assert.equal(await pending, true);
});
test('cancelled native speech ignores late start and finish callbacks', async () => {
  const { context, calls, states } = fixture();
  const pending = context.playNativeSpeech('Hello.', 1);
  context.voicePlaybackToken++;
  calls[0].started({ voiceName: 'English Voice' });
  calls[0].resolve({ finished: true });
  assert.equal(await pending, false);
  assert.deepEqual(states, []);
  assert.equal(await context.playNativeSpeech('Stale.', 1), false);
  assert.equal(calls.length, 1);
});
test('replaced preview cannot reset the newer preview to idle', async () => {
  const { context, calls, states } = fixture();
  const first = context.previewNativeSpeech();
  const second = context.previewNativeSpeech();
  assert.equal(calls[1].payload.voiceId, 'preview.voice');
  assert.equal(calls[1].payload.rate, 1.2);
  calls[1].started({ voiceName: 'Preview Voice' });
  calls[0].reject(new Error('SPEECH_CANCELLED'));
  await first;
  assert.deepEqual(states, ['speaking']);
  calls[1].resolve({ finished: true });
  await second;
  assert.deepEqual(states, ['speaking', 'idle']);
});
test('production WKWebView test awaits the asynchronous public settings handler', () => {
  const tests = readIos('Tests/VoicePracticeXCTests/ScriptBridgeHandlerTests.swift');
  assert.doesNotMatch(tests, /evaluateJavaScript\("openSettingsModal\(\);"\)/);
  assert.ok(tests.includes('callAsyncJavaScript("await openSettingsModal(); return await window.voiceNativeBridge.listSpeechVoices();"'));
});

test('preview stops an active conversation before taking speaker ownership', async () => {
  const { context, calls } = fixture();
  context.isRunning = true;
  let stopped = false;
  context.stopConversation = () => { stopped = true; context.isRunning = false; };
  const pending = context.previewNativeSpeech();
  assert.equal(stopped, true);
  calls[0].resolve({ finished: true });
  await pending;
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function shadowingFixture() {
  const f = fixture();
  const permission = deferred(), transcript = deferred();
  const recorders = [], timers = [], warnings = [], rendered = [];
  let permissionRequests = 0, trackStops = 0;
  const stream = { getTracks: () => [{ stop() { trackStops++; } }] };
  Object.assign(f.context, {
    messages: [{ role: 'assistant', content: 'Practice this.' }],
    navigator: { mediaDevices: { getUserMedia() { permissionRequests++; return permission.promise; } } },
    MediaRecorder: class {
      constructor() { recorders.push(this); }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop(); }
    },
    Blob,
    getSupportedRecordingMimeType: () => 'audio/webm',
    setTimeout(callback) { timers.push(callback); },
    transcribeWithWebAssembly: () => transcript.promise,
    renderShadowingResult(...args) { rendered.push(args); },
    console: { warn(...args) { warnings.push(args); } },
    alert() {},
  });
  vm.runInContext(html.slice(html.indexOf('async function startShadowing('), html.indexOf('// Local-first lesson library management')), f.context);
  return { ...f, permission, transcript, stream, recorders, timers, warnings, rendered,
    get permissionRequests() { return permissionRequests; },
    get trackStops() { return trackStops; } };
}

for (const phase of ['permission', 'capture', 'assessment']) {
  test(`preview is blocked during shadowing ${phase} without touching other playback`, async () => {
    const f = shadowingFixture();
    const shadowing = f.context.startShadowing();
    if (phase !== 'permission') {
      f.permission.resolve(f.stream);
      await new Promise(setImmediate);
      assert.equal(f.recorders[0].state, 'recording');
    }
    if (phase === 'assessment') {
      f.timers[0]();
      await new Promise(setImmediate);
    }
    const token = f.context.voicePlaybackToken;
    const preview = f.context.previewNativeSpeech();
    assert.equal(f.calls.length, 0, 'blocked preview must not call native speak');
    await preview;
    assert.equal(f.context.voicePlaybackToken, token);
    assert.equal(f.stops.length, 0);
    assert.deepEqual(f.states, []);
    assert.match(f.elements.nativeSpeechHint.textContent, /跟讀.*完成.*試聽/);
    await f.context.startShadowing();
    assert.equal(f.permissionRequests, 1, 'duplicate shadowing cannot release the active guard');
    if (phase === 'permission') {
      f.permission.resolve(f.stream);
      await new Promise(setImmediate);
    }
    if (phase !== 'assessment') f.timers[0]();
    f.transcript.resolve('Practice this.');
    await shadowing;
    assert.equal(f.trackStops, 1);
    assert.equal(f.rendered.length, 1);
    const allowedPreview = f.context.previewNativeSpeech();
    assert.equal(f.calls.length, 1, 'successful shadowing releases preview guard');
    f.calls[0].resolve({ finished: true });
    await allowedPreview;
  });
}

for (const failure of ['permission', 'recording', 'transcription']) {
  test(`shadowing ${failure} error releases guard and allows preview`, async () => {
    const f = shadowingFixture();
    const shadowing = f.context.startShadowing();
    assert.equal(f.context.shadowingInProgress, true);
    if (failure === 'permission') f.permission.reject(new Error('PERMISSION_DENIED'));
    else {
      f.permission.resolve(f.stream);
      await new Promise(setImmediate);
      if (failure === 'recording') f.recorders[0].onerror({ error: new Error('RECORDING_FAILED') });
      else {
        f.timers[0]();
        await new Promise(setImmediate);
        f.transcript.reject(new Error('TRANSCRIPTION_FAILED'));
      }
    }
    await shadowing;
    assert.equal(f.context.shadowingInProgress, false);
    assert.equal(f.trackStops, failure === 'permission' ? 0 : 1);
    assert.equal(f.warnings.length, 1);
    assert.match(f.elements.shadowResultBox.textContent, /麥克風權限/);
    const preview = f.context.previewNativeSpeech();
    assert.equal(f.calls.length, 1);
    f.calls[0].resolve({ finished: true });
    await preview;
  });
}

test('native speech failure settles playback and shows recovery guidance', async () => {
  const { context, calls, statuses } = fixture();
  const pending = context.playNativeSpeech('Hello.', 1);
  calls[0].reject(new Error('SPEECH_START_TIMEOUT'));
  assert.equal(await pending, false);
  assert.match(statuses.at(-1), /重新選擇英文聲音/);
});
