const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, Menu, MenuItem } = require('electron');
const { randomUUID, createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SidecarClient } = require('./sidecar-client.cjs');
const { VoiceOperationLedger } = require('./voice-operation-ledger.cjs');
const { RuntimeManager } = require('./runtime-manager.cjs');
const { selectRuntimeArtifact } = require('./runtime-manifest.cjs');
const { isCompatibleRuntimeProbe } = require('./runtime-health.cjs');
const { ModelManager } = require('./model-manager.cjs');
const { ASSET_LIMITS } = require('./tree-integrity.cjs');
const { assertManagedPath } = require('./runtime-paths.cjs');
const { prepareVoiceAssets, prepareHybridVoiceAssets, prepareProbeAssets, bindClientAssets } = require('./managed-asset-lease.cjs');
const { buildPackagedSidecarEnvironment } = require('./sidecar-environment.cjs');
const { CredentialStore } = require('./credential-store.cjs');
const { ProviderBroker } = require('./provider-broker.cjs');
const { SubscriptionAuth, SUBSCRIPTIONS } = require('./subscription-auth.cjs');
const { FoundationModelsService } = require('./foundation-models-service.cjs');
const { enforceSingleInstance, restoreOrCreateWindow } = require('./lifecycle.cjs');

let mainWindow;
let sidecar;
let runtimeManager;
let modelManager;
let nativeModelCatalog = null;
let hybridRuntimeSource = null;
let nativeRestartRequired = false;
let sttSelectionRestartRequired = false;
let nativeModelRefreshSerial = 0;
const nativeModelStates = new Map();
const hybridActiveModelIds = new Set();
// Models this launch bound, recorded before the sidecar finishes starting.
const hybridBoundModelIds = new Set();
let lastModelInstallation = null;
let credentialStore;
let providerBroker;
let subscriptionAuth;
let foundationModels;
let trustedRendererUrl;
let applicationStartupComplete = false;
let shuttingDown = false;
let shutdownPromise;
let quitAllowed = false;
let runtimeStartupPromise;
let applicationStartupPromise;
const ownedClients = new Map();
const ownedTasks = new Map();
const ownedAssetPreparations = new Set();
const voiceOperations = new VoiceOperationLedger();
let voiceDocument;

function assertVoiceOperation(record) {
  if (!(record.legacy ? record.isAllowed() : voiceOperations.allowed(record))) {
    throw new Error('VOICE_OPERATION_ADMISSION_CLOSED');
  }
}

function admitLegacyVoice(owner, work) {
  // Capture the original client/intent synchronously, without inventing wire IDs.
  // Sidecar owns the bounded permit set; ownedTasks already owns physical work.
  try {
    const client = requireSidecar();
    const record = { legacy: true, owner, client,
      isAllowed: () => owner?.live === true && !shuttingDown && !voiceOperations.fault };
    assertVoiceOperation(record);
    record.operation = client.createOperation(record.isAllowed);
    const detach = record.operation.subscribe(original => {
      if (original.status === 'unconfirmed') {
        voiceOperations.fault ||= 'termination-unconfirmed';
        voiceOperations.notifyFailure();
      }
    });
    const task = Promise.resolve().then(async () => {
      try {
        assertVoiceOperation(record);
        const result = await work(record);
        assertVoiceOperation(record);
        return result;
      } finally {
        // Unused validation/denial releases only its original capability. STT
        // joins that capability before input cleanup, never a current-client kill.
        try {
          if (!['completed', 'unconfirmed'].includes(record.operation.snapshot().status)) {
            try { await record.operation.cancel(); } catch {} // preserve legacy request error
          }
        } finally { detach(); }
      }
    }).finally(() => { ownedTasks.delete(task); });
    ownedTasks.set(task, { started: true, cancel: null, voice: record });
    return task;
  } catch (error) { return Promise.reject(error); } // legacy rejected-error API
}

function admitVoiceOperation(record, work) {
  let deliver;
  const reply = new Promise(resolve => { deliver = resolve; });
  let delivered = false;
  const settle = value => {
    if (delivered) return;
    delivered = true;
    deliver(value);
  };
  record.failReply = () => {
    if (delivered) return;
    // A shared stop updates all native receipts before notifying each listener.
    // Sample on this producer path before classifying a collateral failure.
    voiceOperations.producer(record, record.operation.snapshot());
    settle(voiceOperations.finish(record, { error: true, released: false }));
  };
  const operation = Promise.resolve().then(async () => {
    try {
      if (!delivered) voiceOperations.preparing(record);
      assertVoiceOperation(record);
      const result = await work();
      voiceOperations.producer(record, record.operation.snapshot());
      assertVoiceOperation(record);
      voiceOperations.finish(record, { error: false, released: true });
      settle(result);
    } catch (error) {
      record.requestTimedOut = /^VOICE_RUNTIME_REQUEST_TIMEOUT:/.test(error.message);
      // Join only the original capability, including unused/denied permits.
      // Its unused branch never cancels a healthy or replacement generation.
      if (!['completed', 'unconfirmed'].includes(record.operation.snapshot().status)) {
        try { await voiceOperations.cancel(record); } catch {}
      }
      voiceOperations.producer(record, record.operation.snapshot());
      settle(voiceOperations.finish(record, { error: true, released: record.filesReleased !== false }));
    }
  }).finally(() => { ownedTasks.delete(operation); });
  ownedTasks.set(operation, { started: true, cancel: null });
  return reply;
}

function ownClient(client, assets = null) {
  let confirm;
  const confirmed = new Promise(resolve => { confirm = resolve; });
  const record = { confirmed, confirm, attempt: null, cancellation: null, assets };
  ownedClients.set(client, record);
  const cancel = client.cancel.bind(client);
  client.cancel = (...args) => {
    const generation = client.processGeneration;
    const barrier = cancel(...args);
    // Preserve the exact cancellation result: Sidecar can clear stopPromise
    // before its async request rejection reaches Main (including failed kills).
    record.cancellation = { generation, barrier };
    return barrier;
  };
  return client;
}

function stopOwnedClient(client) {
  const record = ownedClients.get(client);
  if (!record) return Promise.resolve();
  // An explicit stop supersedes an earlier cancellation verdict.
  record.cancellation = null;
  if (record.attempt) return record.attempt;
  if (record.exited) {
    record.confirmed = new Promise(resolve => { record.confirm = resolve; });
    record.exited = false;
  }
  // Register before stop rejects callers; those callers await confirmation, not
  // the shutdown drain that in turn waits for their finally blocks.
  let resolveStop;
  let rejectStop;
  const stopped = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
  // Capture only still-owned legacy tasks before stop can reject/reenter them.
  // This attempt is new evidence for these original handles, not client history.
  const legacyDrains = [];
  for (const { voice } of ownedTasks.values()) {
    if (voice?.client !== client) continue;
    const drain = { client, operation: voice.operation, barrier: stopped, confirmed: false };
    voice.finalDrain = drain;
    legacyDrains.push([voice, drain]);
  }
  record.attempt = voiceOperations.finalStop(client, stopped).then(() => {
    for (const [voice, drain] of legacyDrains) {
      drain.confirmed = true;
      if (voice.finalDrain === drain) voice.confirmFinalStop?.();
    }
    record.exited = true;
    record.confirm();
  }).finally(() => { record.attempt = null; });
  // Revoke Sidecar's queued start token in this call stack, not a later microtask.
  try { resolveStop(client.stop()); } catch (error) { rejectStop(error); }
  return record.attempt;
}

async function waitForClientExit(client, existingStop = null) {
  const record = ownedClients.get(client);
  if (!record) { if (existingStop) await existingStop; return; }
  if (existingStop && record.exited) {
    record.confirmed = new Promise(resolve => { record.confirm = resolve; });
    record.exited = false;
  }
  const confirmation = record.confirmed;
  try {
    if (existingStop) {
      // Observe this termination, not the reusable client: another request may
      // already own a start intent behind the barrier. Do not revoke it or mark
      // that next generation exited when this older barrier resolves.
      await existingStop;
      return;
    }
    await stopOwnedClient(client);
  } catch (error) { console.error('Runtime exit unconfirmed; retaining owned resources', error); }
  // A failed passive wait retains resources until explicit shutdown retries;
  // an active stop may have renewed confirmation inside stopOwnedClient.
  await (existingStop ? confirmation : record.confirmed);
}

function admitTask(work, cancel) {
  assertAdmission();
  const record = { cancel, started: false };
  const operation = Promise.resolve().then(() => {
    assertAdmission();
    record.started = true;
    return work();
  }).finally(() => { ownedTasks.delete(operation); });
  ownedTasks.set(operation, record);
  return operation;
}
const customUserData = (app.commandLine?.getSwitchValue ? app.commandLine.getSwitchValue('user-data-dir') : null) || process.env.VOICE_USER_DATA_DIR;
if (customUserData && typeof app.setPath === 'function') {
  app.setPath('userData', path.resolve(customUserData));
}
const appLaunchNonce = (() => {
  const switchVal = app.commandLine?.getSwitchValue ? app.commandLine.getSwitchValue('app-launch-nonce') : null;
  if (switchVal && /^[a-zA-Z0-9_-]{8,64}$/.test(switchVal)) return switchVal;
  if (Array.isArray(process.argv)) {
    for (const arg of process.argv) {
      if (typeof arg === 'string' && arg.startsWith('--app-launch-nonce=')) {
        const val = arg.slice('--app-launch-nonce='.length).trim();
        if (/^[a-zA-Z0-9_-]{8,64}$/.test(val)) return val;
      }
    }
  }
  return process.env.VOICE_LAUNCH_NONCE || randomUUID();
})();
const appLifecycleSecret = (() => {
  let secret = process.env.VOICE_LIFECYCLE_SECRET || null;
  if (secret) {
    delete process.env.VOICE_LIFECYCLE_SECRET;
  }
  if (secret && /^[a-fA-F0-9]{32,128}$/.test(secret)) {
    return secret;
  }
  return randomBytes(32).toString('hex');
})();
const authorizedTrustedRoot = (() => {
  const root = process.env.VOICE_TRUSTED_ROOT || null;
  if (process.env.VOICE_TRUSTED_ROOT) {
    delete process.env.VOICE_TRUSTED_ROOT;
  }
  return root;
})();
let lastKnownHelperPid = null;
let lifecycleReceiptSeq = 0;

