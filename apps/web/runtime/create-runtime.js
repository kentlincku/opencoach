(function exposeRuntimeFactory(root, factory) {
  const isCommonJs = typeof module === 'object' && module.exports;
  const dependencies = isCommonJs
    ? {
        BrowserRuntime: require('./browser-runtime.js').BrowserRuntime,
        ElectronRuntime: require('./electron-runtime.js').ElectronRuntime,
        normalizeRuntimeCapabilities: require('./runtime-contract.js').normalizeRuntimeCapabilities,
      }
    : {
        BrowserRuntime: root.VoiceBrowserRuntime.BrowserRuntime,
        ElectronRuntime: root.VoiceElectronRuntime.ElectronRuntime,
        normalizeRuntimeCapabilities: root.VoiceRuntimeContract.normalizeRuntimeCapabilities,
      };
  const exports = factory(dependencies);
  if (isCommonJs) module.exports = exports;
  if (root) root.VoiceRuntimeFactory = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntimeFactoryModule({
  BrowserRuntime,
  ElectronRuntime,
  normalizeRuntimeCapabilities,
}) {
  async function createRuntime({ electronAPI = null, browser = {} } = {}) {
    const browserRuntime = browser instanceof BrowserRuntime ? browser : new BrowserRuntime(browser);
    if (!electronAPI || typeof electronAPI.runtimeHealth !== 'function') return browserRuntime;

    let capabilities;
    try {
      capabilities = normalizeRuntimeCapabilities(await electronAPI.runtimeHealth());
    } catch (_error) {
      capabilities = normalizeRuntimeCapabilities(null);
    }
    return new ElectronRuntime({ api: electronAPI, capabilities, fallback: browserRuntime });
  }

  return Object.freeze({ createRuntime });
}));
