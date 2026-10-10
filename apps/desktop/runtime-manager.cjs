const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline, finished } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const yauzl = require('yauzl');
const { parseRuntimeManifest, parseModelManifest, selectRuntimeArtifact, validateUrl, validateRawModelUrl, artifactIdentity } = require('./runtime-manifest.cjs');
const { runtimeLayout, generationLayout, ensureManagedDirectory, resolveActivatedEntrypoint, assertManagedPath } = require('./runtime-paths.cjs');
const { getManagedAssetCoordinator, LEASE_LIMITS } = require('./managed-asset-lease.cjs');
const { verifyInventory, ASSET_LIMITS } = require('./tree-integrity.cjs');

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('INSTALL_CANCELLED');
  error.name = 'AbortError';
  throw error;
}

async function fetchWithTrustedRedirects(fetchImpl, startUrl, signal, maxRedirects = 5) {
  let url = startUrl;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    validateUrl(url);
    const response = await fetchImpl(url, {signal, redirect: 'manual'});
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (response.url) validateUrl(response.url);
      return response;
    }
    if (redirects === maxRedirects) throw new Error('TOO_MANY_REDIRECTS');
    const location = response.headers.get('location');
    if (!location) throw new Error('REDIRECT_LOCATION_MISSING');
    url = new URL(location, url).toString();
    validateUrl(url);
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

async function discardRawResponse(response) {
  const body = response.body;
  if (!body) return;
  if (typeof body.cancel === 'function') await body.cancel();
  else {
    const closed = finished(body, {cleanup: true}).catch(() => {});
    body.destroy();
    await closed;
  }
}