// Shared receipt contract generates SHA-256 HMAC with secret via createHmac('sha256', secret)
const {
  CANONICAL_FIELD_NAMES,
  ALLOWED_RECEIPT_KEYS,
  validateReceiptPathPolicy,
  validateReceiptFileMetadata,
  validateCanonicalReceiptSchema,
  canonicalReceiptPayload,
  computeReceiptSignature,
  verifyReceiptSignature,
  CONTRACT_DIGEST,
  getContractDigest
} = require('./receipt-contract.cjs');

function safeWriteReceiptFile(dirPath, filename, data, { trustedRoot = null } = {}) {
  if (!dirPath || typeof dirPath !== 'string' || !filename || typeof filename !== 'string') {
    return false;
  }
  let tempPath = null;
  let fd = null;
  try {
    const destPath = path.join(dirPath, filename);
    const root = trustedRoot || authorizedTrustedRoot || (typeof app !== 'undefined' && app?.getPath ? app.getPath('appData') : null);
    if (!root) {
      return false;
    }

    const tokenBefore = validateReceiptPathPolicy(destPath, { trustedRoot: root });

    if (!syncFs.existsSync(dirPath)) return false;
    const dirStat = syncFs.lstatSync(dirPath);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      return false;
    }

    if (syncFs.existsSync(destPath)) {
      const destStat = syncFs.lstatSync(destPath);
      if (destStat.isSymbolicLink() || !destStat.isFile()) {
        return false;
      }
    }

    const tempName = `.${filename}.tmp.${randomBytes(8).toString('hex')}`;
    tempPath = path.join(dirPath, tempName);
    const content = JSON.stringify(data, null, 2);

    fd = syncFs.openSync(tempPath, 'wx', 0o600);
    syncFs.writeFileSync(fd, content, 'utf8');
    syncFs.fsyncSync(fd);
    syncFs.closeSync(fd);
    fd = null;

    syncFs.renameSync(tempPath, destPath);
    tempPath = null;

    try {
      const dirFd = syncFs.openSync(dirPath, 'r');
      try { syncFs.fsyncSync(dirFd); } finally { syncFs.closeSync(dirFd); }
    } catch {}

    const tokenAfter = validateReceiptPathPolicy(destPath, { trustedRoot: root });
    validateReceiptFileMetadata(destPath);
    if (tokenBefore.realTargetDir !== tokenAfter.realTargetDir) {
      try { syncFs.unlinkSync(destPath); } catch {}
      return false;
    }

    return true;
  } catch {
    if (fd !== null) {
      try { syncFs.closeSync(fd); } catch {}
    }
    if (tempPath && syncFs.existsSync(tempPath)) {
      try { syncFs.unlinkSync(tempPath); } catch {}
    }
    return false;
  }
}

function writeRunningHelperLifecycleReceipt(pid) {
  try {
    const userData = app.getPath('userData');
    if (!userData) return;
    const targetRoot = authorizedTrustedRoot || (app?.getPath ? app.getPath('appData') : null);
    const sessionNonce = appLaunchNonce;
    const ownerId = 'main-authority';
    lifecycleReceiptSeq++;
    const receipt = {
      version: 1,
      type: 'MAIN_HELPER_LIFECYCLE_RECEIPT',
      launchNonce: appLaunchNonce,
      sessionNonce,
      ownerId,
      component: 'voice-foundation-models',
      helperKind: 'foundation-models',
      binaryName: 'voice-foundation-models',
      helperPid: pid,
      status: 'running',
      exited: false,
      reaped: false,
      exitCode: null,
      signalCode: null,
      seq: lifecycleReceiptSeq,
      issuedAt: Date.now(),
      authSignature: ''
    };
    receipt.authSignature = computeReceiptSignature(appLifecycleSecret, receipt);
    safeWriteReceiptFile(userData, 'helper-lifecycle-receipt.json', receipt, { trustedRoot: targetRoot });
  } catch {}
}

