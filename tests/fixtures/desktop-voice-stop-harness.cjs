// Fixture-only extraction. Execute the unchanged registered Main + real Sidecar.
// Electron/DOM/termination injection are doubles; all children are real inert Node.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const tests = path.resolve(__dirname, '..');
const sourcePath = path.join(tests, 'main-voice-operations.test.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const prefix = source.slice(0, source.indexOf("test('producer advances"));
const start = source.indexOf('async function harness(t, options = {}) {');
const end = source.indexOf("\ntest('registered Main held STT", start);
if (start < 0 || end < 0 || !prefix) throw new Error('FIXTURE_EXTRACTION_BOUNDARY');
const moduleBox = { exports: {} };
vm.runInNewContext(prefix + source.slice(start, end) + '\nmodule.exports = { harness, gate, until };', {
  module: moduleBox, require: createRequire(sourcePath), __dirname: tests,
  process, Buffer, URL, console, setTimeout, clearTimeout,
}, { filename: sourcePath });

function preload(invoke) {
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(tests, '../apps/desktop/preload.cjs'), 'utf8'), {
    require(name) {
      if (name !== 'electron') throw new Error('SANDBOX_REQUIRE_DENIED:' + name);
      return { contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        ipcRenderer: { invoke: (channel, payload) => Promise.resolve().then(() => invoke(channel, structuredClone(payload))) } };
    }, Object, Array,
  });
  return api;
}
function ui(runtime, extra = {}) {
  const html = fs.readFileSync(path.join(tests, '../apps/web/index.html'), 'utf8');
  const from = html.indexOf('// Conversation Control Loop');
  const to = html.indexOf('\nlet mediaRecorder = null;', from);
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerText: '', innerHTML: '', disabled: false, style: {}, classList: { toggle() {} } });
    return elements.get(id);
  }, querySelector() { return document.getElementById('conversationBtn'); } };
  let playbackStops = 0;
  const context = vm.createContext({ document, voiceRuntime: runtime, isRunning: true,
    isMediaRecording: false, mediaRecorder: null, navigator: {}, console, setTimeout, clearTimeout,
    updateCoachUI() {}, stopCurrentVoicePlayback() { playbackStops++; context.voicePlaybackToken++; }, startListeningTurn() {},
    voicePlaybackToken: 1, currentVoiceId: 'af_heart', isKokoroLoading: false,
    cleanTextForTTS: text => text, setTTSEngineStatus() {}, getTtsMode: () => 'kokoro',
    refreshFoundationModelsCapability: async () => {},
    window: { VoiceLanguagePolicy: { SAFE_ENGLISH_FALLBACK: 'Hello.' }, VoiceTtsPreference: { shouldUseModelTts: () => true } },
    ...extra,
  });
  vm.runInContext(html.slice(from, to) + '\nglobalThis.stop = stopConversation; globalThis.toggle = toggleConversation;', context);
  vm.runInContext(html.slice(html.indexOf('function browserVoiceOwner('), html.indexOf('async function transcribeWithWebAssembly(')), context);
  if (extra.actualCapture) {
    context.Blob = Blob;
    vm.runInContext(html.slice(to, html.indexOf('// --- Browser Whisper Speech Recognition', to)), context);
  }
  context.run = code => vm.runInContext(code, context);
  if (extra.actualBrowser) {
    context.Blob = Blob;
    vm.runInContext(html.slice(html.indexOf('// --- Browser Whisper Speech Recognition'), html.indexOf('\nfunction isRuntimeCancellation(')), context);
    vm.runInContext(html.slice(html.indexOf('async function synthesizeBrowserSpeech('), html.indexOf('\nasync function speakReply(')), context);
  }
  if (extra.actualKokoro) {
    // Only dynamic module import is replaced: no host model/network execution.
    vm.runInContext(html.slice(html.indexOf('let kokoroTTSInstance = null;'), html.indexOf('\nfunction stopCurrentVoicePlayback('))
      .replace('import("./vendor/kokoro.bundle.js")', 'browserImport()'), context);
  }
  if (extra.actualFactory) {
    context.transcribeBrowserAudio ||= () => {};
    context.synthesizeBrowserSpeech ||= () => {};
    vm.runInContext(html.slice(html.indexOf('async function createVoiceRuntime('), html.indexOf('\nlet availableVoices')), context);
  }
  if (extra.actualPlayback) {
    vm.runInContext(html.slice(html.indexOf('let currentAudioObj = null;'), html.indexOf('\nfunction isKokoroInitializationCurrent')), context);
    vm.runInContext(html.slice(html.indexOf('function stopCurrentVoicePlayback('), html.indexOf('\nfunction cleanTextForTTS')), context);
    vm.runInContext(html.slice(html.indexOf('function playAudioSource('), html.indexOf('\nasync function synthesizeBrowserSpeech')), context);
  }
  if (extra.actualHandlers) {
    // These lifecycle unit fixtures retain their existing provider boundary doubles,
    // but session/action validity and modal entry are the actual HTML implementation.
    vm.runInContext(html.slice(html.indexOf('let modelDebounceTimer = null;'), html.indexOf('\nfunction getProviderConfig(')), context);
    vm.runInContext(html.slice(html.indexOf('async function openSettingsModal('), html.indexOf('\nasync function onProviderSelectChange(')), context);
    vm.runInContext(html.slice(html.indexOf('function selectCoach('), html.indexOf('// Connection adapters:')), context);
    vm.runInContext(html.slice(html.indexOf('async function saveSettings('), html.indexOf('\nfunction updateHeaderStatusBadge')), context);
    vm.runInContext(html.slice(html.indexOf('function closeSettingsModal('), html.indexOf('\ndocument.addEventListener("keydown"')), context);
    vm.runInContext(html.slice(html.indexOf('window.addEventListener("beforeunload"'), html.indexOf('\ninitApp().catch')), context);
  }
  if (extra.actualLessonShadow) {
    // Real entry bodies; the test declares DOM, recorder and local Whisper boundaries.
    context.Blob = Blob;
    vm.runInContext(html.slice(html.indexOf('// Shadowing Coach'), html.indexOf('// Local-first lesson library management')), context);
    vm.runInContext(html.slice(html.indexOf('async function startSpecificLesson('), html.indexOf('// Tabs')), context);
  }
  if (extra.actualLessonExit || extra.actualLessonShadow) {
    // Existing tab/navigation/completion bodies, paired with actual Lesson entry.
    vm.runInContext(html.slice(html.indexOf('// Tabs'), html.indexOf('// Coach Modal')), context);
  }
  if (extra.actualInit) {
    vm.runInContext(html.slice(html.indexOf('async function initApp()'), html.indexOf('\nwindow.addEventListener("beforeunload"')), context);
  }
  if (extra.actualTurns) {
    context.Blob = Blob;
    vm.runInContext(html.slice(html.indexOf('function isRuntimeCancellation('), html.indexOf('\nfunction getZeroKeyDemoReply(')), context);
  }
  vm.runInContext(html.slice(html.indexOf('async function speakReply('), html.indexOf('\nfunction appendChat(')) + '\nglobalThis.speak = speakReply;', context);
  const onclick = html.match(/class="btn btn-stop" onclick="([^"]+)"/)[1];
  const clickLessonExit = action => {
    const name = action === 'return' ? 'returnToLessonList' : 'completeCurrentLesson';
    const binding = html.match(new RegExp('onclick="(' + name + '\\(\\))"'));
    if (!binding || !extra.actualLessonExit) throw new Error('LESSON_EXIT_FIXTURE_BOUNDARY');
    return vm.runInContext(binding[1], context);
  };
  return { elements, context, clickLessonExit, click: () => vm.runInContext(onclick, context), stop: context.stop, toggle: context.toggle, speak: context.speak,
    playbackStops: () => playbackStops };
}
// Reuse the original provider fixture prefix, not a substitute Save/form body.
// Only expose its VM context for voice-fault injection; never replace Save/session bodies.
function settingsUi(options = {}) {
  const fixturePath = path.join(tests, 'provider-settings.test.cjs');
  const fixture = fs.readFileSync(fixturePath, 'utf8');
  const end = fixture.indexOf("test('provider options are capability-driven");
  const originalReturn = 'return { api: context.__settings, dispatch, elements, localStorage,';
  if (end < 0 || !fixture.slice(0, end).includes(originalReturn)) throw new Error('SETTINGS_FIXTURE_EXTRACTION_BOUNDARY');
  const box = { exports: {} };
  let fixtureSource = fixture.slice(0, end).replace(originalReturn, 'return { context, api: context.__settings, dispatch, elements, localStorage,');
  if (options.browserGlobals) {
    const boundary = '  const browserOwnerSource = html.slice';
    if (fixtureSource.split(boundary).length !== 2) throw new Error('BROWSER_SCRIPT_FIXTURE_BOUNDARY');
    fixtureSource = fixtureSource.replace(boundary, '  installBrowserScripts(context, html);\n' + boundary);
  }
  vm.runInNewContext(fixtureSource + '\nmodule.exports = createHarness;', {
    module: box, require: createRequire(fixturePath), __dirname: tests,
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    installBrowserScripts(context, html) {
      require('./browser-runtime-scripts.cjs').loadRuntimeScripts(context, html,
        options.browserGlobals.root, { legacyOrder: !!options.browserGlobals.legacyOrder });
    },
  }, { filename: fixturePath });
  const page = box.exports(options);
  page.run = code => vm.runInContext(code, page.context);
  return page;
}
module.exports = { ...moduleBox.exports, preload, ui, settingsUi };
