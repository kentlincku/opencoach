const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SidecarClient } = require('./sidecar-client.cjs');
const { RuntimeManager, resolveEmbeddedRuntime } = require('./runtime-manager.cjs');
const { validateEmbeddedRuntimeDirectory, REQUIRED_MACOS_RUNTIME_FILES } = require('./embedded-runtime-validator.cjs');
const {
  buildPackagedRuntimeEnvironment,
  createVerifiedRuntimeSnapshot,
  removeVerifiedRuntimeSnapshot,
} = require('./macos-runtime-security.cjs');
const { ModelManager } = require('./model-manager.cjs');
const { CredentialStore } = require('./credential-store.cjs');
const { ProviderBroker } = require('./provider-broker.cjs');
const { isHealthyRuntimeResponse } = require('./runtime-health.cjs');
const { SubscriptionAuthBroker } = require('./subscription-auth-broker.cjs');
const { enforceSingleInstance, restoreOrCreateWindow, writeSmokeResult } = require('./lifecycle.cjs');
const { buildDevelopmentSidecarEnvironment, buildPackagedSidecarEnvironment } = require('./sidecar-environment.cjs');
const { isTrustedMainFrame, assertTrustedSenderPolicy } = require('./ipc-sender-policy.cjs');
const { hasOfflineArtifacts, seedOfflineAssets } = require('./offline-artifacts-loader.cjs');
const { checkWindowsRuntime } = require('./windows-runtime-checker.cjs');

let mainWindow;
let sidecar;
let runtimeManager;
let modelManager;
let credentialStore;
let subscriptionTokenStore;
let providerBroker;
let subscriptionAuthBroker;
let trustedRendererUrl;
let runtimeSnapshot;
let runtimeTempRoot;
let applicationStartupComplete = false;
const activeVoiceControllers = new Map();
const isSmokeTest = process.argv.includes('--smoke-test');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const canStartApplication = enforceSingleInstance({ hasLock: hasSingleInstanceLock, isSmokeTest, app });
app.on('second-instance', () => {
  restoreOrCreateWindow({
    getWindow: () => mainWindow,
    createWindow,
    canCreate: applicationStartupComplete,
  }).catch(error => {
    console.error('Unable to restore application window', error);
  });
});
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_TTS_CHARS = 5000;
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/m4a', 'audio/wav', 'audio/ogg',
]);

function requireSidecar() {
  if (!sidecar) throw new Error('NATIVE_VOICE_RUNTIME_UNAVAILABLE');
  return sidecar;
}

function projectRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '../..');
}

function manifestPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'manifests', name)
    : path.join(projectRoot(), 'resources', name);
}

function createUnavailableRuntimeManager(reason) {
  return {
    status: async () => ({ state: 'unavailable', reason }),
    install: async () => { throw new Error(reason); },
    cancel: () => {},
  };
}

function createUnavailableModelManager(reason) {
  return {
    list: () => [],
    status: async () => ({ state: 'unavailable', reason }),
    install: async () => { throw new Error(reason); },
    cancel: () => {},
  };
}

async function initializeAssetManagers() {
  const userData = app.getPath('userData');
  credentialStore = new CredentialStore({ userData, safeStorage });
  subscriptionTokenStore = new CredentialStore({ userData, safeStorage, namespace: 'subscription' });
  providerBroker = new ProviderBroker({ credentialStore });
  subscriptionAuthBroker = new SubscriptionAuthBroker({
    credentialStore: subscriptionTokenStore,
    clientIds: {
      chatgpt: process.env.VOICE_OPENAI_CODEX_CLIENT_ID,
      grok: process.env.VOICE_XAI_OAUTH_CLIENT_ID,
    },
    grokScope: process.env.VOICE_XAI_OAUTH_SCOPE,
  });
  try {
    const runtimeManifest = JSON.parse(await fs.readFile(manifestPath('runtime-manifest.json'), 'utf8'));
    runtimeManager = new RuntimeManager({ userData, manifest: runtimeManifest, healthCheck: validateRuntimeEntrypoint, requireTrustedManifest: true });
  } catch (error) {
    console.error('Runtime manifest unavailable; native voice remains disabled', error);
    runtimeManager = createUnavailableRuntimeManager('RUNTIME_MANIFEST_UNAVAILABLE');
  }
  try {
    const modelManifest = JSON.parse(await fs.readFile(manifestPath('model-manifest.json'), 'utf8'));
    modelManager = new ModelManager({ userData, manifest: modelManifest, requireTrustedManifest: true });
  } catch (error) {
    console.error('Model manifest unavailable; native models remain disabled', error);
    modelManager = createUnavailableModelManager('MODEL_MANIFEST_UNAVAILABLE');
  }
}

