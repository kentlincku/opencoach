'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_MACOS_RUNTIME_FILES = Object.freeze([
  '_internal/mlx/lib/mlx.metallib',
  '_internal/mlx.metallib',
  '_internal/default.metallib',
]);

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateEmbeddedRuntimeDirectory(runtimeDir, {
  expectedPlatform,
  requireExecutable = true,
  requireTree = false,
  requiredFiles = [],
} = {}) {
  const root = path.resolve(runtimeDir);
  if (!fs.existsSync(root)) fail('MISSING_EMBEDDED_RUNTIME', root);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('INVALID_RUNTIME_DIRECTORY');
  const realRoot = fs.realpathSync(root);

  const metadataPath = path.join(root, 'metadata.json');
  if (!fs.existsSync(metadataPath)) fail('MISSING_RUNTIME_METADATA', metadataPath);
  const metadataStat = fs.lstatSync(metadataPath);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) fail('INVALID_RUNTIME_METADATA', metadataPath);

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    fail('INVALID_RUNTIME_METADATA', metadataPath);
  }
  if (metadata?.schemaVersion !== 1) fail('INVALID_RUNTIME_METADATA_SCHEMA');
  if (expectedPlatform && metadata.platform !== expectedPlatform) {
    fail('RUNTIME_PLATFORM_MISMATCH', `expected ${expectedPlatform}, got ${String(metadata.platform)}`);
  }
  if (typeof metadata.entrypoint !== 'string' || !metadata.entrypoint || path.isAbsolute(metadata.entrypoint)) {
    fail('INVALID_RUNTIME_ENTRYPOINT');
  }
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0) fail('INVALID_RUNTIME_SIZE');
  if (typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) fail('INVALID_RUNTIME_HASH');

  const entrypoint = path.resolve(root, metadata.entrypoint);
  if (!contained(root, entrypoint) || !fs.existsSync(entrypoint)) fail('INVALID_RUNTIME_ENTRYPOINT');
  let component = root;
  for (const part of path.relative(root, entrypoint).split(path.sep)) {
    component = path.join(component, part);
    if (fs.lstatSync(component).isSymbolicLink()) fail('INVALID_RUNTIME_ENTRYPOINT');
  }
  const realEntrypoint = fs.realpathSync(entrypoint);
  if (!contained(realRoot, realEntrypoint)) fail('INVALID_RUNTIME_ENTRYPOINT');
  const stat = fs.lstatSync(entrypoint);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_RUNTIME_ENTRYPOINT');
  if (requireExecutable) {
    try { fs.accessSync(entrypoint, fs.constants.X_OK); }
    catch { fail('RUNTIME_NOT_EXECUTABLE', entrypoint); }
  }
  if (stat.size !== metadata.bytes) fail('RUNTIME_SIZE_MISMATCH', `expected ${metadata.bytes}, got ${stat.size}`);

  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(entrypoint)).digest('hex');
  if (actualHash !== metadata.sha256) fail('RUNTIME_HASH_MISMATCH');

  // Complete runtime tree integrity validation
  // Mandatory: metadata.files must be non-empty and exhaustive for every accepted onedir runtime.
  // Missing, null, non-object, or empty tree data must fail closed; launcher-only verification is forbidden.
  // Note: An unsigned engineering artifact does not defend against a concurrent same-user/privileged
  // attacker; cryptographic execution binding requires signing and notarization.
  const isTreeRuntime = requireTree || fs.existsSync(path.join(root, '_internal')) || metadata.files !== undefined;
  if (isTreeRuntime) {
    if (!metadata.files || typeof metadata.files !== 'object' || Array.isArray(metadata.files)) {
      fail('MISSING_RUNTIME_TREE_MANIFEST');
    }
    const manifestKeys = Object.keys(metadata.files);
    if (manifestKeys.length === 0) fail('MISSING_RUNTIME_TREE_MANIFEST');
    if (!Number.isSafeInteger(metadata.fileCount) || metadata.fileCount !== manifestKeys.length) {
      fail('RUNTIME_FILE_COUNT_MISMATCH');
    }
    if (typeof metadata.treeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.treeSha256)) {
      fail('INVALID_RUNTIME_TREE_HASH');
    }
    const sortedManifestKeys = [...manifestKeys].sort();
    if (!manifestKeys.every((value, index) => value === sortedManifestKeys[index])) {
      fail('RUNTIME_FILES_NOT_SORTED');
    }
    for (const requiredFile of requiredFiles) {
      if (!Object.prototype.hasOwnProperty.call(metadata.files, requiredFile)) {
        fail('MISSING_REQUIRED_RUNTIME_FILE', requiredFile);
      }
    }

    const diskFiles = collectDiskFiles(root, root);
    const manifestSet = new Set();

    for (const relPath of manifestKeys) {
      if (typeof relPath !== 'string' || !relPath) fail('INVALID_RUNTIME_FILE_PATH', relPath);
      const normalized = path.posix.normalize(relPath);
      if (normalized !== relPath || relPath.startsWith('/') || relPath.startsWith('../') || relPath === '..') {
        fail('INVALID_RUNTIME_FILE_PATH', relPath);
      }
      manifestSet.add(relPath);

      const fileEntry = metadata.files[relPath];
      if (!Number.isSafeInteger(fileEntry?.bytes) || fileEntry.bytes < 0) {
        fail('INVALID_RUNTIME_FILE_SIZE', relPath);
      }
      if (typeof fileEntry?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(fileEntry.sha256)) {
        fail('INVALID_RUNTIME_FILE_HASH', relPath);
      }

      const filePath = path.resolve(root, relPath);
      if (!contained(root, filePath) || !fs.existsSync(filePath)) {
        fail('MISSING_RUNTIME_FILE', relPath);
      }

      let component = root;
      for (const part of path.relative(root, filePath).split(path.sep)) {
        component = path.join(component, part);
        if (fs.lstatSync(component).isSymbolicLink()) {
          fail('INVALID_RUNTIME_FILE_TYPE', relPath);
        }
      }
      const realFilePath = fs.realpathSync(filePath);
      if (!contained(realRoot, realFilePath)) {
        fail('INVALID_RUNTIME_FILE_PATH', relPath);
      }

      const stat = fs.lstatSync(filePath);
      if (!stat.isFile()) fail('INVALID_RUNTIME_FILE_TYPE', relPath);
      if (stat.size !== fileEntry.bytes) {
        fail('RUNTIME_SIZE_MISMATCH', `expected ${fileEntry.bytes}, got ${stat.size} for ${relPath}`);
      }

      const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      if (hash !== fileEntry.sha256) {
        fail('RUNTIME_HASH_MISMATCH', `Hash mismatch for ${relPath}`);
      }
    }

    const treeFrame = sortedManifestKeys.map(relPath => {
      const entry = metadata.files[relPath];
      return `${relPath}\0${entry.bytes}\0${entry.sha256}\n`;
    }).join('');
    const treeSha256 = crypto.createHash('sha256').update(treeFrame).digest('hex');
    if (treeSha256 !== metadata.treeSha256) fail('RUNTIME_TREE_HASH_MISMATCH');

    for (const diskFile of diskFiles) {
      if (!manifestSet.has(diskFile)) {
        fail('UNLISTED_RUNTIME_FILE', diskFile);
      }
    }
  }

  return Object.freeze({
    runtimeDir: root,
    metadataPath,
    entrypoint,
    platform: metadata.platform,
    bytes: stat.size,
    sha256: actualHash,
    fileCount: metadata.files ? Object.keys(metadata.files).length : 1,
    treeSha256: metadata.treeSha256 || null,
  });
}

function collectDiskFiles(dir, root, result = new Set()) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPosix = path.relative(root, fullPath).split(path.sep).join('/');
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      fail('INVALID_RUNTIME_FILE_TYPE', `Symbolic link not allowed: ${relPosix}`);
    }
    if (stat.isDirectory()) {
      collectDiskFiles(fullPath, root, result);
    } else if (stat.isFile()) {
      if (relPosix !== 'metadata.json') {
        result.add(relPosix);
      }
    } else {
      fail('INVALID_RUNTIME_FILE_TYPE', `Special file not allowed: ${relPosix}`);
    }
  }
  return result;
}

module.exports = { validateEmbeddedRuntimeDirectory, REQUIRED_MACOS_RUNTIME_FILES };
