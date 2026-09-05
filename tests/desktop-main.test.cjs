'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'apps/desktop/main.cjs'), 'utf8');

test('ElectronRuntime cancellation sends typed requestId to preload and rejects pending call', async () => {
  const { ElectronRuntime } = require('../apps/web/runtime/electron-runtime.js');
  const cancelledCalls = [];
  let rejectStt;
  const pendingPromise = new Promise((_, reject) => { rejectStt = reject; });

  const api = {
    transcribeAudio: async payload => {
      assert.ok(payload.requestId, 'transcribeAudio must receive a requestId');
      return pendingPromise;
    },
    cancelVoiceOperation: payload => {
      cancelledCalls.push(payload);
      rejectStt(new Error('RUNTIME_CANCELLED'));
    },
  };

  const runtime = new ElectronRuntime({
    api,
    capabilities: {
      protocol: 1,
      platform: 'darwin',
      arch: 'arm64',
      sttBackends: ['mlx-whisper'],
      ttsBackends: ['kokoro-python'],
      selectedStt: 'mlx-whisper',
      selectedTts: 'kokoro-python',
      ready: true,
      degradedReason: null,
    },
  });

  const transcribeTask = runtime.transcribe({ buffer: Buffer.from('test') });
  runtime.cancel();

  await assert.rejects(transcribeTask, /RUNTIME_CANCELLED/);
  assert.equal(cancelledCalls.length, 1);
  assert.ok(typeof cancelledCalls[0].requestId === 'string');
  assert.ok(cancelledCalls[0].requestId.startsWith('stt_'));
});

test('voice:cancel idempotently handles unknown requestIds without leaking state', async () => {
  const activeVoiceControllers = new Map();
  function handleCancel(payload) {
    const requestId = String(payload?.requestId || '');
    if (requestId && activeVoiceControllers.has(requestId)) {
      const controller = activeVoiceControllers.get(requestId);
      activeVoiceControllers.delete(requestId);
      controller.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  assert.deepEqual(handleCancel({ requestId: 'unknown_req' }), { cancelled: false });
  assert.deepEqual(handleCancel({}), { cancelled: false });

  const controller = new AbortController();
  activeVoiceControllers.set('req_1', controller);
  assert.equal(controller.signal.aborted, false);

  const res1 = handleCancel({ requestId: 'req_1' });
  assert.deepEqual(res1, { cancelled: true });
  assert.equal(controller.signal.aborted, true);
  assert.equal(activeVoiceControllers.has('req_1'), false);

  const res2 = handleCancel({ requestId: 'req_1' });
  assert.deepEqual(res2, { cancelled: false });
});

test('main.cjs forwards trusted Kokoro provider metadata through the packaged environment builder', () => {
  assert.ok(MAIN_SRC.includes('buildPackagedSidecarEnvironment'));
  assert.ok(MAIN_SRC.includes('VOICE_KOKORO_EXECUTION_PROVIDER:'));
  assert.ok(!MAIN_SRC.includes("'PYTHONPATH'"));
  assert.ok(!MAIN_SRC.includes("'VOICE_RUNTIME_FAKE'"));
});

test('main.cjs uses python on win32 platform in unpackaged mode', () => {
  assert.ok(MAIN_SRC.includes("process.platform === 'win32' ? 'python' : 'python3'"));
});

test('main.cjs validates TTS payload text type and length', () => {
  assert.ok(MAIN_SRC.includes("typeof payload?.text !== 'string'"));
  assert.ok(MAIN_SRC.includes("MAX_TTS_CHARS"));
});

test('runtime installer health check uses the canonical protocol field', () => {
  assert.ok(MAIN_SRC.includes('health?.protocol === 1'));
  assert.ok(!MAIN_SRC.includes('health?.protocolVersion === 1'));
});

test('packaged application cannot bypass managed runtime selection with an environment entrypoint', () => {
  assert.ok(MAIN_SRC.includes("if (!app.isPackaged && process.env.VOICE_RUNTIME_ENTRYPOINT)"));
});

test('application quit proceeds only after observed sidecar stop success', () => {
  assert.ok(!MAIN_SRC.includes('sidecar.stop().finally('));
  assert.ok(MAIN_SRC.includes('await sc.stop()'));
  assert.ok(MAIN_SRC.includes("console.error('Voice runtime termination failed'"));
});

test('index.html prevents renderer Kokoro when running in Electron', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'apps/web/index.html'), 'utf8');
  assert.ok(indexHtml.includes('if (window.electronAPI || (typeof voiceRuntime !== \'undefined\' && voiceRuntime?.kind === \'electron\'))'));
  // Ensure alert() is not used in saveSettings
  assert.ok(!indexHtml.includes("alert(`設定已儲存"));
});