function credentialPayload(payload, includeCredential = false) {
  const allowed = includeCredential ? ['providerId', 'credential'] : ['providerId'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !allowed.includes(key))
      || typeof payload.providerId !== 'string'
      || (includeCredential && typeof payload.credential !== 'string')) {
    throw new Error('INVALID_CREDENTIAL_REQUEST');
  }
  return payload;
}

function audioExtension(mimeType = '') {
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
  if (mimeType.includes('wav')) return '.wav';
  if (mimeType.includes('ogg')) return '.ogg';
  return '.webm';
}

function runtimeEnvironment(tempRoot, trustedVoice) {
  if (app.isPackaged) {
    if (process.platform === 'win32') {
      return buildPackagedSidecarEnvironment({ parent: process.env, tempRoot, trustedVoice });
    }
    return buildPackagedRuntimeEnvironment({
      parentEnv: process.env,
      tempRoot,
      verifiedModels: {},
      offline: true,
    });
  }
  if (process.platform === 'win32') return buildDevelopmentSidecarEnvironment({ parent: process.env, tempRoot });
  return { ...process.env, VOICE_RUNTIME_TEMP_DIR: tempRoot };
}

async function cleanupRuntimePrivateData() {
  if (runtimeSnapshot) {
    removeVerifiedRuntimeSnapshot(runtimeSnapshot, app.getPath('userData'));
    runtimeSnapshot = null;
  }
  if (runtimeTempRoot) {
    const expected = path.join(path.resolve(app.getPath('userData')), 'runtime-temp');
    if (path.resolve(runtimeTempRoot) !== expected) throw new Error('REFUSE_UNSAFE_RUNTIME_TEMP_DELETE');
    await fs.rm(runtimeTempRoot, { recursive: true, force: true });
    runtimeTempRoot = null;
  }
}

