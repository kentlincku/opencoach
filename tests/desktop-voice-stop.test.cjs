const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { harness, gate, until, preload, ui } = require('./fixtures/desktop-voice-stop-harness.cjs');
const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
const { encodePcmWav, isNativePcmWav } = require('../apps/web/runtime/native-audio.js');

// Valid PCM fixture carrying control labels in sample bytes, NOT speech/model data.
function pcmLabel(text) {
  const label = Buffer.from(text);
  const bytes = Buffer.from(encodePcmWav(new Float32Array(Math.ceil(label.length / 2))));
  label.copy(bytes, 44);
  assert.equal(isNativePcmWav(bytes), true);
  return bytes;
}
function pcmLabelText(bytes) {
  assert.equal(isNativePcmWav(Buffer.from(bytes)), true);
  return Buffer.from(bytes).subarray(44).toString().replace(/\0+$/, '');
}

async function pcmHarness(t, options = {}) {
  // Reuse the exact shared harness/Main/Sidecar bodies. Only its external inert
  // child STT boundary learns these PCM fixture labels; the original fixture
  // file stays unchanged for other suites and no native decoder is substituted.
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'mlx-pcm-child-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const child = path.join(dir, 'child.cjs');
  const original = await fs.readFile(path.join(__dirname, 'fixtures/main-voice-operation-child.cjs'), 'utf8');
  const read = "fs.readFileSync(request.params.audioPath, 'utf8')";
  assert.equal(original.split(read).length, 2);
  await fs.writeFile(child, original.replace(read,
    `(() => { const bytes = fs.readFileSync(request.params.audioPath); if (!require(${JSON.stringify(path.resolve(__dirname, '../apps/web/runtime/native-audio.js'))}).isNativePcmWav(bytes)) throw Error('FIXTURE_EXPECTED_PCM'); return bytes.subarray(44).toString().replace(/\\0+$/, ''); })()`));
  const sourcePath = path.join(__dirname, 'main-voice-operations.test.cjs');
  const source = await fs.readFile(sourcePath, 'utf8');
  const prefix = source.slice(0, source.indexOf("test('producer advances"));
  const start = source.indexOf('async function harness(t, options = {}) {');
  const end = source.indexOf("\ntest('registered Main held STT", start);
  assert.ok(prefix && start >= 0 && end > start);
  const body = source.slice(start, end);
  const command = "path.join(__dirname, 'fixtures/main-voice-operation-child.cjs')";
  assert.equal(body.split(command).length, 2);
  const box = { exports: {} };
  require('node:vm').runInNewContext(prefix + body.replace(command, JSON.stringify(child)) + '\nmodule.exports = harness;', {
    module: box, require: require('node:module').createRequire(sourcePath), __dirname,
    process, Buffer, URL, console, setTimeout, clearTimeout,
  }, { filename: sourcePath });
  return box.exports(t, options);
}

