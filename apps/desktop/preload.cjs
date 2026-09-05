const { contextBridge, ipcRenderer } = require('electron');

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
  subscriptionCapabilities: () => invoke('subscription:capabilities'),
  subscriptionBeginLogin: providerId => invoke('subscription:begin-login', { providerId: String(providerId || '') }),
  subscriptionPollLogin: (providerId, loginId) => invoke('subscription:poll-login', {
    providerId: String(providerId || ''), loginId: String(loginId || ''),
  }),
  subscriptionCancelLogin: (providerId, loginId) => invoke('subscription:cancel-login', {
    providerId: String(providerId || ''), loginId: String(loginId || ''),
  }),
  subscriptionStatus: providerId => invoke('subscription:status', { providerId: String(providerId || '') }),
  subscriptionLogout: providerId => invoke('subscription:logout', { providerId: String(providerId || '') }),
  subscriptionOperation: payload => invoke('subscription:operation', payload),
  runtimeStatus: () => invoke('runtime:status'),
  runtimeInstall: () => invoke('runtime:install'),
  runtimeCancelInstall: () => invoke('runtime:cancel'),
  listNativeModels: () => invoke('models:list'),
  nativeModelStatus: modelId => invoke('models:status', { modelId: String(modelId || '') }),
  installNativeModel: modelId => invoke('models:install', { modelId: String(modelId || '') }),
  cancelNativeModelInstall: modelId => invoke('models:cancel', { modelId: String(modelId || '') }),
  runtimeHealth: () => invoke('voice:health'),
  cancelVoiceOperation: payload => invoke('voice:cancel', {
    requestId: String(payload?.requestId || ''),
  }),
  synthKokoro: payload => invoke('voice:tts', {
    text: String(payload?.text || ''),
    voice: String(payload?.voice || 'af_heart'),
    speed: Number(payload?.speed || 1),
    requestId: typeof payload?.requestId === 'string' ? payload.requestId : undefined,
  }),
  transcribeAudio: payload => invoke('voice:stt', {
    buffer: payload?.buffer || payload,
    mimeType: String(payload?.mimeType || 'audio/webm'),
    language: String(payload?.language || 'en'),
    requestId: typeof payload?.requestId === 'string' ? payload.requestId : undefined,
  }),
}));