// Launch-lifetime sticky verdict survives release/delete without retaining clients.
let releasedRuntimeHistoryClean = true;
function writeTerminalHelperLifecycleReceipt(exitCode = 0, signalCode = null) {
  try {
    if (!releasedRuntimeHistoryClean) return false;
    const userData = app.getPath('userData');
    if (!userData) return false;
    const targetRoot = authorizedTrustedRoot || (app?.getPath ? app.getPath('appData') : null);
    const { requireOwnedProcessClosure } = require('./owned-process-lifetime.cjs');
    // This Main authority is emitted only after the complete owned shutdown
    // set, including speech/probe clients, has settled. No PID/name polling.
    for (const [client, record] of ownedClients) {
      if (!record.exited) return false;
      const runtimeHistory = requireOwnedProcessClosure(client);
      if (client.process && runtimeHistory.length === 0) return false;
      const assets = client.assetLifetimeSnapshot?.();
      if (assets && (assets.pendingPreparation || assets.unresolvedGenerations || assets.unknown || assets.fault)) return false;
    }
    const history = foundationModels?.client ? requireOwnedProcessClosure(foundationModels.client) : [];
    if (foundationModels?.client?.proc && history.length === 0) return false;
    const pid = history.at(-1)?.pid || null;
    const sessionNonce = appLaunchNonce;
    const ownerId = 'main-authority';
    lifecycleReceiptSeq++;
    const finalSignalCode = (typeof signalCode === 'string' && signalCode.trim() !== '') ? signalCode : null;
    const finalExitCode = finalSignalCode !== null ? null : (Number.isSafeInteger(exitCode) ? exitCode : 0);
    const receipt = {
      version: 1,
      type: 'MAIN_HELPER_LIFECYCLE_RECEIPT',
      launchNonce: appLaunchNonce,
      sessionNonce,
      ownerId,
      component: 'voice-foundation-models',
      helperKind: 'foundation-models',
      binaryName: 'voice-foundation-models',
      helperPid: pid,
      status: 'exited',
      exited: true,
      reaped: true,
      exitCode: finalExitCode,
      signalCode: finalSignalCode,
      seq: lifecycleReceiptSeq,
      issuedAt: Date.now(),
      authSignature: ''
    };
    receipt.authSignature = computeReceiptSignature(appLifecycleSecret, receipt);
    return safeWriteReceiptFile(userData, 'helper-lifecycle-receipt.json', receipt, { trustedRoot: targetRoot });
  } catch { return false; }
}
const isSmokeTest = (Array.isArray(process.argv) && process.argv.includes('--smoke-test')) || Boolean(app.commandLine?.hasSwitch?.('smoke-test'));
const hasSingleInstanceLock = typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true;
const canStartApplication = enforceSingleInstance({ hasLock: hasSingleInstanceLock, isSmokeTest, app });
if (typeof app.on === 'function') app.on('second-instance', () => {
  if (shuttingDown) return;
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
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function requireSidecar() {
  assertAdmission();
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

async function readBundledAssetJson(name) {
  if (!['runtime-manifest.json', 'model-manifest.json', 'speech-model-capabilities.json'].includes(name)) throw new Error('ASSET_MANIFEST_NAME');
  const filename = manifestPath(name);
  assertManagedPath(path.dirname(filename), filename);
  const handle = await fs.open(filename, fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('ASSET_MANIFEST_NOT_FILE');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > ASSET_LIMITS.maxMetadataBytes) {
      throw new Error('ASSET_MANIFEST_LIMIT');
    }
    // Bounded before parsing; one extra byte rejects growth after stat.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('ASSET_MANIFEST_CHANGED');
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally { await handle.close(); }
}

async function readBundledAssetManifest(name) {
  return require('./asset-manifest-trust.cjs').authenticateAssetManifest(
    await readBundledAssetJson(name), name === 'runtime-manifest.json' ? 'runtime' : 'model');
}

async function initializeAssetManagers() {
  nativeModelCatalog = null;
  nativeModelStates.clear();
  ++nativeModelRefreshSerial;
  const userData = app.getPath('userData');
  credentialStore = new CredentialStore({ userData, safeStorage });
  subscriptionAuth = new SubscriptionAuth({ credentialStore });
  providerBroker = new ProviderBroker({ credentialStore, subscriptionAuth, claudeCodeVersion: detectClaudeCodeVersion });
  try {
    const runtimeManifest = await readBundledAssetManifest('runtime-manifest.json');
    runtimeManager = new RuntimeManager({ userData, manifest: runtimeManifest, healthCheck: validateRuntimeEntrypoint });
  } catch (error) {
    console.error('Runtime manifest unavailable; native voice remains disabled', error);
    runtimeManager = createUnavailableRuntimeManager('RUNTIME_MANIFEST_UNAVAILABLE');
  }
  try {
    const modelManifest = await readBundledAssetManifest('model-manifest.json');
    modelManager = new ModelManager({ userData, manifest: modelManifest });
    const trust = app.isPackaged ? bundledVoiceTrust() : null;
    if (trust?.schemaVersion === 2) {
      const catalog = await readBundledAssetJson('speech-model-capabilities.json');
      // Fixed per-host parser: darwin -> darwin-arm64, win32 -> win32-x64-cpu.
      nativeModelCatalog = require('./macos-model-catalog.cjs').parseNativeModelCatalogFor(process.platform, catalog, trust, modelManager.manifest);
      await refreshNativeModelStates();
    }
  } catch (error) {
    nativeModelCatalog = null;
    console.error('Model manifest unavailable; native models remain disabled', error);
    modelManager = createUnavailableModelManager('MODEL_MANIFEST_UNAVAILABLE');
  }
}

async function refreshNativeModelStates() {
  const serial = ++nativeModelRefreshSerial;
  if (!nativeModelCatalog) return;
  for (const capability of nativeModelCatalog.models) {
    let status;
    try { status = await modelManager.status(capability.id); }
    catch { status = { state: 'unavailable', reason: 'MODEL_STATUS_UNAVAILABLE' }; }
    if (serial !== nativeModelRefreshSerial || shuttingDown) return;
    nativeModelStates.set(capability.id, Object.freeze({
      state: status.state === 'installed' ? 'installed' : 'missing',
      generation: typeof status.generation === 'string' ? status.generation : null,
    }));
  }
}

function nativeModelInstallationView(action) {
  if (!action || action.kind !== 'model') return null;
  return Object.freeze({
    actionId: action.actionId,
    modelId: action.id,
    phase: action.phase || 'confirming',
    bytes: action.bytes || 0,
    total: action.total || 0,
    cancelled: Boolean(action.cancelled),
    restartRequired: Boolean(action.restartRequired),
    ...(action.errorCode ? { errorCode: action.errorCode } : {}),
  });
}

// Spec: with no stored choice, the device recommendation is used; the catalog
// default only when the recommendation does not map to an allowed tier.
function sttRecommendation(allowed) {
  const { recommendSttTier, detectAvx2, TIERS } = require('./stt-recommendation.cjs');
  const os = require('node:os');
  const tiers = allowed.length === TIERS.length ? Object.fromEntries(allowed.map((id, i) => [id, TIERS[i]])) : {};
  const recommendation = recommendSttTier({ platform: process.platform, arch: process.arch,
    totalMemBytes: os.totalmem(), avx2: process.platform === 'win32' ? detectAvx2(os.cpus()) : undefined });
  const recommendedId = allowed.find(id => tiers[id] === recommendation.tier) || null;
  return { tiers, recommendation, recommendedId };
}
function defaultSttModelId(allowed) {
  return sttRecommendation(allowed).recommendedId || nativeModelCatalog.defaultSttModelId;
}

// Main-owned STT choice state for the overview and the remove gate.
function sttChoiceState() {
  if (!nativeModelCatalog || !Array.isArray(nativeModelCatalog.sttChoices) || !nativeModelCatalog.sttChoices.length) return null;
  const { readPreference, selectedSttModel } = require('./stt-model-preference.cjs');
  const { tierWarning } = require('./stt-recommendation.cjs');
  const allowed = nativeModelCatalog.sttChoices;
  const { tiers, recommendation, recommendedId } = sttRecommendation(allowed);
  let selected = null, preferenceError = null;
  try {
    selected = selectedSttModel({ preference: readPreference(app.getPath('userData')), language: 'en', allowed,
      defaultId: recommendedId || nativeModelCatalog.defaultSttModelId });
  } catch (error) {
    const code = String(error?.message || '');
    preferenceError = /^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code : 'STT_PREFERENCE_UNREADABLE';
  }
  return Object.freeze({ allowed, tiers, selected, preferenceError, recommendation, recommendedId,
    warning: id => tierWarning(process.platform, tiers[id]) });
}

// Ids that must not be removed: what the running sidecar bound, the current-language
// selection (or default when unset/invalid), and every TTS binding.
function protectedModelIds(choice) {
  const ids = new Set(hybridActiveModelIds);
  for (const capability of nativeModelCatalog?.models || []) if (capability.kind === 'tts') ids.add(capability.id);
  ids.add(choice?.selected?.modelId || choice?.recommendedId || nativeModelCatalog?.defaultSttModelId);
  return ids;
}

function nativeModelOverview() {
  let trust;
  try { trust = app.isPackaged ? bundledVoiceTrust() : null; } catch { trust = null; }
  const mode = trust?.schemaVersion === 2 ? 'runtime-only' : trust?.schemaVersion === 1 ? 'bundled'
    : app.isPackaged ? 'managed' : 'unavailable';
  const choice = mode === 'runtime-only' ? sttChoiceState() : null;
  const keep = choice ? protectedModelIds(choice) : new Set();
  const busy = Boolean(installationAction) || modelManager?.active?.size > 0;
  const models = mode === 'runtime-only' && nativeModelCatalog ? nativeModelCatalog.models.flatMap(capability => {
    const model = modelManager.manifest?.models[capability.id];
    if (!model) return [];
    const artifact = model.artifacts[nativeModelCatalog.platformKey];
    if (!artifact) return [];
    const state = hybridActiveModelIds.has(capability.id) ? 'active' : nativeModelStates.get(capability.id)?.state || 'missing';
    const stt = capability.kind === 'stt' && choice ? {
      tier: choice.tiers[capability.id] || null,
      selected: choice.selected?.modelId === capability.id,
      recommended: choice.recommendedId === capability.id,
      warning: choice.warning(capability.id),
    } : {};
    return [Object.freeze({
      modelId: capability.id, name: model.name, kind: capability.kind,
      languages: Object.freeze([...capability.languages]), bytes: artifact.bytes,
      license: Object.freeze({ spdx: model.license.spdx, url: model.license.url }),
      state, restartRequired: nativeRestartRequired && state === 'installed',
      canRemove: state === 'installed' && !keep.has(capability.id) && !busy,
      ...stt,
    })];
  }) : [];
  return Object.freeze({
    version: 1, mode, platform: process.platform === 'win32' ? 'win32' : 'darwin',
    runtime: Object.freeze({ state: mode === 'bundled' || hybridRuntimeSource ? 'embedded' : 'unavailable' }),
    targetLanguage: 'en', enabledLanguages: Object.freeze([...(nativeModelCatalog?.enabledLanguages || ['en'])]),
    models: Object.freeze(models),
    stt: choice ? Object.freeze({
      selectedModelId: choice.selected?.modelId || null,
      source: choice.selected?.source || null,
      preferenceError: choice.preferenceError,
      recommendedModelId: choice.recommendedId,
      recommendationReason: choice.recommendation.reason,
    }) : null,
    installation: nativeModelInstallationView(installationAction || lastModelInstallation),
    restartRequired: nativeRestartRequired || sttSelectionRestartRequired,
  });
}

function selectSttModel(payload) {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).join() !== 'modelId' || typeof payload.modelId !== 'string') {
    throw new Error('INVALID_MODEL_REQUEST');
  }
  if (!nativeModelCatalog) throw new Error('NATIVE_MODEL_CATALOG_UNAVAILABLE');
  const pref = require('./stt-model-preference.cjs');
  const userData = app.getPath('userData');
  let current;
  try { current = pref.readPreference(userData); }
  catch { current = { schemaVersion: 1, stt: {} }; } // explicit user choice repairs an invalid file
  const next = pref.setSttPreference(current, 'en', payload.modelId, nativeModelCatalog.sttChoices);
  pref.writePreference(userData, next);
  // A different STT model only takes effect after a full Quit + relaunch; choosing the
  // model the running sidecar already uses clears the selection-driven restart.
  // Compare with what this launch bound (set before the sidecar finishes starting), so a
  // choice made while the runtime is still starting is not reported as already effective.
  // Nothing bound (runtime not started/failed): any choice needs a full relaunch to apply.
  sttSelectionRestartRequired = !hybridBoundModelIds.has(payload.modelId);
  return nativeModelOverview();
}

async function removeNativeModel(payload) {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).join() !== 'modelId' || typeof payload.modelId !== 'string') {
    throw new Error('INVALID_MODEL_REQUEST');
  }
  if (!nativeModelCatalog || !nativeModelCatalog.models.some(model => model.id === payload.modelId)) throw new Error('UNKNOWN_MODEL');
  if (installationAction) throw new Error('INSTALL_ALREADY_RUNNING');
  const choice = sttChoiceState();
  let result;
  try {
    result = await modelManager.remove(payload.modelId, { protectedIds: [...protectedModelIds(choice)] });
  } catch (error) {
    // A removal may fail part-way (e.g. a locked file on Windows): re-read the real state
    // instead of keeping a stale 'installed'. Launch still digest-verifies before use.
    if (!/^(MODEL_IN_USE|INSTALL_ALREADY_RUNNING|UNKNOWN_MODEL)/.test(String(error?.message))) {
      await refreshNativeModelStates().catch(() => {});
    }
    throw error;
  }
  ++nativeModelRefreshSerial;
  nativeModelStates.set(payload.modelId, Object.freeze({ state: 'missing', generation: null }));
  return Object.freeze({ ...result, overview: nativeModelOverview() });
}

let installationAction = null;
let installationMenu = null;
let installationStatus = '尚未安裝；語音可用性以健康檢查為準';

function refreshInstallationMenu() {
  if (!installationMenu) return;
  for (const item of installationMenu.items) {
    if (item.id === 'asset-status') item.label = installationStatus;
    else if (item.id === 'asset-cancel') {
      const original = installationAction;
      item.enabled = Boolean(original && !original.cancelled && !shuttingDown);
      item.click = () => cancelInstallation(original);
    } else if (item.id?.startsWith('asset-')) {
      item.enabled = item.installAvailable && !installationAction && !shuttingDown;
    }
  }
}