// Actual UI verticals use boundary doubles for DOM/media/provider, never Main or Sidecar.
function verticalPage(runtime, extra = {}) {
  const events = [], recorders = [], audio = [], chats = [];
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options.mimeType; recorders.push(this); }
    start() { this.state = 'recording'; events.push('recorder:start'); }
    stop() { this.state = 'inactive'; events.push('recorder:stop'); }
  }
  class Audio {
    constructor(src) { this.src = src; audio.push(this); events.push('audio:construct'); }
    play() { events.push('audio:play'); this.onplay?.(); return Promise.resolve(); }
    pause() { events.push('audio:pause'); }
    removeAttribute() {} load() {}
  }
  const page = ui(runtime, { actualCapture: true, actualTurns: true, actualPlayback: true,
    MediaRecorder: Recorder, Audio, messages: [], logKokoroStep() {},
    navigator: { mediaDevices: { async getUserMedia() {
      events.push('permission'); return { getTracks: () => [{ stop() { events.push('track:stop'); } }] };
    } } },
    localStorage: { getItem: () => 'direct-api' }, DIRECT_API_PROVIDER_ID: 'direct-api',
    getProviderConfig: () => ({ kind: 'api', authMode: 'optional' }), getProviderApiKey: () => '',
    getProviderBaseUrl: () => 'https://example.invalid', getProviderModel: () => 'boundary-double',
    requestProviderChat: async request => { events.push('llm:' + request.messages.at(-1).content.trim()); return 'A healthy reply.'; },
    appendChat: (role, text) => chats.push({ role, text }),
    window: { VoiceLanguagePolicy: require('../apps/web/runtime/language-policy.js'),
      VoiceTtsPreference: require('../apps/web/runtime/tts-preference.js') }, ...extra });
  return { page, events, recorders, audio, chats };
}
async function childRequests(h) {
  try { return (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('vertical-close actual Stop user Start permission recorder STT LLM TTS playback uses fresh real PID', { timeout: 8000 }, async t => {
  const h = await pcmHarness(t), calls = [], replies = [];
  const api = preload(async (channel, payload) => {
    calls.push({ channel, payload }); const result = await h.invoke(channel, payload);
    replies.push({ channel, payload, result }); return result;
  });
  const runtime = new ElectronRuntime({ api, capabilities: { ready: true, selectedStt: 'mlx-whisper', selectedTts: 'kokoro-python' } });
  const v = verticalPage(runtime);
  const oldWork = v.page.context.transcribeAudioBlob(new Blob([pcmLabel('hold')]));
  await until(async () => (await childRequests(h)).length === 1);
  const old = h.children[0]; await v.page.click(); await oldWork;
  assert.throws(() => process.kill(old.pid, 0), { code: 'ESRCH' });
  assert.equal(v.page.elements.get('conversationBtn').disabled, false);
  // Opt-in affects only the replacement inert child; default fixture controls remain unchanged.
  h.clients[0].env.MAIN_FIXTURE_TTS_AUDIO = '1';
  await v.page.toggle(); await until(() => v.recorders.length === 1);
  const recorder = v.recorders[0];
  recorder.ondataavailable({ data: new Blob([pcmLabel('fresh speech' + ' '.repeat(1100))]) });
  await v.page.toggle();
  const turn = recorder.onstop();
  await until(() => v.audio.length === 1 || !!runtime.fault);
  assert.equal(runtime.fault, null, 'native-shaped fixture result must reach actual HTML playback');
  assert.equal(v.audio.length, 1); assert.ok(v.events.includes('audio:play'));
  assert.equal(v.recorders.length, 1, 'listening cannot restart before playback ends');
  assert.match(v.audio[0].src, /^data:audio\/wav;base64,/);
  assert.equal(Buffer.from(v.audio[0].src.split(',')[1], 'base64').subarray(0, 4).toString(), 'RIFF');
  v.audio[0].onended(); await turn;
  await until(() => v.recorders.length === 2);
  const native = replies.filter(r => ['voice:stt', 'voice:tts'].includes(r.channel) && r.result.success);
  assert.deepEqual(native.map(r => r.channel), ['voice:stt', 'voice:tts']);
  assert.equal(h.children.length, 2);
  for (const reply of native) { assert.equal(reply.result.pid, h.children[1].pid); assert.notEqual(reply.result.pid, old.pid); }
  const requests = await childRequests(h);
  assert.deepEqual(requests.map(r => r.method), ['stt.transcribe', 'stt.transcribe', 'tts.synthesize']);
  assert.equal(new Set(requests.map(r => r.id)).size, 3, 'real JSONL replies correlate distinct Sidecar request IDs');
  assert.deepEqual(v.chats.map(c => [c.role, c.text.trim()]), [['user', 'fresh speech'], ['assistant', 'A healthy reply.']]);
  assert.ok(v.events.indexOf('llm:fresh speech') < v.events.indexOf('audio:play'));
  assert.deepEqual(v.events.slice(0, 4), ['permission', 'track:stop', 'permission', 'recorder:start']);
  console.log('VERTICAL_CLOSE_HEALTHY:' + JSON.stringify({ oldPid: old.pid, newPid: h.children[1].pid, requests, replies: native, events: v.events }));
  await v.page.click(); await runtime.dispose();
});

test('vertical-close actual mixed HTML passive Main observation Stop and natural old PID exit stay fenced', { timeout: 15000 }, async t => {
  for (const route of ['held-observer', 'late-fault-old-proof']) await t.test(route, async t => {
    const write = gate(), kill = gate(), decode = gate(), observer = gate(), delivery = gate(), fallback = gate();
    let writing = false, terminating = false, decoding = false, closes = 0, observed = false, fallbackCalls = 0;
    let client, terminate;
    const h = await pcmHarness(t, { release() {
      write.release(); kill.release(); decode.release(); observer.release(); delivery.release(); fallback.release({ useSystemSpeech: true });
      if (client) client._terminate = terminate;
    }, fs: { writeFile: async (...args) => {
      if (pcmLabelText(args[1]) === 'held-write') { writing = true; await write.promise; }
      return fs.writeFile(...args);
    } } });
    client = h.clients[0]; terminate = client._terminate.bind(client);
    client._terminate = async () => { terminating = true; await kill.promise; throw Error('MEMORY_VERTICAL_UNCONFIRMED'); };
    client.requestTimeoutMs = 180;
    const originalContext = globalThis.AudioContext;
    globalThis.AudioContext = class {
      decodeAudioData() { decoding = true; return decode.promise; }
      close() { closes++; return Promise.resolve(); }
    };
    t.after(() => { globalThis.AudioContext = originalContext; });
    const calls = [], passive = [], proofRoute = route === 'late-fault-old-proof';
    let holdObserver = true, proof;
    const api = preload(async (channel, payload) => {
      calls.push({ channel, payload });
      const result = await h.invoke(channel, payload);
      if (channel === 'voice:operation-state' && holdObserver) {
        holdObserver = false; observed = true; passive.push(structuredClone(result)); await observer.promise;
      }
      if (result?.type === 'failure') {
        if (result.code === 'backend-error') proof = structuredClone(result);
        else await delivery.promise;
      }
      return result;
    });
    const capabilities = { ready: true, selectedStt: 'mlx-whisper', selectedTts: 'kokoro-python' };
    const runtime = new ElectronRuntime({ api, capabilities, fallback: {
      synthesize() { fallbackCalls++; return fallback.promise; }, cancel() {}, dispose() {},
    } });
    const v = verticalPage(runtime);
    const speech = v.page.speak(proofRoute ? 'fail' : 'hold');
    let proofRecord;
    if (proofRoute) {
      await until(() => fallbackCalls === 1);
      proofRecord = [...runtime._scope.records][0];
      assert.deepEqual(proofRecord.proof, proof, 'proof comes from the real original Main backend failure');
      assert.equal((await h.invoke('voice:operation-state', { version: 1, type: 'observe', requestId: proof.requestId })).knowledge, 'retired');
    } else await until(async () => (await childRequests(h)).length === 1);
    const running = proofRoute ? v.page.context.transcribeAudioBlob(new Blob([pcmLabel('hold')])) : Promise.resolve();
    if (proofRoute) await until(async () => (await childRequests(h)).length === 2);
    const nativeRecord = [...runtime._scope.records].find(r => !r.nativeDone);
    let observation;
    if (!proofRoute) {
      observation = runtime._scope.observe(nativeRecord).catch(e => e);
      await until(() => observed);
      assert.equal(passive[0].receipt.status, 'running');
      assert.equal(calls.some(c => c.channel === 'voice:operation-revoke' && c.payload.requestIds.length), false);
    }
    await until(() => terminating);
    const stt = v.page.context.transcribeAudioBlob(new Blob([pcmLabel('held-write')]));
    await until(() => writing);
    capabilities.selectedStt = 'faster-whisper';
    const pcm = v.page.context.transcribeAudioBlob(new Blob(['codec']));
    await until(() => decoding);
    const records = [...runtime._scope.records], planned = records.filter(r => r.nativePlanned && !r.nativeDone).map(r => r.requestId);
    assert.equal(planned.length, 3);
    kill.release();
    await until(() => h.invoke('voice:operation-state', { version: 1, type: 'observe', requestId: nativeRecord.requestId }).failure?.code === 'termination-unconfirmed');
    if (proofRoute) {
      observation = runtime._scope.observe(nativeRecord).catch(e => e);
      await until(() => observed); assert.equal(runtime.fault, null, 'held passive delivery has not published its late fault');
      observer.release(); await observation;
      assert.ok(runtime.fault);
      assert.deepEqual(proofRecord.proof, proof, 'new fault does not rewrite old proof');
      const { canFallback } = require('../apps/web/runtime/desktop-voice-operation-contract.js');
      assert.equal(canFallback(proof, runtime._scope.context(proofRecord)), false, 'old completed proof cannot clear current fault');
    }
    const requestsBefore = await childRequests(h);
    const stopped = v.page.click().catch(e => e);
    await until(() => closes === 1 && calls.some(c => c.channel === 'voice:operation-revoke'));
    const revoked = calls.filter(c => c.channel === 'voice:operation-revoke').flatMap(c => c.payload.requestIds);
    assert.deepEqual(revoked, planned, 'all preparing/PCM/native IDs revoked despite pending observer or known failure');
    assert.ok(records.every(r => r.revoked));
    assert.equal(closes, 1); assert.equal(v.audio.length, 0);
    observer.release(); delivery.release(); fallback.release({ useSystemSpeech: true });
    await Promise.all([observation, speech, running, stt, pcm]);
    assert.match((await stopped).message, /UNCERTAIN/);
    const fault = runtime.fault, notice = v.page.elements.get('micNotice').textContent;
    const original = h.children[0]; original.stdin.end();
    await until(() => original.exitCode !== null);
    assert.throws(() => process.kill(original.pid, 0), { code: 'ESRCH' });
    write.release(); decode.release({ sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(4) });
    // An unconfirmed submitted STT retains its original input until public Quit;
    // natural EOF is deliberately NOT correlated cleanup authority.
    await until(async () => (await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length === (proofRoute ? 1 : 0));
    if (proofRoute) assert.equal(pcmLabelText(await fs.readFile(requestsBefore[1].params.audioPath)), 'hold');
    await v.page.toggle(); await v.page.speak('late speech');
    assert.equal(runtime.fault, fault); assert.equal(v.page.elements.get('micNotice').textContent, notice);
    assert.equal(v.page.elements.get('conversationBtn').disabled, true);
    assert.equal(v.recorders.length, 0); assert.equal(v.audio.length, 0); assert.equal(v.chats.length, 0);
    assert.equal(fallbackCalls, proofRoute ? 1 : 0, 'no fallback begins after current fault');
    assert.equal(h.children.length, 1); assert.deepEqual(await childRequests(h), requestsBefore);
    assert.equal(calls.filter(c => ['voice:stt', 'voice:tts'].includes(c.channel)).length, proofRoute ? 3 : 2, 'PCM never reaches native IPC');
    console.log('VERTICAL_CLOSE_MIXED:' + JSON.stringify({ route, pid: original.pid, planned, revoked, passive, proof, closes, fallbackCalls, requests: requestsBefore }));
    client._terminate = terminate;
  });
});

test('actual onclick healthy Stop permits explicit fresh runtime work on a NEW real child PID', { timeout: 8000 }, async t => {
  const h = await pcmHarness(t);
  const calls = [];
  const api = preload(async (channel, payload) => {
    calls.push({ channel, payload });
    const result = await h.invoke(channel, payload);
    if (channel === 'voice:operation-state') console.log('HEALTHY_STOP_STATE:' + JSON.stringify(result));
    return result;
  });
  const runtime = new ElectronRuntime({ api, capabilities: { ready: true, selectedStt: 'mlx-whisper' } });
  const old = runtime.transcribe({ buffer: pcmLabel('hold') }).catch(e => e);
  await until(async () => {
    try { return (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).includes('stt.transcribe'); }
    catch (_) { return false; }
  });
  const oldChild = h.children[0], page = ui(runtime);
  await page.click();
  assert.match((await old).message, /RUNTIME_CANCELLED/);
  assert.equal(page.elements.get('conversationBtn').disabled, false);
  assert.ok(oldChild.exitCode !== null || oldChild.signalCode !== null, 'signal termination is a real child exit too');
  assert.throws(() => process.kill(oldChild.pid, 0), { code: 'ESRCH' });
  const fresh = await runtime.transcribe({ buffer: pcmLabel('fresh success') });
  assert.equal(fresh.text, 'fresh success');
  assert.notEqual(fresh.pid, oldChild.pid);
  assert.equal(fresh.pid, h.children[1].pid);
  const ids = calls.filter(c => c.channel === 'voice:stt').map(c => c.payload.requestId);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(calls.filter(c => c.channel === 'voice:operation-revoke').flatMap(c => c.payload.requestIds), [ids[0]]);
  await runtime.dispose();
});

test('actual permission continuation cannot start over a fresh session after Stop', async () => {
  const permission = gate(); let requests = 0, tracks = 0, listening = 0;
  const stream = { getTracks: () => [{ stop() { tracks++; } }] };
  const page = ui({ cancel: async () => {} }, { isRunning: false,
    navigator: { mediaDevices: { getUserMedia: () => ++requests === 1 ? permission.promise : Promise.resolve(stream) } },
    startListeningTurn() { listening++; },
  });
  const old = page.toggle();
  let stopped = false;
  const stop = page.click().then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false, 'Stop owns the original unsettled permission grant');
  await page.toggle(); assert.equal(listening, 0);
  permission.release(stream); await Promise.all([old, stop]);
  await page.toggle();
  assert.equal(listening, 1);
  assert.equal(listening, 1, 'late old grant must not start a second recorder');
  assert.equal(tracks, 2, 'both permission-probe streams release their own tracks');
});

test('actual late permission error cannot overwrite visible Stop failure', async () => {
  let rejectPermission;
  const permission = new Promise((_, reject) => { rejectPermission = reject; });
  const page = ui({ cancel: async () => { throw new Error('VOICE_CLEANUP_UNCERTAIN'); } }, { isRunning: false,
    navigator: { mediaDevices: { getUserMedia: () => permission } },
  });
  const old = page.toggle(); await assert.rejects(page.click(), /VOICE_CLEANUP_UNCERTAIN/);
  const notice = page.elements.get('micNotice'); const before = { text: notice.textContent, html: notice.innerHTML };
  rejectPermission(new Error('old permission denial')); await old;
  assert.deepEqual({ text: notice.textContent, html: notice.innerHTML }, before);
  assert.equal(page.elements.get('conversationBtn').disabled, true);
  assert.equal(page.context.isRunning, false);
});

test('actual recorder pending grant drains before Stop; old events cannot touch fresh capture', async () => {
  const permission = gate(); const records = []; let stopped = 0, transcribed = 0;
  const stream = () => ({ getTracks: () => [{ stop() { stopped++; } }] });
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(source) { this.stream = source; this.mimeType = 'audio/webm'; records.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  const page = ui({ cancel: async () => {} }, { actualCapture: true, MediaRecorder: Recorder,
    navigator: { mediaDevices: { getUserMedia: () => permission.promise } },
    transcribeAudioBlob() { transcribed++; },
  });
  const capture = page.context.run('startMediaRecording()');
  let finished = false; const stop = page.click().then(() => { finished = true; });
  await new Promise(setImmediate);
  assert.equal(finished, false, 'Stop must retain the owned pending grant');
  permission.release(stream()); await Promise.all([stop, capture]);
  assert.equal(stopped, 1); assert.equal(records.length, 0, 'late grant must not construct a recorder');
  page.context.navigator.mediaDevices.getUserMedia = async () => stream();
  page.context.isRunning = true; await page.context.run('startMediaRecording()');
  const old = records[0]; old.ondataavailable({ data: new Blob(['x'.repeat(2000)]) });
  await page.click();
  page.context.isRunning = true; await page.context.run('startMediaRecording()');
  const fresh = records[1]; const before = page.elements.get('micNotice').innerHTML;
  old.ondataavailable({ data: new Blob(['stale']) }); await old.onstop();
  assert.equal(page.context.run('mediaRecorder'), fresh);
  assert.equal(page.context.run('audioChunks.length'), 0);
  assert.equal(page.elements.get('micNotice').innerHTML, before);
  assert.equal(transcribed, 0); assert.equal(fresh.state, 'recording');
  await page.click();
});

test('actual late capture cleanup failure attempts every original track and keeps Start locked', async () => {
  const grant = gate(); let tracks = 0;
  const page = ui({ cancel: async () => {} }, { actualCapture: true,
    navigator: { mediaDevices: { getUserMedia: () => grant.promise } },
  });
  const capture = page.context.run('startMediaRecording()');
  const stop = page.click();
  grant.release({ getTracks: () => [
    { stop() { tracks++; throw new Error('track failure'); } }, { stop() { tracks++; } },
  ] });
  await capture;
  await assert.rejects(stop, /UNCERTAIN/);
  assert.equal(tracks, 2);
  assert.equal(page.elements.get('conversationBtn').disabled, true);
  assert.match(page.elements.get('micNotice').textContent, /關閉.*重新/);
});

test('actual STT and provider continuations cannot append or speak over a fresh manual turn', async t => {
  for (const boundary of ['stt', 'provider', 'repair']) await t.test(boundary, async () => {
    const held = gate(); let requests = 0; const chat = [], speech = [];
    const runtime = { kind: 'browser', cancel: async () => {},
      transcribe: () => held.promise, synthesize: async ({ text }) => { speech.push(text); return {}; } };
    const page = ui(runtime, { actualTurns: true, messages: [], DIRECT_API_PROVIDER_ID: 'api',
      localStorage: { getItem: () => null }, getProviderConfig: () => ({ kind: 'api' }),
      getProviderApiKey: () => '', getProviderBaseUrl: () => '', getProviderModel: () => 'model',
      appendChat: (...args) => chat.push(args),
      requestProviderChat: () => {
        requests++;
        if (boundary === 'repair' && requests === 1) return Promise.resolve('中文');
        if (requests === (boundary === 'repair' ? 2 : 1) && boundary !== 'stt') return held.promise;
        return Promise.resolve('Fresh English.');
      },
      playFallbackWebSpeech: async (_text, _token, start) => { start(); return true; },
      window: { VoiceLanguagePolicy: { isEnglishOnlyReply: text => text !== '中文', SAFE_ENGLISH_FALLBACK: 'Safe.', REPAIR_INSTRUCTION: 'English only.' },
        VoiceTtsPreference: { shouldUseModelTts: () => true } },
    });
    const old = page.context.run(boundary === 'stt' ? 'transcribeAudioBlob(new Blob(["old"]))' : 'handleLLMResponse("old")');
    if (boundary !== 'stt') await until(() => requests === (boundary === 'repair' ? 2 : 1));
    await page.click();
    page.elements.set('userTextInput', { value: 'fresh manual' });
    await page.context.run('sendManualText()');
    const before = JSON.stringify({ chat, speech, messages: page.context.messages });
    held.release(boundary === 'stt' ? { text: 'old transcript' } : 'Old English.'); await old;
    assert.equal(JSON.stringify({ chat, speech, messages: page.context.messages }), before);
  });
});

test('actual STT passive fault is visible before releasing the turn', async () => {
  const runtime = { fault: null, cancel: async () => { throw new Error('VOICE_CLEANUP_UNCERTAIN'); },
    async transcribe() { this.fault = new Error('VOICE_CLEANUP_UNCERTAIN'); throw this.fault; } };
  const page = ui(runtime, { actualTurns: true });
  page.context.document.getElementById('conversationBtn');
  await page.context.run('transcribeAudioBlob(new Blob(["fault"]))');
  assert.equal(page.elements.get('conversationBtn').disabled, true);
  assert.match(page.elements.get('micNotice').textContent, /關閉.*重新/);
  await assert.rejects(page.click(), /UNCERTAIN/);
});

// Actual lesson/shadowing entries. DOM/audio/local inference are explicit doubles.
function lessonShadowPage(runtime, extra = {}) {
  const chat = [], states = []; let listening = 0;
  const element = () => ({ textContent: '', innerText: '', innerHTML: '', disabled: false,
    style: {}, children: [], replaceChildren(...items) { this.children = items; this.textContent = ''; },
    appendChild(item) { this.children.push(item); } });
  const page = ui(runtime, { actualLessonShadow: true, actualBrowser: true, actualCapture: true,
    isRunning: false, messages: [{ role: 'assistant', content: 'Hello world!' }],
    lessons: ['a', 'b'].map(id => ({ id, title: 'Lesson ' + id, objectives: ['speak'], opening_line: 'Hello ' + id })),
    ENGLISH_COACH_SYSTEM_PROMPT: 'English coach.', currentMode: 'free', currentLessonId: null,
    switchTab() {}, appendChat: (...args) => chat.push(args), updateCoachUI: state => states.push(state),
    startListeningTurn() { listening++; }, playFallbackWebSpeech: async () => true,
    ...extra });
  for (const id of ['chatBox', 'shadowResultBox']) page.elements.set(id, element());
  page.context.document.createElement = element;
  return { ...page, chat, states, listening: () => listening,
    lesson: id => page.context.run(`startSpecificLesson(${JSON.stringify(id)})`),
    shadow: () => page.context.run('startShadowing()') };
}

test('lesson-shadow lesson joins already pending original Stop before publishing or greeting', async () => {
  const cleanup = gate(); let cancels = 0, synths = 0;
  const page = lessonShadowPage({ kind: 'browser', cancel: () => ++cancels === 1 ? cleanup.promise : Promise.resolve(),
    synthesize: async () => { synths++; return {}; } });
  const stop = page.click();
  assert.equal(page.context.isRunning, false);
  const lesson = page.lesson('a'); await new Promise(setImmediate);
  assert.equal(page.context.currentMode, 'free');
  assert.deepEqual(page.chat, []);
  assert.equal(synths, 0);
  cleanup.release(); await Promise.all([stop, lesson]);
  assert.equal(page.context.currentLessonId, 'a');
  assert.deepEqual(page.chat, [['assistant', 'Hello a']]);
  assert.equal(synths, 1); assert.equal(page.listening(), 1);
});

test('lesson-shadow lesson stale greeting success or failure cannot restart after Stop or competing click', async t => {
  for (const action of ['stop', 'lesson']) for (const outcome of ['success', 'failure']) await t.test(`${action}/${outcome}`, async () => {
    const held = gate(); let entered = false, synths = 0;
    const page = lessonShadowPage({ kind: 'browser', cancel: async () => {},
      synthesize: () => { if (++synths === 1) { entered = true; return held.promise; } return Promise.resolve({}); } });
    const old = page.lesson('a'); await until(() => entered);
    if (action === 'stop') await page.click(); else await page.lesson('b');
    const before = JSON.stringify({ messages: page.context.messages, chat: page.chat, states: page.states,
      lesson: page.context.currentLessonId, running: page.context.isRunning, listening: page.listening() });
    if (outcome === 'failure') held.release(Promise.reject(Error('late synthesis'))); else held.release({});
    await old;
    assert.equal(JSON.stringify({ messages: page.context.messages, chat: page.chat, states: page.states,
      lesson: page.context.currentLessonId, running: page.context.isRunning, listening: page.listening() }), before);
    assert.equal(page.listening(), action === 'stop' ? 0 : 1);
  });
});

test('lesson-shadow competing lessons waiting on cleanup publish only latest and observe failure', async t => {
  for (const failure of [false, true]) await t.test(String(failure), async () => {
    const held = gate(); let cancels = 0;
    const page = lessonShadowPage({ kind: 'browser', cancel: () => ++cancels === 1 ? held.promise : Promise.resolve(), synthesize: async () => ({}) });
    const first = page.lesson('a'), second = page.lesson('b');
    assert.deepEqual(page.chat, []);
    held.release(failure ? Promise.reject(Error('VOICE_CLEANUP_UNCERTAIN')) : undefined);
    await Promise.all([first, second]);
    assert.deepEqual(page.chat, failure ? [] : [['assistant', 'Hello b']]);
    assert.equal(page.listening(), failure ? 0 : 1);
    if (failure) assert.equal(page.elements.get('conversationBtn').disabled, true);
  });
});

function shadowCapturePage(extra = {}) {
  const records = [], timers = new Map(), stopped = []; let requests = 0, transcripts = 0, nextTimer = 1;
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options?.mimeType; this.state = 'inactive'; this.stops = 0; records.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.stops++; this.state = 'inactive'; this.onstop?.(); }
  }
  const stream = label => ({ getTracks: () => [0, 1].map(i => ({ stop() { stopped.push(`${label}/${i}`); } })) });
  const page = lessonShadowPage({ kind: 'browser', cancel: async () => {} }, {
    MediaRecorder: Recorder, navigator: { mediaDevices: { getUserMedia: async () => { requests++; return stream('owned'); } } },
    setTimeout(fn, ms) { if (ms !== 15000) return setTimeout(fn, ms); const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout(id) { if (!timers.delete(id)) clearTimeout(id); }, ...extra });
  page.context.transcribeWithWebAssembly = async () => { transcripts++; return 'hello world'; };
  return { ...page, records, timers, stopped, stream, requests: () => requests, transcripts: () => transcripts };
}

test('lesson-shadow shadow Stop owns held grant and duplicate admission is bounded', async () => {
  const grant = gate(); let requests = 0;
  const page = shadowCapturePage({ navigator: { mediaDevices: { getUserMedia() { requests++; return grant.promise; } } } });
  const old = page.shadow();
  let stopped = false; const stop = page.click().then(() => { stopped = true; });
  await new Promise(setImmediate);
  const observed = stopped;
  const duplicates = Array.from({ length: 12 }, () => page.shadow());
  grant.release(page.stream('late')); await new Promise(setImmediate);
  assert.equal(observed, false, 'Stop joins original permission even while conversation is idle');
  await Promise.all([old, stop, ...duplicates]);
  assert.equal(requests, 1); assert.equal(page.records.length, 0);
  assert.deepEqual(page.stopped, ['late/0', 'late/1']);
  assert.equal(page.transcripts(), 0); assert.equal(page.timers.size, 0);
});

test('lesson-shadow recording Stop closes owned recorder tracks timer and stale events spare fresh capture', async () => {
  const page = shadowCapturePage();
  const old = page.shadow(); await until(() => page.records.length === 1 && page.timers.size === 1);
  const recorder = page.records[0], timer = [...page.timers.values()][0];
  const data = recorder.ondataavailable, ended = recorder.onstop, failed = recorder.onerror;
  const stop = page.click(); await new Promise(setImmediate);
  assert.equal(recorder.state, 'inactive'); assert.equal(recorder.stops, 1);
  assert.equal(page.timers.size, 0); assert.deepEqual(page.stopped, ['owned/0', 'owned/1']);
  await Promise.all([old, stop]); assert.equal(page.transcripts(), 0);
  const fresh = page.shadow(); await until(() => page.records.length === 2);
  const before = page.elements.get('shadowResultBox').textContent;
  data({ data: new Blob(['late']) }); ended(); failed({ error: Error('late recorder') }); timer();
  assert.equal(page.elements.get('shadowResultBox').textContent, before);
  assert.equal(page.records[1].state, 'recording'); assert.equal(page.stopped.length, 2);
  await page.click(); await fresh;
});

test('lesson-shadow healthy original bounded local recording retains mime chunks and scoring', async () => {
  const page = shadowCapturePage(); let blob, owner;
  page.context.transcribeWithWebAssembly = async (value, caller) => { blob = value; owner = caller; return 'hello world'; };
  const running = page.shadow(); await until(() => page.timers.size === 1);
  page.records[0].ondataavailable({ data: new Blob(['first']) });
  page.records[0].ondataavailable({ data: new Blob(['second']) });
  [...page.timers.values()][0](); await running;
  assert.equal(blob.type, 'audio/webm;codecs=opus'); assert.equal(await blob.text(), 'firstsecond');
  assert.ok(owner, 'Whisper receives the original browser owner rather than recapturing it');
  assert.equal(page.elements.get('shadowResultBox').children[0].textContent, '發音匹配評分: 100%');
  assert.equal(page.elements.get('shadowResultBox').children[2].children.length, 2);
  assert.equal(page.timers.size, 0); assert.deepEqual(page.stopped, ['owned/0', 'owned/1']);
  assert.equal(page.context.run('voiceCaptures.size'), 0);
});

test('lesson-shadow held Whisper retains bounded Stop obligation and late score or error cannot touch fresh text UI', async t => {
  for (const outcome of ['success', 'failure']) await t.test(outcome, async () => {
    const inference = gate(); let deadline, entered = false;
    const page = shadowCapturePage({
      setTimeout(fn, ms) { if (ms === 2000) { deadline = fn; return 'drain'; } return setTimeout(fn, ms); },
      clearTimeout(id) { if (id !== 'drain') clearTimeout(id); },
    });
    page.context.transcribeWithWebAssembly = async () => { entered = true; return inference.promise; };
    const old = page.shadow(); await until(() => page.records.length === 1);
    page.records[0].ondataavailable({ data: new Blob(['hello']) }); page.records[0].stop();
    await until(() => entered);
    const stop = page.click(); const rejected = assert.rejects(stop, /VOICE_CAPTURE_CLEANUP_UNCERTAIN/);
    assert.equal(page.context.run('voiceCaptures.size'), 1);
    for (let i = 0; i < 12; i++) await page.shadow();
    assert.equal(page.requests(), 1);
    deadline(); await rejected;
    assert.equal(page.context.run('voiceCaptures.size'), 1, 'deadline cannot pretend held inference drained');
    const box = page.elements.get('shadowResultBox'); box.textContent = 'fresh text UI'; box.replaceChildren = () => { throw Error('STALE_SCORE_PUBLICATION'); };
    page.context.run('beginVoiceTurn("text")');
    const before = JSON.stringify({ text: box.textContent, states: page.states, stopped: page.stopped });
    let scoreNodes = 0; const create = page.context.document.createElement;
    page.context.document.createElement = (...args) => { scoreNodes++; return create(...args); };
    inference.release(outcome === 'success' ? 'hello world' : Promise.reject(Error('late Whisper'))); await old;
    assert.equal(scoreNodes, 0, 'stale Whisper success must not even construct score UI');
    assert.equal(JSON.stringify({ text: box.textContent, states: page.states, stopped: page.stopped }), before);
    assert.equal(page.elements.get('conversationBtn').disabled, true);
    assert.equal(page.context.run('voiceStopFailed'), true);
    assert.equal(page.context.run('voiceCaptures.size'), 0, 'late actual settlement releases only its original slot');
  });
});

test('lesson-shadow recorder and individual track cleanup throws remain isolated and fault sticky', async t => {
  for (const boundary of ['recording', 'late grant']) await t.test(boundary, async () => {
    const grant = gate(); const calls = [];
    const page = shadowCapturePage({ navigator: { mediaDevices: { getUserMedia: () => grant.promise } } });
    const running = page.shadow();
    const stream = { getTracks: () => [{ stop() { calls.push('bad'); throw Error('track'); } }, { stop() { calls.push('good'); } }] };
    if (boundary === 'recording') {
      grant.release(stream); await until(() => page.records.length === 1);
      page.records[0].stop = () => { calls.push('recorder'); throw Error('recorder'); };
    }
    const stop = page.click(); const rejected = assert.rejects(stop, /UNCERTAIN/);
    if (boundary === 'late grant') grant.release(stream);
    await Promise.all([running, rejected]);
    assert.equal(calls.filter(x => x === 'bad').length, 1); assert.equal(calls.filter(x => x === 'good').length, 1);
    if (boundary === 'recording') assert.ok(calls.includes('recorder'));
    assert.equal(page.timers.size, 0); assert.equal(page.context.run('voiceCaptures.size'), 1);
    assert.equal(page.context.run('voiceStopFailed'), true); assert.equal(page.elements.get('conversationBtn').disabled, true);
    await page.shadow(); assert.equal(page.records.length, boundary === 'recording' ? 1 : 0);
  });
});

test('lesson-shadow original lesson UI continuation is fenced after synchronous tab or restart-button Stop', async t => {
  for (const boundary of ['tab', 'restart-button']) await t.test(boundary, async () => {
    const page = lessonShadowPage({ kind: 'browser', cancel: async () => {}, synthesize: async () => ({}) });
    let stop;
    const replace = () => { stop = page.click(); page.context.run('beginVoiceTurn("text")'); page.context.messages = [{ role: 'user', content: 'fresh' }]; };
    if (boundary === 'tab') page.elements.set('tabBtnFree', { classList: { toggle: replace } });
    else page.elements.set('btnIcon', { set textContent(value) { if (value === '⏹') replace(); }, innerText: '' });
    await page.lesson('a'); await stop;
    assert.deepEqual(page.context.messages, [{ role: 'user', content: 'fresh' }]);
    assert.equal(page.listening(), 0); assert.equal(page.context.isRunning, false);
    if (boundary === 'tab') assert.deepEqual(page.chat, []);
  });
});

test('lesson-shadow score DOM Stop cannot publish old score and permission reentry remains single-owner', async () => {
  let page, reentered;
  page = shadowCapturePage({ navigator: { mediaDevices: { getUserMedia() {
    reentered = page.shadow(); return Promise.resolve(page.stream('original'));
  } } } });
  const running = page.shadow(); await until(() => page.records.length === 1); await reentered;
  assert.equal(page.context.run('voiceCaptures.size'), 1);
  let stop, creates = 0; const create = page.context.document.createElement;
  const box = page.elements.get('shadowResultBox');
  page.context.document.createElement = (...args) => {
    if (++creates === 1) { stop = page.click(); box.textContent = 'fresh UI'; }
    return create(...args);
  };
  let publications = 0; box.replaceChildren = () => { publications++; };
  page.records[0].stop(); await running; await stop;
  assert.equal(publications, 0); assert.equal(box.textContent, 'fresh UI');
  assert.equal(page.records.length, 1); assert.deepEqual(page.stopped, ['original/0', 'original/1']);
});

test('lesson-shadow late actual speech rejection is observed without restarting or changing fresh UI', async () => {
  const playback = gate(); let entered = false;
  const page = lessonShadowPage({ kind: 'browser', cancel: async () => {}, synthesize: async () => ({}) }, {
    playFallbackWebSpeech() { entered = true; return playback.promise; },
  });
  const old = page.lesson('a'); await until(() => entered);
  await page.click();
  const before = JSON.stringify({ states: page.states, messages: page.context.messages });
  const observed = assert.doesNotReject(old);
  playback.release(Promise.reject(Error('late actual playback rejection'))); await observed;
  assert.equal(JSON.stringify({ states: page.states, messages: page.context.messages }), before);
  assert.equal(page.listening(), 0); assert.equal(page.context.isRunning, false);
});

test('lesson-shadow healthy lesson greeting reaches actual listening permission and recorder once', async () => {
  const page = shadowCapturePage({ actualTurns: true }); let greetings = 0;
  page.context.voiceRuntime.synthesize = async () => { greetings++; return {}; };
  await page.lesson('a'); await until(() => page.records.length === 1);
  assert.equal(greetings, 1); assert.equal(page.requests(), 1);
  assert.equal(page.context.run('isMediaRecording'), true);
  assert.equal(page.context.run('mediaRecorder'), page.records[0]);
  assert.equal(page.records[0].state, 'recording');
  await page.click(); assert.deepEqual(page.stopped, ['owned/0', 'owned/1']);
});

// Closure UI entry/timer controls; controlled scheduling, not native acceptance.
test('closure scheduled Kokoro retains schedule caller across Stop fresh turn and fault', async t => {
  for (const boundary of ['Stop', 'turn', 'fault', 'healthy']) await t.test(boundary, async () => {
    let callback, imports = 0;
    const runtime = { kind: 'browser', cancel: async () => {} };
    const page = ui(runtime, { actualBrowser: true, actualKokoro: true,
      setTimeout(fn, ms) { if (ms === 17) { callback = fn; return 17; } return setTimeout(fn, ms); },
      clearTimeout(id) { if (id !== 17) clearTimeout(id); },
      browserImport: async () => { imports++; throw Error('controlled unavailable model'); },
      window: { VoiceTtsPreference: require('../apps/web/runtime/tts-preference.js') } });
    let manifests = 0;
    page.context.manifest = async () => { manifests++; return { models: { kokoro: {} } }; };
    page.context.run('loadBrowserModelManifest = manifest; scheduleBrowserKokoroInitialization(17)');
    if (boundary === 'Stop') await page.click();
    if (boundary === 'turn') page.context.run('beginVoiceTurn("voice")');
    if (boundary === 'fault') runtime.fault = Error('known fault');
    const notice = page.context.document.getElementById('micNotice').textContent;
    await callback(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(manifests, boundary === 'healthy' ? 1 : 0, 'stale schedule must not start initialization');
    if (boundary !== 'healthy') {
      assert.equal(imports, 0);
      assert.equal(page.elements.get('micNotice').textContent, notice);
    }
  });
});

test('closure initApp old continuation cannot reset fresh voice UI at local migration factory or capabilities', async t => {
  for (const boundary of ['local', 'migration', 'factory', 'capabilities', 'healthy']) await t.test(boundary, async () => {
    const held = gate(); let entered = false, coach = 0, labels = 0, scheduled = 0, factories = 0;
    const wait = async name => { if (boundary === name) { entered = true; await held.promise; } };
    const runtime = { kind: 'electron', cancel: async () => {}, capabilities: async () => { await wait('capabilities'); return { ready: true, selectedTts: 'kokoro' }; } };
    const page = ui(null, { actualInit: true, isRunning: false,
      initializeLocalFirstWeb: () => wait('local'), removeRetiredOAuthState() {},
      migrateProviderSettingsForEnvironment: () => wait('migration'),
      localStorage: { getItem: () => 'api', setItem() {}, removeItem() {} },
      DIRECT_API_PROVIDER_ID: 'api', PROVIDERS_CONFIG: { api: { baseUrl: 'https://example.invalid' } },
      getProviderBaseUrl: () => 'https://example.invalid', setProviderBaseUrl() {},
      isSelectableProviderState: () => true, getCurrentProviderState: () => 'available', getProviderModel: () => 'model',
      updateHeaderStatusBadge() {}, updateCoachUI() { coach++; }, setTTSEngineStatus() { labels++; },
      scheduleBrowserKokoroInitialization() { scheduled++; },
      createVoiceRuntime: async () => { factories++; await wait('factory'); page.context.voiceRuntime = runtime; return runtime; },
      window: { location: { protocol: 'https:' }, VoiceTtsPreference: { shouldLoadBrowserKokoro: () => false, shouldUseModelTts: () => true } }
    });
    const pending = page.context.initApp();
    if (boundary !== 'healthy') {
      await until(() => entered); await page.click();
      page.context.run('beginVoiceTurn("voice"); isRunning = true');
      const before = { coach, labels, scheduled, factories };
      held.release(); await pending;
      assert.deepEqual({ coach, labels, scheduled, factories }, before, 'old init must not write voice UI or start factory/schedule after original owner is revoked');
    } else { await pending; assert.equal(labels, 1); assert.equal(factories, 1); }
  });
});

// Browser model/codec boundaries are doubles; these run the real HTML callback bodies.
test('browser Blob cancellation closes original context promptly and never starts decode', async () => {
  const bytes = gate(), closed = gate(); let closes = 0, decodes = 0, inferred = 0;
  class Context { close() { closes++; return closed.promise; } decodeAudioData() { decodes++; return { getChannelData: () => new Float32Array(4) }; } }
  const page = ui({ kind: 'browser', cancel: async () => {} }, { actualBrowser: true,
    window: { AudioContext: Context } });
  page.context.pipeline = async () => { inferred++; return { text: 'stale' }; };
  page.context.run('offlineWhisperPipeline = pipeline');
  const op = page.context.transcribeBrowserAudio({ audioBlob: { arrayBuffer: () => bytes.promise } }).catch(e => e);
  let done = false; const stop = page.click().then(() => { done = true; });
  await new Promise(setImmediate);
  const before = { closes, decodes, done };
  closed.release(); bytes.release(new ArrayBuffer(2));
  await stop; const result = await op;
  assert.deepEqual(before, { closes: 1, decodes: 0, done: false });
  assert.equal(closes, 1); assert.equal(decodes, 0); assert.equal(inferred, 0);
  assert.match(result.message, /RUNTIME_CANCELLED/);
});

test('browser Whisper model progress and late init do not revive stopped owner; cache stays reusable', async () => {
  const ready = gate(); let progress, contexts = 0, inferences = 0;
  const page = ui({ kind: 'browser', cancel: async () => {} }, { actualBrowser: true,
    window: { AudioContext: class { constructor() { contexts++; } } } });
  page.context.manifest = async () => ({ models: { whisper: { id: 'pinned', revision: 'a'.repeat(40) } } });
  page.context.module = { env: {}, pipeline(_task, _id, options) { progress = options.progress_callback; return ready.promise; } };
  page.context.run('loadBrowserModelManifest = manifest; transformersModule = module');
  const old = page.context.transcribeBrowserAudio({ audioBlob: {} }).catch(e => e);
  await until(() => progress);
  await page.click();
  const before = page.elements.get('micNotice').innerHTML;
  progress({ status: 'progress', progress: 88 });
  ready.release(async () => { inferences++; return { text: 'warm' }; });
  const result = await old;
  assert.equal(page.elements.get('micNotice').innerHTML, before);
  assert.equal(contexts, 0); assert.equal(inferences, 0);
  assert.match(result.message, /RUNTIME_CANCELLED/);
  assert.equal(page.context.run('typeof offlineWhisperPipeline'), 'function', 'already-started shared model load may settle into cache, not force-aborted');
});

test('browser Kokoro stopped manifest continuation cannot import or start a new model', async () => {
  const manifest = gate(); let imports = 0;
  const page = ui({ kind: 'browser', cancel: async () => {} }, { actualBrowser: true, actualKokoro: true,
    browserImport() { imports++; return Promise.reject(Error('no host model')); },
    window: { VoiceTtsPreference: require('../apps/web/runtime/tts-preference.js') } });
  page.context.manifest = () => manifest.promise;
  page.context.run('loadBrowserModelManifest = manifest');
  const old = page.context.initKokoroTTS();
  await page.click(); const notice = page.elements.get('micNotice').textContent;
  manifest.release({ models: { kokoro: { id: 'pinned', revision: 'a'.repeat(40) } } });
  await old;
  assert.equal(imports, 0);
  assert.equal(page.elements.get('micNotice').textContent, notice);
  assert.equal(page.context.run('kokoroInitTimer'), null);
});

test('browser Kokoro late generate cannot convert Blob, update UI or enter fallback', async t => {
  for (const rejected of [false, true]) await t.test(String(rejected), async () => {
    const generated = gate(); let blobs = 0, inits = 0;
    const page = ui({ kind: 'browser', cancel: async () => {} }, { actualBrowser: true,
      browserKokoroUsable: true, kokoroTTSInstance: { generate: () => generated.promise },
      logKokoroStep() {}, initKokoroTTS() { inits++; }, window: {} });
    const old = page.context.synthesizeBrowserSpeech({ text: 'old' }).catch(e => e);
    await page.click(); const notice = page.elements.get('micNotice').textContent;
    generated.release(rejected ? Promise.reject(Error('generation')) : { toBlob() { blobs++; return new Blob(['audio']); } });
    const result = await old;
    assert.match(result.message, /RUNTIME_CANCELLED/);
    assert.equal(blobs, 0); assert.equal(inits, 0);
    assert.equal(page.elements.get('micNotice').textContent, notice);
  });
});

function browserModelPage(extra = {}) {
  const tensors = class { constructor(type, data, dims) { this.data = data; this.dims = dims; } };
  const events = []; const controls = { model: async () => ({ waveform: { data: new Float32Array([0, 0.1]) } }),
    features: async () => new Float32Array(256 * 4).buffer,
    phonemes: async () => 'hello', pretrained: async instance => instance };
  const instance = { tokenizer() { events.push('tokenizer'); return { input_ids: new tensors('int64', [], [1, 3]) }; },
    model: (...args) => { events.push('model'); return controls.model(...args); } };
  const page = ui({ kind: 'browser', cancel: async () => {} }, { actualBrowser: true, actualKokoro: true,
    performance, localStorage: { getItem: () => null }, PERSONAS: { af_heart: {}, af_other: {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout,
    fetch: async () => ({ ok: true, blob: async () => new Blob(['feature']), arrayBuffer: () => controls.features() }),
    browserImport: async () => ({ configureKokoroRevision() {}, phonemizeForKokoro: (...args) => { events.push('phonemes'); return controls.phonemes(...args); },
      KokoroTTS: { from_pretrained: async () => { events.push('pretrained'); return controls.pretrained(instance); } } }),
    window: { VoiceTtsPreference: require('../apps/web/runtime/tts-preference.js') }, ...extra });
  page.context.manifest = async () => ({ models: { kokoro: { id: 'pinned', revision: 'a'.repeat(40) } } });
  page.context.run('loadBrowserModelManifest = manifest');
  return { page, controls, events, instance };
}

function schedulerModelPage(extra = {}) {
  const timers = new Map(); let next = 0;
  const h = browserModelPage({ console: cycle1Quiet,
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), ...extra });
  return { ...h, timers, fire() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); return timer.fn();
  } };
}

for (const terminal of ['success', 'error']) test('v3 D2 active A terminal hands due B its own load ' + terminal, async () => {
  const h = schedulerModelPage(), held = gate(); let loads = 0;
  h.controls.pretrained = instance => ++loads === 1 ? held.promise : Promise.resolve(instance);
  const a = h.page.context.initKokoroTTS();
  await until(() => loads === 1);
  h.page.context.scheduleBrowserKokoroInitialization(0);
  await h.fire();
  assert.equal(loads, 1, 'due B must not start parallel model load');
  held.release(terminal === 'error' ? Promise.reject(Error('MEMORY_A_FAILURE')) : h.instance);
  await a; await cycle1Tick();
  assert.equal(loads, 2, 'A terminal must hand off the retained B, not lose B or retry A');
  await until(() => h.page.context.run('isKokoroLoading') === false);
  assert.equal(h.page.context.run('kokoroTTSInstance'), h.instance);
  assert.equal(h.page.context.run('browserKokoroUsable'), true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.events.filter(x => x === 'phonemes').length, 1, 'only current B warms up');
});

test('v3 D2 explicit speech while A loads admits pending caller without waiting or fallback', async () => {
  const h = schedulerModelPage(), held = gate(); let loads = 0;
  h.controls.pretrained = instance => ++loads === 1 ? held.promise : Promise.resolve(instance);
  const a = h.page.context.initKokoroTTS(); await until(() => loads === 1);
  const oldGeneration = h.page.context.run('activeKokoroLoad.generation');
  const speech = await h.page.context.synthesizeBrowserSpeech({ text: 'Explicit speech' });
  assert.equal(speech.useSystemSpeech, true, 'retain the existing System speech return without waiting for model');
  assert.equal(speech.backend, 'system-speech');
  const b = h.page.context.run('pendingKokoroInit');
  assert.ok(b, 'explicit speech must register its original caller despite active loading');
  assert.notEqual(b.generation, oldGeneration);
  assert.equal(b.state, 'WAITING_LOAD');
  assert.equal(loads, 1);
  held.release(h.instance); await a; await cycle1Tick();
  assert.equal(loads, 2); assert.equal(h.page.context.run('browserKokoroUsable'), true);
});

test('v3 D2 stale direct init cannot cancel the current pending generation', async () => {
  const h = schedulerModelPage();
  const stale = h.page.context.browserVoiceOwner();
  await h.page.click();
  h.page.context.scheduleBrowserKokoroInitialization(3000);
  const b = h.page.context.run('pendingKokoroInit');
  await h.page.context.initKokoroTTS(undefined, stale);
  assert.equal(h.page.context.run('pendingKokoroInit'), b);
  assert.equal(h.page.context.run('kokoroModeEpoch.isCurrent(pendingKokoroInit.generation)'), true,
    'rejected stale direct entry cannot mint a generation that revokes B');
  await h.fire();
  assert.equal(h.page.context.run('browserKokoroUsable'), true);
});

for (const route of ['healthy', 'Start-denied']) test('v3 D2 startup retains original authority and 3000ms delay ' + route, async () => {
  const held = gate();
  const h = schedulerModelPage({ actualInit: true, isRunning: false,
    initializeLocalFirstWeb: () => held.promise, removeRetiredOAuthState() {}, migrateProviderSettingsForEnvironment: async () => {},
    localStorage: { getItem: () => 'api', setItem() {}, removeItem() {} }, DIRECT_API_PROVIDER_ID: 'api',
    PROVIDERS_CONFIG: { api: { baseUrl: 'https://example.invalid' } }, getProviderBaseUrl: () => 'https://example.invalid',
    setProviderBaseUrl() {}, isSelectableProviderState: () => true, getCurrentProviderState: () => 'available', getProviderModel: () => 'model',
    updateHeaderStatusBadge() {}, navigator: { mediaDevices: { getUserMedia: async () => { throw Error('MEMORY_DENIED'); } } }
  });
  h.page.context.window.location = { protocol: 'http:' };
  h.page.context.createVoiceRuntime = async () => h.page.context.voiceRuntime;
  const originalAuthority = h.page.context.run('uiVoiceAuthority');
  const app = h.page.context.initApp();
  if (route === 'Start-denied') await h.page.toggle();
  held.release(); await app;
  assert.equal(h.timers.size, route === 'healthy' ? 1 : 0, 'old app init must not capture newer V after failed Start');
  if (route === 'healthy') {
    assert.equal([...h.timers.values()][0].ms, 3000);
    assert.equal(h.page.context.run('pendingKokoroInit.owner.authority'), originalAuthority);
    assert.equal(h.page.context.run('pendingKokoroInit.owner.sourceCurrent'), undefined, 'startup does not invent settings context');
    await h.fire(); assert.equal(h.page.context.run('browserKokoroUsable'), true);
  }
});

test('v3 D2 timer cleanup reentry keeps newer C instead of outer B', async () => {
  const h = schedulerModelPage();
  h.page.context.scheduleBrowserKokoroInitialization(3000);
  let c, entered = false;
  h.page.context.clearTimeout = id => {
    h.timers.delete(id);
    if (entered) return; entered = true;
    h.page.context.scheduleBrowserKokoroInitialization(2169);
    c = h.page.context.run('pendingKokoroInit');
  };
  h.page.context.scheduleBrowserKokoroInitialization(0);
  assert.equal(h.page.context.run('pendingKokoroInit'), c, 'clear old timer must not let outer B replace reentrant C');
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 2169);
  await h.fire(); assert.equal(h.page.context.run('browserKokoroUsable'), true);
});

for (const terminal of ['success', 'error']) test('v3 D2 A early terminal preserves B WAITING_TIMER delay ' + terminal, async () => {
  const h = schedulerModelPage(), held = gate(); let loads = 0;
  h.controls.pretrained = instance => ++loads === 1 ? held.promise : Promise.resolve(instance);
  const a = h.page.context.initKokoroTTS(); await until(() => loads === 1);
  h.page.context.scheduleBrowserKokoroInitialization(3000);
  const b = h.page.context.run('pendingKokoroInit'), timer = h.page.context.run('kokoroInitTimer');
  held.release(terminal === 'error' ? Promise.reject(Error('MEMORY_A')) : h.instance); await a;
  assert.equal(loads, 1); assert.equal(h.page.context.run('activeKokoroLoad'), null);
  assert.equal(h.page.context.run('pendingKokoroInit'), b); assert.equal(b.state, 'WAITING_TIMER');
  assert.equal(h.page.context.run('kokoroInitTimer'), timer); assert.equal(h.timers.size, 1);
  assert.equal(h.page.context.run('kokoroTTSInstance'), null, 'stale A must not publish');
  const callback = [...h.timers.values()][0].fn;
  await h.fire(); await callback();
  assert.equal(loads, 2); assert.equal(h.page.context.run('browserKokoroUsable'), true);
  assert.equal(h.page.context.run('pendingKokoroInit'), null); assert.equal(h.timers.size, 0);
});

for (const route of ['Stop', 'cancel', 'C', 'C-delayed']) test('v3 D2 due B cancellation or C supersession remains bounded ' + route, async () => {
  const h = schedulerModelPage(), first = gate(), second = gate(); let loads = 0;
  h.controls.pretrained = () => ++loads === 1 ? first.promise : second.promise;
  const a = h.page.context.initKokoroTTS(); await until(() => loads === 1);
  const active = h.page.context.run('activeKokoroLoad');
  h.page.context.scheduleBrowserKokoroInitialization(0);
  const obsoleteTimer = [...h.timers.values()][0].fn;
  await h.fire(); const b = h.page.context.run('pendingKokoroInit');
  assert.equal(b.state, 'WAITING_LOAD'); assert.equal(h.page.context.run('activeKokoroLoad'), active);
  if (route === 'Stop') await h.page.click();
  else if (route === 'cancel') h.page.context.cancelPendingKokoroInitialization();
  else h.page.context.scheduleBrowserKokoroInitialization(route === 'C' ? 0 : 3000);
  const c = h.page.context.run('pendingKokoroInit'), timer = h.page.context.run('kokoroInitTimer');
  await obsoleteTimer();
  assert.equal(h.page.context.run('pendingKokoroInit'), c); assert.equal(h.page.context.run('kokoroInitTimer'), timer);
  if (route === 'C') await h.fire();
  first.release(h.instance); await a; await cycle1Tick();
  if (route === 'C-delayed') { assert.equal(loads, 1); h.fire(); }
  if (route.startsWith('C')) {
    await until(() => loads === 2);
    const current = h.page.context.run('activeKokoroLoad');
    assert.equal(current.owner, c.owner); assert.equal(current.generation, c.generation);
    assert.notEqual(current.owner, b.owner); assert.equal(h.page.context.run('isKokoroLoading'), true);
    second.release(h.instance); await current.promise;
    assert.equal(h.page.context.run('browserKokoroUsable'), true);
  } else { assert.equal(loads, 1); assert.equal(h.page.context.run('kokoroTTSInstance'), null); }
  assert.equal(h.page.context.run('activeKokoroLoad'), null); assert.equal(h.page.context.run('pendingKokoroInit'), null);
  assert.equal(h.page.context.run('kokoroWarmupPromise'), null); assert.equal(h.timers.size, 0);
});

test('v3 D2 canceled active warmup retains its promise until terminal and does not claim download abort', async () => {
  const h = schedulerModelPage(), held = gate();
  h.controls.phonemes = () => held.promise;
  const a = h.page.context.initKokoroTTS(); await until(() => h.events.includes('phonemes'));
  const active = h.page.context.run('activeKokoroLoad'), warmup = h.page.context.run('kokoroWarmupPromise');
  assert.ok(warmup);
  h.page.context.cancelPendingKokoroInitialization();
  assert.equal(h.page.context.run('activeKokoroLoad'), active);
  assert.equal(h.page.context.run('kokoroWarmupPromise'), warmup); assert.equal(h.page.context.run('isKokoroLoading'), true);
  h.page.context.scheduleBrowserKokoroInitialization(0); await h.fire();
  assert.equal(h.events.filter(x => x === 'pretrained').length, 1, 'never terminal A means B waits, not another deadline/load');
  assert.equal(h.page.context.run('pendingKokoroInit.state'), 'WAITING_LOAD');
  h.controls.phonemes = async () => 'hello'; held.release('old'); await a; await cycle1Tick();
  assert.equal(h.events.filter(x => x === 'pretrained').length, 2);
  assert.equal(h.page.context.run('browserKokoroUsable'), true); assert.equal(h.timers.size, 0);
});

test('v3 D2 ordinary load failure does not retry until a new direct caller', async () => {
  const h = schedulerModelPage(); let loads = 0;
  h.controls.pretrained = async instance => { if (++loads === 1) throw Error('MEMORY_FAILURE'); return instance; };
  await h.page.context.initKokoroTTS(); await cycle1Tick();
  assert.equal(loads, 1); assert.equal(h.timers.size, 0);
  assert.equal(h.page.context.run('activeKokoroLoad'), null); assert.equal(h.page.context.run('pendingKokoroInit'), null);
  assert.equal(h.page.context.run('browserKokoroUsable'), false);
  await h.page.context.initKokoroTTS();
  assert.equal(loads, 2); assert.equal(h.page.context.run('browserKokoroUsable'), true);
});

for (const stage of ['timer', 'active']) for (const revoke of ['reopen', 'edit', 'Test']) test('v3 D2 original Save binding survives throughout ' + stage + '/' + revoke, async () => {
  const page = await v3SettingsPage(), held = gate(); let manifests = 0;
  page.context.loadBrowserModelManifest = () => { manifests++; return held.promise; };
  page.elements.ttsModeSelect.value = 'kokoro';
  assert.equal(await page.api.saveSettings(), true);
  const b = page.run('pendingKokoroInit'); assert.equal(typeof b.owner.sourceCurrent, 'function');
  const timer = [...page.timers.values()].find(x => x.ms === 0);
  let load;
  if (stage === 'active') { load = timer.fn(); await until(() => manifests === 1); }
  if (revoke === 'reopen') await page.api.openSettingsModal();
  else if (revoke === 'edit') page.dispatch('apiKey', 'input');
  else page.run('beginSettingsAction("TEST", document.getElementById("providerSelect").value)');
  const notice = page.elements.micNotice.textContent;
  held.release({ models: { kokoro: {} } });
  if (load) await load; else await timer.fn();
  const revoked = revoke === 'reopen';
  assert.equal(manifests, stage === 'active' || !revoked ? 1 : 0);
  assert.equal(page.imports(), revoked ? 0 : 1, 'hidden-session edit/Test are no-ops; reopen revokes S');
  if (revoked) assert.equal(page.elements.micNotice.textContent, notice);
  assert.equal(page.run('kokoroTTSInstance'), null); assert.equal(page.run('activeKokoroLoad'), null);
});

test('vertical-close initApp synchronous coach and file DOM boundaries', async t => {
  for (const boundary of ['coach', 'file-dom', 'healthy']) await t.test(boundary, async () => {
    let page, stopped, factories = 0, labels = 0, staleNotice = 0;
    const runtime = { kind: 'electron', cancel: async () => {}, capabilities: async () => ({ ready: true, selectedTts: 'kokoro' }) };
    page = ui(runtime, { actualInit: true, isRunning: false,
      initializeLocalFirstWeb: async () => {}, removeRetiredOAuthState() {}, migrateProviderSettingsForEnvironment: async () => {},
      localStorage: { getItem: () => 'api', setItem() {}, removeItem() {} }, DIRECT_API_PROVIDER_ID: 'api',
      PROVIDERS_CONFIG: { api: { baseUrl: 'https://example.invalid' } }, getProviderBaseUrl: () => 'https://example.invalid',
      setProviderBaseUrl() {}, isSelectableProviderState: () => true, getCurrentProviderState: () => 'available', getProviderModel: () => 'model',
      updateHeaderStatusBadge() {}, updateCoachUI() { if (boundary === 'coach' && !stopped) stopped = page.click(); },
      setTTSEngineStatus() { labels++; }, createVoiceRuntime: async () => { factories++; return runtime; },
      window: { location: { protocol: 'file:' }, VoiceTtsPreference: { shouldLoadBrowserKokoro: () => false, shouldUseModelTts: () => true } }
    });
    const document = page.context.document, get = document.getElementById.bind(document);
    let firing = false;
    document.getElementById = id => {
      const element = get(id);
      if (id === 'micNotice' && boundary === 'file-dom' && !firing) {
        firing = true; stopped = page.click();
        let text = element.textContent;
        Object.defineProperty(element, 'textContent', { get: () => text, set(value) {
          text = value; if (String(value).includes('本地檔案')) staleNotice++;
        } });
      }
      return element;
    };
    await page.context.initApp(); if (stopped) await stopped;
    assert.equal(staleNotice, 0, 'lookup reentry must not write the old file notice');
    assert.equal(factories, boundary === 'coach' ? 0 : 1);
    assert.equal(labels, boundary === 'healthy' ? 1 : 0);
  });
});

test('vertical-close Kokoro finite synchronous UI model and publication reentry', async t => {
  const boundaries = ['initial-status', 'module-log', 'debug-dom', 'notice', 'manifest', 'import', 'pretrained', 'pretrained-log', 'feature-log', 'warm-status',
    'tokenizer-log', 'tokenizer', 'Tensor', 'forward-log', 'model', 'publication-log', 'classify', 'ready-status', 'direct-tokenizer'];
  for (const boundary of boundaries) await t.test(boundary, async () => {
    let h, armed = boundary !== 'direct-tokenizer', stopped, atStop;
    const trace = [];
    const hit = name => {
      trace.push(name);
      if (armed && !stopped && name === boundary) {
        stopped = h.page.click(); atStop = trace.length;
      }
    };
    h = browserModelPage({ console: {
      log(msg) {
        const name = msg.includes('[Kokoro] 1/4 ') ? 'module-log' : msg.includes('[Kokoro] 2/4 ') ? 'pretrained-log'
          : msg.includes('3.1/4 ') ? 'feature-log' : msg.includes('測試 Tokenizer') ? 'tokenizer-log'
          : msg.includes('Tokenizer 耗時') ? 'forward-log' : msg.includes('4/4 暖機') ? 'publication-log' : 'other-log';
        hit(name);
      }, warn() { hit('warning'); }, error() { hit('error'); }
    }, setTTSEngineStatus(label) { hit(label.includes('下載中') ? 'initial-status' : label.includes('暖機中') ? 'warm-status' : 'ready-status'); } });
    const document = h.page.context.document, get = document.getElementById.bind(document);
    document.getElementById = id => {
      const element = get(id);
      if (!element.instrumented) {
        element.instrumented = true; let text = element.textContent;
        Object.defineProperty(element, 'textContent', { get: () => text, set(value) {
          text = value;
          if (String(value).includes('正在快取 Kokoro')) hit('notice');
          else if (id === 'kokoroDebugLog') hit('debug-dom');
          else if (String(value).includes('Kokoro')) hit('voice-dom');
        } });
      }
      return element;
    };
    const manifest = h.page.context.manifest;
    h.page.context.manifest = () => { hit('manifest'); return manifest(); };
    h.page.context.run('loadBrowserModelManifest = manifest');
    const imported = h.page.context.browserImport;
    h.page.context.browserImport = () => { hit('import'); return imported(); };
    const pretrained = h.controls.pretrained, model = h.controls.model;
    h.controls.pretrained = instance => { hit('pretrained'); return pretrained(instance); };
    h.controls.model = (...args) => { hit('model'); return model(...args); };
    class Tensor { constructor(type, data, dims) { this.data = data; this.dims = dims; hit('Tensor'); } }
    h.instance.tokenizer = () => {
      hit(armed && boundary === 'direct-tokenizer' ? 'direct-tokenizer' : 'tokenizer');
      return { input_ids: { constructor: Tensor, dims: [1, 3] } };
    };
    const preference = h.page.context.window.VoiceTtsPreference;
    h.page.context.window.VoiceTtsPreference = { ...preference, classifySuccessfulKokoroWarmup(ms) {
      hit('classify'); return preference.classifySuccessfulKokoroWarmup(ms);
    } };
    if (boundary === 'direct-tokenizer') {
      await h.page.context.initKokoroTTS(); assert.equal(h.page.context.run('browserKokoroUsable'), true);
      armed = true; trace.length = 0;
      await h.page.context.synthesizeBrowserSpeech({ text: 'fresh direct' }).catch(e => e);
    } else await h.page.context.initKokoroTTS();
    assert.ok(stopped, 'must actually exercise the selected synchronous boundary');
    await stopped;
    assert.deepEqual(trace.slice(atStop), [], 'no subsequent UI, manifest/import, tokenizer/Tensor/model or publication callback after original Stop');
    assert.equal(h.page.context.run('isKokoroLoading'), false);
    if (!['publication-log', 'ready-status', 'direct-tokenizer'].includes(boundary)) {
      assert.equal(h.page.context.run('kokoroTTSInstance'), null, 'revoked initialization cannot publish model');
    }
  });
});

test('closure successful Kokoro warmup leaves no orphan 90s rejection timer', async () => {
  const pending = new Map(); let next = 1;
  const h = browserModelPage({
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); }
  });
  await h.page.context.initKokoroTTS();
  assert.equal(h.page.context.run('browserKokoroUsable'), true);
  assert.deepEqual([...pending.values()].map(timer => timer.ms), [],
    'successful warmup must not leave the unused WARMUP_TIMEOUT rejection scheduled');
});

