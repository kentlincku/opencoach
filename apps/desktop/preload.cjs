const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload may require Electron, not relative Node modules. This is
// only the two-command transport whitelist; Main owns full C6 validation.
function voiceId(value) {
  if (typeof value !== 'string' || value.length > 96 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error('INVALID_VOICE_OPERATION_CONTRACT');
  return value;
}
function requestMetadata(payload) {
  if (!payload || (typeof payload !== 'object' && typeof payload !== 'function')) return {};
  if (!Object.hasOwn(payload, 'requestId')) {
    if ('requestId' in payload) throw new Error('INVALID_VOICE_OPERATION_CONTRACT');
    return {};
  }
  const descriptor = Object.getOwnPropertyDescriptor(payload, 'requestId');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('INVALID_VOICE_OPERATION_CONTRACT');
  return { requestId: voiceId(descriptor.value) };
}
function voiceCommand(command, type) {
  const fail = () => { throw new Error('INVALID_VOICE_OPERATION_CONTRACT'); };
  if (!command || Object.getPrototypeOf(command) !== Object.prototype) fail();
  const d = Object.getOwnPropertyDescriptors(command);
  const key = type === 'observe' ? 'requestId' : 'requestIds';
  if (Reflect.ownKeys(d).length !== 3) fail();
  for (const name of ['version', 'type', key]) {
    if (!d[name] || !Object.hasOwn(d[name], 'value') || !d[name].enumerable) fail();
  }
  if (d.version.value !== 1 || d.type.value !== type) fail();
  if (type === 'observe') return { version: 1, type, requestId: voiceId(d[key].value) };
  const array = d[key].value;
  if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype) fail();
  const entries = Object.getOwnPropertyDescriptors(array), length = entries.length.value;
  if (length < 1 || length > 32 || Reflect.ownKeys(entries).length !== length + 1) fail();
  const requestIds = [];
  for (let i = 0; i < length; i++) {
    if (!entries[i] || !Object.hasOwn(entries[i], 'value') || !entries[i].enumerable) fail();
    const id = voiceId(entries[i].value);
    if (!requestIds.includes(id)) requestIds.push(id);
  }
  return { version: 1, type, requestIds };
}

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('electronAPI', Object.freeze({
  providerCredentialHas: providerId => invoke('credential:has', { providerId: String(providerId || '') }),
  providerCredentialSet: (providerId, credential) => invoke('credential:set', {
    providerId: String(providerId || ''),
    credential: String(credential || ''),
  }),
  providerCredentialClear: providerId => invoke('credential:clear', { providerId: String(providerId || '') }),
  providerOperation: payload => invoke('provider:operation', payload),
  subscriptionBeginLogin: providerId => invoke('subscription:begin-login', { providerId: String(providerId || '') }),
  subscriptionPollLogin: loginId => invoke('subscription:poll-login', { loginId: String(loginId || '') }),
  subscriptionCompleteLogin: (loginId, code) => invoke('subscription:complete-login', {
    loginId: String(loginId || ''), code: String(code || ''),
  }),
  subscriptionCancelLogin: loginId => invoke('subscription:cancel-login', { loginId: String(loginId || '') }),
  subscriptionStatus: providerId => invoke('subscription:status', { providerId: String(providerId || '') }),
  subscriptionLogout: providerId => invoke('subscription:logout', { providerId: String(providerId || '') }),
  foundationModelsCapabilities: payload => invoke('foundation-models:capabilities', payload),
  foundationModelsGenerate: payload => invoke('foundation-models:generate', payload),
  foundationModelsCancel: payload => invoke('foundation-models:cancel', payload),
  helperLifecycle: payload => invoke('helper:lifecycle', payload),
  foundationModelsLifecycle: payload => invoke('foundation-models:lifecycle', payload),
  runtimeStatus: () => invoke('runtime:status'),
  runtimeInstall: () => invoke('runtime:install'),
  runtimeCancelInstall: () => invoke('runtime:cancel'),
  listNativeModels: () => invoke('models:list'),
  nativeModelOverview: () => invoke('models:overview'),
  cancelNativeModelInstallAction: actionId => {
    if (typeof actionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(actionId)) throw new Error('INVALID_MODEL_ACTION');
    return invoke('models:cancel-action', { actionId });
  },
  nativeModelStatus: modelId => invoke('models:status', { modelId: String(modelId || '') }),
  installNativeModel: modelId => invoke('models:install', { modelId: String(modelId || '') }),
  cancelNativeModelInstall: modelId => invoke('models:cancel', { modelId: String(modelId || '') }),
  selectNativeSttModel: modelId => invoke('models:select-stt', { modelId: String(modelId || '') }),
  removeNativeModel: modelId => invoke('models:remove', { modelId: String(modelId || '') }),
  runtimeHealth: () => invoke('voice:health'),
  voiceOperationState: command => invoke('voice:operation-state', voiceCommand(command, 'observe')),
  voiceOperationRevoke: command => invoke('voice:operation-revoke', voiceCommand(command, 'revoke')),
  synthKokoro: payload => invoke('voice:tts', {
    ...requestMetadata(payload),
    text: String(payload?.text || ''),
    voice: String(payload?.voice || 'af_heart'),
    speed: Number(payload?.speed || 1),
  }),
  transcribeAudio: payload => invoke('voice:stt', {
    ...requestMetadata(payload),
    buffer: payload?.buffer || payload,
    mimeType: String(payload?.mimeType || 'audio/webm'),
    language: String(payload?.language || 'en'),
  }),
  launchIdentity: challenge => {
    if (typeof challenge !== 'string' || !/^[a-f0-9]{64}$/.test(challenge)) throw new Error('INVALID_LAUNCH_CHALLENGE');
    return invoke('app:launch-identity', challenge);
  },
  windowCycle: payload => invoke('app:window-cycle', payload),
  managedAssetSource: payload => invoke('app:managed-asset-source', payload),
  windowCycleReceipt: payload => invoke('app:window-cycle-receipt', payload),
  quit: () => invoke('app:quit'),
}));
