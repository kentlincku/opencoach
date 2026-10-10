const path = require('node:path');
const { parseModelManifest } = require('./runtime-manifest.cjs');
const { RuntimeManager } = require('./runtime-manager.cjs');
const { getManagedAssetCoordinator } = require('./managed-asset-lease.cjs');

class ModelManager {
  constructor(options) {
    this.options = {...options};
    this.manifest = require('./asset-manifest-trust.cjs').inheritManifestAuthority(options.manifest, parseModelManifest(options.manifest));
    this.coordinator = getManagedAssetCoordinator(options.userData);
    this.active = new Map();
  }
  _manager(id, onProgress = this.options.onProgress) {
    const model = this.manifest.models[id];
    if (!model) throw new Error(`UNKNOWN_MODEL:${id}`);
    return new RuntimeManager({
      userData: path.join(this.options.userData, 'models', id),
      appUserData: this.options.userData,
      manifest: this.manifest,
      artifactKind: 'model', modelId: id,
      platform: this.options.platform,
      arch: this.options.arch,
      flavor: this.options.flavor,
      fetchImpl: this.options.fetchImpl,
      writeMetadata: this.options.writeMetadata,
      onProgress: progress => onProgress?.({modelId: id, ...progress}),
    });
  }
  status(id) { return this._manager(id).status(); }
  pinCurrent(id, owner) { return this._manager(id).pinCurrent(owner); }
  async install(id, onProgress) {
    if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('INVALID_MODEL_PROGRESS_CALLBACK');
    const manager = this._manager(id, onProgress);
    if (this.active.has(id)) throw new Error('INSTALL_ALREADY_RUNNING');
    this.active.set(id, manager);
    try { return await manager.install(); } finally { if (this.active.get(id) === manager) this.active.delete(id); }
  }
  cancel(id) {
    if (!this.manifest.models[id]) throw new Error(`UNKNOWN_MODEL:${id}`);
    this.active.get(id)?.cancel();
  }
  // Remove one installed model's whole managed directory. Main supplies the ids it
  // considers in use (sidecar-bound, current-language selection, TTS). Refused while
  // any install/preparation is active or while any coordinator root under this
  // model still has a pin. Holds the coordinator's exclusive slot for the duration.
  async remove(id, {protectedIds = []} = {}) {
    if (!this.manifest.models[id]) throw new Error(`UNKNOWN_MODEL:${id}`);
    if (protectedIds.includes(id)) throw new Error('MODEL_IN_USE');
    if (this.active.size) throw new Error('INSTALL_ALREADY_RUNNING');
    const { assertManagedPath } = require('./runtime-paths.cjs');
    const { removeManagedTree } = require('./managed-asset-lease.cjs');
    const fs = require('node:fs');
    const coordinator = this.coordinator;
    if (coordinator.active) throw new Error('INSTALL_ALREADY_RUNNING');
    const modelRoot = path.join(this.options.userData, 'models', id);
    const inside = root => { const rel = path.relative(modelRoot, root); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
    const operation = {}; coordinator.active = operation;
    try {
      for (const record of coordinator.roots.values()) {
        if (inside(record.root) && record.pins.size) throw new Error('MODEL_IN_USE');
      }
      let stat;
      try { stat = fs.lstatSync(modelRoot); } catch (error) { if (error.code === 'ENOENT') return Object.freeze({removed: false}); throw error; }
      if (!stat.isDirectory()) throw new Error('MANAGED_PATH_NOT_DIRECTORY');
      assertManagedPath(this.options.userData, modelRoot);
      removeManagedTree(modelRoot);
      for (const root of [...coordinator.roots.keys()]) if (inside(root)) coordinator.roots.delete(root);
      return Object.freeze({removed: true});
    } finally { if (coordinator.active === operation) coordinator.active = null; }
  }
  list() { return Object.entries(this.manifest.models).map(([id, value]) => ({id, name: value.name, purpose: value.purpose, license: value.license})); }
}

module.exports = { ModelManager, parseModelManifest };
