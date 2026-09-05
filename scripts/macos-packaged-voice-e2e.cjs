'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildPackagedRuntimeEnvironment } = require('../apps/desktop/macos-runtime-security.cjs');

const execFileAsync = promisify(execFile);

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_CONNECT_TIMEOUT')), 15000);
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')); };
      this.ws.onmessage = event => {
        const message = JSON.parse(event.data);
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error('CDP_COMMAND_FAILED'));
        else pending.resolve(message.result);
      };
    });
  }

  send(method, params = {}, timeoutMs = 300000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP_COMMAND_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error('RENDERER_EVALUATION_FAILED');
    return result.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return { port, release: () => new Promise(resolve => server.close(resolve)) };
}

async function debuggerTarget(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const body = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/json/list`, response => {
          let data = '';
          response.on('data', chunk => { data += chunk; });
          response.on('end', () => resolve(data));
        });
        request.once('error', reject);
      });
      const targets = JSON.parse(body);
      const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('PACKAGED_APP_CDP_TARGET_NOT_FOUND');
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  let observed = false;
  const exited = new Promise(resolve => child.once('exit', () => { observed = true; resolve(); }));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (!observed) {
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('PACKAGED_APP_TERMINATION_TIMEOUT')), 5000))]);
  }
  if (!observed) throw new Error('PACKAGED_APP_TERMINATION_TIMEOUT');
}

async function exactProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('INVALID_RUNTIME_PID');
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
    });
    const startToken = stdout.trim();
    return startToken ? Object.freeze({ pid, startToken }) : null;
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}

async function assertExactProcessExited(identity) {
  if (!identity) return;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await exactProcessIdentity(identity.pid);
    if (!current || current.startToken !== identity.startToken) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`RUNTIME_PROCESS_DID_NOT_EXIT:${identity.pid}`);
}

async function listRegularFiles(directory) {
  try {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function main() {
  const appFlag = process.argv.indexOf('--app');
  const appPath = appFlag >= 0 ? process.argv[appFlag + 1] : '';
  if (!appPath) throw new Error('MISSING_APP_PATH');
  const resolvedApp = path.resolve(appPath);
  const executable = path.join(resolvedApp, 'Contents', 'MacOS', 'Voice Practice');
  if (!fs.existsSync(executable)) throw new Error('MISSING_PACKAGED_APP_EXECUTABLE');

  const omlxOnly = process.argv.includes('--omlx-only');
  const verifyOmlx = process.argv.includes('--verify-omlx');
  const verifyCancel = process.argv.includes('--verify-cancel');
  if (omlxOnly && (!verifyOmlx || verifyCancel)) throw new Error('INVALID_OMLX_ONLY_FLAGS');

  const { checkPackagedMacOsRuntime } = await import('./check-macos-runtime.mjs');
  const runtime = checkPackagedMacOsRuntime(resolvedApp);
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'voice-practice-macos-e2e-'));
  const reservation = await reservePort();
  const runtimeTempDirectory = path.join(userData, 'runtime-temp');
  let child;
  let client;
  let result;
  const runtimeProcessIdentities = [];
  try {
    await reservation.release();
    const env = buildPackagedRuntimeEnvironment({
      parentEnv: process.env,
      tempRoot: path.join(userData, 'launcher-temp'),
      verifiedModels: {},
      offline: true,
    });
    child = spawn(executable, [
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${reservation.port}`,
    ], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    const target = await debuggerTarget(reservation.port);
    let targetPath;
    try {
      targetPath = fileURLToPath(target.url);
    } catch {
      throw new Error('UNTRUSTED_PACKAGED_RENDERER_TARGET');
    }
    const expectedRendererRoot = path.join(resolvedApp, 'Contents', 'Resources', 'app.asar');
    const relativeTarget = path.relative(expectedRendererRoot, targetPath);
    if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget) || relativeTarget !== path.join('apps', 'web', 'index.html')) {
      throw new Error('UNTRUSTED_PACKAGED_RENDERER_TARGET');
    }
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    if (!omlxOnly) {
      result = await client.evaluate(`(async () => {
      if (!window.electronAPI) throw new Error('PRELOAD_API_MISSING');
      const health = await window.electronAPI.runtimeHealth();
      if (!health || health.protocol !== 1 || health.ready !== true || health.fake === true
          || health.platform !== 'darwin' || health.arch !== 'arm64'
          || health.selectedStt !== 'mlx-whisper' || health.selectedTts !== 'kokoro-python'
          || !Number.isSafeInteger(health.runtimeIdentity?.pid) || health.runtimeIdentity.pid <= 0
          || typeof health.runtimeIdentity?.processGeneration !== 'string' || !health.runtimeIdentity.processGeneration) {
        throw new Error('NATIVE_HEALTH_NOT_READY');
      }
      const tts = await window.electronAPI.synthKokoro({
        text: 'The quick brown fox jumps over the lazy dog.',
        voice: 'af_heart',
        speed: 1
      });
      if (!tts || tts.format !== 'audio/wav' || typeof tts.audio !== 'string' || !Number.isInteger(tts.sampleRate) || tts.sampleRate <= 0) throw new Error('TTS_RESULT_INVALID');
      const binary = atob(tts.audio);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      if (binary.slice(0, 4) !== 'RIFF' || binary.slice(8, 12) !== 'WAVE') throw new Error('TTS_WAV_INVALID');
      let formatValid = false;
      let dataBytes = 0;
      let nonZeroPcm = false;
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const id = binary.slice(offset, offset + 4);
        const size = view.getUint32(offset + 4, true);
        const start = offset + 8;
        const end = start + size;
        if (end > bytes.length) throw new Error('TTS_WAV_INVALID');
        if (id === 'fmt ' && size >= 16) {
          formatValid = view.getUint16(start, true) === 1
            && view.getUint16(start + 2, true) >= 1
            && view.getUint32(start + 4, true) === tts.sampleRate
            && view.getUint16(start + 14, true) === 16;
        }
        if (id === 'data') {
          dataBytes += size;
          for (let index = start; index + 1 < end; index += 2) {
            if (view.getInt16(index, true) !== 0) { nonZeroPcm = true; break; }
          }
        }
        offset = end + (size % 2);
      }
      if (!formatValid || dataBytes < 4800 || !nonZeroPcm) throw new Error('TTS_PCM_INVALID');
      const stt = await window.electronAPI.transcribeAudio({
        buffer: bytes.buffer,
        mimeType: 'audio/wav',
        language: 'en'
      });
      if (!stt || typeof stt.text !== 'string' || !stt.text.trim()) throw new Error('STT_RESULT_EMPTY');
      const expected = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog'];
      const actual = new Set(stt.text.toLowerCase().match(/[a-z0-9]+/g) || []);
      const matched = expected.filter(word => actual.has(word)).length;
      if (matched / expected.length < 0.6) throw new Error('STT_TRANSCRIPT_MISMATCH');

      return {
        protocol: health.protocol,
        platform: health.platform,
        arch: health.arch,
        sttBackend: health.selectedStt,
        ttsBackend: health.selectedTts,
        audioBase64Length: tts.audio.length,
        transcriptLength: stt.text.trim().length,
        runtimeIdentity: health.runtimeIdentity,
        fixtureAudio: tts.audio,
      };
    })()`);

    const initialIdentity = result.runtimeIdentity;
    if (!initialIdentity || !String(initialIdentity.executable).startsWith(path.join(userData, 'runtime-snapshots') + path.sep)) {
      throw new Error('EMBEDDED_RUNTIME_PROCESS_NOT_OBSERVED');
    }
    const initialProcessIdentity = await exactProcessIdentity(initialIdentity.pid);
    if (!initialProcessIdentity) throw new Error('EMBEDDED_RUNTIME_PID_NOT_OBSERVED');
    runtimeProcessIdentities.push(initialProcessIdentity);

    // In-flight native STT cancellation through the visible Stop control.
    let cancelInfo = null;
    if (verifyCancel) {
      const oldPid = initialIdentity.pid;
      const oldGeneration = initialIdentity.processGeneration;
      const fixtureAudio = JSON.stringify(result.fixtureAudio);
      const pendingOperation = client.evaluate(`(async () => {
        const binary = atob(${fixtureAudio});
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        try {
          await voiceRuntime.transcribe({ buffer: bytes.buffer, mimeType: 'audio/wav', language: 'en' });
          return { errorObserved: false, errorCode: '' };
        } catch (error) {
          const errorCode = String(error?.message || error);
          return { errorObserved: /RUNTIME_CANCELLED|aborted|VOICE_RUNTIME_STOPPED/i.test(errorCode), errorCode };
        }
      })()`);

      let beforeFiles = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        beforeFiles = await listRegularFiles(runtimeTempDirectory);
        if (beforeFiles.length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (beforeFiles.length === 0) throw new Error('CANCEL_TEMP_FILES_BEFORE_MISSING');

      const cancelEval = await client.evaluate(`(async () => {
        const isVisible = element => Boolean(element && element.getClientRects().length > 0);
        const stop = [...document.querySelectorAll('button')].find(button => isVisible(button) && button.classList.contains('btn-stop'));
        if (!stop) throw new Error('MISSING_VISIBLE_STOP_TRIGGER');
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('VISIBLE_STOP_ACK_TIMEOUT')), 10000);
          document.addEventListener('voice-runtime-cancelled', event => {
            clearTimeout(timer);
            resolve(event.detail);
          }, { once: true });
          document.addEventListener('voice-runtime-cancel-failed', () => {
            clearTimeout(timer);
            reject(new Error('VISIBLE_STOP_CANCEL_FAILED'));
          }, { once: true });
          stop.click();
        });
        return { cancelled: result?.cancelled === true };
      })()`);
      const pendingResult = await pendingOperation;
      if (!cancelEval.cancelled) throw new Error('CANCEL_OPERATION_NOT_CONFIRMED');
      if (!pendingResult.errorObserved) throw new Error('CANCELLED_REQUEST_DID_NOT_REJECT');

      let afterFiles = beforeFiles;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        afterFiles = await listRegularFiles(runtimeTempDirectory);
        if (afterFiles.length === 0) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (afterFiles.length !== 0) throw new Error('CANCEL_TEMP_FILES_REMAIN');

      const recovery = await client.evaluate(`(async () => {
        const health = await window.electronAPI.runtimeHealth();
        const tts = await voiceRuntime.synthesize({ text: 'Recovery voice check.', voice: 'af_heart', speed: 1 });
        if (!tts || tts.format !== 'audio/wav' || typeof tts.audio !== 'string' || tts.audio.length < 6400) {
          throw new Error('RECOVERY_TTS_INVALID');
        }
        return { health, audioLength: tts.audio.length };
      })()`);
      const identity = recovery.health?.runtimeIdentity;
      if (!recovery.health?.ready || !identity || identity.pid === oldPid
          || identity.processGeneration === oldGeneration) {
        throw new Error('RECOVERY_PROCESS_IDENTITY_NOT_DISTINCT');
      }
      const recoveryProcessIdentity = await exactProcessIdentity(identity.pid);
      if (!recoveryProcessIdentity) throw new Error('RECOVERY_RUNTIME_PID_NOT_OBSERVED');
      runtimeProcessIdentities.push(recoveryProcessIdentity);
      cancelInfo = {
        oldPid,
        newPid: identity.pid,
        beforeTempCount: beforeFiles.length,
        afterTempCount: afterFiles.length,
        recoveryAudioLength: recovery.audioLength,
      };
    }
    delete result.fixtureAudio;
    } else {
    result = {};
    }

    // Visible-renderer oMLX E2E check (S4)
    let omlxInfo = null;
    if (verifyOmlx) {
      omlxInfo = await client.evaluate(`(async () => {
        const isVisible = element => Boolean(element && element.getClientRects().length > 0);
        const visibleButton = (label, errorCode) => {
          const button = [...document.querySelectorAll('button')]
            .find(candidate => isVisible(candidate) && candidate.textContent?.includes(label));
          if (!button) throw new Error(errorCode);
          return button;
        };
        const rejectOmlxErrorBubble = (reply, turn) => {
          const productErrors = [
            /^Could not connect to /i,
            /^Authentication failed for /i,
            /^Model ".*" or the configured endpoint was not found/i,
            /^MODEL_REQUIRED:/i,
            /requires the Electron desktop app/i,
            /連線失敗|無法連線|連不上|未授權|請先.*設定/i,
          ];
          if (productErrors.some(pattern => pattern.test(reply))) {
            throw new Error('OMLX_ERROR_BUBBLE:TURN_' + turn);
          }
        };

        visibleButton('設定大腦 AI 模型', 'MISSING_VISIBLE_SETTINGS_TRIGGER').click();
        const settingsModal = document.getElementById('settingsModal');
        if (!isVisible(settingsModal)) throw new Error('SETTINGS_MODAL_NOT_VISIBLE');

        const presetEl = document.getElementById('directApiPreset');
        if (!isVisible(presetEl)) throw new Error('MISSING_VISIBLE_DIRECT_API_PRESET');
        presetEl.value = 'omlx';
        presetEl.dispatchEvent(new Event('change', { bubbles: true }));
        const apiBaseUrl = document.getElementById('apiBaseUrl');
        const apiKey = document.getElementById('apiKey');
        if (apiBaseUrl?.value !== 'http://127.0.0.1:8000/v1' || apiKey?.value !== '') {
          throw new Error('OMLX_FIXED_ENDPOINT_OR_CREDENTIAL_POLICY_FAILED');
        }

        visibleButton('從端點取得模型', 'MISSING_VISIBLE_MODEL_DISCOVERY_TRIGGER').click();

        const modelSelect = document.getElementById('modelSelect');
        if (!isVisible(modelSelect)) throw new Error('MISSING_VISIBLE_MODEL_SELECT');
        let modelsReady = false;
        for (let i = 0; i < 60; i += 1) {
          if (modelSelect.options.length > 0 && modelSelect.options[0].value && !modelSelect.options[0].value.includes('正在從端點取得')) {
            modelsReady = true;
            break;
          }
          await new Promise(r => setTimeout(r, 250));
        }
        if (!modelsReady || modelSelect.options.length === 0) throw new Error('OMLX_MODELS_EMPTY_OR_UNAVAILABLE');
        const count = modelSelect.options.length;

        modelSelect.selectedIndex = 0;
        if (!modelSelect.value || modelSelect.value.trim().toLowerCase() === 'auto') {
          throw new Error('OMLX_AUTO_MODEL_FORBIDDEN');
        }
        modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
        visibleButton('儲存設定', 'MISSING_VISIBLE_SAVE_SETTINGS_TRIGGER').click();
        await new Promise(r => setTimeout(r, 100));

        const inputEl = document.getElementById('userTextInput');
        if (!isVisible(inputEl)) throw new Error('MISSING_VISIBLE_USER_TEXT_INPUT');
        const chatBox = document.getElementById('chatBox');
        if (!isVisible(chatBox)) throw new Error('MISSING_VISIBLE_CHAT_BOX');
        const sendButton = visibleButton('發送', 'MISSING_VISIBLE_SEND_TRIGGER');

        // Turn 1
        const countBefore1 = chatBox.querySelectorAll('.chat-msg.assistant .msg-bubble').length;
        inputEl.value = 'Count to three. Reply with numbers only.';
        const t0 = performance.now();
        sendButton.click();

        let reply1 = '';
        for (let i = 0; i < 150; i += 1) {
          const bubbles = chatBox.querySelectorAll('.chat-msg.assistant .msg-bubble');
          if (bubbles.length > countBefore1) {
            reply1 = bubbles[bubbles.length - 1].textContent?.trim() || '';
            if (reply1.length > 0) break;
          }
          await new Promise(r => setTimeout(r, 200));
        }
        const t1 = performance.now();
        if (!reply1) throw new Error('OMLX_TURN1_EMPTY_REPLY');
        rejectOmlxErrorBubble(reply1, 1);
        if (!/(?:^|\\D)1\\D+2\\D+3(?:\\D|$)/.test(reply1)) throw new Error('OMLX_TURN1_UNEXPECTED_REPLY');
        const latency1 = Math.round(t1 - t0);

        // Turn 2
        const countBefore2 = chatBox.querySelectorAll('.chat-msg.assistant .msg-bubble').length;
        inputEl.value = 'Count from four to six. Reply with numbers only.';
        const t2 = performance.now();
        sendButton.click();

        let reply2 = '';
        for (let i = 0; i < 150; i += 1) {
          const bubbles = chatBox.querySelectorAll('.chat-msg.assistant .msg-bubble');
          if (bubbles.length > countBefore2) {
            reply2 = bubbles[bubbles.length - 1].textContent?.trim() || '';
            if (reply2.length > 0) break;
          }
          await new Promise(r => setTimeout(r, 200));
        }
        const t3 = performance.now();
        if (!reply2) throw new Error('OMLX_TURN2_EMPTY_REPLY');
        rejectOmlxErrorBubble(reply2, 2);
        if (!/(?:^|\\D)4\\D+5\\D+6(?:\\D|$)/.test(reply2)) throw new Error('OMLX_TURN2_UNEXPECTED_REPLY');
        const latency2 = Math.round(t3 - t2);

        return {
          modelCount: count,
          turn1Length: reply1.length,
          turn2Length: reply2.length,
          latency1,
          latency2
        };
      })()`);
    }

    result = { ...result, cancelInfo, omlxInfo };
  } finally {
    client?.close();
    try {
      await stopProcess(child);
      for (const identity of runtimeProcessIdentities) {
        await assertExactProcessExited(identity);
      }
    } finally {
      await fsp.rm(userData, { recursive: true, force: true });
    }
  }
  if (!omlxOnly) {
    console.log(`PACKAGED_APP_NATIVE_HEALTH_OK protocol=${result.protocol} platform=${result.platform} arch=${result.arch}`);
    console.log(`PACKAGED_APP_EMBEDDED_RUNTIME_OK runtimeSha256=${runtime.sha256}`);
    console.log(`PACKAGED_APP_IPC_TTS_OK backend=${result.ttsBackend} audioBase64Length=${result.audioBase64Length}`);
    console.log(`PACKAGED_APP_IPC_STT_OK backend=${result.sttBackend} transcriptLength=${result.transcriptLength}`);
  }
  if (result.cancelInfo) {
    console.log('PACKAGED_APP_PRODUCT_CANCEL_OK');
    console.log(`PACKAGED_APP_CANCEL_OLD_PID_EXITED old_pid=${result.cancelInfo.oldPid}`);
    console.log('PACKAGED_APP_CANCEL_TEMP_CLEANUP_OK');
    console.log(`PACKAGED_APP_CANCEL_RECOVERY_OK new_pid=${result.cancelInfo.newPid}`);
  }
  if (result.omlxInfo) {
    console.log(`PACKAGED_APP_OMLX_MODELS_OK count=${result.omlxInfo.modelCount}`);
    console.log(`PACKAGED_APP_OMLX_CHAT_2_TURNS_OK response_lengths=${result.omlxInfo.turn1Length},${result.omlxInfo.turn2Length} latency_ms=${result.omlxInfo.latency1},${result.omlxInfo.latency2}`);
  }
  console.log('PACKAGED_APP_PROCESS_CLEANUP_OK');
  if (!omlxOnly) console.log(`PACKAGED_APP_VOICE_ROUNDTRIP_OK runtimeSha256=${runtime.sha256}`);
}

main().catch(error => {
  console.error(`PACKAGED_APP_VOICE_E2E_FAILED:${error.message}`);
  process.exit(1);
});
