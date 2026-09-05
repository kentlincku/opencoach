'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractZipSecure } = require('./runtime-manager.cjs');
const { scanFiles, digestFiles } = require('./tree-integrity.cjs');
const { checkWindowsRuntime } = require('./windows-runtime-checker.cjs');

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getOfflineArtifactsDir({ resourcesPath }) {
  if (!resourcesPath || typeof resourcesPath !== 'string') return null;
  return path.join(path.resolve(resourcesPath), 'offline-artifacts');
}

function hasOfflineArtifacts({ resourcesPath }) {
  const dir = getOfflineArtifactsDir({ resourcesPath });
  if (!dir) return false;
  const manifestFile = path.join(dir, 'artifacts-manifest.json');
  return fs.existsSync(manifestFile) && fs.statSync(manifestFile).isFile();
}

function loadOfflineManifest({ resourcesPath }) {
  const dir = getOfflineArtifactsDir({ resourcesPath });
  if (!dir) throw new Error('OFFLINE_ARTIFACTS_DIR_UNAVAILABLE');
  const manifestFile = path.join(dir, 'artifacts-manifest.json');
  return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
}

async function verifyAndExtractArtifact(zipPath, targetDir, expectedSha256, expectedBytes, verifyFn) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`OFFLINE_ZIP_NOT_FOUND:${zipPath}`);
  }
  const stat = await fsp.stat(zipPath);
  if (stat.size !== expectedBytes) {
    throw new Error(`OFFLINE_ZIP_SIZE_MISMATCH: expected ${expectedBytes}, got ${stat.size}`);
  }
  const actualHash = sha256File(zipPath);
  if (actualHash !== expectedSha256) {
    throw new Error(`OFFLINE_ZIP_HASH_MISMATCH: expected ${expectedSha256}, got ${actualHash}`);
  }

  // Check if targetDir is already valid
  if (fs.existsSync(targetDir)) {
    try {
      verifyFn(targetDir);
      return; // Already extracted and valid
    } catch {
      await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Extract to a staging directory first (extractZipSecure creates destination)
  const stagingDir = `${targetDir}.staging-${crypto.randomUUID()}`;
  try {
    await extractZipSecure(zipPath, stagingDir);
    verifyFn(stagingDir);
    await fsp.rename(stagingDir, targetDir);
  } catch (error) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function seedOfflineAssets({ userData, resourcesPath }) {
  if (!hasOfflineArtifacts({ resourcesPath })) return null;
  const artifactsDir = getOfflineArtifactsDir({ resourcesPath });
  const manifest = loadOfflineManifest({ resourcesPath });

  const offlineRoot = path.join(path.resolve(userData), 'offline-assets');
  await fsp.mkdir(offlineRoot, { recursive: true, mode: 0o700 });

  // 1. Seed voice-runtime
  const runtimeZip = path.join(artifactsDir, manifest.runtime.archiveName);
  const runtimeDir = path.join(offlineRoot, 'voice-runtime');
  await verifyAndExtractArtifact(
    runtimeZip,
    runtimeDir,
    manifest.runtime.archiveSha256,
    manifest.runtime.archiveBytes,
    dir => {
      const check = checkWindowsRuntime(dir);
      if (check.treeDigest !== manifest.runtime.treeDigest) {
        throw new Error(`Runtime tree digest mismatch: ${check.treeDigest}`);
      }
    }
  );

  // 2. Seed whisper-base-en
  const whisperZip = path.join(artifactsDir, manifest.whisper.archiveName);
  const whisperDir = path.join(offlineRoot, 'whisper-base-en');
  await verifyAndExtractArtifact(
    whisperZip,
    whisperDir,
    manifest.whisper.archiveSha256,
    manifest.whisper.archiveBytes,
    dir => {
      const files = scanFiles(dir);
      const digest = digestFiles(files);
      if (digest !== manifest.whisper.treeDigest) {
        throw new Error(`Whisper tree digest mismatch: ${digest}`);
      }
    }
  );

  // 3. Seed kokoro-v1.0-onnx
  const kokoroZip = path.join(artifactsDir, manifest.kokoro.archiveName);
  const kokoroDir = path.join(offlineRoot, 'kokoro-v1.0-onnx');
  await verifyAndExtractArtifact(
    kokoroZip,
    kokoroDir,
    manifest.kokoro.archiveSha256,
    manifest.kokoro.archiveBytes,
    dir => {
      const files = scanFiles(dir);
      const digest = digestFiles(files);
      if (digest !== manifest.kokoro.treeDigest) {
        throw new Error(`Kokoro tree digest mismatch: ${digest}`);
      }
    }
  );

  return Object.freeze({
    runtimeDir,
    runtimeEntrypoint: path.join(runtimeDir, manifest.runtime.entrypoint || 'voice-runtime.exe'),
    whisperDir,
    kokoroDir,
    kokoroOnnxPath: path.join(kokoroDir, 'kokoro-v1.0.onnx'),
    kokoroVoicesPath: path.join(kokoroDir, 'voices-v1.0.bin'),
    manifest,
  });
}

module.exports = {
  getOfflineArtifactsDir,
  hasOfflineArtifacts,
  loadOfflineManifest,
  seedOfflineAssets,
};