test('browser Kokoro actual init and direct generation fence original continuation boundaries', async t => {
  for (const boundary of ['pretrained', 'warm-forward', 'voice-features', 'phonemes']) await t.test(boundary, async () => {
    const h = browserModelPage(), held = gate(); let entered = false;
    if (boundary === 'pretrained') h.controls.pretrained = async instance => { entered = true; await held.promise; return instance; };
    if (boundary === 'warm-forward') h.controls.model = async () => { entered = true; await held.promise; return { waveform: { data: new Float32Array(2) } }; };
    if (boundary === 'voice-features' || boundary === 'phonemes') {
      await h.page.context.initKokoroTTS();
      assert.equal(h.page.context.run('browserKokoroUsable'), true, 'real warmup body must complete before held synthesis');
      if (boundary === 'voice-features') h.controls.features = async () => { entered = true; await held.promise; return new Float32Array(1024).buffer; };
      else h.controls.phonemes = async () => { entered = true; await held.promise; return 'hello'; };
    }
    const old = (boundary.startsWith('voice') || boundary === 'phonemes'
      ? h.page.context.synthesizeBrowserSpeech({ text: 'hello', voice: 'af_other' }) : h.page.context.initKokoroTTS()).catch(e => e);
    await until(() => entered); await h.page.click();
    const before = h.events.slice(), notice = h.page.elements.get('micNotice').textContent;
    held.release(); await old;
    assert.deepEqual(h.events, before, 'no new tokenizer, phonemizer or model work after Stop');
    assert.equal(h.page.elements.get('micNotice').textContent, notice);
  });
});

