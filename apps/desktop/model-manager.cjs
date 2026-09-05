const path = require('node:path');
const {assertManifestTrust, assertRelativeSafe, parseRuntimeManifest} = require('./runtime-manifest.cjs');
const {RuntimeManager} = require('./runtime-manager.cjs');

const MODEL_ROLES = new Set(['onnx', 'voices']);

function validateLicense(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['spdx', 'url'].includes(key))
      || typeof value.spdx !== 'string' || !value.spdx || typeof value.url !== 'string') throw new Error('INVALID_MODEL_LICENSE');
  let url;
  try { url = new URL(value.url); } catch { throw new Error('INVALID_MODEL_LICENSE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_MODEL_LICENSE_URL');
  return Object.freeze({spdx: value.spdx, url: url.toString()});
}

function parseModelManifest(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 || typeof input.release !== 'string' || !input.release) throw new Error('INVALID_MODEL_MANIFEST');
  if (Object.keys(input).some(key => !['schemaVersion', 'release', 'models'].includes(key)) || !input.models || typeof input.models !== 'object' || Array.isArray(input.models)) throw new Error('INVALID_MODELS');
  assertManifestTrust(input, 'model', options);
  const models = {};
  for (const [id, model] of Object.entries(input.models)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error('INVALID_MODEL_ID');
    const allowed = ['name', 'purpose', 'revision', 'license', 'assets', 'artifacts'];
    if (!model || typeof model !== 'object' || Object.keys(model).some(key => !allowed.includes(key))) throw new Error('INVALID_MODEL');
    if (typeof model.name !== 'string' || !model.name || typeof model.purpose !== 'string' || !model.purpose
        || typeof model.revision !== 'string' || !/^[A-Za-z0-9._-]+$/.test(model.revision)) throw new Error('INVALID_MODEL_METADATA');
    const license = validateLicense(model.license);
    if (!Array.isArray(model.assets) || !model.assets.length) throw new Error('INVALID_MODEL_ASSETS');
    const assets = model.assets.map(asset => {
      if (!asset || typeof asset !== 'object' || Object.keys(asset).some(key => !['role', 'path', 'bytes', 'sha256', 'license'].includes(key))
          || !MODEL_ROLES.has(asset.role) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
          || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error('INVALID_MODEL_ASSET');
      return Object.freeze({role: asset.role, path: assertRelativeSafe(asset.path), bytes: asset.bytes, sha256: asset.sha256, license: validateLicense(asset.license)});
    });
    if (new Set(assets.map(asset => asset.role)).size !== assets.length || new Set(assets.map(asset => asset.path)).size !== assets.length) throw new Error('DUPLICATE_MODEL_ASSET');
    if (id === 'kokoro' && (!assets.some(asset => asset.role === 'onnx') || !assets.some(asset => asset.role === 'voices'))) throw new Error('KOKORO_REQUIRED_ASSET_MISSING');
    const validated = parseRuntimeManifest(
      {schemaVersion: 1, release: `${input.release}-${id}`, artifacts: model.artifacts},
      {requireArtifactIntegrity: true},
    );
    for (const artifact of Object.values(validated.artifacts)) {
      if (!artifact.files) throw new Error('MODEL_ARTIFACT_FILESET_REQUIRED');
      if (artifact.files.length !== assets.length || artifact.files.some((item, index) => {
        const asset = [...assets].sort((a, b) => a.path.localeCompare(b.path))[index];
        return item.path !== asset.path || item.bytes !== asset.bytes || item.sha256 !== asset.sha256;
      })) throw new Error('MODEL_ASSET_FILESET_MISMATCH');
    }
    models[id] = Object.freeze({name: model.name, purpose: model.purpose, revision: model.revision, license, assets: Object.freeze(assets), artifacts: validated.artifacts});
  }
  return Object.freeze({schemaVersion: 1, release: input.release, models: Object.freeze(models)});
}

class ModelManager {
  constructor(options) {
    this.options = {...options};
    this.manifest = parseModelManifest(options.manifest, {requireTrusted: options.requireTrustedManifest, trustedDigests: options.trustedManifestDigests});
    this.active = new Map();
  }
  _manager(id) {
    const model = this.manifest.models[id];
    if (!model) throw new Error(`UNKNOWN_MODEL:${id}`);
    return new RuntimeManager({
      userData: path.join(this.options.userData, 'models', id),
      manifest: {schemaVersion: 1, release: `${this.manifest.release}-${id}`, artifacts: model.artifacts},
      platform: this.options.platform,
      arch: this.options.arch,
      flavor: this.options.flavor,
      fetchImpl: this.options.fetchImpl,
      onProgress: progress => this.options.onProgress?.({modelId: id, ...progress}),
    });
  }
  async status(id) {
    const model = this.manifest.models[id];
    if (!model) throw new Error(`UNKNOWN_MODEL:${id}`);
    const status = await this._manager(id).status();
    if (status.state !== 'installed') return status;
    const assets = Object.fromEntries(model.assets.map(asset => [asset.role, path.join(status.directory, ...asset.path.split('/'))]));
    return {...status, revision: model.revision, assets};
  }
  async prepareAssets(id) {
    const model = this.manifest.models[id];
    if (!model) throw new Error(`UNKNOWN_MODEL:${id}`);
    const launch = await this._manager(id).prepareLaunch();
    const assets = Object.fromEntries(model.assets.map(asset => [asset.role, path.join(launch.directory, ...asset.path.split('/'))]));
    return Object.freeze({...launch, revision: model.revision, assets: Object.freeze(assets)});
  }
  async install(id) {
    const manager = this._manager(id);
    if (this.active.has(id)) throw new Error('INSTALL_ALREADY_RUNNING');
    this.active.set(id, manager);
    try { return await manager.install(); } finally { this.active.delete(id); }
  }
  cancel(id) {
    if (!this.manifest.models[id]) throw new Error(`UNKNOWN_MODEL:${id}`);
    this.active.get(id)?.cancel();
  }
  list() { return Object.entries(this.manifest.models).map(([id, value]) => ({id, name: value.name, purpose: value.purpose, revision: value.revision, license: value.license, assets: value.assets.map(({role, bytes, sha256, license}) => ({role, bytes, sha256, license}))})); }
}

module.exports = {MODEL_ROLES, ModelManager, parseModelManifest};