function setupInstallationMenu() {
  if ((process.platform !== 'win32' && process.platform !== 'darwin') || !applicationStartupComplete || shuttingDown || installationMenu) return;
  const entry = (kind, id, label, itemId) => {
    let available = false;
    try { installationSelection(kind, id); available = true; } catch {} // no published compatible artifact
    return {id: itemId, label: available ? label : `${label}（無相容發行資產）`, enabled: available,
      click: () => requestInstallation(kind, kind === 'model' ? {modelId: id} : undefined)
        .catch(() => ({state: 'unavailable', reason: 'INSTALLATION_FAILED'}))};
  };
  const trust = app.isPackaged ? bundledVoiceTrust() : null;
  const embedded = trust?.schemaVersion === 1 || trust?.schemaVersion === 2;
  if (embedded && !installationAction && !lastModelInstallation) {
    installationStatus = trust.schemaVersion === 1 ? '使用 App 內建語音資產；就緒狀態以健康檢查為準'
      : '模型可分包安裝；安裝與就緒狀態請查看設定';
  }
  const template = [embedded ? {id: 'asset-runtime', label: '執行環境隨 App 內建（不需另行下載）', enabled: false}
    : entry('runtime', null, '安裝原生執行環境…', 'asset-runtime')];
  for (const model of modelManager.list()) template.push(entry('model', model.id, `安裝模型：${model.name}…`, `asset-model-${model.id}`));
  if (template.length === 1) template.push({label: '沒有已發布的模型', enabled: false});
  template.push({type: 'separator'}, {id: 'asset-cancel', label: '取消目前安裝', enabled: false},
    {id: 'asset-status', label: installationStatus, enabled: false});
  installationMenu = Menu.buildFromTemplate(template);
  for (const item of installationMenu.items) item.installAvailable = item.enabled;
  // Keep Electron's actual default/custom menu items and their accelerators.
  const menu = Menu.getApplicationMenu() || Menu.buildFromTemplate([
    {role: 'fileMenu'}, {role: 'editMenu'}, {role: 'viewMenu'}, {role: 'windowMenu'}, {role: 'help'}]);
  menu.append(new MenuItem({label: '原生語音安裝', submenu: installationMenu}));
  Menu.setApplicationMenu(menu);
  refreshInstallationMenu();
}

function recordInstallationProgress(action, progress) {
  if (installationAction !== action || !action.started || action.cancelled || !progress
      || !Number.isSafeInteger(progress.bytes) || progress.bytes < action.bytes || progress.bytes > action.total
      || progress.total !== action.total) return;
  action.bytes = progress.bytes;
  action.phase = progress.phase === 'verifying' ? 'verifying' : 'downloading';
}

function cancelNativeModelInstallAction(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_MODEL_ACTION');
  const fields = Object.getOwnPropertyDescriptors(payload), keys = Reflect.ownKeys(fields);
  const id = fields.actionId;
  if (keys.length !== 1 || keys[0] !== 'actionId' || !id || !Object.hasOwn(id, 'value')
      || typeof id.value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id.value)) {
    throw new Error('INVALID_MODEL_ACTION');
  }
  assertAdmission();
  const action = installationAction;
  return cancelInstallation(action?.kind === 'model' && action.actionId === id.value ? action : null);
}

function cancelInstallation(original) {
  if (!original || installationAction !== original || original.cancelled) return {cancelled: false};
  original.cancelled = true;
  original.phase = 'cancelling';
  original.dialogController.abort();
  installationStatus = '已取消；等待原始作業結束';
  if (original.started) {
    if (original.kind === 'runtime') original.manager.cancel();
    else original.manager.cancel(original.id);
  }
  refreshInstallationMenu();
  return {cancelled: true};
}

function cancelInstallationRequest(kind, payload) {
  assertAdmission();
  const id = kind === 'model' ? installationModelId(payload) : null;
  const original = installationAction;
  return cancelInstallation(original?.kind === kind && original.id === id ? original : null);
}

function installationModelId(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_MODEL_REQUEST');
  const keys = Reflect.ownKeys(payload);
  const field = Object.getOwnPropertyDescriptor(payload, 'modelId');
  if (keys.length !== 1 || keys[0] !== 'modelId' || !field || !Object.hasOwn(field, 'value')
      || typeof field.value !== 'string' || !Object.hasOwn(modelManager.manifest?.models || {}, field.value)) {
    throw new Error('UNKNOWN_MODEL');
  }
  return field.value;
}

function installationSelection(kind, id) {
  const manager = kind === 'runtime' ? runtimeManager : modelManager;
  const manifest = manager.manifest;
  const selection = kind === 'runtime' ? manifest : manifest?.models[id];
  if (!selection) throw new Error('ASSET_MANIFEST_UNAVAILABLE');
  const options = kind === 'runtime' ? manager : manager.options;
  const artifact = selectRuntimeArtifact(selection, options.platform || process.platform,
    options.arch || process.arch, options.flavor || 'cpu');
  return {manager, artifact, name: kind === 'runtime' ? '原生語音執行環境' : selection.name,
    release: manifest.release, license: artifact.provenance.license.spdx};
}

async function requestInstallation(kind, payload) {
  assertAdmission();
  const id = kind === 'model' ? installationModelId(payload) : null;
  if (kind === 'runtime' && payload !== undefined) throw new Error('INVALID_RUNTIME_REQUEST');
  if (installationAction) throw new Error('INSTALL_ALREADY_RUNNING');
  const selected = installationSelection(kind, id);
  // Own the original intent before invoking any asynchronous native dialog.
  const action = {kind, id, actionId: randomUUID(), manager: selected.manager, started: false, cancelled: false,
    phase: 'confirming', bytes: 0, total: selected.artifact.bytes, restartRequired: false, dialogController: new AbortController()};
  installationAction = action;
  installationStatus = `等待同意：${selected.name}`;
  refreshInstallationMenu();
  try {
    const answer = await dialog.showMessageBox({type: 'question', title: '安裝原生語音資產',
      message: `下載並安裝 ${selected.name}？`,
      detail: `${selected.name}\n版本：${selected.release}\n下載：${selected.artifact.bytes} bytes\n授權：${selected.license}\n完成後必須完整結束並重新啟動應用程式；不會立即啟用語音。模型需另行同意下載。`,
      buttons: ['取消', '下載並安裝'], defaultId: 0, cancelId: 0, noLink: true, signal: action.dialogController.signal});
    if (answer.response !== 1 || action.cancelled) {
      installationStatus = '已取消；未安裝';
      action.phase = 'cancelled';
      return {cancelled: true};
    }
    assertAdmission();
    const result = await admitTask(() => {
      if (action.cancelled) return {cancelled: true};
      action.started = true;
      action.phase = 'downloading';
      installationStatus = `下載／驗證／安裝中：${selected.name}`;
      refreshInstallationMenu();
      return kind === 'runtime' ? action.manager.install() : action.manager.install(id, progress => recordInstallationProgress(action, progress));
    }, () => cancelInstallation(action));
    // B's committed result remains true even if cancellation arrived after commit.
    installationStatus = result.restartRequired ? '安裝完成；必須完整結束並重新啟動應用程式' : '已取消';
    action.phase = result.restartRequired ? 'installed' : 'cancelled';
    action.restartRequired = Boolean(result.restartRequired);
    if (kind === 'model' && result.restartRequired) {
      action.bytes = action.total;
      nativeRestartRequired = true;
      ++nativeModelRefreshSerial;
      nativeModelStates.set(id, Object.freeze({ state: 'installed', generation: result.generation || null }));
    }
    return result;
  } catch (error) {
    installationStatus = action.cancelled ? '已取消；原始作業已結束' : '安裝失敗；語音可用性以健康檢查為準';
    action.phase = action.cancelled ? 'cancelled' : 'failed';
    const code = String(error?.message || '').split(':')[0];
    action.errorCode = /^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code : 'INSTALLATION_FAILED';
    if (action.cancelled && !action.started) return {cancelled: true};
    if (!action.cancelled) dialog.showErrorBox('原生語音安裝失敗', '安裝未完成。請確認有相容的已發布資產、足夠空間與網路；未自動啟用語音。');
    throw error;
  } finally {
    if (kind === 'model') lastModelInstallation = Object.freeze({ kind, id, actionId: action.actionId,
      phase: action.phase, bytes: action.bytes, total: action.total, cancelled: action.cancelled,
      restartRequired: action.restartRequired, ...(action.errorCode ? { errorCode: action.errorCode } : {}) });
    if (installationAction === action) installationAction = null;
    refreshInstallationMenu();
  }
}

// Anthropic rejects OAuth requests whose claude-code/<version> UA lags too far behind;
// mirror the locally installed CLI when present.
let claudeCodeVersionCache = null;
function claudeCodeCandidates(platform = process.platform, home = app.getPath('home'), env = process.env) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(home, '.bun', 'bin', 'claude.exe'),
    ];
  }
  return ['.local/bin/claude', '.claude/local/claude', '.npm-global/bin/claude', '.bun/bin/claude']
    .map(rel => path.join(home, rel)).concat(['/opt/homebrew/bin/claude', '/usr/local/bin/claude']);
}