test('browser finite codec cancellation errors close deadline reentry and positive controls', async t => {
  for (const route of ['decode-abort', 'pipeline-abort', 'decode-error', 'close-reject', 'constructor-reentry', 'close-reentry', 'close-deadline', 'positive']) await t.test(route, async () => {
    const held = gate(), controller = new AbortController(); let page, closes = 0, calls = 0, stop, deadline;
    const decoded = { getChannelData: () => new Float32Array([0, 0.1]) };
    class Context {
      constructor() { if (route === 'constructor-reentry') stop = page.click(); }
      decodeAudioData() {
        if (route === 'decode-error') throw Error('codec failure');
        return route === 'decode-abort' ? held.promise : decoded;
      }
      close() {
        closes++;
        if (route === 'close-reentry') stop = page.click();
        if (route === 'close-reject') throw Error('cannot close');
        return route === 'close-deadline' ? held.promise : Promise.resolve();
      }
    }
    page = ui({ kind: 'browser', cancel: async () => {} }, { actualBrowser: true, window: { AudioContext: Context },
      setTimeout: (fn, ms) => { if (route === 'close-deadline' && ms === 2000) { deadline = fn; return 0; } return setTimeout(fn, ms); } });
    page.context.pipeline = async () => { calls++; return route === 'pipeline-abort' ? held.promise : { text: ' Ready. ' }; };
    page.context.run('offlineWhisperPipeline = pipeline');
    const operation = page.context.transcribeBrowserAudio({ audioBlob: new Blob(['data']), signal: controller.signal }).catch(e => e);
    await new Promise(setImmediate);
    if (route.endsWith('abort')) {
      controller.abort(); held.release(route === 'decode-abort' ? decoded : { text: 'old' });
    }
    if (route === 'close-deadline') {
      stop = page.click(); const rejected = assert.rejects(stop, /UNCERTAIN/);
      deadline(); await rejected; held.release();
    }
    const result = await operation;
    if (stop && route !== 'close-deadline') await stop;
    assert.equal(closes, 1, 'original AudioContext closes exactly once across abort/finally/reentry');
    if (route === 'positive') { assert.equal(result.text, 'Ready.'); assert.equal(calls, 1); }
    else if (route === 'decode-error') { assert.equal(result.localUnavailable, true); assert.equal(calls, 0); }
    else if (route === 'close-reject') {
      assert.equal(result.code, 'VOICE_AUDIO_CLEANUP_FAILED');
      assert.equal(page.context.run('voiceCaptures.size'), 1, 'failed original close stays retained');
      await assert.rejects(page.click(), /UNCERTAIN/);
    } else assert.match(result.message, /RUNTIME_CANCELLED/);
    if (route === 'close-deadline' || route === 'close-reject') {
      assert.equal(page.context.run('voiceStopFailed'), true);
      assert.equal(page.elements.get('conversationBtn').disabled, true);
    }
  });
});