async function validateRuntimeEntrypoint(entrypoint) {
  const tempRoot = path.join(app.getPath('temp'), `voice-practice-runtime-health-${randomUUID()}`);
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const candidate = new SidecarClient({
    command: entrypoint,
    args: [],
    env: runtimeEnvironment(tempRoot),
    requestTimeoutMs: 10_000,
  });
  try {
    await candidate.start();
    const health = await candidate.request('runtime.health');
    return health?.protocol === 1 && isHealthyRuntimeResponse(health);
  } catch (error) {
    console.error('Candidate runtime health check failed', error);
    return false;
  } finally {
    await candidate.stop();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function startRuntime() {
  runtimeTempRoot = app.isPackaged
    ? path.join(path.resolve(app.getPath('userData')), 'runtime-temp')
    : path.join(app.getPath('temp'), 'voice-practice-runtime');
  await fs.mkdir(runtimeTempRoot, { recursive: true, mode: 0o700 });
  let command;
  let args;
  let validateBeforeSpawn = null;
  let envOverrides;
  let preparedRuntime;
  let preparedModel;
  if (!app.isPackaged && process.env.VOICE_RUNTIME_ENTRYPOINT) {
    command = process.env.VOICE_RUNTIME_ENTRYPOINT;
    args = [];
  } else if (app.isPackaged) {
    const embedded = await resolveEmbeddedRuntime({ resourcesPath: process.resourcesPath });
    if (process.platform === 'darwin') {
      if (!embedded || embedded.state !== 'embedded') throw new Error('EMBEDDED_MACOS_VOICE_RUNTIME_INVALID');
      runtimeSnapshot = createVerifiedRuntimeSnapshot({
        sourceDirectory: embedded.directory,
        userData: app.getPath('userData'),
      });
      command = runtimeSnapshot.entrypoint;
      args = [];
      const immutableDirectory = runtimeSnapshot.runtimeDir;
      const immutableTreeSha256 = runtimeSnapshot.treeSha256;
      validateBeforeSpawn = () => {
        const verified = validateEmbeddedRuntimeDirectory(immutableDirectory, {
          expectedPlatform: 'darwin-arm64', requireExecutable: true, requireTree: true,
          requiredFiles: REQUIRED_MACOS_RUNTIME_FILES,
        });
        if (verified.entrypoint !== command || verified.treeSha256 !== immutableTreeSha256) {
          throw new Error('RUNTIME_SNAPSHOT_CHANGED_BEFORE_SPAWN');
        }
      };
    } else {
      if (hasOfflineArtifacts({ resourcesPath: process.resourcesPath })) {
        const offline = await seedOfflineAssets({
          userData: app.getPath('userData'),
          resourcesPath: process.resourcesPath,
        });
        command = offline.runtimeEntrypoint;
        args = [];
        envOverrides = {
          VOICE_STT_BACKEND: 'faster-whisper',
          VOICE_FASTER_WHISPER_MODEL: offline.whisperDir,
          VOICE_TTS_BACKEND: 'kokoro-onnx',
          VOICE_KOKORO_ONNX_MODEL: offline.kokoroOnnxPath,
          VOICE_KOKORO_ONNX_VOICES: offline.kokoroVoicesPath,
          VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu',
        };
        validateBeforeSpawn = () => {
          checkWindowsRuntime(offline.runtimeDir);
        };
      } else {
        preparedRuntime = await runtimeManager.prepareLaunch();
        command = preparedRuntime.entrypoint;
        args = [];
        try {
          preparedModel = await modelManager.prepareAssets('kokoro');
          if (preparedModel.assets.onnx && preparedModel.assets.voices) {
            envOverrides = {
              VOICE_TTS_BACKEND: 'kokoro-onnx',
              VOICE_KOKORO_ONNX_MODEL: preparedModel.assets.onnx,
              VOICE_KOKORO_ONNX_VOICES: preparedModel.assets.voices,
              VOICE_KOKORO_EXECUTION_PROVIDER: runtimeManager.flavor === 'dml' ? 'directml' : 'cpu',
            };
          }
        } catch (error) {
          console.warn('Kokoro model status check skipped:', error.message);
        }
      }
    }
  } else {
    command = process.env.VOICE_RUNTIME_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    args = ['-u', path.join(projectRoot(), 'native/python/voice_runtime/server.py')];
  }
  const validatePlatformBeforeSpawn = validateBeforeSpawn;
  validateBeforeSpawn = () => {
    validatePlatformBeforeSpawn?.();
    preparedRuntime?.verify();
    preparedModel?.verify();
  };
  sidecar = new SidecarClient({
    command,
    args,
    env: runtimeEnvironment(runtimeTempRoot, envOverrides),
    beforeSpawn: validateBeforeSpawn,
    afterExit: async () => {
      await preparedModel?.cleanup();
      await preparedRuntime?.cleanup();
    },
  });
  await sidecar.start();
}

function isTrustedRendererUrl(value) {
  if (!trustedRendererUrl || typeof value !== 'string') return false;
  try {
    const candidate = new URL(value);
    candidate.hash = '';
    return candidate.href === trustedRendererUrl;
  } catch {
    return false;
  }
}

const trustedWebContents = new WeakSet();

function assertTrustedSender(event) {
  const targetWebContents = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow.webContents
    : (trustedWebContents.has(event?.sender) ? event.sender : null);
  const isTrusted = mainWindow
    ? isTrustedMainFrame(event, mainWindow.webContents)
    : (targetWebContents && isTrustedMainFrame(event, targetWebContents));
  if (!targetWebContents || !isTrusted) {
    throw new Error('UNTRUSTED_IPC_SENDER');
  }
  const senderUrl = String(event.senderFrame?.url || '');
  if (!isTrustedRendererUrl(senderUrl)) throw new Error('UNTRUSTED_IPC_ORIGIN');
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, payload) => {
    assertTrustedSender(event);
    return handler(event, payload);
  });
}

