const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const yauzl = require('yauzl');
const { parseRuntimeManifest, selectRuntimeArtifact, validateUrl } = require('./runtime-manifest.cjs');
const { runtimeLayout, resolveActivatedEntrypoint } = require('./runtime-paths.cjs');
const { validateEmbeddedRuntimeDirectory, REQUIRED_MACOS_RUNTIME_FILES } = require('./embedded-runtime-validator.cjs');
const { verifyFiles } = require('./tree-integrity.cjs');

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

async function readJson(filename) {
  try { return JSON.parse(await fsp.readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), {recursive: true, mode: 0o700});
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  await fsp.rename(temporary, filename);
}

const { checkWindowsRuntime } = require('./windows-runtime-checker.cjs');

class RuntimeManager {
  constructor({userData, manifest, platform = process.platform, arch = process.arch, flavor = 'cpu', fetchImpl = globalThis.fetch, healthCheck = async () => true, onProgress = () => {}, writeMetadata = atomicJson, treeChecker = null, requireTrustedManifest = false, trustedManifestDigests}) {
    this.userData = userData;
    this.manifest = parseRuntimeManifest(manifest, {requireTrusted: requireTrustedManifest, trustedDigests: trustedManifestDigests});
    this.platform = platform; this.arch = arch; this.flavor = flavor;
    this.fetchImpl = fetchImpl; this.healthCheck = healthCheck; this.onProgress = onProgress; this.writeMetadata = writeMetadata;
    this.treeChecker = treeChecker || (platform === 'win32' ? checkWindowsRuntime : null);
    this.controller = null;
  }
  _verifyDirectory(directory, artifact) {
    if (this.platform === 'win32' && artifact.entrypoint === 'voice-runtime.exe' && typeof this.treeChecker === 'function') {
      return this.treeChecker(directory, artifact.files ? artifact : undefined);
    }
    if (artifact.files) {
      const result = verifyFiles(directory, artifact.files);
      if (artifact.fileCount !== undefined && result.fileCount !== artifact.fileCount) throw new Error('ARTIFACT_FILE_COUNT_MISMATCH');
      if (artifact.treeDigest !== undefined && result.treeDigest !== artifact.treeDigest) throw new Error('ARTIFACT_TREE_DIGEST_MISMATCH');
      return result;
    }
    return null;
  }
  _selection() {
    const artifact = selectRuntimeArtifact(this.manifest, this.platform, this.arch, this.flavor);
    const key = this.platform === 'win32' ? `${this.platform}-${this.arch}-${this.flavor}` : `${this.platform}-${this.arch}`;
    return {artifact, key, layout: runtimeLayout(this.userData, this.manifest.release, key)};
  }
  async status() {
    let selected;
    try { selected = this._selection(); } catch (error) { return {state: 'unavailable', reason: error.message}; }
    const metadata = await readJson(selected.layout.metadata);
    const current = metadata?.current;
    if (!current) return {state: 'unavailable'};
    const trusted = current.release === this.manifest.release
      && current.platformKey === selected.key
      && path.resolve(current.directory || '') === path.resolve(selected.layout.versionDir)
      && current.entrypoint === selected.artifact.entrypoint
      && current.sha256 === selected.artifact.sha256;
    if (!trusted) return {state: 'unavailable', reason: 'UNTRUSTED_ACTIVATION_METADATA'};
    const entrypoint = resolveActivatedEntrypoint(selected.layout.versionDir, selected.artifact.entrypoint);
    try { await fsp.access(entrypoint); }
    catch { return {state: 'unavailable', reason: 'ACTIVE_ENTRYPOINT_MISSING'}; }

    try {
      this._verifyDirectory(selected.layout.versionDir, selected.artifact);
    } catch (treeErr) {
      return {state: 'unavailable', reason: 'RUNTIME_TREE_CORRUPTED', detail: treeErr.message};
    }

    return {state: 'installed', ...current, directory: selected.layout.versionDir, entrypoint};
  }
  async prepareLaunch() {
    const selected = this._selection();
    const status = await this.status();
    if (status.state !== 'installed') throw new Error(`RUNTIME_NOT_READY:${status.reason || status.state}`);
    const launches = path.join(selected.layout.root, '.launches');
    await fsp.mkdir(launches, {recursive: true, mode: 0o700});
    const directory = path.join(launches, crypto.randomUUID());
    await fsp.cp(selected.layout.versionDir, directory, {recursive: true, errorOnExist: true, force: false, dereference: false});
    try {
      this._verifyDirectory(directory, selected.artifact);
      const entrypoint = resolveActivatedEntrypoint(directory, selected.artifact.entrypoint);
      return Object.freeze({
        directory,
        entrypoint,
        verify: () => this._verifyDirectory(directory, selected.artifact),
        cleanup: () => fsp.rm(directory, {recursive: true, force: true}),
      });
    } catch (error) {
      await fsp.rm(directory, {recursive: true, force: true});
      throw error;
    }
  }
  cancel() { this.controller?.abort(); }
  async install() {
    if (this.controller) throw new Error('INSTALL_ALREADY_RUNNING');
    const {artifact, key, layout} = this._selection();
    this.controller = new AbortController();
    try {
      await fsp.mkdir(layout.downloads, {recursive: true, mode: 0o700});
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
      await pipeline(input, meter, fs.createWriteStream(layout.partial, {flags: 'w', mode: 0o600, signal: this.controller.signal}));
      if (bytes !== artifact.bytes) throw new Error('BYTE_COUNT_MISMATCH');
      if (hash.digest('hex') !== artifact.sha256) throw new Error('SHA256_MISMATCH');
      throwIfAborted(this.controller.signal);
      await fsp.rm(layout.staging, {recursive: true, force: true});
      const maxExtractedBytes = Math.min(8 * 1024 * 1024 * 1024, Math.max(128 * 1024 * 1024, artifact.bytes * 100));
      await extractZipSecure(layout.partial, layout.staging, {maxExtractedBytes, signal: this.controller.signal});
      throwIfAborted(this.controller.signal);
      const stagedEntrypoint = resolveActivatedEntrypoint(layout.staging, artifact.entrypoint);
      await fsp.access(stagedEntrypoint);
      this._verifyDirectory(layout.staging, artifact);
      if (this.platform !== 'win32') await fsp.chmod(stagedEntrypoint, 0o700);
      if (!await this.healthCheck(stagedEntrypoint)) throw new Error('RUNTIME_HEALTH_CHECK_FAILED');
      throwIfAborted(this.controller.signal);
      await fsp.mkdir(path.dirname(layout.versionDir), {recursive: true, mode: 0o700});
      const old = await readJson(layout.metadata);
      const backup = `${layout.versionDir}.previous-${crypto.randomUUID()}`;
      let previousDirectoryMoved = false;
      let candidateActivated = false;
      try {
        try {
          await fsp.rename(layout.versionDir, backup);
          previousDirectoryMoved = true;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        throwIfAborted(this.controller.signal);
        await fsp.rename(layout.staging, layout.versionDir);
        candidateActivated = true;
        throwIfAborted(this.controller.signal);
        const current = {release: this.manifest.release, platformKey: key, directory: layout.versionDir, entrypoint: artifact.entrypoint, sha256: artifact.sha256, activatedAt: new Date().toISOString()};
        const previous = old?.current ? {...old.current, directory: previousDirectoryMoved && path.resolve(old.current.directory || '') === path.resolve(layout.versionDir) ? backup : old.current.directory} : null;
        await this.writeMetadata(layout.metadata, {current, previous});
        const entrypoint = resolveActivatedEntrypoint(layout.versionDir, artifact.entrypoint);
        return {state: 'installed', ...current, entrypoint};
      } catch (error) {
        if (candidateActivated) await fsp.rm(layout.versionDir, {recursive: true, force: true}).catch(() => {});
        if (previousDirectoryMoved) await fsp.rename(backup, layout.versionDir).catch(() => {});
        throw error;
      }
    } finally {
      await fsp.rm(layout.partial, {force: true}).catch(() => {});
      await fsp.rm(layout.staging, {recursive: true, force: true}).catch(() => {});
      this.controller = null;
    }
  }
}

async function resolveEmbeddedRuntime({ resourcesPath, platform = process.platform, arch = process.arch }) {
  if (!resourcesPath || typeof resourcesPath !== 'string') return null;
  try {
    const result = validateEmbeddedRuntimeDirectory(path.join(path.resolve(resourcesPath), 'runtime'), {
      expectedPlatform: `${platform}-${arch}`,
      requireExecutable: platform !== 'win32',
      requireTree: true,
      requiredFiles: platform === 'darwin' ? REQUIRED_MACOS_RUNTIME_FILES : [],
    });
    return {
      state: 'embedded',
      platformKey: result.platform,
      directory: result.runtimeDir,
      entrypoint: result.entrypoint,
      bytes: result.bytes,
      sha256: result.sha256,
      fileCount: result.fileCount,
      treeSha256: result.treeSha256,
    };
  } catch {
    return null;
  }
}

module.exports = { RuntimeManager, resolveEmbeddedRuntime, extractZipSecure, validateZipEntry };