test('browser healthy Kokoro cache survives Stop and new owner produces an actual WAV Blob; ordinary failure still falls back', async () => {
  const { page, controls, events } = browserModelPage();
  await page.context.initKokoroTTS();
  const original = page.context.run('kokoroTTSInstance');
  await page.click();
  const result = await page.context.synthesizeBrowserSpeech({ text: 'fresh' });
  assert.equal(result.backend, 'browser-kokoro');
  const bytes = Buffer.from(await result.blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF'); assert.ok(bytes.length > 44);
  assert.equal(page.context.run('kokoroTTSInstance'), original);
  assert.equal(events.filter(e => e === 'pretrained').length, 1);
  controls.phonemes = async () => { throw Error('ordinary phonemizer failure'); };
  assert.equal((await page.context.synthesizeBrowserSpeech({ text: 'fallback' })).useSystemSpeech, true);
});

test('browser synthesis original playback owner cannot continue after same-turn replacement', async () => {
  const generated = gate(); let blobs = 0;
  const page = ui({ kind: 'browser', cancel: async () => {} }, { actualBrowser: true,
    browserKokoroUsable: true, kokoroTTSInstance: { generate: () => generated.promise }, logKokoroStep() {}, window: {} });
  const old = page.context.synthesizeBrowserSpeech({ text: 'old' }).catch(e => e);
  page.context.stopCurrentVoicePlayback();
  generated.release({ toBlob() { blobs++; return new Blob(['audio']); } });
  const result = await old;
  assert.equal(blobs, 0);
  assert.match(result.message, /RUNTIME_CANCELLED/);
});

// Actual HTML handlers; DOM/Audio/speech/factory/provider boundaries below are doubles.
test('owner probe throwing first track still releases all original tracks and remains sticky', async () => {
  const grant = gate(); let tracks = 0;
  const page = ui({ cancel: async () => {} }, { isRunning: false,
    navigator: { mediaDevices: { getUserMedia: () => grant.promise } } });
  const probe = page.toggle(), stop = page.click();
  grant.release({ getTracks: () => [{ stop() { tracks++; throw Error('track'); } }, { stop() { tracks++; } }] });
  await probe; await assert.rejects(stop, /UNCERTAIN/);
  assert.equal(tracks, 2); await page.toggle();
  assert.equal(page.context.run('voiceStopFailed'), true);
});

test('owner speech late cancel rejection cannot stop a different original runtime/turn', async () => {
  let reject; const held = new Promise((_, r) => { reject = r; }); let freshCancels = 0;
  const page = ui({ cancel: () => held });
  const old = page.speak('old');
  // Runtime replacement boundary double; real publication transitions tested separately.
  page.context.voiceRuntime = { cancel() { freshCancels++; } };
  page.context.run('beginVoiceTurn("text")');
  reject(Error('old cancellation failure')); await old;
  assert.equal(freshCancels, 0);
  assert.equal(page.context.isRunning, true);
});

test('owner speech original runtime gates late synthesis failure and completion', async t => {
  for (const failure of [false, true]) await t.test(String(failure), async () => {
    const held = gate(); let reject; let fallback = 0, freshCancels = 0;
    const pending = new Promise((resolve, r) => { reject = r; held.promise.then(resolve); });
    const runtime = { kind: 'electron', cancel: async () => {}, synthesize: () => pending };
    const page = ui(runtime, { playFallbackWebSpeech() { fallback++; return true; } });
    const old = page.speak('old'); await new Promise(setImmediate);
    page.context.voiceRuntime = { cancel() { freshCancels++; } };
    page.context.run('beginVoiceTurn("text")');
    if (failure) { runtime.fault = Error('old fault'); reject(runtime.fault); }
    else held.release({});
    await old;
    assert.equal(fallback, 0); assert.equal(freshCancels, 0);
  });
});

test('owner speech synchronous cancellation errors are observed and lock voice', async () => {
  const page = ui({ cancel() { throw Error('sync cleanup'); } });
  assert.equal(await page.speak('hello'), false);
  assert.equal(page.context.run('voiceStopFailed'), true);
});

test('owner manual text joins active capture grant before provider and still works after voice fault', async t => {
  for (const fault of [false, true]) await t.test(String(fault), async () => {
    const grant = gate(); let requests = 0, tracks = 0; const chat = [];
    const runtime = { kind: 'browser', cancel: async () => {}, synthesize: async () => ({}) };
    const page = ui(runtime, { actualCapture: true, actualTurns: true, messages: [], DIRECT_API_PROVIDER_ID: 'api',
      navigator: { mediaDevices: { getUserMedia: () => grant.promise } },
      localStorage: { getItem: () => null }, getProviderConfig: () => ({ kind: 'api' }),
      getProviderApiKey: () => '', getProviderBaseUrl: () => '', getProviderModel: () => 'model',
      requestProviderChat: async () => { requests++; return 'Text still works.'; }, appendChat: (...args) => chat.push(args),
      playFallbackWebSpeech: async (_text, _token, start) => { start(); return true; },
      window: { VoiceLanguagePolicy: { isEnglishOnlyReply: () => true }, VoiceTtsPreference: { shouldUseModelTts: () => true } } });
    const capture = page.context.run('startMediaRecording()');
    page.elements.set('userTextInput', { value: 'manual' });
    const manual = page.context.run('sendManualText()'); await new Promise(setImmediate);
    const before = requests;
    grant.release({ getTracks: () => [{ stop() { tracks++; if (fault) throw Error('track failure'); } }] });
    await Promise.all([capture, manual]);
    assert.equal(before, 0, 'provider cannot overlap unsettled capture ownership');
    assert.equal(tracks, 1); assert.equal(requests, 1);
    assert.equal(chat.at(-1)[1], 'Text still works.');
    assert.equal(page.context.isRunning, false);
    assert.equal(page.context.run('voiceStopFailed'), fault);
  });
});

test('owner actual Audio late play rejection and callbacks cannot write over fresh playback', async () => {
  const audios = [], events = []; let rejectOld;
  class Audio {
    constructor() { audios.push(this); }
    play() { return audios.length === 1 ? new Promise((_, r) => { rejectOld = r; }) : Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  }
  const page = ui({ kind: 'electron', cancel: async () => {}, synthesize: async () => ({ audio: 'wav' }) }, {
    isRunning: false, actualPlayback: true, Audio, logKokoroStep: text => events.push(text),
    updateCoachUI: state => events.push(state), window: { VoiceTtsPreference: { shouldUseModelTts: () => true } } });
  const old = page.speak('old'); await until(() => audios.length === 1);
  await page.click(); await old;
  const fresh = page.speak('fresh'); await until(() => audios.length === 2);
  const before = events.slice(); rejectOld(Error('late play reject')); audios[0].onerror(Error('late error'));
  audios[0].onplay(); audios[0].onended(); await new Promise(setImmediate);
  assert.deepEqual(events, before);
  assert.equal(page.context.run('currentAudioObj'), audios[1]);
  audios[1].onplay(); audios[1].onended(); assert.equal(await fresh, true);
});

test('owner factory replacement joins old cancel/dispose and one competing publication', async () => {
  const cancel = gate(), dispose = gate(); let cancels = 0, disposes = 0, factories = 0;
  const old = { cancel() { cancels++; return cancel.promise; }, dispose() { disposes++; return dispose.promise; } };
  const next = { cancel: async () => {}, dispose: async () => {} };
  const page = ui(old, { actualFactory: true, window: { VoiceRuntimeFactory: { createRuntime: async () => { factories++; return next; } } } });
  const a = page.context.run('createVoiceRuntime()'), b = page.context.run('createVoiceRuntime()');
  await new Promise(setImmediate);
  assert.equal(factories, 0); assert.equal(page.context.voiceRuntime, old); assert.equal(cancels, 1);
  cancel.release(); await until(() => disposes === 1); assert.equal(factories, 0);
  assert.equal(page.elements.get('conversationBtn').disabled, true, 'publication cleanup is not healthy Stop completion');
  dispose.release(); assert.equal(await a, next); assert.equal(await b, next);
  assert.equal(factories, 1); assert.equal(page.context.voiceRuntime, next);
});

test('owner pending initial factory Stop discards only its late result and keeps initial-start semantics', async t => {
  for (const stopped of [false, true]) await t.test(String(stopped), async () => {
    const factory = gate(); let factories = 0, disposes = 0, foreignStops = 0;
    const next = { dispose: async () => { disposes++; } };
    const page = ui(null, { actualFactory: true, window: { VoiceRuntimeFactory: { createRuntime: () => { factories++; return factory.promise; } } } });
    const pending = page.context.run('createVoiceRuntime()').catch(e => e);
    let done = false; const stop = stopped ? page.click().then(() => { done = true; }) : null;
    await new Promise(setImmediate);
    if (stopped) {
      assert.equal(done, false, 'Stop owns pending factory cleanup');
      page.context.voiceRuntime = { cancel() { foreignStops++; } };
    }
    factory.release(next); const result = await pending; await stop;
    assert.equal(factories, 1); assert.equal(disposes, stopped ? 1 : 0); assert.equal(foreignStops, 0);
    if (!stopped) { assert.equal(result, next); assert.equal(page.context.isRunning, true); }
    else { assert.match(result.message, /CANCELLED/); assert.notEqual(page.context.voiceRuntime, next); }
  });
});

test('owner failed old runtime disposal prevents any factory bypass', async () => {
  let factories = 0;
  const old = { cancel: async () => {}, dispose: async () => { throw Error('dispose failed'); } };
  const page = ui(old, { actualFactory: true, window: { VoiceRuntimeFactory: { createRuntime: async () => { factories++; return {}; } } } });
  await assert.rejects(page.context.run('createVoiceRuntime()'));
  await assert.rejects(page.context.run('createVoiceRuntime()'));
  assert.equal(factories, 0); assert.equal(page.context.voiceRuntime, old);
  assert.equal(page.context.run('voiceStopFailed'), true);
});

async function handlerPage(runtime, extra = {}) {
  const listeners = {}, writes = [];
  const window = { addEventListener: (name, callback) => { listeners[name] = callback; },
    VoiceTtsPreference: { normalizeTtsMode: value => value, shouldLoadBrowserKokoro: () => false, shouldUseModelTts: () => true } };
  const page = ui(runtime, { actualHandlers: true, isRunning: false,
    saveCurrentProviderForm: async () => {}, invalidateModelDiscovery() {}, activeSettingsProvider: 'api',
    localStorage: { getItem: () => null, setItem: (...args) => writes.push(args), removeItem() {} },
    // Existing 'api' is a lifecycle-unit provider double, not a shipping capability.
    // Open the real modal/session while retaining these unrelated policy boundaries.
    PROVIDERS_CONFIG: { api: { name: 'API' } }, DIRECT_API_PROVIDER_ID: 'api',
    removeRetiredOAuthState() {}, migrateLegacyDirectProviderSettings() {}, applyLlmProviderCapabilities() {},
    loadProviderIntoForm: async () => {}, isIosBrowserEnvironment: () => false, getTtsMode: () => 'system',
    isSelectableProviderState: () => true, getCurrentProviderState: () => 'available',
    setProviderModel() {}, getProviderBaseUrl: () => 'https://example.invalid', getProviderConfig: () => ({ name: 'API' }),
    cancelPendingKokoroInitialization() {}, updateHeaderStatusBadge() {}, alert() {},
    playFallbackWebSpeech: async () => true, window, ...extra });
  for (const [id, value] of Object.entries({ providerSelect: 'api', apiBaseUrl: 'https://example.invalid', apiModel: 'model', modelSelect: 'model', ttsModeSelect: 'system' })) page.elements.set(id, { value });
  await page.context.openSettingsModal();
  return { ...page, listeners, writes };
}

test('v3 handler fixture uses actual session action edit and dismiss invalidation', async () => {
  const page = await handlerPage({ cancel: async () => {} });
  assert.equal(page.context.run('globalThis.fixtureAction = beginSettingsAction("TEST"); settingsActionIsCurrent(fixtureAction)'), true);
  page.context.run('onSettingsFormEdit()');
  assert.equal(page.context.run('settingsActionIsCurrent(fixtureAction)'), false);
  assert.equal(page.context.run('globalThis.fixtureNext = beginSettingsAction("TEST"); settingsActionIsCurrent(fixtureNext)'), true);
  await page.context.closeSettingsModal();
  assert.equal(page.context.run('settingsActionIsCurrent(fixtureNext)'), false);
  assert.equal(page.context.run('beginSettingsAction("TEST")'), null);
  await page.context.openSettingsModal();
  assert.equal(page.context.run('settingsActionIsCurrent(fixtureAction) || settingsActionIsCurrent(fixtureNext)'), false);
  assert.deepEqual(page.writes, []);
});

for (const boundary of ['healthy', 'hide-Stop', 'update-Stop', 'hide-newer', 'update-newer']) test('IND08 coach preview original owner survives only current final UI boundary: ' + boundary, { timeout: 8000 }, async t => {
  // Real registered Main/preload/Sidecar + inert child. Only DOM and Audio are MEMORY.
  const h = await harness(t), requests = [];
  h.clients[0].env.MAIN_FIXTURE_TTS_AUDIO = '1';
  await h.clients[0].stop();
  const runtime = new ElectronRuntime({ api: preload((channel, payload) => {
    if (channel === 'voice:tts') requests.push({ requestId: payload.requestId, text: payload.text });
    return h.invoke(channel, payload);
  }), capabilities: { ready: true, selectedTts: 'kokoro-python' } });
  let page, newer, stopped, armed = true, plays = 0, hits = 0;
  class Audio {
    play() { plays++; this.onplay?.(); queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  }
  const reenter = where => {
    if (!armed || !boundary.startsWith(where + '-') || page.context.currentVoiceId !== 'af_heart') return;
    armed = false; hits++;
    if (boundary.endsWith('Stop')) stopped = page.click();
    else newer = page.context.selectCoach('af_bella');
  };
  page = ui(runtime, { actualPlayback: true, isRunning: false, currentVoiceId: 'am_adam', Audio,
    console: { log() {}, warn() {}, error() {} }, logKokoroStep() {},
    updateCoachUI() { reenter('update'); },
    window: { VoiceTtsPreference: require('../apps/web/runtime/tts-preference.js') } });
  const html = await fs.readFile(path.join(__dirname, '../apps/web/index.html'), 'utf8');
  page.context.run(html.slice(html.indexOf('function selectCoach('), html.indexOf('// Connection adapters:')));
  const modal = page.context.document.getElementById('coachModal'); let display;
  Object.defineProperty(modal.style, 'display', { get: () => display, set(value) { display = value; reenter('hide'); } });
  try {
    await page.context.selectCoach('af_heart');
    await newer; await stopped; await new Promise(setImmediate);
    const denied = boundary.endsWith('Stop');
    assert.equal(hits, boundary === 'healthy' ? 0 : 1);
    assert.equal(requests.length, denied ? 0 : 1, 'no revoked preview IPC; a newer coach must remain usable');
    assert.equal(plays, denied ? 0 : 1);
    if (!denied) assert.match(requests[0].text, boundary.endsWith('newer') ? /Bella/ : /Heart/);
    if (boundary.endsWith('newer')) assert.equal(page.context.currentVoiceId, 'af_bella');
    console.log('IND08_COACH_BOUNDARY:' + JSON.stringify({ boundary, hits, requests, plays, children: h.children.map(c => c.pid) }));
  } finally {
    await page.click().catch(() => {}); await runtime.dispose().catch(() => {});
  }
});

test('owner coach greeting joins original cleanup and newer selection supersedes old preview', async () => {
  const held = gate(); const speech = []; let calls = 0;
  const page = await handlerPage({ kind: 'browser', cancel: () => ++calls === 1 ? held.promise : Promise.resolve(),
    synthesize: async ({ text }) => { speech.push(text); return {}; } });
  const old = page.context.run('selectCoach("af_heart")');
  const fresh = page.context.run('selectCoach("af_bella")');
  await new Promise(setImmediate); assert.equal(speech.length, 0);
  held.release(); await Promise.all([old, fresh]);
  assert.equal(speech.length, 1); assert.match(speech[0], /Bella/);
});

test('owner settings save-close join cleanup, observe rejection, and retain text configuration policy', async t => {
  for (const route of ['save', 'close', 'save-fail', 'close-fail', 'coach-fail']) await t.test(route, async () => {
    const held = gate(); let reject, calls = 0, finished = false;
    const pending = new Promise((resolve, r) => { reject = r; held.promise.then(resolve); });
    const page = await handlerPage({ cancel: () => { calls++; return pending; } });
    const operation = Promise.resolve(page.context.run(route.startsWith('save') ? 'saveSettings()'
      : route.startsWith('coach') ? 'selectCoach("af_heart")' : 'closeSettingsModal()')).then(() => { finished = true; });
    await new Promise(setImmediate);
    const before = finished;
    if (route.endsWith('fail')) reject(Error('cleanup failed')); else held.release();
    await operation;
    assert.equal(before, false); assert.ok(calls >= 1);
    assert.equal(page.context.run('voiceStopFailed'), route.endsWith('fail'));
    if (route === 'save') assert.ok(page.writes.some(([key, value]) => key === 'vp_ttsMode' && value === 'system'));
  });
});

test('owner beforeunload synchronously invalidates and starts original cleanup with observed errors', async () => {
  const calls = []; let reject;
  const page = await handlerPage({ cancel: () => { calls.push('cancel'); return new Promise((_, r) => { reject = r; }); },
    dispose: () => { calls.push('dispose'); throw Error('dispose failure'); } });
  const epoch = page.context.run('voiceSessionEpoch');
  assert.doesNotThrow(() => page.listeners.beforeunload());
  assert.ok(page.context.run('voiceSessionEpoch') > epoch);
  assert.deepEqual(calls, ['cancel', 'dispose']);
  reject(Error('cancel failure')); await new Promise(setImmediate);
  assert.equal(page.context.run('voiceStopFailed'), true);
  // Dispatch is a synchronous event boundary double, not a browser promise-wait claim.
});

test('owner playback teardown attempts every method despite throws and keeps Stop fault sticky', async () => {
  const calls = [];
  const page = ui({ cancel: async () => {} }, { actualPlayback: true,
    window: { speechSynthesis: { cancel() { calls.push('speech'); throw Error('speech stop'); } } } });
  page.context.audio = { pause() { calls.push('pause'); throw Error('pause'); },
    removeAttribute() { calls.push('src'); }, load() { calls.push('load'); } };
  page.context.done = () => calls.push('resolve');
  page.context.run('currentAudioObj = audio; currentPlaybackResolve = done');
  await assert.rejects(page.click());
  assert.deepEqual(calls, ['pause', 'src', 'load', 'speech', 'resolve']);
  assert.equal(page.context.run('voiceStopFailed'), true);
});

test('owner Audio constructor and synchronous play failure release their original URL and resolver', async t => {
  for (const boundary of ['constructor', 'play']) await t.test(boundary, async () => {
    let revoked = 0;
    class Audio {
      constructor() { if (boundary === 'constructor') throw Error('Audio constructor'); }
      play() { throw Error('play sync'); } pause() {} removeAttribute() {} load() {}
    }
    const page = ui({ kind: 'electron', cancel: async () => {}, synthesize: async () => ({ blob: {} }) }, {
      isRunning: false, actualPlayback: true, Audio, URL: { createObjectURL: () => 'blob:original', revokeObjectURL() { revoked++; } },
      logKokoroStep() {}, window: { VoiceTtsPreference: { shouldUseModelTts: () => true } } });
    await page.speak('hello');
    assert.equal(revoked, 1); assert.equal(page.context.run('currentPlaybackResolve'), null);
    assert.equal(page.context.run('currentAudioObj'), null);
  });
});

test('owner actual speech callbacks cannot clear or update fresh utterance', async () => {
  const utterances = [], events = [];
  const page = ui({ kind: 'browser', cancel: async () => {}, synthesize: async () => ({}) }, {
    actualPlayback: true, isRunning: false, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    PERSONA_VOICE_CONFIG: { af_heart: {} }, findBestVoiceForPersona: () => ({ name: 'Local', lang: 'en-US' }),
    updateCoachUI: state => events.push(state), setTTSEngineStatus: state => events.push(state),
    window: { VoiceTtsPreference: { shouldUseModelTts: () => false },
      speechSynthesis: { cancel() {}, resume() {}, speak(utter) { utterances.push(utter); } } } });
  const old = page.speak('old'); await until(() => utterances.length === 1); await page.click(); await old;
  const fresh = page.speak('fresh'); await until(() => utterances.length === 2);
  const resolver = page.context.run('currentPlaybackResolve'), before = events.slice();
  utterances[0].onstart(); utterances[0].onerror(Error('late')); utterances[0].onend();
  assert.deepEqual(events, before); assert.equal(page.context.run('currentPlaybackResolve'), resolver);
  utterances[1].onstart(); utterances[1].onend(); assert.equal(await fresh, true);
});

test('owner Stop during replacement cleanup prevents factory and does not deadlock competing callers', async () => {
  const held = gate(); let factories = 0, disposes = 0;
  const page = ui({ cancel: () => held.promise, dispose: async () => { disposes++; } }, {
    actualFactory: true, window: { VoiceRuntimeFactory: { createRuntime: async () => { factories++; return {}; } } } });
  const a = page.context.run('createVoiceRuntime()').catch(e => e);
  const b = page.context.run('createVoiceRuntime()').catch(e => e);
  const stop = page.click(); held.release(); await stop;
  assert.match((await a).message, /CANCELLED/); assert.match((await b).message, /CANCELLED/);
  assert.equal(factories, 0); assert.equal(disposes, 1); assert.equal(page.context.run('voiceRuntimeTransition'), null);
});

test('owner late factory disposal failure stays blocked and stale browser cleanup cannot stop fresh playback', async () => {
  const held = gate(); let options;
  const page = ui(null, { actualFactory: true, window: { VoiceRuntimeFactory: { createRuntime: opts => { options = opts; return held.promise; } } } });
  const result = page.context.run('createVoiceRuntime()').catch(e => e), stop = page.click();
  page.context.voiceRuntime = { cancel: async () => {} };
  const before = page.playbackStops();
  held.release({ dispose() { options.browser.dispose(); throw Error('late dispose'); } });
  await assert.rejects(stop); await result;
  assert.equal(page.playbackStops(), before); assert.equal(page.context.run('voiceStopFailed'), true);
  await assert.rejects(page.context.run('createVoiceRuntime()'));
});

test('owner synchronous factory and cancellation reentry Stop owns already-published pending receipt', async t => {
  for (const boundary of ['factory', 'cancel']) await t.test(boundary, async () => {
    const held = gate(); let stop, stopped = false, page, calls = 0, disposed = 0;
    const reenter = () => { stop = page.click().then(() => { stopped = true; }); };
    const runtime = boundary === 'factory' ? null : { cancel() { if (++calls === 1) { reenter(); return held.promise; } } };
    page = ui(runtime, { actualFactory: true, window: { VoiceRuntimeFactory: { createRuntime() { reenter(); return held.promise; } } } });
    const work = (boundary === 'factory' ? page.context.run('createVoiceRuntime()') : page.speak('old')).catch(e => e);
    await new Promise(setImmediate); const before = stopped;
    held.release({ dispose: async () => { disposed++; } }); await work; await stop;
    assert.equal(before, false, 'ownership receipt must exist before synchronous boundary callback');
    if (boundary === 'factory') assert.equal(disposed, 1);
  });
});

test('actual onclick after mixed held write/PCM + unconfirmed TTS revokes every planned ID and closes PCM', { timeout: 8000 }, async t => {
  const write = gate(), kill = gate(), decode = gate();
  let writing = false, terminating = false, decoding = false, closes = 0, fallbacks = 0;
  let client, terminate;
  const h = await harness(t, { release() { write.release(); kill.release(); decode.release(); if (client) client._terminate = terminate; },
    fs: { writeFile: async (...args) => { writing = true; await write.promise; return fs.writeFile(...args); } } });
  client = h.clients[0]; terminate = client._terminate.bind(client);
  client._terminate = async () => { terminating = true; await kill.promise; throw new Error('MEMORY_UNCONFIRMED'); };
  client.requestTimeoutMs = 100;
  const oldContext = globalThis.AudioContext;
  globalThis.AudioContext = class {
    decodeAudioData() { decoding = true; return decode.promise; }
    close() { closes++; return Promise.resolve(); }
  };
  t.after(() => { globalThis.AudioContext = oldContext; });
  const calls = [];
  const api = preload((channel, payload) => { calls.push({ channel, payload }); return h.invoke(channel, payload); });
  const capabilities = { ready: true, selectedStt: 'mlx-whisper', selectedTts: 'kokoro-python' };
  const runtime = new ElectronRuntime({ api, capabilities, fallback: {
    synthesize() { fallbacks++; return { useSystemSpeech: true }; }, cancel() {}, dispose() {},
  } });
  const tts = runtime.synthesize({ text: 'hold' }).catch(error => error);
  await until(() => terminating);
  const stt = runtime.transcribe({ buffer: pcmLabel('held') }).catch(error => error);
  await until(() => writing);
  capabilities.selectedStt = 'faster-whisper';
  const pcm = runtime.transcribe({ buffer: Buffer.from('codec') }).catch(error => error);
  await until(() => decoding);
  kill.release(); await tts;
  const page = ui(runtime);
  const stopped = Promise.resolve(page.click()).catch(error => error);
  await until(() => closes === 1);
  await stopped;
  const revoked = calls.filter(c => c.channel === 'voice:operation-revoke').flatMap(c => c.payload.requestIds);
  assert.equal(new Set(revoked).size, 3, 'Stop must include held Main write, rejected TTS and pre-admission PCM');
  assert.equal(fallbacks, 0, 'unconfirmed typed failure must not become ordinary fallback');
  assert.match(page.elements.get('micNotice').textContent, /關閉.*重新/);
  assert.equal(page.elements.get('conversationBtn').disabled, true);
  const original = h.children[0]; original.stdin.end();
  await until(() => original.exitCode !== null);
  write.release(); await Promise.all([stt, pcm]);
  await until(async () => (await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length === 0);
  assert.equal(h.children.length, 1, 'natural old PID exit is not permission for late spawn');
  assert.equal((await fs.readFile(path.join(h.root, 'requests'), 'utf8')).trim().split('\n').length, 1);
  client._terminate = terminate;
});

test('actual shared speakReply surfaces TTS-only uncertainty before finally and never plays system fallback', { timeout: 6000 }, async t => {
  let client, terminate, fallback = 0, listened = 0;
  const h = await harness(t, { release() { if (client) client._terminate = terminate; } });
  client = h.clients[0]; terminate = client._terminate.bind(client);
  client._terminate = async () => { throw new Error('MEMORY_TTS_UNCONFIRMED'); };
  client.requestTimeoutMs = 100;
  const runtime = new ElectronRuntime({ api: preload(h.invoke),
    capabilities: { ready: true, selectedTts: 'kokoro-python' }, fallback: { cancel() {} } });
  const page = ui(runtime, { playFallbackWebSpeech() { fallback++; return true; }, startListeningTurn() { listened++; } });
  await page.speak('hold');
  assert.equal(fallback, 0, 'outer UI catch must not undo typed fail-closed');
  assert.equal(listened, 0, 'session finally must not automatically restart');
  assert.equal(page.elements.get('conversationBtn').disabled, true);
  assert.match(page.elements.get('micNotice').textContent, /關閉.*重新/);
  const a = page.click(), b = page.click();
  assert.equal(a, b);
  await assert.rejects(a, /UNCERTAIN/);
  client._terminate = terminate;
});

// Formal cycle1: normative ports of the independent SAFE findings. Assertions
// are outside reentrant callbacks; Main/preload/Sidecar/child are never replaced.
const cycle1Tick = () => new Promise(setImmediate);
const cycle1Quiet = { log() {}, warn() {}, error() {} };
const cycle1Preference = { shouldUseModelTts: () => true, shouldLoadBrowserKokoro: () => false, normalizeTtsMode: x => x };

test('cycle1 IND01 final TTS status Stop forbids real Main late REQUEST_STARTED', { timeout: 8000 }, async t => {
  const h = await harness(t), calls = [];
  const runtime = new ElectronRuntime({ api: preload((channel, payload) => {
    calls.push({ channel, payload }); return h.invoke(channel, payload);
  }), capabilities: { ready: true, selectedTts: 'kokoro-python' } });
  let page, stopped, settled = false;
  page = ui(runtime, { setTTSEngineStatus(label) {
    if (label === 'Native TTS 生成中…' && !stopped) stopped = page.click();
  } });
  const speaking = page.speak('hold').finally(() => { settled = true; });
  try {
    await until(() => !!stopped); await stopped;
    await until(async () => settled || (await childRequests(h)).length > 0);
    const requests = await childRequests(h);
    console.log('CYCLE1_LATE_NATIVE:' + JSON.stringify({ settled, requests, calls, scopeRecords: runtime._scope.records.size }));
    assert.equal(requests.length, 0, 'Stop must forbid stale native work, not merely suppress its reply');
    assert.equal(calls.filter(c => c.channel === 'voice:tts').length, 0);
    assert.equal(runtime._scope.records.size, 0);
    assert.equal(settled, true);
  } finally { await page.click().catch(() => {}); await speaking; await runtime.dispose().catch(() => {}); }
});

test('cycle1 IND01 Audio constructor Stop cleans original resource without play or stale publication', async () => {
  let page, stopped, plays = 0, pauses = 0, removes = 0, loads = 0;
  class Audio {
    constructor() { stopped = page.click(); }
    play() { plays++; return Promise.resolve(); }
    pause() { pauses++; } removeAttribute() { removes++; } load() { loads++; }
  }
  page = ui({ kind: 'electron', cancel: async () => {}, synthesize: async () => ({ audio: 'boundary-audio' }) }, {
    actualPlayback: true, isRunning: false, Audio, console: cycle1Quiet,
    window: { VoiceTtsPreference: cycle1Preference }, logKokoroStep() {} });
  await page.speak('old'); await stopped;
  const orphan = page.context.run('currentAudioObj !== null');
  await page.click();
  assert.equal(plays, 0); assert.equal(orphan, false);
  assert.deepEqual([pauses, removes, loads], [1, 1, 1], 'Stop could not see the not-yet-returned Audio');
});

test('cycle1 IND01 WebSpeech resume Stop cannot publish resolver or submit old utterance', async () => {
  let page, stopped, armed = true; const spoken = [];
  page = ui({ kind: 'browser', cancel: async () => {} }, { actualPlayback: true, isRunning: false, console: cycle1Quiet,
    SpeechSynthesisUtterance: class {}, PERSONA_VOICE_CONFIG: { af_heart: {} },
    findBestVoiceForPersona: () => ({ name: 'local', lang: 'en-US', localService: true }),
    window: { VoiceTtsPreference: { shouldUseModelTts: () => false }, speechSynthesis: {
      cancel() {}, resume() { if (armed) { armed = false; stopped = page.click(); } }, speak(u) { spoken.push(u); }
    } } });
  const speech = page.speak('old'); await until(() => !!stopped); await stopped; await cycle1Tick();
  const submitted = spoken.length, staleResolver = page.context.run('currentPlaybackResolve !== null');
  spoken.forEach(u => u.onend()); await speech; await page.click();
  assert.equal(submitted, 0); assert.equal(staleResolver, false);
});

test('cycle1 IND01 conversation recorder constructor Stop prevents original start and publication', async () => {
  let page, stopped, starts = 0, tracks = 0;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { stopped = page.click(); }
    start() { starts++; this.state = 'recording'; } stop() { this.state = 'inactive'; }
  }
  page = ui({ cancel: async () => {} }, { actualCapture: true, MediaRecorder: Recorder, console: cycle1Quiet,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { tracks++; } }] }) } } });
  await page.context.startMediaRecording(); await stopped;
  assert.equal(starts, 0); assert.equal(tracks, 1);
  assert.equal(page.context.run('mediaRecorder'), null);
  assert.equal(page.context.run('voiceCaptureOwner'), null);
});