function detectClaudeCodeVersion() {
  if (claudeCodeVersionCache) return claudeCodeVersionCache;
  claudeCodeVersionCache = '2.1.290';
  for (const bin of claudeCodeCandidates()) {
    try {
      if (!syncFs.existsSync(bin)) continue;
      // .cmd shims need a shell on Windows; the path is from a fixed allowlist, never user input.
      const shell = process.platform === 'win32' && bin.toLowerCase().endsWith('.cmd');
      const out = require('node:child_process').execFileSync(bin, ['--version'],
        { timeout: 5000, encoding: 'utf8', windowsHide: true, shell });
      const match = /(\d+\.\d+\.\d+)/.exec(out);
      if (match) { claudeCodeVersionCache = match[1]; break; }
    } catch {}
  }
  return claudeCodeVersionCache;
}

function subscriptionPayload(payload, keys) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== keys.length || keys.some(key => typeof payload[key] !== 'string')) {
    throw new Error('INVALID_SUBSCRIPTION_REQUEST');
  }
  if (keys.includes('providerId') && !Object.hasOwn(SUBSCRIPTIONS, payload.providerId)) throw new Error('PROVIDER_NOT_ALLOWED');
  return payload;
}

const SUBSCRIPTION_LOGIN_HOSTS = new Set(['auth.openai.com', 'accounts.x.ai', 'auth.x.ai', 'claude.ai']);

function credentialPayload(payload, includeCredential = false) {
  const allowed = includeCredential ? ['providerId', 'credential'] : ['providerId'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !allowed.includes(key))
      || typeof payload.providerId !== 'string'
      || (includeCredential && typeof payload.credential !== 'string')) {
    throw new Error('INVALID_CREDENTIAL_REQUEST');
  }
  // OAuth subscription tokens are Main-only; the renderer may not read, write or clear them here.
  if (Object.hasOwn(SUBSCRIPTIONS, payload.providerId)) throw new Error('PROVIDER_NOT_ALLOWED');
  return payload;
}

function audioExtension(mimeType = '') {
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
  if (mimeType.includes('wav')) return '.wav';
  if (mimeType.includes('ogg')) return '.ogg';
  return '.webm';
}

function runtimeEnvironment(tempRoot) {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
    'HF_HOME', 'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
    'DYLD_LIBRARY_PATH', 'PYTHONPATH', 'VOICE_WHISPER_MODEL', 'VOICE_RUNTIME_FAKE',
    'VOICE_RUNTIME_DEBUG', 'VOICE_STT_BACKEND', 'VOICE_TTS_BACKEND', 'VOICE_MLX_WHISPER_MODEL',
    'VOICE_FASTER_WHISPER_MODEL', 'VOICE_FASTER_WHISPER_DEVICE',
    'VOICE_FASTER_WHISPER_COMPUTE_TYPE', 'VOICE_KOKORO_ONNX_MODEL',
    'VOICE_KOKORO_ONNX_VOICES',
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.VOICE_RUNTIME_TEMP_DIR = tempRoot;
  return env;
}

function validateRuntimeEntrypoint(entrypoint, context) {
  assertAdmission();
  // Already inside B's install transaction: acquire its candidate pin, never begin
  // another install. Retain the concrete preparation even if admission is revoked.
  const bundle = prepareProbeAssets(runtimeManager, entrypoint, context);
  ownedAssetPreparations.add(bundle);
  // Admission may be revoked before its deferred callback runs, while shutdown
  // waits on another original client. Observe this work now without replacing
  // it or releasing its pin; owned preparation still requires the actual drain.
  bundle.work.catch(() => {});
  return admitTask(() => checkRuntimeEntrypoint(entrypoint, context, bundle));
}

async function checkRuntimeEntrypoint(entrypoint, context, bundle) {
  let candidate;
  let onAbort;
  let compatible = false;
  try {
    await bundle.work;
    assertAdmission();
    let assets;
    candidate = new SidecarClient({
      command: entrypoint,
      args: [],
      trackAssetLifetime: true,
      lifetimePurpose: 'candidate-probe',
      beforeSpawn: () => { assertAdmission(); return assets.beforeSpawn(); },
      env: buildPackagedSidecarEnvironment({tempRoot: bundle.tempRoot, cacheRoot: bundle.cacheRoot,
        platform: runtimeManager.platform, arch: runtimeManager.arch}),
      requestTimeoutMs: 10_000,
    });
    assets = bindClientAssets(candidate, bundle);
    ownClient(candidate, assets);
    ownedAssetPreparations.delete(bundle);
    onAbort = () => { assets.retire(); stopOwnedClient(candidate).catch(error => console.error('Probe stop unconfirmed', error)); };
    context.signal.addEventListener('abort', onAbort, {once: true});
    if (context.signal.aborted) onAbort();
    await candidate.start();
    assertAdmission();
    const probe = await candidate.request('runtime.probe');
    compatible = isCompatibleRuntimeProbe(probe, runtimeManager.platform, runtimeManager.arch);
  } catch (error) {
    console.error('Candidate runtime health check failed', error);
  } finally {
    if (onAbort) context.signal.removeEventListener('abort', onAbort);
    // No wait on ownedTasks/shutdownPromise here: this callback is one of them.
    try {
      if (candidate && ownedClients.has(candidate)) {
        ownedClients.get(candidate).assets.retire();
        await stopOwnedClient(candidate); await releaseClientAssets(candidate);
      } else { await bundle.release(); ownedAssetPreparations.delete(bundle); }
    } catch (error) { compatible = false; console.error('Probe assets retained', error); }
  }
  return compatible;
}

function assertAdmission() {
  if (shuttingDown) throw new Error('DESKTOP_SHUTTING_DOWN');
}

function startRuntime() {
  assertAdmission();
  if (runtimeStartupPromise) return runtimeStartupPromise;
  if (sidecar) return Promise.resolve();
  const operation = Promise.resolve().then(launchRuntime).finally(() => {
    if (runtimeStartupPromise === operation) runtimeStartupPromise = null;
  });
  runtimeStartupPromise = operation;
  return operation;
}

async function launchRuntime() {
  assertAdmission();
  if (app.isPackaged) return launchPackagedRuntime();
  const tempRoot = path.join(app.getPath('temp'), 'voice-practice-runtime');
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
  assertAdmission();
  let command;
  let args;
  command = process.env.VOICE_RUNTIME_PYTHON || 'python3';
  args = ['-u', path.join(projectRoot(), 'native/python/voice_runtime/server.py')];
  sidecar = ownClient(new SidecarClient({
    command,
    args,
    env: runtimeEnvironment(tempRoot),
  }));
  await sidecar.start();
}

async function releaseClientAssets(client) {
  const record = ownedClients.get(client);
  if (!record?.assets) return;
  await retainReleasedHistory(client);
  await record.assets.release(client, record.assets.bundle);
  ownedClients.delete(client); // only after the original obligation is released
}

async function retainReleasedHistory(client) {
  const { waitOwnedProcessClosure, requireOwnedProcessClosure } = require('./owned-process-lifetime.cjs');
  // Unknown physical lifetime retains the owner and assets. Fully reaped faults
  // permit product Quit, but permanently deny this launch's clean attestation.
  await waitOwnedProcessClosure(client);
  try { requireOwnedProcessClosure(client); }
  catch { releasedRuntimeHistoryClean = false; }
}

function getManagedAssetObservation() {
  if (!sidecar && [runtimeManager?.manifest,modelManager?.manifest].some(m =>
      require('./asset-manifest-trust.cjs').manifestAuthority(m)?.authority === 'UNPUBLISHED')) {
    return require('./asset-source-observation.cjs').missingSource('MANIFEST_UNPUBLISHED');
  }
  return SidecarClient.observeManagedAssets(sidecar);
}
const assetSourceAuthority = require('./asset-source-observation.cjs').createAssetSourceAuthority({
  launchNonce: appLaunchNonce, mainPid: process.pid, observe: getManagedAssetObservation,
}, appLifecycleSecret);