async function packagedRuntimeStatus() {
  if (!app.isPackaged) return runtimeManager.status();
  if (process.platform === 'darwin') {
    const embedded = await resolveEmbeddedRuntime({ resourcesPath: process.resourcesPath });
    if (!embedded) return { state: 'unavailable', reason: 'EMBEDDED_MACOS_VOICE_RUNTIME_INVALID' };
    const verified = validateEmbeddedRuntimeDirectory(embedded.directory, {
      expectedPlatform: 'darwin-arm64', requireExecutable: true, requireTree: true,
      requiredFiles: REQUIRED_MACOS_RUNTIME_FILES,
    });
    return Object.freeze({
      state: 'embedded', platformKey: verified.platform, directory: verified.runtimeDir,
      entrypoint: verified.entrypoint, bytes: verified.bytes, sha256: verified.sha256,
      fileCount: verified.fileCount, treeSha256: verified.treeSha256,
    });
  }
  if (hasOfflineArtifacts({ resourcesPath: process.resourcesPath })) {
    try {
      const offline = await seedOfflineAssets({
        userData: app.getPath('userData'),
        resourcesPath: process.resourcesPath,
      });
      const check = checkWindowsRuntime(offline.runtimeDir);
      return Object.freeze({
        state: 'installed',
        platformKey: 'win32-x64-cpu',
        directory: offline.runtimeDir,
        entrypoint: offline.runtimeEntrypoint,
        fileCount: check.fileCount,
        treeDigest: check.treeDigest,
      });
    } catch (error) {
      return { state: 'unavailable', reason: 'OFFLINE_RUNTIME_CORRUPTED', detail: error.message };
    }
  }
  return runtimeManager.status();
}

function registerIpc() {
  trustedHandle('credential:has', (_event, payload) => {
    const { providerId } = credentialPayload(payload);
    return credentialStore.has(providerId);
  });
  trustedHandle('credential:set', (_event, payload) => {
    const { providerId, credential } = credentialPayload(payload, true);
    return credentialStore.set(providerId, credential);
  });
  trustedHandle('credential:clear', (_event, payload) => {
    const { providerId } = credentialPayload(payload);
    return credentialStore.clear(providerId);
  });
  trustedHandle('provider:operation', (_event, payload) => providerBroker.operation(payload));
  trustedHandle('runtime:status', () => packagedRuntimeStatus());
  trustedHandle('subscription:capabilities', () => subscriptionAuthBroker.capabilities());
  trustedHandle('subscription:begin-login', (_event, payload) => subscriptionAuthBroker.beginLogin(payload));
  trustedHandle('subscription:poll-login', (_event, payload) => subscriptionAuthBroker.pollLogin(payload));
  trustedHandle('subscription:cancel-login', (_event, payload) => subscriptionAuthBroker.cancelLogin(payload));
  trustedHandle('subscription:status', (_event, payload) => subscriptionAuthBroker.status(payload));
  trustedHandle('subscription:logout', (_event, payload) => subscriptionAuthBroker.logout(payload));
  trustedHandle('subscription:operation', (_event, payload) => subscriptionAuthBroker.operation(payload));

  trustedHandle('runtime:install', async () => {
    if (app.isPackaged && process.platform === 'darwin') return packagedRuntimeStatus();
    const result = await runtimeManager.install();
    if (!sidecar) startRuntime().catch(error => console.error('Installed runtime could not start', error));
    return result;
  });
  trustedHandle('runtime:cancel', () => { runtimeManager.cancel(); return { cancelled: true }; });
  trustedHandle('models:list', () => modelManager.list());
  trustedHandle('models:status', (_event, payload) => modelManager.status(String(payload?.modelId || '')));
  trustedHandle('models:install', (_event, payload) => modelManager.install(String(payload?.modelId || '')));
  trustedHandle('models:cancel', (_event, payload) => { modelManager.cancel(String(payload?.modelId || '')); return { cancelled: true }; });
  trustedHandle('voice:health', async () => {
    const client = requireSidecar();
    const health = await client.request('runtime.health');
    const runtimeIdentity = client.identity();
    if (!runtimeIdentity) throw new Error('VOICE_RUNTIME_IDENTITY_UNAVAILABLE');
    return { ...health, runtimeIdentity };
  });
  trustedHandle('voice:cancel', async (_event, payload) => {
    const requestId = String(payload?.requestId || '');
    if (requestId && activeVoiceControllers.has(requestId)) {
      const controller = activeVoiceControllers.get(requestId);
      activeVoiceControllers.delete(requestId);
      controller.abort();
      await requireSidecar().stop();
      return { cancelled: true };
    }
    return { cancelled: false };
  });
  trustedHandle('voice:tts', async (_event, payload) => {
    if (typeof payload?.text !== 'string') throw new Error('INVALID_TTS_TEXT');
    const text = payload.text;
    if (!text || text.length > MAX_TTS_CHARS) throw new Error('INVALID_TTS_TEXT_LENGTH');
    const requestId = typeof payload?.requestId === 'string' && payload.requestId.length <= 128 ? payload.requestId : null;
    const controller = new AbortController();
    if (requestId) activeVoiceControllers.set(requestId, controller);
    try {
      const result = await requireSidecar().request('tts.synthesize', { ...payload, text }, { signal: controller.signal });
      return { ...result, success: true };
    } finally {
      if (requestId) activeVoiceControllers.delete(requestId);
    }
  });
  trustedHandle('voice:stt', async (_event, payload) => {
    const mimeType = String(payload?.mimeType || 'audio/webm').toLowerCase();
    if (!ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) throw new Error('UNSUPPORTED_AUDIO_MIME_TYPE');
    const source = payload?.buffer;
    if (!source) throw new Error('MISSING_AUDIO_PAYLOAD');
    const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
    if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) throw new Error('AUDIO_PAYLOAD_TOO_LARGE');
    const requestId = typeof payload?.requestId === 'string' && payload.requestId.length <= 128 ? payload.requestId : null;
    const controller = new AbortController();
    if (requestId) activeVoiceControllers.set(requestId, controller);
    const tempRoot = runtimeTempRoot;
    if (!tempRoot) throw new Error('RUNTIME_TEMP_ROOT_UNAVAILABLE');
    await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const tempPath = path.join(tempRoot, `${randomUUID()}${audioExtension(mimeType)}`);
    await fs.writeFile(tempPath, buffer, { mode: 0o600 });
    try {
      const result = await requireSidecar().request('stt.transcribe', {
        audioPath: tempPath,
        language: payload.language || 'en',
      }, { signal: controller.signal });
      return { ...result, success: true };
    } finally {
      if (requestId) activeVoiceControllers.delete(requestId);
      await fs.rm(tempPath, { force: true });
    }
  });
}