test('cycle1 IND01 unpublished Audio cleanup throws isolate methods and spare fresh original-owner slots', async () => {
  let page, stopped; const events = [], freshAudio = { pause() { events.push('FRESH_PAUSE'); } }, freshResolve = () => events.push('FRESH_RESOLVE');
  class Audio {
    constructor() {
      stopped = page.click().catch(e => e);
      page.context.freshAudio = freshAudio; page.context.freshResolve = freshResolve;
      page.context.run('currentAudioObj = freshAudio; currentPlaybackResolve = freshResolve;');
    }
    play() { events.push('OLD_PLAY'); return Promise.resolve(); }
    pause() { events.push('old:pause'); throw Error('MEMORY_OLD_PAUSE'); }
    removeAttribute() { events.push('old:remove'); } load() { events.push('old:load'); }
  }
  page = ui({ cancel: async () => {} }, { actualPlayback: true, Audio, isRunning: false, console: cycle1Quiet });
  const token = page.context.run('voicePlaybackToken');
  const result = await page.context.playAudioSource('old', token, null, () => { events.push('old:url'); throw Error('MEMORY_OLD_URL'); }).catch(e => e);
  await stopped;
  assert.deepEqual(events, ['old:pause', 'old:remove', 'old:load', 'old:url']);
  assert.match(result.message, /MEMORY_OLD/);
  assert.equal(page.context.run('voiceStopFailed'), true, 'stale early-return must not mask original cleanup failure');
  assert.equal(page.context.run('currentAudioObj'), freshAudio);
  assert.equal(page.context.run('currentPlaybackResolve'), freshResolve);
});

