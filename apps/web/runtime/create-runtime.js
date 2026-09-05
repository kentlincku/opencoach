(function exposeRuntimeFactory(root, factory) {
  const isCommonJs = typeof module === 'object' && module.exports;
  const dependencies = isCommonJs
    ? {
        BrowserRuntime: require('./browser-runtime.js').BrowserRuntime,
        ElectronRuntime: require('./electron-runtime.js').ElectronRuntime,
        AndroidRuntime: require('./android-runtime.js').AndroidRuntime,
        normalizeRuntimeCapabilities: require('./runtime-contract.js').normalizeRuntimeCapabilities,
      }
    : {
        BrowserRuntime: root.VoiceBrowserRuntime.BrowserRuntime,
        ElectronRuntime: root.VoiceElectronRuntime.ElectronRuntime,
        AndroidRuntime: root.VoiceAndroidRuntime.AndroidRuntime,
        normalizeRuntimeCapabilities: root.VoiceRuntimeContract.normalizeRuntimeCapabilities,
      };
  const exports = factory(dependencies);
  if (isCommonJs) module.exports = exports;
  if (root) root.VoiceRuntimeFactory = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntimeFactoryModule({
  BrowserRuntime,
  ElectronRuntime,
  AndroidRuntime,
  normalizeRuntimeCapabilities,
}) {
  async function createRuntime({ androidBridge = null, electronAPI = null, browser = {} } = {}) {
    const browserRuntime = browser instanceof BrowserRuntime ? browser : new BrowserRuntime(browser);
    if (androidBridge && typeof androidBridge.voiceHealth === 'function') {
      let capabilities;
      try {
        capabilities = normalizeRuntimeCapabilities(await androidBridge.voiceHealth());
      } catch (_error) {
        capabilities = null;
      }
      if (capabilities?.platform !== 'android') {
        capabilities = normalizeRuntimeCapabilities({
          protocol: 1,
          platform: 'android',
          arch: 'unknown',
          sttBackends: [],
          ttsBackends: [],
          selectedStt: null,
          selectedTts: null,
          ready: false,
          degradedReason: 'ANDROID_NATIVE_HEALTH_UNAVAILABLE',
        });
      }
      return new AndroidRuntime({ bridge: androidBridge, capabilities });
    }
    if (!electronAPI || typeof electronAPI.runtimeHealth !== 'function') return browserRuntime;

    let capabilities;
    try {
      capabilities = normalizeRuntimeCapabilities(await electronAPI.runtimeHealth());
    } catch (_error) {
      capabilities = normalizeRuntimeCapabilities(null);
    }
    const normalized = normalizeRuntimeCapabilities(capabilities);
    if (!normalized.ready) return browserRuntime;
    return new ElectronRuntime({ api: electronAPI, capabilities: normalized, fallback: browserRuntime });
  }

  return Object.freeze({ createRuntime });
}));
