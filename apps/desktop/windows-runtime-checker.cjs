const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function verifyPeX64(exePath) {
  const buf = fs.readFileSync(exePath);
  if (buf.length < 64 || buf.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`Invalid PE binary: Missing MZ magic at ${exePath}`);
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.length < peOffset + 6 || buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`Invalid PE binary: Missing PE signature at offset ${peOffset}`);
  }
  const machine = buf.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error(`Invalid architecture: Expected IMAGE_FILE_MACHINE_AMD64 (0x8664), got 0x${machine.toString(16)}`);
  }
}

function scanTree(dir, rootDir = dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isSymbolicLink()) {
      throw new Error(`Symlink forbidden in runtime tree: ${relPath}`);
    }
    if (entry.isDirectory()) {
      results.push(...scanTree(fullPath, rootDir));
    } else if (entry.isFile()) {
      const stats = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      results.push({
        path: relPath,
        bytes: stats.size,
        sha256: hash,
      });
    } else {
      throw new Error(`Special file forbidden in runtime tree: ${relPath}`);
    }
  }
  return results;
}

function checkWindowsRuntime(runtimeDir, trustedArtifact) {
  if (!fs.existsSync(runtimeDir)) {
    throw new Error(`Runtime directory does not exist: ${runtimeDir}`);
  }

  const exePath = path.join(runtimeDir, 'voice-runtime.exe');
  if (!fs.existsSync(exePath)) {
    throw new Error(`Entrypoint not found: ${exePath}`);
  }

  // 1. Verify PE x64 binary header
  verifyPeX64(exePath);

  // 2. Scan the complete tree. The generated manifest describes every payload
  // file but intentionally excludes itself to avoid a recursive digest.
  const scannedFiles = scanTree(runtimeDir);
  scannedFiles.sort((a, b) => a.path.localeCompare(b.path));

  // 3. Require and verify the generated manifest against the actual payload.
  const manifestPath = path.join(runtimeDir, 'runtime-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('RUNTIME_TREE_MANIFEST_MISSING');
  }
  const raw = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
  const manifest = JSON.parse(raw);
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Invalid manifest schemaVersion: ${manifest.schemaVersion}`);
  }
  if (!['win32-x64-cpu', 'win32-x64-dml'].includes(manifest.platform)) {
    throw new Error(`Invalid platform in manifest: ${manifest.platform}`);
  }
  if (manifest.entrypoint !== 'voice-runtime.exe') {
    throw new Error(`Invalid entrypoint in manifest: ${manifest.entrypoint}`);
  }
  if (!Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.fileCount)
      || typeof manifest.treeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.treeDigest)) {
    throw new Error('RUNTIME_TREE_MANIFEST_INVALID');
  }

  const files = scannedFiles.filter(file => file.path !== 'runtime-manifest.json');
  if (manifest.fileCount !== files.length || manifest.files.length !== files.length) {
    throw new Error('RUNTIME_TREE_FILE_COUNT_MISMATCH');
  }
  for (let index = 0; index < files.length; index += 1) {
    const actual = files[index];
    const expected = manifest.files[index];
    if (!expected || expected.path !== actual.path) {
      const actualPaths = new Set(files.map(file => file.path));
      const expectedPaths = new Set(manifest.files.map(file => file?.path));
      if ([...expectedPaths].some(item => !actualPaths.has(item))) throw new Error('RUNTIME_TREE_MISSING_FILE_MISMATCH');
      if ([...actualPaths].some(item => !expectedPaths.has(item))) throw new Error('RUNTIME_TREE_UNLISTED_FILE_MISMATCH');
      throw new Error('RUNTIME_TREE_FILE_MISMATCH');
    }
    if (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) {
      throw new Error(`RUNTIME_TREE_FILE_MISMATCH:${actual.path}`);
    }
  }

  const digestHasher = crypto.createHash('sha256');
  for (const file of files) {
    digestHasher.update(`${file.path}:${file.bytes}:${file.sha256}\n`);
  }
  const treeDigest = digestHasher.digest('hex');
  if (treeDigest !== manifest.treeDigest) {
    throw new Error('RUNTIME_TREE_DIGEST_MISMATCH');
  }
  if (trustedArtifact) {
    if (!Array.isArray(trustedArtifact.files) || trustedArtifact.fileCount !== files.length) {
      throw new Error('TRUSTED_RUNTIME_FILESET_MISSING');
    }
    if (trustedArtifact.treeDigest && trustedArtifact.treeDigest !== treeDigest) {
      throw new Error('TRUSTED_RUNTIME_TREE_DIGEST_MISMATCH');
    }
    for (let index = 0; index < files.length; index += 1) {
      const trusted = trustedArtifact.files[index];
      const actual = files[index];
      if (!trusted || trusted.path !== actual.path || trusted.bytes !== actual.bytes || trusted.sha256 !== actual.sha256) {
        throw new Error(`TRUSTED_RUNTIME_FILE_MISMATCH:${actual.path}`);
      }
    }
  }

  return {
    fileCount: files.length,
    treeDigest,
    entrypoint: 'voice-runtime.exe',
  };
}

module.exports = {
  checkWindowsRuntime,
  verifyPeX64,
  scanTree,
};
