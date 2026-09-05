const crypto = require('node:crypto');
const path = require('node:path');

const PLATFORM_KEYS = new Set(['darwin-arm64', 'win32-x64-cpu', 'win32-x64-dml', 'win32-x64-cuda']);
const GITHUB_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const SHA256 = /^[0-9a-f]{64}$/;
// Publication requires a reviewed code change which pins the canonical manifest
// digest here. The trust root is intentionally not stored in the manifest.
const TRUSTED_MANIFEST_DIGESTS = Object.freeze({
  runtime: Object.freeze([]),
  model: Object.freeze([]),
});

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalManifestDigest(input) {
  return crypto.createHash('sha256').update(canonicalize(input), 'utf8').digest('hex');
}

function assertManifestTrust(input, kind, {requireTrusted = false, trustedDigests} = {}) {
  const collection = kind === 'model' ? input.models : input.artifacts;
  if (input.release === 'unpublished') {
    if (!collection || Object.keys(collection).length !== 0) throw new Error('UNPUBLISHED_MANIFEST_MUST_BE_EMPTY');
    return;
  }
  if (!requireTrusted) return;
  const roots = trustedDigests || TRUSTED_MANIFEST_DIGESTS[kind];
  const digest = canonicalManifestDigest(input);
  const trusted = typeof roots?.has === 'function' ? roots.has(digest) : roots?.includes(digest);
  if (!trusted) throw new Error(`UNTRUSTED_${kind.toUpperCase()}_MANIFEST`);
}

function assertRelativeSafe(value, field = 'path') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) throw new Error(`INVALID_${field.toUpperCase()}`);
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error(`ABSOLUTE_${field.toUpperCase()}`);
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`UNSAFE_${field.toUpperCase()}`);
  if (path.posix.normalize(value) !== value) throw new Error(`UNSAFE_${field.toUpperCase()}`);
  return value;
}

function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_ARTIFACT_URL'); }
  if (url.protocol !== 'https:' || !GITHUB_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('UNTRUSTED_ARTIFACT_URL');
  if (url.hostname === 'github.com' && !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname)) throw new Error('INVALID_GITHUB_RELEASE_URL');
  return url.toString();
}

function parseFiles(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('INVALID_ARTIFACT_FILES');
  const files = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['path', 'bytes', 'sha256'].includes(key))) throw new Error('INVALID_ARTIFACT_FILE');
    if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !SHA256.test(item.sha256)) throw new Error('INVALID_ARTIFACT_FILE');
    return Object.freeze({path: assertRelativeSafe(item.path), bytes: item.bytes, sha256: item.sha256});
  });
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map(item => item.path)).size !== files.length || files.some((item, index) => item.path !== sorted[index].path)) throw new Error('ARTIFACT_FILES_NOT_SORTED_UNIQUE');
  return Object.freeze(files);
}

function parseArtifact(value, {requireFiles = false, requireTreeIntegrity = false} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARTIFACT');
  const allowed = new Set(['url', 'sha256', 'bytes', 'entrypoint', 'archive', 'files', 'treeDigest', 'fileCount']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('UNKNOWN_ARTIFACT_FIELD');
  if (!SHA256.test(value.sha256)) throw new Error('INVALID_SHA256');
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) throw new Error('INVALID_BYTES');
  if (value.archive !== 'zip') throw new Error('UNSUPPORTED_ARCHIVE');
  const files = value.files === undefined ? undefined : parseFiles(value.files);
  if (requireFiles && !files) throw new Error('ARTIFACT_FILESET_REQUIRED');
  if (files) {
    if (value.fileCount !== undefined && value.fileCount !== files.length) throw new Error('ARTIFACT_FILE_COUNT_MISMATCH');
    if (value.treeDigest !== undefined && !SHA256.test(value.treeDigest)) throw new Error('INVALID_TREE_DIGEST');
    if (requireTreeIntegrity && (value.fileCount !== files.length || !SHA256.test(value.treeDigest))) throw new Error('ARTIFACT_TREE_INTEGRITY_REQUIRED');
  }
  const result = {url: validateUrl(value.url), sha256: value.sha256, bytes: value.bytes, entrypoint: assertRelativeSafe(value.entrypoint, 'entrypoint'), archive: value.archive};
  if (files) Object.assign(result, {files, fileCount: files.length, treeDigest: value.treeDigest});
  return Object.freeze(result);
}

function parseRuntimeManifest(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_MANIFEST');
  if (input.schemaVersion !== 1) throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  if (typeof input.release !== 'string' || !input.release) throw new Error('INVALID_RELEASE');
  if (!input.artifacts || typeof input.artifacts !== 'object' || Array.isArray(input.artifacts)) throw new Error('INVALID_ARTIFACTS');
  if (Object.keys(input).some(key => !['schemaVersion', 'release', 'artifacts'].includes(key))) throw new Error('UNKNOWN_MANIFEST_FIELD');
  assertManifestTrust(input, 'runtime', options);
  const artifacts = {};
  for (const [key, value] of Object.entries(input.artifacts)) {
    if (!PLATFORM_KEYS.has(key)) throw new Error('UNKNOWN_PLATFORM_KEY');
    const requireTreeIntegrity = (Boolean(options.requireTrusted) && key.startsWith('win32-')) || Boolean(options.requireArtifactIntegrity);
    artifacts[key] = parseArtifact(value, {requireFiles: requireTreeIntegrity, requireTreeIntegrity});
  }
  return Object.freeze({schemaVersion: 1, release: input.release, artifacts: Object.freeze(artifacts)});
}

function selectRuntimeArtifact(manifest, platform = process.platform, arch = process.arch, flavor = 'cpu') {
  const key = platform === 'win32' ? `${platform}-${arch}-${flavor}` : `${platform}-${arch}`;
  const artifact = manifest.artifacts[key];
  if (!artifact) throw new Error(`RUNTIME_UNAVAILABLE:${key}`);
  return artifact;
}

module.exports = {
  GITHUB_HOSTS, assertManifestTrust, assertRelativeSafe,
  canonicalManifestDigest, parseArtifact, parseFiles, parseRuntimeManifest,
  selectRuntimeArtifact, validateUrl,
};