async function fetchRawModelFile(fetchImpl, source, signal) {
  let url = source;
  for (let redirects = 0; redirects <= 5; redirects++) {
    throwIfAborted(signal);
    validateRawModelUrl(url, source);
    const response = await fetchImpl(url, {signal, redirect: 'manual', credentials: 'omit'});
    let accepted = false;
    try {
      throwIfAborted(signal);
      validateRawModelUrl(response.url, source);
      if (new URL(response.url).href !== new URL(url).href) throw new Error('RAW_RESPONSE_URL_MISMATCH');
      if (![301, 302, 303, 307, 308].includes(response.status)) { accepted = true; return response; }
      if (redirects === 5) throw new Error('TOO_MANY_REDIRECTS');
      const location = response.headers.get('location');
      if (!location) throw new Error('REDIRECT_LOCATION_MISSING');
      // Preserve the wire spelling until policy checks; URL normalization must
      // not turn a forbidden host/path into an allowed redirect.
      const target = location.startsWith('//') ? `https:${location}`
        : location.startsWith('/') ? `${new URL(url).origin}${location}` : location;
      validateRawModelUrl(target, source);
      url = target;
    } finally { if (!accepted) await discardRawResponse(response); }
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

async function materializeRawModelFiles(artifact, layout, {appRoot, fetchImpl, signal, onProgress}) {
  ensureManagedDirectory(appRoot, layout.staging);
  const roots = [layout.generationRoot, layout.staging].map(directory => [directory, fs.lstatSync(directory)]);
  const checkRoots = () => {
    for (const [directory, original] of roots) {
      const current = fs.lstatSync(assertManagedPath(appRoot, directory));
      if (!current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino) throw new Error('RAW_GENERATION_CHANGED');
    }
  };
  const temporary = path.join(layout.generationRoot, 'raw-file.partial');
  let completed = 0;
  for (const file of artifact.files) {
    throwIfAborted(signal);
    checkRoots();
    const source = artifact.sources[file.path];
    const response = await fetchRawModelFile(fetchImpl, source, signal);
    let handedToPipeline = false, output, input, fd;
    try {
      throwIfAborted(signal);
      checkRoots();
      if (!response.ok || !response.body) throw new Error(`DOWNLOAD_FAILED:${response.status}`);
      validateRawModelUrl(response.url, source);
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) !== file.bytes)) throw new Error('CONTENT_LENGTH_MISMATCH');
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      const meter = new Transform({transform(chunk, _encoding, callback) {
        try {
          throwIfAborted(signal);
          bytes += chunk.length;
          if (bytes > file.bytes) throw new Error('BYTE_COUNT_EXCEEDED');
          hash.update(chunk);
          onProgress({bytes: completed + bytes, total: artifact.bytes, phase: 'download'});
          throwIfAborted(signal);
          callback(null, chunk);
        } catch (error) { callback(error); }
      }});
      checkRoots();
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      const opened = fs.fstatSync(fd);
      output = fs.createWriteStream(temporary, {fd, flags: 'wx', mode: 0o600});
      fd = undefined; // the pipeline's writable now owns this descriptor
      input = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
      handedToPipeline = true;
      await pipeline(input, meter, output, {signal});
      throwIfAborted(signal);
      if (bytes !== file.bytes) throw new Error('BYTE_COUNT_MISMATCH');
      if (hash.digest('hex') !== file.sha256) throw new Error('SHA256_MISMATCH');
      checkRoots();
      const target = resolveActivatedEntrypoint(layout.staging, file.path);
      ensureManagedDirectory(appRoot, path.dirname(target));
      const downloaded = fs.lstatSync(assertManagedPath(appRoot, temporary));
      if (!downloaded.isFile() || downloaded.nlink !== 1 || downloaded.dev !== opened.dev || downloaded.ino !== opened.ino
        || downloaded.size !== file.bytes || (downloaded.mode & 0o111)) throw new Error('RAW_FILE_IDENTITY_CHANGED');
      try { fs.lstatSync(target); throw new Error('RAW_DESTINATION_EXISTS'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      throwIfAborted(signal);
      fs.renameSync(temporary, target);
      completed += bytes;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (!handedToPipeline) {
        if (output) {
          const closed = finished(output, {cleanup: true}).catch(() => {});
          output.destroy(); await closed;
        }
        await discardRawResponse(input ? {body: input} : response);
      }
    }
  }
  return checkRoots;
}

function validateZipEntry(entry) {
  const name = entry.fileName;
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error('UNSAFE_ARCHIVE_ENTRY');
  const parts = name.replace(/\/$/, '').split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) throw new Error('UNSAFE_ARCHIVE_ENTRY');
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const kind = mode & 0o170000;
  if (kind === 0o120000) throw new Error('ARCHIVE_SYMLINK_FORBIDDEN');
  if (kind && kind !== 0o100000 && kind !== 0o040000) throw new Error('ARCHIVE_SPECIAL_FILE_FORBIDDEN');
  return parts.join('/') + (name.endsWith('/') ? '/' : '');
}

function openZip(filename) {
  return new Promise((resolve, reject) => yauzl.open(filename, {lazyEntries: true, decodeStrings: true, validateEntrySizes: true}, (error, zip) => error ? reject(error) : resolve(zip)));
}
function openEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

async function extractZipSecure(filename, destination, {maxExtractedBytes = 8 * 1024 * 1024 * 1024, signal} = {}) {
  throwIfAborted(signal);
  await fsp.mkdir(destination, {recursive: false, mode: 0o700});
  const zip = await openZip(filename);
  const seen = new Set();
  let total = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = async error => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch {}
      reject(error);
    };
    zip.on('error', fail);
    zip.on('end', () => { if (!settled) { settled = true; resolve(); } });
    zip.on('entry', async entry => {
      try {
        throwIfAborted(signal);
        const safeName = validateZipEntry(entry);
        const relative = safeName.replace(/\/$/, '');
        if (seen.has(relative)) throw new Error('DUPLICATE_ARCHIVE_ENTRY');
        seen.add(relative);
        total += entry.uncompressedSize;
        if (!Number.isSafeInteger(total) || total > maxExtractedBytes) throw new Error('ARCHIVE_EXPANSION_LIMIT');
        const target = path.resolve(destination, ...relative.split('/'));
        const root = path.resolve(destination);
        if (!target.startsWith(root + path.sep)) throw new Error('ARCHIVE_PATH_ESCAPE');
        if (safeName.endsWith('/')) await fsp.mkdir(target, {recursive: true, mode: 0o700});
        else {
          await fsp.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
          const input = await openEntry(zip, entry);
          await pipeline(input, fs.createWriteStream(target, {flags: 'wx', mode: ((entry.externalFileAttributes >>> 16) & 0o111) ? 0o700 : 0o600}), {signal});
          throwIfAborted(signal);
        }
        zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.readEntry();
  });
}

