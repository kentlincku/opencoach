(function initModelStorage(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VoiceModelCache = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createModelStorage() {
  async function requestPersistentStorage(navigatorLike = globalThis.navigator) {
    try {
      if (!navigatorLike?.storage?.persist) return false;
      return Boolean(await navigatorLike.storage.persist());
    } catch {
      return false;
    }
  }

  async function estimateStorage(navigatorLike = globalThis.navigator) {
    try {
      if (!navigatorLike?.storage?.estimate) return null;
      const estimate = await navigatorLike.storage.estimate();
      const usage = Number(estimate?.usage || 0);
      const quota = Number(estimate?.quota || 0);
      return { usage, quota, remaining: Math.max(0, quota - usage) };
    } catch {
      return null;
    }
  }

  return { requestPersistentStorage, estimateStorage };
});