function bundledVoiceTrust() {
  return (process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64'))
    && require('./bundled-voice-assets.cjs').loadTrust();
}

// R56 local app: runtime + models shipped inside Contents/Resources, verified
// against the compiled trust root on every launch; no download, no copy.
let bundledTempRoot = null;
async function launchBundledRuntime() {
  const { prepareBundledVoiceAssets } = require('./bundled-voice-assets.cjs');
  const assets = await prepareBundledVoiceAssets({ resourcesPath: process.resourcesPath });
  assertAdmission();
  const tempParent = await fs.realpath(app.getPath('temp'));
  const tempRoot = await fs.mkdtemp(path.join(tempParent, 'voice-practice-runtime-'));
  await fs.chmod(tempRoot, 0o700);
  const cacheRoot = path.join(tempRoot, 'cache');
  const audioRoot = path.join(tempRoot, 'audio');
  await fs.mkdir(cacheRoot, { mode: 0o700 });
  await fs.mkdir(audioRoot, { mode: 0o700 });
  bundledTempRoot = { root: tempRoot, audio: audioRoot };
  const client = ownClient(new SidecarClient({
    command: assets.command, args: [],
    env: buildPackagedSidecarEnvironment({ tempRoot: audioRoot, cacheRoot, trustedVoice: assets.trustedVoice,
      platform: process.platform, arch: process.arch, bundled: true }),
    beforeSpawn: () => { assertAdmission(); return assets.verifyRuntimeBeforeSpawn(); },
  }));
  try {
    await client.start();
    assertAdmission();
    sidecar = client;
  } catch (error) {
    await stopOwnedClient(client).catch(() => {});
    throw error;
  }
}

async function removeBundledTempRoot() {
  const owned = bundledTempRoot;
  if (!owned) return;
  bundledTempRoot = null;
  await fs.rm(owned.root, { recursive: true, force: true });
}

async function launchPackagedRuntime() {
  const trust = bundledVoiceTrust();
  if (trust?.schemaVersion === 1) return launchBundledRuntime();
  let nativeRuntime = null;
  let bundle;
  let launchedBindings = null;
  if (trust?.schemaVersion === 2) {
    const bundled = require('./bundled-voice-assets.cjs');
    nativeRuntime = await bundled.prepareBundledRuntimeAssets({ resourcesPath: process.resourcesPath });
    assertAdmission();
    if (!bundled.authenticatedBundledRuntimeSource(nativeRuntime)) throw new Error('BUNDLED_RUNTIME_SOURCE_UNTRUSTED');
    hybridRuntimeSource = nativeRuntime;
    if (!nativeModelCatalog) throw new Error('NATIVE_MODEL_CATALOG_UNAVAILABLE');
    const { readPreference, selectedSttModel } = require('./stt-model-preference.cjs');
    const { resolveEffectiveBindings } = require('./bundled-voice-assets.cjs');
    const stt = Array.isArray(nativeModelCatalog.sttChoices) && nativeModelCatalog.sttChoices.length
      ? selectedSttModel({ preference: readPreference(app.getPath('userData')), language: 'en',
        allowed: nativeModelCatalog.sttChoices, defaultId: defaultSttModelId(nativeModelCatalog.sttChoices) })
      : { modelId: null, source: 'default' };
    const effective = resolveEffectiveBindings(trust, stt.modelId);
    launchedBindings = effective;
    hybridBoundModelIds.clear();
    for (const binding of Object.values(effective)) hybridBoundModelIds.add(binding.modelId);
    // Only the selected STT pack and the TTS pack must be installed.
    const required = [...new Set(Object.values(effective).map(binding => binding.modelId))];
    if (required.some(id => nativeModelStates.get(id)?.state !== 'installed')) throw new Error('NATIVE_MODELS_NOT_INSTALLED');
    bundle = prepareHybridVoiceAssets(nativeRuntime, modelManager, { sttModelId: stt.modelId });
  } else bundle = prepareVoiceAssets(runtimeManager, modelManager);
  ownedAssetPreparations.add(bundle);
  let client;
  try {
    await bundle.work;
    assertAdmission();
    let assets;
    client = new SidecarClient({command: bundle.command, args: [], trackAssetLifetime: true,
      lifetimePurpose: nativeRuntime ? 'hybrid-speech' : 'managed-speech',
      ...(nativeRuntime ? { nativeRuntime } : {}),
      env: buildPackagedSidecarEnvironment({tempRoot: bundle.tempRoot, cacheRoot: bundle.cacheRoot, trustedVoice: bundle.trustedVoice,
        platform: nativeRuntime ? process.platform : runtimeManager.platform, arch: nativeRuntime ? process.arch : runtimeManager.arch,
        hybrid: Boolean(nativeRuntime)}),
      beforeSpawn: () => { assertAdmission(); return assets.beforeSpawn(); }});
    assets = bindClientAssets(client, bundle);
    ownClient(client, assets); // Quit sees the preparing child before start's first await
    ownedAssetPreparations.delete(bundle);
    await client.start();
    assertAdmission();
    sidecar = client;
    if (nativeRuntime) {
      // Active = exactly what this launch bound (a previous tier must not stay 'active').
      hybridActiveModelIds.clear();
      for (const binding of Object.values(launchedBindings)) hybridActiveModelIds.add(binding.modelId);
    }
  } catch (error) {
    if (client && ownedClients.has(client)) {
      ownedClients.get(client).assets.retire();
      try { await stopOwnedClient(client); await releaseClientAssets(client); }
      catch (cleanup) { console.error('Startup assets retained', cleanup); }
    } else {
      try { await bundle.release(); ownedAssetPreparations.delete(bundle); }
      catch (cleanup) { console.error('Preparation assets retained', cleanup); }
    }
    throw error;
  }
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

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('UNTRUSTED_IPC_SENDER');
  }
  const senderUrl = String(event.senderFrame?.url || '');
  if (!isTrustedRendererUrl(senderUrl)) throw new Error('UNTRUSTED_IPC_ORIGIN');
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, payload) => {
    assertTrustedSender(event);
    if (channel === 'voice:operation-state') return voiceOperations.observe(voiceDocument, payload);
    if (channel === 'voice:operation-revoke') return voiceOperations.revoke(voiceDocument, payload);
    if ((channel === 'voice:stt' || channel === 'voice:tts') && !(payload && Object.hasOwn(payload, 'requestId'))) {
      return admitLegacyVoice(voiceDocument, record => handler(event, payload, record));
    }
    if ((channel === 'voice:stt' || channel === 'voice:tts') && payload && Object.hasOwn(payload, 'requestId')) {
      const owner = voiceDocument;
      const client = requireSidecar();
      if (!owner?.live) throw new Error('VOICE_OPERATION_ADMISSION_CLOSED');
      const record = voiceOperations.admit(owner, payload.requestId, client,
        () => owner.live && !shuttingDown);
      return admitVoiceOperation(record, () => handler(event, payload, record));
    }
    if (/^(runtime|models):(install|cancel)$/.test(channel)) return handler(event, payload);
    if (/^(runtime|models|voice):/.test(channel)) return admitTask(() => handler(event, payload), null);
    return handler(event, payload);
  });
}

const foundationStopObservations = new WeakMap();
function getHelperLifecycleReceipt(owner, payload = {}) {
  if (Object.hasOwn(payload || {}, 'operation')) {
    const observation = require('./foundation-stop-observation.cjs').observeFoundationStop(
      foundationStopObservations, foundationModels, owner, payload, appLaunchNonce);
    const closed = observation.closed;
    const receipt = { version: 1, type: 'MAIN_HELPER_LIFECYCLE_RECEIPT', launchNonce: appLaunchNonce,
      sessionNonce: appLaunchNonce, ownerId: 'main-authority', component: 'voice-foundation-models',
      helperKind: 'foundation-models', binaryName: 'voice-foundation-models', helperPid: observation.pid,
      status: closed ? 'exited' : 'running', exited: closed, reaped: closed,
      exitCode: closed ? 0 : null, signalCode: null, seq: ++lifecycleReceiptSeq, issuedAt: Date.now(),
      operation: observation.operation, authSignature: '' };
    receipt.authSignature = computeReceiptSignature(appLifecycleSecret, receipt);
    // Operation evidence is IPC-only, never overwrites the App-Quit final file.
    return receipt;
  }
  const queryNonce = payload?.launchNonce || null;
  if (queryNonce && queryNonce !== appLaunchNonce) {
    throw new Error('STALE_OR_CROSS_LAUNCH_RECEIPT');
  }
  if (payload?.component && payload.component !== 'voice-foundation-models') {
    throw new Error('COMPONENT_IDENTITY_MISMATCH');
  }
  let pid = null;
  let status = 'unobserved';
  let exited = false;
  let exitCode = null;
  let signalCode = null;

  const fmClient = foundationModels?.client;
  const fmProc = fmClient?.proc;
  if (fmProc?.child && typeof fmProc.child.pid === 'number' && fmProc.child.pid > 0) {
    pid = fmProc.child.pid;
    lastKnownHelperPid = pid;
    exited = Boolean(fmProc.exited);
    status = exited ? 'exited' : 'running';
    if (status === 'exited') {
      const rawSig = fmProc.child.signalCode;
      signalCode = (typeof rawSig === 'string' && rawSig.trim() !== '') ? rawSig : null;
      exitCode = signalCode !== null ? null : (Number.isSafeInteger(fmProc.child.exitCode) ? fmProc.child.exitCode : 0);
    }
  }

  if (payload?.sessionNonce && payload.sessionNonce !== appLaunchNonce) throw new Error('LIFECYCLE_SESSION_MISMATCH');
  const sessionNonce = appLaunchNonce;
  const ownerId = 'main-authority';
  lifecycleReceiptSeq++;

  const receipt = {
    version: 1,
    type: 'MAIN_HELPER_LIFECYCLE_RECEIPT',
    launchNonce: appLaunchNonce,
    sessionNonce,
    ownerId,
    component: 'voice-foundation-models',
    helperKind: 'foundation-models',
    binaryName: 'voice-foundation-models',
    helperPid: pid,
    status,
    exited,
    reaped: exited,
    exitCode,
    signalCode,
    seq: lifecycleReceiptSeq,
    issuedAt: Date.now(),
    authSignature: ''
  };
  receipt.authSignature = computeReceiptSignature(appLifecycleSecret, receipt);

  try {
    const userData = app.getPath('userData');
    safeWriteReceiptFile(userData, 'helper-lifecycle-receipt.json', receipt, { trustedRoot: userData });
  } catch {}

  return receipt;
}