async function createWindow() {
  const rendererPath = path.join(projectRoot(), 'apps/web/index.html');
  trustedRendererUrl = pathToFileURL(rendererPath).href;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 850,
    minWidth: 360,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  trustedWebContents.add(mainWindow.webContents);
  const electronSession = mainWindow.webContents.session;
  electronSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => callback({ cancel: details.resourceType === 'script' })
  );
  electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = String(details?.requestingUrl || webContents.getURL() || '');
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const audioOnly = mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio');
    const trusted = webContents === mainWindow.webContents && isTrustedRendererUrl(requestingUrl);
    callback(trusted && permission === 'media' && audioOnly);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  const createdWindow = mainWindow;
  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });
  await mainWindow.loadFile(rendererPath);
}

app.whenReady().then(async () => {
  if (!canStartApplication) return;
  await initializeAssetManagers();
  registerIpc();
  if (isSmokeTest) {
    await createWindow();
    const title = mainWindow.webContents.getTitle();
    if (!title) throw new Error('PACKAGED_APP_SMOKE_EMPTY_TITLE');
    const smokeMarker = `PACKAGED_APP_SMOKE_OK:${title}`;
    if (process.env.VOICE_PRACTICE_SMOKE_RESULT_FILE) {
      await writeSmokeResult({
        filePath: process.env.VOICE_PRACTICE_SMOKE_RESULT_FILE,
        tempRoot: app.getPath('temp'),
        marker: smokeMarker,
      });
    }
    console.log(smokeMarker);
    mainWindow?.destroy();
    app.exit(0);
    return;
  }
  try {
    await startRuntime();
  } catch (error) {
    console.error('Native voice runtime unavailable; browser fallbacks remain active', error);
    await sidecar?.stop();
    sidecar = null;
    await cleanupRuntimePrivateData();
  }
  await createWindow();
  applicationStartupComplete = true;
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => {
  console.error('Desktop startup failed', error);
  app.quit();
});

const cleanupAndExit = async () => {
  try {
    await sidecar?.stop();
    sidecar = null;
    await cleanupRuntimePrivateData();
    app.exit(0);
  } catch (error) {
    console.error('Voice runtime termination failed', error);
  }
};
process.on('SIGTERM', cleanupAndExit);
process.on('SIGINT', cleanupAndExit);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async (e) => {
  subscriptionAuthBroker?.dispose();
  if (sidecar) {
    e.preventDefault();
    const sc = sidecar;
    try {
      await sc.stop();
      if (sidecar === sc) sidecar = null;
      await cleanupRuntimePrivateData();
      app.quit();
    } catch (error) {
      console.error('Voice runtime termination failed', error);
    }
  }
});