for (const action of ['Start', 'Shadowing']) test('cycle1 IND02 actual ' + action + ' never records live coach playback with real Main reply', { timeout: 8000 }, async t => {
  const h = await harness(t);
  h.clients[0].env.MAIN_FIXTURE_TTS_AUDIO = '1';
  await h.clients[0].stop();
  const replies = [];
  const runtime = new ElectronRuntime({ api: preload(async (channel, payload) => {
    const reply = await h.invoke(channel, payload); replies.push({ channel, reply }); return reply;
  }), capabilities: { ready: true, selectedTts: 'kokoro-python' } });
  const audios = [], recorders = [], events = [];
  let permissions = 0;
  class Audio {
    constructor(src) { this.src = src; this.active = false; audios.push(this); }
    play() { this.active = true; events.push('play'); this.onplay?.(); return Promise.resolve(); }
    pause() { this.active = false; events.push('pause'); } removeAttribute() {} load() {}
  }
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options?.mimeType; recorders.push(this); }
    start() { this.state = 'recording'; events.push(audios.some(a => a.active) ? 'OVERLAP' : 'record'); }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const page = ui(runtime, { actualCapture: true, actualPlayback: true, actualLessonShadow: true,
    actualBrowser: true, isRunning: false, Audio, MediaRecorder: Recorder,
    messages: [{ role: 'assistant', content: 'Hello.' }], console: cycle1Quiet,
    logKokoroStep() {}, transcribeAudioBlob: async () => {}, window: { VoiceTtsPreference: cycle1Preference },
    navigator: { mediaDevices: { getUserMedia: async () => {
      permissions++; return { getTracks: () => [{ stop() { events.push('track-stop'); } }] };
    } } } });
  page.context.startListeningTurn = () => page.context.startMediaRecording();
  page.context.document.getElementById('shadowResultBox').replaceChildren = () => {};
  const speaking = page.speak('Hello.'); let shadow;
  try {
    await until(() => audios.length === 1 && audios[0].active);
    const native = replies.find(r => r.channel === 'voice:tts');
    assert.equal(native.reply.success, true); assert.equal(native.reply.pid, h.children.at(-1).pid);
    if (action === 'Start') await page.toggle(); else shadow = page.context.startShadowing();
    await cycle1Tick(); await cycle1Tick();
    console.log('CYCLE1_CAPTURE_PLAYBACK:' + JSON.stringify({ action, events, permissions, recorders: recorders.length, native }));
    assert.equal(events.includes('OVERLAP'), false, 'actual Start/Shadowing must refuse or join original playback cleanup');
    assert.equal(permissions, 0, 'busy speech must reject before mic permission');
    assert.equal(recorders.length, 0);
    assert.equal(audios[0].active, true, 'busy rejection preserves original speech');
    // Normal completion releases busy admission. Healthy explicit Start still records.
    audios[0].active = false; audios[0].onended(); await speaking;
    await page.toggle(); await until(() => recorders.length === 1);
    assert.equal(events.includes('OVERLAP'), false);
    assert.equal(recorders[0].state, 'recording');
  } finally { await page.click().catch(() => {}); await Promise.allSettled([speaking, shadow]); await runtime.dispose().catch(() => {}); }
});

test('cycle1 IND03 exact known voice failure still persists whole Save selection without restart', async () => {
  let cancels = 0, starts = 0;
  const fault = Error('VOICE_CLEANUP_UNCERTAIN');
  const runtime = { kind: 'electron', fault, cancel: async () => { cancels++; throw fault; }, synthesize() { starts++; } };
  const page = await handlerPage(runtime, { console: cycle1Quiet, createVoiceRuntime() { starts++; },
    scheduleBrowserKokoroInitialization() { starts++; }, startListeningTurn() { starts++; } });
  const result = await page.context.saveSettings();
  console.log('CYCLE1_FAULT_SAVE:' + JSON.stringify({ result, writes: page.writes, cancels, starts }));
  assert.deepEqual(page.writes, [['vp_provider', 'api'], ['vp_baseUrl', 'https://example.invalid'], ['vp_model', 'model'], ['vp_ttsMode', 'system']]);
  assert.equal(result, true, 'success describes actual durable settings writes, never voice recovery');
  assert.equal(page.context.run('voiceStopFailed'), true); assert.equal(runtime.fault, fault);
  assert.equal(starts, 0); assert.equal(cancels, 1);
  await page.toggle(); await page.speak('blocked'); assert.equal(starts, 0);
});

for (const route of ['system', 'kokoro', 'invalid-endpoint', 'storage-failure']) test('cycle1 IND03 actual validated provider form and whole Save under voice fault: ' + route, async () => {
  const { settingsUi } = require('./fixtures/desktop-voice-stop-harness.cjs');
  let bridgeCalls = 0;
  // Endpoint allowlisting is a desktop credential policy, not browser form validation.
  const page = settingsUi({ storage: { vp_provider: 'chatgpt-subscription' }, ...(route === 'invalid-endpoint' ? { electronAPI: {
    providerOperation() { bridgeCalls++; }, providerCredentialSet() { bridgeCalls++; },
  } } : {}) });
  // Establish the real modal session without a discovery/IPC side effect, then arrange
  // the pre-existing form/fault fixture. Do not manufacture an always-valid action.
  await page.api.openSettingsModal();
  page.localStorage.removeItem('vp_provider');
  const fault = Error('VOICE_CLEANUP_UNCERTAIN'); let cancels = 0, restarts = 0;
  const runtime = { kind: 'electron', fault, cancel: async () => { cancels++; throw fault; } };
  page.context.voiceRuntime = runtime;
  page.context.createVoiceRuntime = () => { restarts++; };
  page.context.scheduleBrowserKokoroInitialization = () => { restarts++; };
  page.context.cancelPendingKokoroInitialization = () => { restarts++; };
  page.context.startListeningTurn = () => { restarts++; };
  page.run('activeSettingsProvider = DIRECT_API_PROVIDER_ID');
  page.elements.providerSelect.value = 'openai-compatible';
  page.elements.apiBaseUrl.value = route === 'invalid-endpoint' ? 'javascript:forbidden' : 'https://api.example/v1';
  page.elements.apiModel.value = 'selected-model';
  page.elements.ttsModeSelect.value = route === 'kokoro' ? 'kokoro' : 'system';
  const writes = [], originalSet = page.localStorage.setItem.bind(page.localStorage);
  page.localStorage.setItem = (key, value) => {
    if (route === 'storage-failure' && key === 'vp_ttsMode') throw Error('MEMORY_STORAGE_FAILURE');
    writes.push([key, value]); originalSet(key, value);
  };
  const result = await page.api.saveSettings();
  if (route === 'invalid-endpoint' || route === 'storage-failure') {
    assert.equal(result, false, 'validation/storage exceptions remain real Save failures');
    assert.equal(page.localStorage.getItem('vp_ttsMode'), null);
    if (route === 'invalid-endpoint') {
      assert.equal(page.localStorage.getItem('vp_provider'), null);
      assert.ok(page.warnings.some(args => args.some(error => error?.message === 'INVALID_PROVIDER_ENDPOINT')));
    }
  } else {
    assert.deepEqual(['vp_provider', 'vp_baseUrl', 'vp_model', 'vp_ttsMode'].map(k => [k, page.localStorage.getItem(k)]), [
      ['vp_provider', 'openai-compatible'], ['vp_baseUrl', 'https://api.example/v1'], ['vp_model', 'selected-model'], ['vp_ttsMode', route],
    ]);
    assert.equal(JSON.parse(page.localStorage.getItem('vp_provider_models'))['openai-compatible'], 'selected-model');
    assert.equal(result, true);
  }
  assert.equal(page.run('voiceStopFailed'), true); assert.equal(page.context.voiceRuntime, runtime); assert.equal(runtime.fault, fault);
  assert.equal(restarts, 0); assert.equal(cancels, 1); assert.equal(page.fetchCalls, 0);
  assert.equal(bridgeCalls, 0);
  assert.ok(writes.every(([key]) => !key.includes('verified')), 'no fake provider connection proof');
});

// Formal final cycle2: exact independent SAFE schedules, with assertions outside
// reentrant product callbacks. DOM/media/synthesis remain explicit MEMORY doubles.
for (const route of ['healthy', 'constructor', 'handler-install']) test('cycle2 IND04 actual onclick shadow final activation ' + route, { timeout: 5000 }, async () => {
  let page, stop, recorder, hit = 0, transcripts = 0;
  const events = [], timers = new Map();
  const fire = () => { hit++; stop = page.click(); events.push('Stop-called'); };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; recorder = this; if (route === 'constructor') fire(); }
    set onstop(value) { this.ended = value; if (route === 'handler-install') fire(); }
    get onstop() { return this.ended; }
    start() { events.push('start'); this.state = 'recording'; }
    stop() { events.push('recorder-stop'); this.state = 'inactive'; this.onstop?.(); }
  }
  const element = () => ({ value: '', textContent: '', style: {}, children: [],
    replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); } });
  page = ui({ kind: 'browser', cancel: async () => {} }, {
    actualBrowser: true, actualCapture: true, actualLessonShadow: true, isRunning: false,
    MediaRecorder: Recorder, messages: [{ role: 'assistant', content: 'hello world' }], console: cycle1Quiet,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { events.push('track-stop'); } }] }) } },
    setTimeout(fn, ms) { if (ms === 15000) { timers.set('recording', fn); return 'recording'; } return setTimeout(fn, ms); },
    clearTimeout(id) { if (id === 'recording') timers.delete(id); else clearTimeout(id); },
  });
  page.elements.set('shadowResultBox', element()); page.context.document.createElement = element;
  page.context.transcribeWithWebAssembly = async () => { transcripts++; return 'hello world'; };
  const work = page.context.startShadowing();
  if (route === 'healthy') {
    await until(() => timers.size === 1);
    recorder.ondataavailable({ data: new Blob(['MEM audio']) }); timers.get('recording')();
  }
  await work; await stop;
  console.log('CYCLE2_SHADOW:' + JSON.stringify({ route, hit, events, transcripts, timers: timers.size }));
  assert.equal(hit, route === 'healthy' ? 0 : 1);
  assert.equal(events.filter(x => x === 'start').length, route === 'healthy' ? 1 : 0,
    'No activation of original recorder after synchronous actual Stop');
  assert.equal(transcripts, route === 'healthy' ? 1 : 0);
  assert.equal(events.filter(x => x === 'track-stop').length, 1);
  assert.equal(timers.size, 0); assert.equal(page.context.run('voiceCaptures.size'), 0);
  assert.equal(page.context.run('voiceStopFailed'), false); assert.equal(recorder.state, 'inactive');
});

test('v3 IND06 Library command revokes held greeting before microphone admission', async () => {
  const page = cycle2LessonPage();
  const old = page.lesson('a'); await until(() => page.entered() === 1);
  page.context.switchTab('lesson');
  page.held.release({ useSystemSpeech: true }); await old; await cycle1Tick();
  assert.equal(page.recorders.length, 0);
  assert.equal(page.context.currentLessonId, null);
  assert.equal(page.context.isRunning, false);
  await page.click();
});

test('v3 entering Library repeated command cancels original pending lesson reservation', async () => {
  const page = cycle2LessonPage(), held = gate();
  await page.context.switchTab('lesson');
  page.onCancel(() => held.promise);
  const old = page.lesson('a');
  page.context.switchTab('lesson');
  held.release(); page.held.release({}); await old; await cycle1Tick();
  assert.equal(page.entered(), 0);
  assert.equal(page.context.currentLessonId, null);
});

test('v3 public Stop joining existing P revokes waiting text without a second epoch', async () => {
  const page = cycle2LessonPage(), held = gate(); let requests = 0;
  page.onCancel(() => held.promise);
  page.context.requestProviderChat = async () => { requests++; return 'Late reply.'; };
  page.context.document.getElementById('userTextInput').value = 'Waiting';
  const text = page.context.sendManualText();
  const epoch = page.context.run('voiceSessionEpoch');
  const stop = page.click();
  assert.equal(page.context.run('voiceSessionEpoch'), epoch);
  held.release(); page.held.release({}); await Promise.all([text, stop]);
  assert.equal(requests, 0); assert.equal(page.chats.length, 0);
});