let acceptanceWindowCycle = null;
function assertWindowCycleEnabled(payload) {
  if (!process.argv.includes('--acceptance-window-cycle') || process.platform !== 'darwin' || !app.isPackaged || shuttingDown) throw new Error('WINDOW_CYCLE_DISABLED');
  require('./window-cycle.cjs').validateWindowCommand(payload, appLaunchNonce);
}
function requestWindowCycle(payload) {
  assertWindowCycleEnabled(payload);
  if (acceptanceWindowCycle || !mainWindow || mainWindow.isDestroyed()) throw new Error('WINDOW_CYCLE_UNAVAILABLE');
  const old = mainWindow;
  const state = acceptanceWindowCycle = { version: 1, launchNonce: appLaunchNonce, mainPid: process.pid,
    oldWindowId: old.id, oldWebContentsId: old.webContents.id, closed: false, mainStayedLive: false, status: 'pending',
    expiresAt: Date.now() + 5000, challenges: new Set([payload.challenge]) };
  const timer = setTimeout(() => { if (state.status !== 'complete') state.status = 'failed'; }, 3000);
  old.once('closed', () => {
    // Wait for the product's closed/document-revocation handlers, with no old
    // renderer/CDP dependency. Darwin's normal window-all-closed policy is intact.
    setImmediate(async () => {
      if (state.status !== 'pending') return;
      try {
        if (shuttingDown || mainWindow || !old.isDestroyed()) throw new Error('WINDOW_CYCLE_NOT_CLOSED');
        state.closed = true; state.mainStayedLive = true;
        await voiceDocument?.foundationModelsReady;
        const history = foundationModels?.client ? require('./owned-process-lifetime.cjs').requireOwnedProcessClosure(foundationModels.client) : [];
        state.closedHelperPid = history.at(-1)?.pid || null;
        state.closureChain = history.map(r => ({ pid: r.pid, exited: r.exited, reaped: r.reaped, drained: r.drained, exitCode: r.code, signalCode: r.signal }));
        if (state.status !== 'pending' || shuttingDown || mainWindow) throw new Error('WINDOW_CYCLE_DRAIN_UNCONFIRMED');
        await createWindow();
        if (state.status !== 'pending' || shuttingDown || !mainWindow || mainWindow.isDestroyed() || mainWindow.id === old.id) throw new Error('WINDOW_CYCLE_REOPEN_FAILED');
        state.newWindowId = mainWindow.id; state.newWebContentsId = mainWindow.webContents.id;
        state.status = 'complete';
      } catch { state.status = 'failed'; }
      finally { clearTimeout(timer); }
    });
  });
  setImmediate(() => { if (state.status === 'pending' && !shuttingDown && mainWindow === old) {
    try { old.close(); } catch { state.status = 'failed'; clearTimeout(timer); }
  } });
  return { accepted: true };
}
function registerIpc() {
  trustedHandle('app:managed-asset-source', (event, payload) => {
    if (!app.isPackaged || shuttingDown || !process.argv.includes('--acceptance-asset-source')) throw Error('ASSET_OBSERVATION_DISABLED');
    return assetSourceAuthority(payload, event.sender.id);
  });
  trustedHandle('app:window-cycle', (_event, payload) => requestWindowCycle(payload));
  trustedHandle('app:window-cycle-receipt', (_event, payload) => {
    assertWindowCycleEnabled(payload);
    const state = acceptanceWindowCycle;
    if (state?.status === 'pending') return null; // no authority until Main's loadFile continuation settles
    if (state?.status !== 'complete' || mainWindow?.id !== state.newWindowId || state.expiresAt <= Date.now() ||
        state.challenges.size >= 128 || state.challenges.has(payload.challenge)) throw new Error('WINDOW_CYCLE_UNCONFIRMED');
    state.challenges.add(payload.challenge);
    // One synchronous Main observation: no inter-IPC generation race.
    state.current = getHelperLifecycleReceipt(voiceDocument, { launchNonce: appLaunchNonce });
    state.reopenedHelperPid = state.current.helperPid || state.closedHelperPid;
    state.pending = state.current.status === 'unobserved' && (state.closedHelperPid !== null || Boolean(foundationModels?.client?.preparing));
    return require('./window-cycle.cjs').createWindowCycleReceipt(state, payload.challenge, appLifecycleSecret);
  });
  trustedHandle('app:launch-identity', (event, challenge) => {
    if (shuttingDown) throw new Error('APP_SHUTTING_DOWN');
    return require('./launch-identity.cjs').createLaunchIdentity({
      launchNonce: appLaunchNonce, mainPid: process.pid,
      webContentsId: event.sender.id, url: trustedRendererUrl,
      challenge, packaged: app.isPackaged === true
    }, appLifecycleSecret);
  });
  foundationModels ||= new FoundationModelsService({ platform: process.platform, arch: process.arch,
    root: projectRoot(), packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  if (foundationModels && foundationModels.client && !foundationModels.client._hookedSpawn) {
    foundationModels.client._hookedSpawn = true;
    const origSpawn = foundationModels.client.spawnImpl;
    foundationModels.client.spawnImpl = function(...args) {
      const child = origSpawn.apply(this, args);
      if (child && typeof child.pid === 'number') {
        lastKnownHelperPid = child.pid;
        child.once('exit', (code, sig) => {
          writeTerminalHelperLifecycleReceipt(code, sig);
        });
        writeRunningHelperLifecycleReceipt(child.pid);
      }
      return child;
    };
  }
  trustedHandle('foundation-models:capabilities', async (_event, payload) => {
    const owner = voiceDocument;
    // A replacement document joins the prior document's physical drain. Capture
    // its original identity before waiting; Service rechecks revocation after it.
    await owner?.foundationModelsReady;
    return foundationModels.capabilities(owner, payload);
  });
  trustedHandle('foundation-models:generate', (_event, payload) => foundationModels.generate(voiceDocument, payload));
  trustedHandle('foundation-models:cancel', (_event, payload) => foundationModels.cancel(voiceDocument, payload));
  trustedHandle('foundation-models:lifecycle', (_event, payload) => getHelperLifecycleReceipt(voiceDocument, payload));
  trustedHandle('helper:lifecycle', (_event, payload) => getHelperLifecycleReceipt(voiceDocument, payload));
  trustedHandle('voice:operation-state', null);
  trustedHandle('voice:operation-revoke', null);
  trustedHandle('app:quit', () => {
    app.quit();
  });
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
  trustedHandle('subscription:begin-login', async (_event, payload) => {
    const { providerId } = subscriptionPayload(payload, ['providerId']);
    const login = await subscriptionAuth.beginLogin(providerId);
    const url = new URL(login.verificationUrl);
    if (url.protocol !== 'https:' || !SUBSCRIPTION_LOGIN_HOSTS.has(url.hostname)) throw new Error('UNSAFE_AUTH_ENDPOINT');
    await shell.openExternal(url.toString());
    // Claude's authorize URL carries the PKCE state; it is opened by Main and not returned.
    return { loginId: login.loginId, mode: login.mode, userCode: login.userCode || null,
      verificationHost: url.hostname, interval: login.interval || null };
  });
  trustedHandle('subscription:poll-login', (_event, payload) => {
    const { loginId } = subscriptionPayload(payload, ['loginId']);
    return subscriptionAuth.pollLogin(loginId);
  });
  trustedHandle('subscription:complete-login', (_event, payload) => {
    const { loginId, code } = subscriptionPayload(payload, ['loginId', 'code']);
    return subscriptionAuth.completeLogin(loginId, code);
  });
  trustedHandle('subscription:cancel-login', (_event, payload) => {
    const { loginId } = subscriptionPayload(payload, ['loginId']);
    return subscriptionAuth.cancelLogin(loginId);
  });
  trustedHandle('subscription:status', (_event, payload) => {
    const { providerId } = subscriptionPayload(payload, ['providerId']);
    return subscriptionAuth.status(providerId);
  });
  trustedHandle('subscription:logout', (_event, payload) => {
    const { providerId } = subscriptionPayload(payload, ['providerId']);
    return subscriptionAuth.logout(providerId);
  });
  trustedHandle('runtime:status', () => runtimeManager.status());
  trustedHandle('runtime:install', (_event, payload) => requestInstallation('runtime', payload));
  trustedHandle('runtime:cancel', (_event, payload) => cancelInstallationRequest('runtime', payload));
  trustedHandle('models:list', () => modelManager.list());
  trustedHandle('models:overview', (_event, payload) => {
    if (payload !== undefined) throw new Error('INVALID_MODEL_REQUEST');
    return nativeModelOverview();
  });
  trustedHandle('models:cancel-action', (_event, payload) => cancelNativeModelInstallAction(payload));
  trustedHandle('models:status', (_event, payload) => modelManager.status(String(payload?.modelId || '')));
  trustedHandle('models:install', (_event, payload) => requestInstallation('model', payload));
  trustedHandle('models:cancel', (_event, payload) => cancelInstallationRequest('model', payload));
  trustedHandle('models:select-stt', (_event, payload) => selectSttModel(payload));
  trustedHandle('models:remove', (_event, payload) => removeNativeModel(payload));
  trustedHandle('voice:health', () => requireSidecar().request('runtime.health'));
  trustedHandle('voice:tts', async (_event, payload, record) => {
    if (voiceOperations.fault) throw new Error('VOICE_OPERATION_ADMISSION_CLOSED');
    if (typeof payload?.text !== 'string') throw new Error('INVALID_TTS_TEXT');
    const text = payload.text;
    if (!text || text.length > MAX_TTS_CHARS) throw new Error('INVALID_TTS_TEXT_LENGTH');
    const params = { ...payload, text };
    if (record) delete params.requestId;
    const result = await (record?.operation || requireSidecar()).request('tts.synthesize', params);
    return { ...result, success: true };
  });
  trustedHandle('voice:stt', async (_event, payload, record) => {
    if (voiceOperations.fault) throw new Error('VOICE_OPERATION_ADMISSION_CLOSED');
    const mimeType = String(payload?.mimeType || 'audio/webm').toLowerCase();
    if (!ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) throw new Error('UNSUPPORTED_AUDIO_MIME_TYPE');
    const source = payload?.buffer;
    if (!source) throw new Error('MISSING_AUDIO_PAYLOAD');
    const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
    if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) throw new Error('AUDIO_PAYLOAD_TOO_LARGE');
    const client = record?.client || requireSidecar();
    const tempRoot = app.isPackaged ? (ownedClients.get(client).assets ? ownedClients.get(client).assets.bundle.tempRoot : bundledTempRoot.audio) : path.join(app.getPath('temp'), 'voice-practice-runtime');
    await fs.mkdir(tempRoot, { recursive: true });
    if (record) assertVoiceOperation(record);
    const tempPath = path.join(tempRoot, `${randomUUID()}${audioExtension(mimeType)}`);
    let submitted = false;
    try {
      if (record) record.filesReleased = false;
      await fs.writeFile(tempPath, buffer, { mode: 0o600 });
      assertAdmission();
      if (record) assertVoiceOperation(record);
      submitted = true;
      const result = await (record?.operation || client).request('stt.transcribe', {
        audioPath: tempPath,
        language: payload.language || 'en',
      });
      return { ...result, success: true };
    } finally {
      if (record && !record.legacy) {
        if (record.operation.snapshot().status === 'unconfirmed') {
          voiceOperations.producer(record, record.operation.snapshot());
          await voiceOperations.waitForFinalStop(record);
        } else if (submitted && record.operation.snapshot().status !== 'completed') {
          try { await voiceOperations.cancel(record); }
          catch (error) {
            voiceOperations.producer(record, record.operation.snapshot());
            // Only original public Quit confirmation may release unsafe input.
            await voiceOperations.waitForFinalStop(record);
          }
        }
        voiceOperations.producer(record, record.operation.snapshot());
        record.cleanupRetry = async () => {
          try { await fs.rm(tempPath, { force: true }); }
          catch (error) { record.cleanupFailed = true; throw error; }
          record.filesReleased = true;
          record.cleanupFailed = false;
          record.cleanupRetry = null;
        };
        await record.cleanupRetry();
      } else if (record?.legacy) {
        if (submitted) {
          const status = record.operation.snapshot().status;
          if (status !== 'completed') {
            // Even an unconfirmed handle joins its ORIGINAL rejected barrier;
            // it cannot retry against a newer client intent or physical process.
            try { await record.operation.cancel(); }
            catch (error) {
              console.error('Runtime exit unconfirmed; retaining owned resources', error);
              await voiceOperations.waitForFinalStop(record);
            }
          }
        }
        await fs.rm(tempPath, { force: true });
      } else {
      const cancellation = ownedClients.get(client)?.cancellation;
      const stopping = client.stopPromise || (cancellation?.generation === client.processGeneration
        ? cancellation.barrier : null);
      if (submitted && (shuttingDown || stopping || client.terminationFailure)) {
        await waitForClientExit(client, stopping);
      }
      await fs.rm(tempPath, { force: true });
      }
    }
  });
}

async function createWindow() {
  if (shuttingDown) return;
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
  const electronSession = mainWindow.webContents.session;
  let documentOwner = { live: true, foundationModelsReady: voiceDocument?.foundationModelsReady };
  let documentDestroyed = false;
  voiceDocument = documentOwner;
  const closeDocument = () => {
    voiceOperations.closeOwner(documentOwner);
    documentOwner.foundationModelsReady = Promise.all([
      documentOwner.foundationModelsReady, foundationModels?.closeOwner(documentOwner),
    ]);
    documentOwner.foundationModelsReady.catch(() => console.error('FM_EXIT_UNCONFIRMED'));
    // The owner is closed before any callback. Existing task slots suffice;
    // repeated navigation/Stop can only address each captured original handle.
    for (const task of ownedTasks.values()) {
      if (task.voice?.owner === documentOwner) {
        try { task.voice.operation.cancel().catch(() => {}); } catch {}
      }
    }
  };
  mainWindow.webContents.on('did-start-navigation', (_event, url, inPlace, isMainFrame) => {
    // External renderer navigations are prevented below: they do not replace
    // this document. A programmatic external commit still revokes it below.
    if (isMainFrame && !inPlace && isTrustedRendererUrl(url)) closeDocument();
  });
  const destroyDocument = () => { documentDestroyed = true; closeDocument(); };
  mainWindow.webContents.on('destroyed', destroyDocument);
  // A trusted document can invoke preload IPC before onload/did-finish-load.
  // Renew at its committed main-frame navigation, never at navigation start.
  mainWindow.webContents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame, processId, routingId) => {
    if (mainWindow !== createdWindow || shuttingDown || documentDestroyed || !isMainFrame) return;
    const frame = createdWindow.webContents.mainFrame;
    if (frame.processId !== processId || frame.routingId !== routingId) return;
    if (!isTrustedRendererUrl(url) || !isTrustedRendererUrl(frame.url)) { closeDocument(); return; }
    if (documentOwner.live) return;
    documentOwner = { live: true, foundationModelsReady: documentOwner.foundationModelsReady };
    voiceDocument = documentOwner;
  });
  mainWindow.on('closed', destroyDocument);
  electronSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => callback({ cancel: details.resourceType === 'script' })
  );
  // Renderer CSP: no eval/new Function, scripts/workers only from the packaged
  // web root; wasm allowed for the local ORT/Whisper fallbacks. Inline script/style
  // remain until the UI's inline handlers are migrated. Network calls go through
  // the Main provider broker, so connect-src stays local.
  electronSession.webRequest.onHeadersReceived({ urls: ['file://*/*'] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [RENDERER_CSP] } });
  });
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
  if (typeof mainWindow.setTitle === 'function') {
    mainWindow.setTitle(`Voice Practice [launch:${appLaunchNonce}]`);
  }
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed?.() && typeof mainWindow.setTitle === 'function') {
      mainWindow.setTitle(`Voice Practice [launch:${appLaunchNonce}]`);
    }
  });
  try {
    const userData = app.getPath('userData');
    syncFs.writeFileSync(path.join(userData, 'main-launch-receipt.json'), JSON.stringify({
      launchNonce: appLaunchNonce,
      mainPid: process.pid,
      createdAt: Date.now()
    }, null, 2), 'utf8');
  } catch {}
}