function readJson(filename) {
  let handle;
  try {
    assertManagedPath(path.dirname(filename), filename);
    handle = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw new Error('METADATA_NOT_FILE');
    if (stat.size > ASSET_LIMITS.maxMetadataBytes) throw new Error('METADATA_LIMIT');
    // One extra byte detects growth; never let a concurrent rewrite grow a readFile allocation.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(handle, buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('METADATA_CHANGED');
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}
function metadataGate(_filename, _value, {commit}) { return commit(); }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

class RuntimeManager {
  constructor({userData, appUserData = userData, manifest, artifactKind = 'runtime', modelId, platform = process.platform, arch = process.arch, flavor = 'cpu', fetchImpl = globalThis.fetch, healthCheck, onProgress = () => {}, writeMetadata = metadataGate}) {
    if (!['runtime', 'model'].includes(artifactKind)) throw new Error('INVALID_ARTIFACT_KIND');
    this.artifactKind = artifactKind; this.modelId = modelId;
    this.userData = userData;
    this.coordinator = getManagedAssetCoordinator(appUserData);
    this.manifest = require('./asset-manifest-trust.cjs').inheritManifestAuthority(manifest,
      artifactKind === 'model' ? parseModelManifest(manifest) : parseRuntimeManifest(manifest));
    if (artifactKind === 'model' && (typeof modelId !== 'string' || !Object.hasOwn(this.manifest.models, modelId))) throw new Error('UNKNOWN_MODEL');
    this.platform = platform; this.arch = arch; this.flavor = flavor;
    this.fetchImpl = fetchImpl; this.healthCheck = healthCheck; this.onProgress = onProgress; this.writeMetadata = writeMetadata;
    this.controller = null;
  }
  _selection() {
    const selection = this.artifactKind === 'model' ? this.manifest.models[this.modelId] : this.manifest;
    const artifact = selectRuntimeArtifact(selection, this.platform, this.arch, this.flavor);
    const key = this.platform === 'win32' ? `${this.platform}-${this.arch}-${this.flavor}` : `${this.platform}-${this.arch}`;
    return {artifact, key, layout: runtimeLayout(this.userData, this.manifest.release, key)};
  }
  _metadata(selected) {
    const metadata = readJson(selected.layout.metadata);
    if (metadata === null) return null;
    const fail = () => { throw new Error('UNTRUSTED_ACTIVATION_METADATA'); };
    const raw = selected.artifact.transport === 'raw-files';
    if (!exactKeys(metadata, ['schemaVersion', 'current', 'previous']) || metadata.schemaVersion !== (raw ? 3 : 2)) fail();
    const tuple = current => {
      if (!exactKeys(current, ['kind', 'modelId', 'generation', 'release', 'platformKey', 'directory', 'entrypoint', raw ? 'identity' : 'sha256', 'treeDigest', 'activatedAt'])) fail();
      if (raw) {
        if (!exactKeys(current.identity, ['kind', 'treeDigest']) || current.identity.kind !== 'raw-files'
          || typeof current.identity.treeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(current.identity.treeDigest)
          || current.identity.treeDigest !== current.treeDigest) fail();
        Object.freeze(current.identity);
      }
      if (current.kind !== this.artifactKind || current.modelId !== (this.modelId || null)
        || typeof current.release !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(current.release)
        || current.platformKey !== selected.key || typeof current.generation !== 'string'
        || !/^g-[0-9a-f]{64}$/.test(current.generation)
        || (!raw && (typeof current.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(current.sha256)))
        || typeof current.treeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(current.treeDigest)
        || typeof current.activatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(current.activatedAt)) fail();
      const timestamp = new Date(current.activatedAt);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== current.activatedAt) fail();
      const layout = generationLayout(selected.layout, current.generation);
      if (current.directory !== layout.versionDir) fail();
      resolveActivatedEntrypoint(layout.versionDir, current.entrypoint);
    };
    tuple(metadata.current);
    if (metadata.previous !== null) tuple(metadata.previous);
    return metadata;
  }
  _trustedCurrent(selected) {
    const current = this._metadata(selected)?.current;
    if (!current || current.release !== this.manifest.release || current.entrypoint !== selected.artifact.entrypoint
      || (selected.artifact.transport === 'raw-files' ? current.identity.treeDigest !== selected.artifact.treeDigest : current.sha256 !== selected.artifact.sha256)
      || current.treeDigest !== selected.artifact.treeDigest) throw new Error('UNTRUSTED_ACTIVATION_METADATA');
    return current;
  }
  async status() {
    try {
      const selected = this._selection();
      const current = this._trustedCurrent(selected);
      await verifyInventory(current.directory, selected.artifact);
      const after = this._trustedCurrent(selected);
      if (JSON.stringify(after) !== JSON.stringify(current)) throw new Error('ACTIVATION_CHANGED');
      return {state: 'installed', ...current, entrypoint: resolveActivatedEntrypoint(current.directory, selected.artifact.entrypoint)};
    } catch (error) { return {state: 'unavailable', reason: error.message}; }
  }
  cancel() { this.controller?.abort(); }
  async pinCurrent(owner) {
    const selected = this._selection();
    const current = this._trustedCurrent(selected);
    const layout = generationLayout(selected.layout, current.generation);
    const pin = this.coordinator.prepare(layout.generationRoot, layout.metadata, owner);
    try {
      const status = await this.status();
      if (status.state !== 'installed' || status.generation !== current.generation) throw new Error('PIN_SELECTION_CHANGED');
      return Object.freeze({...status, release: pin.release});
    } catch (error) { await pin.release(owner); throw error; }
  }
  async install() {
    if (this.controller) throw new Error('INSTALL_ALREADY_RUNNING');
    const selected = this._selection();
    const {artifact, key} = selected;
    const layout = generationLayout(selected.layout);
    if (this.artifactKind === 'runtime' && typeof this.healthCheck !== 'function') throw new Error('RUNTIME_VALIDATION_REQUIRED');
    const expandedBytes = artifact.files.reduce((total, file) => total + file.bytes, 0);
    const raw = artifact.transport === 'raw-files';
    if (raw) this._metadata(selected); // New raw IDs do not migrate an existing ZIP activation.
    const reservation = (raw ? expandedBytes : artifact.bytes + expandedBytes) + LEASE_LIMITS.scratchBytes;
    const operation = this.coordinator.begin(layout.generationRoot, layout.metadata, reservation, () => this._metadata(selected));
    const owner = {};
    const pin = this.coordinator.pin(layout.generationRoot, owner);
    const controller = new AbortController(); this.controller = controller;
    try {
      this.coordinator.checkDisk();
      ensureManagedDirectory(this.coordinator.appRoot, path.dirname(layout.generationRoot));
      fs.mkdirSync(layout.generationRoot, {mode: 0o700});
      this.coordinator.created(layout.generationRoot);
      let checkRawRoots;
      if (raw) {
        checkRawRoots = await materializeRawModelFiles(artifact, layout, {appRoot: this.coordinator.appRoot,
          fetchImpl: this.fetchImpl, signal: controller.signal, onProgress: this.onProgress});
      } else {
        const response = await fetchWithTrustedRedirects(this.fetchImpl, artifact.url, this.controller.signal);
        if (!response.ok || !response.body) throw new Error(`DOWNLOAD_FAILED:${response.status}`);
        if (response.url) validateUrl(response.url);
        const declared = response.headers.get('content-length');
        if (declared && Number(declared) !== artifact.bytes) throw new Error('CONTENT_LENGTH_MISMATCH');
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        const meter = new Transform({transform: (chunk, _encoding, callback) => {
          bytes += chunk.length;
          if (bytes > artifact.bytes) return callback(new Error('BYTE_COUNT_EXCEEDED'));
          hash.update(chunk);
          this.onProgress({bytes, total: artifact.bytes});
          callback(null, chunk);
        }});
        const input = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
        await pipeline(input, meter, fs.createWriteStream(layout.partial, {flags: 'wx', mode: 0o600, signal: controller.signal}));
        if (bytes !== artifact.bytes) throw new Error('BYTE_COUNT_MISMATCH');
        if (hash.digest('hex') !== artifact.sha256) throw new Error('SHA256_MISMATCH');
        throwIfAborted(this.controller.signal);

        const maxExtractedBytes = expandedBytes;
        await extractZipSecure(layout.partial, layout.staging, {maxExtractedBytes, signal: this.controller.signal});
      }
      throwIfAborted(this.controller.signal);
      const stagedEntrypoint = resolveActivatedEntrypoint(layout.staging, artifact.entrypoint);
      checkRawRoots?.();
      if (raw) {
        this.onProgress({bytes: artifact.bytes, total: artifact.bytes, phase: 'verifying'});
        throwIfAborted(controller.signal);
      }
      await verifyInventory(layout.staging, artifact, {signal: this.controller.signal});
      checkRawRoots?.();
      if (this.artifactKind === 'runtime') {
        if (this.platform !== 'win32') await fsp.chmod(stagedEntrypoint, 0o700);
        const context = Object.freeze({authority: 'MEMORY', generation: layout.generation,
          directory: layout.versionDir, signal: controller.signal,
          pin: originalOwner => this.coordinator.pin(layout.generationRoot, originalOwner)});
        if (await this.healthCheck(stagedEntrypoint, context) !== true) throw new Error('RUNTIME_HEALTH_CHECK_FAILED');
        throwIfAborted(controller.signal);
        await verifyInventory(layout.staging, artifact, {signal: controller.signal});
      }
      throwIfAborted(this.controller.signal);
      const old = this._metadata(selected); // previous is retention, never trust
      const current = Object.freeze({kind: this.artifactKind, modelId: this.modelId || null, generation: layout.generation, release: this.manifest.release, platformKey: key, directory: layout.versionDir, entrypoint: artifact.entrypoint, ...(raw ? {identity: artifactIdentity(artifact)} : {sha256: artifact.sha256}), treeDigest: artifact.treeDigest, activatedAt: new Date().toISOString()});
      const value = Object.freeze({schemaVersion: raw ? 3 : 2, current, previous: old?.current ? Object.freeze(old.current) : null});
      let committed = false, open = true, warning;
      const commit = () => {
        if (!open || committed || this.coordinator.active !== operation) throw new Error('METADATA_COMMIT_CLOSED');
        throwIfAborted(controller.signal);
        checkRawRoots?.();
        const temporary = path.join(layout.generationRoot, 'metadata.tmp');
        assertManagedPath(this.coordinator.appRoot, layout.generationRoot);
        assertManagedPath(this.coordinator.appRoot, layout.root);
        if (fs.existsSync(layout.metadata)) assertManagedPath(layout.root, layout.metadata);
        fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {flag: 'wx', mode: 0o600});
        throwIfAborted(controller.signal);
        // Synchronous rename + flag: cancellation cannot interleave in this commit turn.
        fs.renameSync(temporary, layout.metadata);
        committed = true;
        this.coordinator.publish(layout.generationRoot, old?.current ? path.dirname(old.current.directory) : null);
      };
      try {
        await this.writeMetadata(layout.metadata, value, Object.freeze({commit}));
        if (!committed) throw new Error('METADATA_NOT_COMMITTED');
      } catch (error) {
        if (!committed) throw error;
        warning = error.message;
      } finally { open = false; }
      return {state: 'installed', ...current, entrypoint: stagedEntrypoint, restartRequired: true, ...(warning ? {warning} : {})};
    } finally {
      await pin.release(owner);
      await this.coordinator.finish(operation);
      if (this.controller === controller) this.controller = null;
    }
  }
}

module.exports = { RuntimeManager, extractZipSecure, validateZipEntry };