async function v3SettingsPage(options = {}) {
  const { settingsUi } = require('./fixtures/desktop-voice-stop-harness.cjs');
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
  const timers = new Map(); let next = 0, manifests = 0, imports = 0;
  const page = settingsUi({ ...options,
    timerImpl(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimerImpl: id => timers.delete(id) });
  page.context.voiceRuntime = { kind: 'browser', cancel() {}, dispose() {} };
  page.context.currentVoiceId = 'af_heart';
  page.context.loadBrowserModelManifest = async () => { manifests++; return { models: { kokoro: {} } }; };
  page.context.browserImport = async () => { imports++; throw Error('MEMORY_MODEL_BOUNDARY'); };
  page.run(html.slice(html.indexOf('function getTtsMode()'), html.indexOf('function isIosBrowserEnvironment()')));
  page.run(html.slice(html.indexOf('let kokoroTTSInstance = null;'), html.indexOf('function stopCurrentVoicePlayback('))
    .replace('import("./vendor/kokoro.bundle.js")', 'browserImport()'));
  await page.api.openSettingsModal();
  return { ...page, timers, manifests: () => manifests, imports: () => imports };
}

test('v3 D2 Save scheduled caller cannot borrow a reopened settings session', async () => {
  const page = await v3SettingsPage();
  page.elements.ttsModeSelect.value = 'kokoro';
  assert.equal(await page.api.saveSettings(), true);
  const timer = [...page.timers.values()].find(x => x.ms === 0);
  assert.ok(timer);
  await page.api.openSettingsModal();
  await timer.fn();
  assert.equal(page.manifests(), 0, 'original activated S/G/A must remain part of scheduled caller');
  assert.equal(page.imports(), 0);
});

test('v3 IND07 healthy Save private hide retains original scheduled Kokoro caller', async () => {
  const page = await v3SettingsPage();
  page.elements.ttsModeSelect.value = 'kokoro';
  assert.equal(await page.api.saveSettings(), true);
  assert.equal(page.localStorage.getItem('vp_ttsMode'), 'kokoro');
  assert.equal(page.elements.settingsModal.style.display, 'none');
  const scheduled = [...page.timers.values()].filter(x => x.ms === 0);
  assert.equal(scheduled.length, 1);
  await scheduled[0].fn();
  assert.equal(page.manifests(), 1); assert.equal(page.imports(), 1);
});

for (const admission of ['Start-held', 'Start-denied', 'Shadowing-denied', 'Stop']) test('v3 Save persistence survives later ' + admission + ' but original warmup cannot revive', async () => {
  const credential = gate(), permission = gate(); let writes = 0, grants = 0;
  const page = await v3SettingsPage({ storage: {
    vp_provider: 'openai-compatible', vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' })
  }, electronAPI: {
    providerOperation: async () => ({ models: ['model'] }), providerCredentialHas: async () => ({}),
    providerCredentialSet: () => { writes++; return credential.promise; }
  } });
  page.elements.apiKey.value = '[REDACTED]'; page.elements.ttsModeSelect.value = 'kokoro';
  page.context.navigator = { mediaDevices: { getUserMedia() { grants++; return permission.promise; } } };
  page.context.startListeningTurn = () => {};
  page.context.messages = [{ role: 'assistant', content: 'Hello.' }];
  const save = page.api.saveSettings(); await until(() => writes === 1 && page.run('voiceStopPromise') === null);
  let start;
  if (admission === 'Stop') await page.run('stopConversation()');
  else if (admission.startsWith('Shadowing')) {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../apps/web/index.html'), 'utf8');
    page.run(html.slice(html.indexOf('// Shadowing Coach'), html.indexOf('// Local-first lesson library management')));
    page.elements.shadowResultBox = { style: {}, replaceChildren() {}, textContent: '' };
    start = page.run('startShadowing()');
  } else start = page.run('toggleConversation()');
  if (admission.endsWith('denied')) { permission.release(Promise.reject(Error('MEMORY_DENIED'))); await start; }
  credential.release(); assert.equal(await save, true);
  const scheduled = [...page.timers.values()].filter(x => x.ms === 0);
  for (const timer of scheduled) await timer.fn();
  assert.equal(page.localStorage.getItem('vp_ttsMode'), 'kokoro');
  assert.equal(page.manifests(), 0, 'new admission permanently revokes old voice reservation');
  if (admission === 'Start-held') { permission.release({ getTracks: () => [] }); await start; }
  assert.equal(grants, admission === 'Stop' ? 0 : 1);
});

for (const revoke of ['edit', 'Test']) test('v3 D2 visible Save badge reentry revokes pending original action ' + revoke, async () => {
  const page = await v3SettingsPage(); page.elements.ttsModeSelect.value = 'kokoro';
  let b, text = '', once = true;
  page.elements.headerConnText = { style: {} }; page.elements.headerConnDot = { style: {} };
  Object.defineProperty(page.elements.headerConnText, 'textContent', { get: () => text, set(value) {
    text = value;
    if (!once) return; once = false;
    b = page.run('pendingKokoroInit');
    if (revoke === 'edit') page.dispatch('apiKey', 'input');
    else page.run('beginSettingsAction("TEST", document.getElementById("providerSelect").value)');
  } });
  assert.equal(await page.api.saveSettings(), false);
  assert.ok(b); assert.equal(b.owner.sourceCurrent(), false);
  const timer = [...page.timers.values()].find(x => x.ms === 0); await timer.fn();
  assert.equal(page.manifests(), 0); assert.equal(page.elements.settingsModal.style.display, 'flex');
});

for (const route of ['Library-success', 'Stop-error', 'Library-repair-success', 'Stop-repair-error']) test('v3 finite late text is discarded at original result boundary ' + route, async () => {
  const page = cycle2LessonPage(), reply = gate(), fresh = gate(); let requests = 0;
  page.context.requestProviderChat = () => {
    requests++;
    if (route.includes('repair') && requests === 1) return Promise.resolve('你好');
    return reply.promise;
  };
  page.context.document.getElementById('userTextInput').value = 'Original text';
  const old = page.context.sendManualText();
  await until(() => requests === (route.includes('repair') ? 2 : 1));
  if (route.startsWith('Library')) await page.context.switchTab('lesson'); else await page.click();
  page.context.requestProviderChat = () => fresh.promise;
  page.context.document.getElementById('userTextInput').value = 'New text';
  const newer = page.context.sendManualText(); await until(() => page.chats.length === 2);
  const newOwner = page.context.run('voiceTurnOwner');
  const messages = JSON.stringify(page.context.messages), chats = JSON.stringify(page.chats);
  const notice = page.context.document.getElementById('micNotice').textContent;
  const events = page.events.slice();
  reply.release(route.endsWith('error') ? Promise.reject(Error('MEMORY_LATE')) : 'Obsolete reply.'); await old;
  assert.equal(JSON.stringify(page.context.messages), messages); assert.equal(JSON.stringify(page.chats), chats);
  assert.equal(page.context.document.getElementById('micNotice').textContent, notice);
  assert.deepEqual(page.events, events); assert.equal(page.context.run('voiceTurnOwner'), newOwner);
  page.held.release({ useSystemSpeech: true }); fresh.release('A fresh reply.'); await newer;
  assert.equal(page.context.messages.at(-1).content, 'A fresh reply.');
  assert.equal(page.chats.at(-1).text, 'A fresh reply.'); await page.click();
});

test('v3 finite current tabs are no-op and same-id lesson reentry owns distinct intent', async () => {
  const page = cycle2LessonPage(); const authority = page.context.run('uiVoiceAuthority');
  await page.context.switchTab('free'); assert.equal(page.cancels(), 0); assert.equal(page.context.run('uiVoiceAuthority'), authority);
  await page.context.switchTab('lesson'); const cancels = page.cancels(), n = page.context.run('navigationIntent');
  await page.context.switchTab('lesson'); assert.equal(page.cancels(), cancels); assert.equal(page.context.run('navigationIntent'), n);
  const old = page.lesson('a'); await until(() => page.entered() === 1);
  const first = page.context.run('navigationIntent');
  const fresh = page.lesson('a'); await fresh;
  assert.notEqual(page.context.run('navigationIntent'), first);
  page.held.release({ useSystemSpeech: true }); await old;
  assert.equal(page.recorders.length, 1); assert.equal(page.recorders[0].state, 'recording'); await page.click();
});

test('v3 finite completion storage throw cannot report progress or navigate', async () => {
  const page = cycle2LessonPage(); const old = page.lesson('a'); await until(() => page.entered() === 1);
  page.context.localStorage.setItem = () => { throw Error('MEMORY_STORAGE'); };
  assert.throws(() => page.clickLessonExit('complete'), /MEMORY_STORAGE/);
  assert.equal(page.storage.has('vp_completed_lessons'), false); assert.equal(page.context.currentLessonId, 'a');
  page.held.release({ useSystemSpeech: true }); await old; await page.click();
});

test('v3 finite admitted Start records while old Save persistence finishes without warmup', async () => {
  const credential = gate(); let writes = 0, recorder;
  const page = await v3SettingsPage({ storage: { vp_provider: 'openai-compatible',
    vp_provider_urls: JSON.stringify({ 'openai-compatible': 'https://api.openai.com/v1' }) }, electronAPI: {
    providerOperation: async () => ({ models: ['model'] }), providerCredentialHas: async () => ({}),
    providerCredentialSet: () => { writes++; return credential.promise; }
  } });
  const html = require('node:fs').readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
  page.run(html.slice(html.indexOf('let mediaRecorder = null;'), html.indexOf('// --- Browser Whisper Speech Recognition')));
  page.context.navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } };
  page.context.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { recorder = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  };
  page.elements.apiKey.value = '[REDACTED]'; page.elements.ttsModeSelect.value = 'kokoro';
  const save = page.api.saveSettings(); await until(() => writes === 1 && page.run('voiceStopPromise') === null);
  await page.run('toggleConversation()'); await until(() => recorder?.state === 'recording');
  const authority = page.run('uiVoiceAuthority'); credential.release(); assert.equal(await save, true);
  assert.equal(recorder.state, 'recording'); assert.equal(page.run('uiVoiceAuthority'), authority);
  assert.equal(page.manifests(), 0); assert.equal(page.run('pendingKokoroInit'), null);
  await page.run('stopConversation()');
});

function cycle2LessonPage() {
  const held = gate(), storage = new Map(); let entered = 0, cancels = 0, onCancel;
  const runtime = { kind: 'browser',
    cancel() { cancels++; page.context.stopCurrentVoicePlayback(); return onCancel?.() || Promise.resolve(); },
    synthesize() { entered++; events.push('greeting-held'); return entered === 1 ? held.promise : Promise.resolve({ useSystemSpeech: true }); },
  };
  const { page, events, recorders, chats } = verticalPage(runtime, {
    actualLessonShadow: true, actualLessonExit: true, isRunning: false, console: cycle1Quiet,
    currentMode: 'free', currentLessonId: null, ENGLISH_COACH_SYSTEM_PROMPT: 'Coach.',
    lessons: ['a', 'b'].map(id => ({ id, title: 'Lesson ' + id, objectives: ['speak'], opening_line: 'Hello ' + id })),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    renderLessonList() { events.push('lesson-list'); },
  });
  // Only local System Speech and DOM presentation are doubled, never entry/exit/Stop.
  page.context.playFallbackWebSpeech = async () => { events.push('system-speech'); return true; };
  for (const id of ['tabBtnFree', 'tabBtnLesson']) page.context.document.getElementById(id).classList = { toggle() {} };
  page.context.document.getElementById('chatBox').replaceChildren = () => {};
  return { ...page, events, recorders, chats, held, storage, runtime,
    entered: () => entered, cancels: () => cancels, onCancel: fn => { onCancel = fn; },
    lesson: id => page.context.startSpecificLesson(id) };
}

for (const action of ['return', 'complete', 'Stop', 'healthy', 'tab-free']) test('cycle2 IND05 held greeting actual exit ' + action, { timeout: 5000 }, async () => {
  const page = cycle2LessonPage();
  const lesson = page.lesson('a');
  try {
    await until(() => page.entered() === 1);
    assert.equal(page.context.isRunning, false); assert.equal(page.recorders.length, 0);
    if (action === 'return' || action === 'complete') await page.clickLessonExit(action);
    else if (action === 'Stop') await page.click();
    else if (action === 'tab-free') page.context.switchTab('free');
    if (action === 'return' || action === 'complete') {
      assert.equal(page.context.currentMode, 'free'); assert.equal(page.context.currentLessonId, null);
      assert.ok(page.events.includes('lesson-list'));
      assert.equal(page.storage.get('vp_completed_lessons'), action === 'complete' ? '["a"]' : undefined);
    }
    page.held.release({ useSystemSpeech: true }); await lesson; await cycle1Tick();
    console.log('CYCLE2_LESSON_EXIT:' + JSON.stringify({ action, events: page.events, recorders: page.recorders.length, running: page.context.isRunning }));
    assert.equal(page.events.filter(x => x === 'permission').length, action === 'healthy' ? 1 : 0,
      'Leaving/completing original lesson must not request microphone after greeting');
    assert.equal(page.recorders.length, action === 'healthy' ? 1 : 0);
    assert.equal(page.context.isRunning, action === 'healthy');
    if (action === 'healthy') assert.equal(page.recorders[0].state, 'recording');
    assert.equal(page.context.run('voiceStopFailed'), false);
  } finally { page.held.release({}); await lesson; await page.click(); }
});

for (const action of ['return', 'complete']) for (const failure of [false, true]) test('cycle2 IND05 exit joins original cleanup without blocking navigation ' + action + '/' + failure, { timeout: 5000 }, async () => {
  const page = cycle2LessonPage(), cleanup = gate();
  const old = page.lesson('a'); await until(() => page.entered() === 1);
  let settled = false;
  page.onCancel(() => cleanup.promise);
  const cancels = page.cancels();
  const exit = page.clickLessonExit(action);
  const observed = Promise.resolve(exit).then(() => { settled = true; });
  await cycle1Tick();
  const before = { settled, cancels: page.cancels(), mode: page.context.currentMode, lesson: page.context.currentLessonId };
  // A real new text turn must survive the old cleanup's success/failure and greeting.
  const reply = gate();
  page.context.requestProviderChat = () => reply.promise;
  page.context.document.getElementById('userTextInput').value = 'Fresh text after exit';
  const text = page.context.sendManualText();
  const freshOwner = page.context.run('voiceTurnOwner');
  cleanup.release(failure ? Promise.reject(Error('MEMORY_EXIT_CLEANUP_FAILURE')) : undefined);
  await observed;
  await until(() => page.chats.some(x => x.role === 'user'));
  page.held.release({ useSystemSpeech: true }); await old;
  // Keep the real text turn pending: its own legitimate finally releases it later.
  const ownerAfterOld = page.context.run('voiceTurnOwner');
  reply.release('A healthy reply.'); await text;
  assert.equal(before.settled, false, 'exit must return an observation of original pending Stop');
  assert.equal(await exit, !failure, 'cleanup failure is observed, never reported as confirmed');
  assert.equal(before.cancels, cancels + 1, 'idle greeting exit must cancel original voice work exactly once');
  assert.equal(before.mode, 'free'); assert.equal(before.lesson, null);
  assert.equal(ownerAfterOld, freshOwner);
  assert.equal(page.storage.get('vp_completed_lessons'), action === 'complete' ? '["a"]' : undefined);
  assert.ok(page.chats.some(x => x.role === 'user' && x.text === 'Fresh text after exit'));
  assert.ok(page.chats.some(x => x.role === 'assistant' && x.text === 'A healthy reply.'));
  assert.equal(page.events.filter(x => x === 'permission').length, 0);
  assert.equal(page.recorders.length, 0); assert.equal(page.context.isRunning, false);
  assert.equal(page.context.run('voiceStopFailed'), failure);
  if (failure) {
    assert.equal(page.elements.get('conversationBtn').disabled, true);
    assert.equal(page.entered(), 1, 'text remains usable without voice recovery');
    await page.toggle(); assert.equal(page.recorders.length, 0);
  }
});

for (const action of ['return', 'complete']) for (const outcome of ['success', 'failure']) test('cycle2 IND05 rapid exit then new lesson spares fresh owner ' + action + '/' + outcome, { timeout: 5000 }, async () => {
  const page = cycle2LessonPage(); const old = page.lesson('a');
  await until(() => page.entered() === 1);
  const exit = page.clickLessonExit(action), fresh = page.lesson('b');
  await Promise.all([exit, fresh]); await until(() => page.recorders.length === 1);
  const owner = page.context.run('voiceTurnOwner'), capture = page.context.run('voiceCaptureOwner');
  const snapshot = () => JSON.stringify({ messages: page.context.messages, events: page.events, chats: page.chats,
    mode: page.context.currentMode, lesson: page.context.currentLessonId, running: page.context.isRunning });
  const before = snapshot(), cancels = page.cancels();
  page.held.release(outcome === 'failure' ? Promise.reject(Error('MEMORY_OLD_GREETING_FAILURE')) : { useSystemSpeech: true });
  await old; await cycle1Tick();
  assert.equal(snapshot(), before, 'old exit/greeting continuation may not navigate or mutate fresh lesson');
  assert.equal(page.cancels(), cancels); assert.equal(page.context.run('voiceTurnOwner'), owner);
  assert.equal(page.context.run('voiceCaptureOwner'), capture); assert.equal(page.recorders[0].state, 'recording');
  assert.equal(page.context.currentLessonId, 'b'); assert.equal(page.context.isRunning, true);
  assert.equal(page.storage.get('vp_completed_lessons'), action === 'complete' ? '["a"]' : undefined);
  await page.click();
});

for (const action of ['return', 'complete']) test('cycle2 IND05 exit synchronous cleanup reentry retains original lesson identity ' + action, { timeout: 5000 }, async () => {
  const page = cycle2LessonPage(); const old = page.lesson('a');
  await until(() => page.entered() === 1);
  let fresh;
  page.onCancel(() => { page.onCancel(null); fresh = page.lesson('b'); });
  const exit = page.clickLessonExit(action);
  await Promise.all([exit, fresh]); await until(() => page.recorders.length === 1);
  assert.equal(page.events.filter(x => x === 'lesson-list').length, 0,
    'old exit must not navigate after synchronous cleanup has admitted a newer lesson turn');
  assert.equal(page.context.currentLessonId, 'b');
  assert.equal(page.storage.get('vp_completed_lessons'), action === 'complete' ? '["a"]' : undefined);
  const owner = page.context.run('voiceTurnOwner'), capture = page.context.run('voiceCaptureOwner');
  page.held.release({ useSystemSpeech: true }); await old;
  assert.equal(page.context.run('voiceTurnOwner'), owner); assert.equal(page.context.run('voiceCaptureOwner'), capture);
  assert.equal(page.recorders[0].state, 'recording'); assert.equal(page.context.run('voiceStopFailed'), false);
  await page.click();
});
