const path = require('node:path');
const {types: {isProxy}} = require('node:util');
const { ASSET_LIMITS, assertPortablePath, validateInventory } = require('./tree-integrity.cjs');

const PLATFORM_KEYS = new Set(['darwin-arm64', 'win32-x64-cpu', 'win32-x64-cuda']);
const GITHUB_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const SHA256 = /^[0-9a-f]{64}$/;

// Legacy lexical helper remains available; v2 uses assertPortablePath below.
function assertRelativeSafe(value, field = 'path') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) throw new Error(`INVALID_${field.toUpperCase()}`);
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error(`ABSOLUTE_${field.toUpperCase()}`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`UNSAFE_${field.toUpperCase()}`);
  if (path.posix.normalize(value) !== value) throw new Error(`UNSAFE_${field.toUpperCase()}`);
  return value;
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_OBJECT');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) throw new Error('INVALID_OBJECT_FIELD');
  }
  return value;
}
function exact(value, keys) {
  object(value);
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error('INVALID_OR_UNKNOWN_FIELD');
}
function boundedMetadata(value) {
  // JSON inputs only; size checked before accepting any parsed trust record.
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > ASSET_LIMITS.maxMetadataBytes) throw new Error('METADATA_LIMIT');
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > ASSET_LIMITS.maxTextLength || /[\x00-\x1f\x7f]/.test(value)) throw new Error('INVALID_TEXT');
  return value;
}
function segment(value) {
  assertPortablePath(value);
  if (value.includes('/')) throw new Error('INVALID_SEGMENT');
  return value;
}
function modelId(value) {
  segment(value);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new Error('INVALID_MODEL_ID');
  return value;
}
function sha(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error('INVALID_SHA256');
  return value;
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > ASSET_LIMITS.maxUrlLength || value.trim() !== value) throw new Error('INVALID_URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_HTTPS_URL');
  return url;
}
function validateUrl(value) {
  const url = httpsUrl(value);
  if (!GITHUB_HOSTS.has(url.hostname)) throw new Error('UNTRUSTED_ARTIFACT_URL');
  if (url.hostname === 'github.com' && !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname)) throw new Error('INVALID_GITHUB_RELEASE_URL');
  return url.toString();
}
// Separate raw-model lane; legacy ZIP/runtime validateUrl is unchanged.
function rawHttpsUrl(value) {
  const url = httpsUrl(value);
  const spelling = /^https:\/\/([^/?#]+)(\/[^?#]*)/.exec(value);
  if (/[\x00-\x20\x7f\\#]/.test(value) || (url.port && url.port !== '443') || !spelling
    || spelling[1] !== url.hostname + (spelling[1].endsWith(':443') ? ':443' : '')
    || spelling[2] !== url.pathname) throw new Error('INVALID_RAW_MODEL_URL');
  return url;
}
function validateRawModelUrl(value, sourceUrl = value) {
  const source = rawHttpsUrl(sourceUrl);
  const url = rawHttpsUrl(value);
  if (GITHUB_HOSTS.has(source.hostname)) {
    validateUrl(sourceUrl); validateUrl(value); return value;
  }
  const match = /^https:\/\/huggingface\.co(?::443)?\/([^/]+)\/([^/]+)\/resolve\/([0-9a-f]{40})\/([^?#]+)$/.exec(sourceUrl);
  if (!match) throw new Error('UNTRUSTED_RAW_MODEL_URL');
  segment(match[1]); segment(match[2]); assertPortablePath(match[4]);
  if (url.href === source.href) return value;
  const cachePath = `/api/resolve-cache/models/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
  if (url.hostname === 'huggingface.co' && url.pathname === cachePath) return value;
  // Only the observed official LFS lane; no wildcard or speculative CDN hosts.
  if (url.hostname === 'us.aws.cdn.hf.co' && /^\/xet-bridge-us\/[0-9a-f]{24}\/[0-9a-f]{64}$/.test(url.pathname)
    && url.search) return value;
  throw new Error('UNTRUSTED_RAW_MODEL_URL');
}
function license(value) {
  exact(value, ['spdx', 'url']);
  return Object.freeze({spdx: text(value.spdx), url: httpsUrl(value.url).toString()});
}
function provenance(value) {
  exact(value, ['sourceRevision', 'sourceUrl', 'license']);
  if (typeof value.sourceRevision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.sourceRevision)) throw new Error('INVALID_SOURCE_REVISION');
  return Object.freeze({sourceRevision: value.sourceRevision, sourceUrl: httpsUrl(value.sourceUrl).toString(), license: license(value.license)});
}
function bindings(value) {
  const roles = ['sttRoot', 'onnxModel', 'onnxVoices'];
  exact(value, roles);
  return Object.freeze(Object.fromEntries(roles.map(role => {
    const binding = value[role];
    exact(binding, role === 'sttRoot' ? ['modelId', 'archiveSha256'] : ['modelId', 'archiveSha256', 'path']);
    return [role, Object.freeze({modelId: modelId(binding.modelId), archiveSha256: sha(binding.archiveSha256),
      ...(role === 'sttRoot' ? {} : {path: assertPortablePath(binding.path)})})];
  })));
}
// Raw v3 accepts JSON data only, before size encoding can invoke a getter/toJSON.
function rawData(value, ancestors = new Set(), depth = 0, budget = {remaining: ASSET_LIMITS.maxMetadataBytes}) {
  if (--budget.remaining < 0 || depth > ASSET_LIMITS.maxDepth) throw new Error('METADATA_LIMIT');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value !== 'object' || isProxy(value) || ancestors.has(value)) throw new Error('INVALID_RAW_DATA');
  const array = Array.isArray(value);
  if (array) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > ASSET_LIMITS.maxFiles
      || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('INVALID_RAW_DATA');
  } else object(value);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error('INVALID_RAW_DATA');
    rawData(descriptor.value, ancestors, depth + 1, budget);
  }
  ancestors.delete(value);
}
function parseRawArtifact(value) {
  exact(value, ['transport', 'bytes', 'entrypoint', 'files', 'treeDigest', 'sources', 'provenance']);
  if (value.transport !== 'raw-files') throw new Error('UNSUPPORTED_MODEL_TRANSPORT');
  const inventory = validateInventory(value.files, value.treeDigest);
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes !== inventory.totalBytes) throw new Error('INVALID_BYTES');
  const entrypoint = assertPortablePath(value.entrypoint);
  if (!inventory.files.some(file => file.path === entrypoint)) throw new Error('ENTRYPOINT_NOT_IN_INVENTORY');
  exact(value.sources, inventory.files.map(file => file.path));
  const sources = Object.freeze(Object.fromEntries(inventory.files.map(file => [file.path, validateRawModelUrl(value.sources[file.path])])));
  return Object.freeze({transport: 'raw-files', bytes: value.bytes, entrypoint,
    files: inventory.files, treeDigest: inventory.treeDigest, sources, provenance: provenance(value.provenance)});
}
function parseArtifact(value, kind = 'runtime', schemaVersion = 2) {
  if (!['runtime', 'model'].includes(kind)) throw new Error('INVALID_ARTIFACT_KIND');
  // Unsupported kind/version pairs must not inspect or serialize metadata.
  if (schemaVersion !== 2 && (schemaVersion !== 3 || kind !== 'model')) throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  if (schemaVersion === 3 && kind === 'model') rawData(value);
  boundedMetadata(value);
  if (schemaVersion === 3 && kind === 'model') return parseRawArtifact(value);
  const keys = ['url', 'sha256', 'bytes', 'entrypoint', 'archive', 'files', 'treeDigest', 'provenance'];
  exact(value, kind === 'runtime' ? [...keys, 'modelBindings'] : keys);
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > ASSET_LIMITS.maxTotalBytes) throw new Error('INVALID_BYTES');
  if (value.archive !== 'zip') throw new Error('UNSUPPORTED_ARCHIVE');
  const inventory = validateInventory(value.files, value.treeDigest);
  const entrypoint = assertPortablePath(value.entrypoint);
  if (!inventory.files.some(file => file.path === entrypoint)) throw new Error('ENTRYPOINT_NOT_IN_INVENTORY');
  return Object.freeze({url: validateUrl(value.url), sha256: sha(value.sha256), bytes: value.bytes,
    entrypoint, archive: value.archive, files: inventory.files, treeDigest: inventory.treeDigest,
    provenance: provenance(value.provenance), ...(kind === 'runtime' ? {modelBindings: bindings(value.modelBindings)} : {})});
}
function artifactIdentity(value) {
  if (isProxy(value)) throw new Error('INVALID_RAW_DATA');
  object(value);
  // Any own transport field selects v3; malformed values must not fall back to ZIP.
  const raw = Object.hasOwn(value, 'transport');
  const parsed = parseArtifact(value, Object.hasOwn(value, 'modelBindings') ? 'runtime' : 'model', raw ? 3 : 2);
  return Object.freeze(raw ? {kind: 'raw-files', treeDigest: parsed.treeDigest}
    : {kind: 'zip', archiveSha256: parsed.sha256});
}
function artifacts(input, kind, schemaVersion = 2) {
  object(input);
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (!PLATFORM_KEYS.has(key)) throw new Error('UNKNOWN_PLATFORM_KEY');
    return [key, parseArtifact(value, kind, schemaVersion)];
  })));
}
function manifestRoot(input, collection) {
  boundedMetadata(input);
  exact(input, ['schemaVersion', 'release', collection]);
  if (!(collection === 'models' ? [1, 2, 3] : [1, 2]).includes(input.schemaVersion)) throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  segment(input.release);
  object(input[collection]);
  if (input.schemaVersion === 1 && Object.keys(input[collection]).length) throw new Error('LEGACY_REINSTALL_REQUIRED');
}
function parseRuntimeManifest(input) {
  manifestRoot(input, 'artifacts');
  return Object.freeze({schemaVersion: input.schemaVersion, release: input.release, artifacts: artifacts(input.artifacts, 'runtime')});
}
function parseModelManifest(input) {
  if (isProxy(input)) throw new Error('INVALID_RAW_DATA');
  object(input);
  if (input.schemaVersion === 3) rawData(input);
  manifestRoot(input, 'models');
  const models = Object.fromEntries(Object.entries(input.models).map(([id, model]) => {
    modelId(id);
    exact(model, ['name', 'purpose', 'license', 'artifacts']);
    return [id, Object.freeze({name: text(model.name), purpose: text(model.purpose), license: license(model.license), artifacts: artifacts(model.artifacts, 'model', input.schemaVersion)})];
  }));
  return Object.freeze({schemaVersion: input.schemaVersion, release: input.release, models: Object.freeze(models)});
}
function selectRuntimeArtifact(manifest, platform = process.platform, arch = process.arch, flavor = 'cpu') {
  const key = platform === 'win32' ? `${platform}-${arch}-${flavor}` : `${platform}-${arch}`;
  const artifact = manifest.artifacts[key];
  if (!artifact) throw new Error(`RUNTIME_UNAVAILABLE:${key}`);
  return artifact;
}

function resolveModelBindings(runtimeArtifact, modelManifest, platformKey) {
  if (!PLATFORM_KEYS.has(platformKey)) throw new Error('UNKNOWN_PLATFORM_KEY');
  const runtime = parseArtifact(runtimeArtifact, 'runtime');
  const manifest = parseModelManifest(modelManifest);
  for (const [role, binding] of Object.entries(runtime.modelBindings)) {
    const artifact = manifest.models[binding.modelId]?.artifacts[platformKey];
    if (!artifact || artifact.sha256 !== binding.archiveSha256) throw new Error(`MODEL_BINDING_MISMATCH:${role}`);
    if (role !== 'sttRoot' && !artifact.files.some(file => file.path === binding.path)) throw new Error(`MODEL_BINDING_PATH_MISSING:${role}`);
  }
  return runtime.modelBindings;
}

module.exports = { assertRelativeSafe, artifactIdentity, parseArtifact, parseRuntimeManifest, parseModelManifest, resolveModelBindings, selectRuntimeArtifact, validateUrl, validateRawModelUrl, ASSET_LIMITS };