async function startApplication() {
  if (shuttingDown) return;
  await initializeAssetManagers();
  if (shuttingDown) return;
  registerIpc();
  if (isSmokeTest) {
    await createWindow();
    if (shuttingDown) return;
    const title = mainWindow.webContents.getTitle();
    if (!title) throw new Error('PACKAGED_APP_SMOKE_EMPTY_TITLE');
    console.log(`PACKAGED_APP_SMOKE_OK:${title}`);
    app.exit(0);
    return;
  }
  try {
    await startRuntime();
  } catch (error) {
    console.error('Native voice runtime unavailable; browser fallbacks remain active', error);
    if (shuttingDown) return;
    if (sidecar) {
      await stopOwnedClient(sidecar);
      await retainReleasedHistory(sidecar);
      ownedClients.delete(sidecar);
    }
    sidecar = null;
  }
  if (shuttingDown) return;
  await createWindow();
  if (shuttingDown) return;
  applicationStartupComplete = true;
  setupInstallationMenu();
  app.on('activate', () => { if (!shuttingDown && BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

app.whenReady().then(() => {
  if (!canStartApplication || shuttingDown) return;
  applicationStartupPromise = Promise.resolve().then(startApplication);
  return applicationStartupPromise;
}).catch(error => {
  console.error('Desktop startup failed', error);
  if (!shuttingDown) app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (quitAllowed) return;
  event.preventDefault();
  shuttingDown = true;
  cancelInstallation(installationAction); // synchronous revocation; pure consent is not a native drain
  refreshInstallationMenu();
  if (shutdownPromise) return;
  let signals;
  shutdownPromise = Promise.resolve().then(async () => {
    await Promise.all(signals);
    await Promise.allSettled([runtimeStartupPromise, applicationStartupPromise]);
    await Promise.allSettled([...ownedTasks.keys()]);
    await voiceOperations.drainFiles();
    for (const client of ownedClients.keys()) await releaseClientAssets(client);
    if (bundledTempRoot) {
      for (const client of ownedClients.keys()) await stopOwnedClient(client);
      await removeBundledTempRoot();
    }
    for (const bundle of ownedAssetPreparations) {
      await bundle.release(); ownedAssetPreparations.delete(bundle);
    }
    const { waitOwnedProcessClosure } = require('./owned-process-lifetime.cjs');
    await Promise.all([...ownedClients.keys(), foundationModels?.client].filter(Boolean).map(client => waitOwnedProcessClosure(client)));
    // A failed clean-attestation (e.g. a prior forced cancellation) denies the
    // acceptance runner's restart, not the user's physically confirmed Quit.
    // Never fabricate a clean terminal to make that runner continue.
    writeTerminalHelperLifecycleReceipt(0, null);
    quitAllowed = true;
    app.quit();
  }).catch(error => {
    console.error('Desktop shutdown failed; quit remains prevented', error);
    if (error.message === 'ASSET_LIFETIME_UNCONFIRMED') {
      // Independent of BrowserWindow/modal settlement; no retry, force-exit or PID chase.
      try { dialog.showErrorBox('無法安全結束應用程式',
        'ASSET_LIFETIME_UNCONFIRMED：無法確認原生語音程序已完整結束。已阻止結束並保留資產；不會強制退出或刪除仍可能使用中的檔案。'); }
      catch { console.error('Unable to display native shutdown warning'); }
    }
  }).finally(() => { shutdownPromise = null; });
  // Own shutdown before hooks, and signal clients synchronously before any
  // queued preparation can spawn. Never wait for readiness before stopping.
  for (const owner of voiceOperations.owners.keys()) voiceOperations.closeOwner(owner);
  for (const record of ownedClients.values()) record.assets?.retire();
  for (const bundle of ownedAssetPreparations) bundle.cancel();
  signals = [...ownedClients.keys()].map(stopOwnedClient);
  if (foundationModels) signals.push(foundationModels.shutdown());
  signals.push(...[...ownedTasks.values()].filter(record => record.started && record.cancel)
    .map(record => Promise.resolve().then(record.cancel)));
});
