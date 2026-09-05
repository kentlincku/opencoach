'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateEmbeddedRuntimeDirectory, REQUIRED_MACOS_RUNTIME_FILES } = require('./embedded-runtime-validator.cjs');

const SYSTEM_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoSymlinkComponents(target, stopAt) {
  let current = path.resolve(target);
  const boundary = path.resolve(stopAt);
  while (current !== boundary) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('SYMLINKED_PRIVATE_PATH');
    const parent = path.dirname(current);
    if (parent === current || !contained(boundary, current)) throw new Error('PRIVATE_PATH_ESCAPE');
    current = parent;
  }
  if (fs.existsSync(boundary) && fs.lstatSync(boundary).isSymbolicLink()) throw new Error('SYMLINKED_PRIVATE_PATH');
}

function validateProductModelPath(candidate, trustedRoot) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('INVALID_PRODUCT_MODEL_PATH');
  const root = path.resolve(trustedRoot);
  const resolved = path.resolve(candidate);
  if (!contained(root, resolved) || !fs.existsSync(resolved)) throw new Error('INVALID_PRODUCT_MODEL_PATH');
  assertNoSymlinkComponents(resolved, root);
  const stat = fs.lstatSync(resolved);
  if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink()) throw new Error('INVALID_PRODUCT_MODEL_PATH');
  const real = fs.realpathSync(resolved);
  if (!contained(fs.realpathSync(root), real)) throw new Error('INVALID_PRODUCT_MODEL_PATH');
  return Object.freeze({ path: resolved, trustedRoot: root });
}

function buildPackagedRuntimeEnvironment({ parentEnv = process.env, tempRoot, verifiedModels = {}, offline = true }) {
  if (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot)) throw new Error('INVALID_RUNTIME_TEMP_ROOT');
  const env = {};
  for (const key of SYSTEM_ENV_ALLOWLIST) {
    if (typeof parentEnv[key] === 'string' && parentEnv[key]) env[key] = parentEnv[key];
  }
  env.TMPDIR = tempRoot;
  env.TMP = tempRoot;
  env.TEMP = tempRoot;
  env.VOICE_RUNTIME_TEMP_DIR = tempRoot;
  if (offline) {
    env.HF_HUB_OFFLINE = '1';
    env.TRANSFORMERS_OFFLINE = '1';
  }
  const mappings = {
    mlxWhisper: 'VOICE_MLX_WHISPER_MODEL',
    fasterWhisper: 'VOICE_FASTER_WHISPER_MODEL',
    kokoroPython: 'VOICE_KOKORO_MODEL',
    kokoroOnnxModel: 'VOICE_KOKORO_ONNX_MODEL',
    kokoroOnnxVoices: 'VOICE_KOKORO_ONNX_VOICES',
  };
  for (const [name, envKey] of Object.entries(mappings)) {
    const value = verifiedModels[name];
    if (!value) continue;
    if (!value.path || !value.trustedRoot) throw new Error('UNVERIFIED_PRODUCT_MODEL_PATH');
    env[envKey] = validateProductModelPath(value.path, value.trustedRoot).path;
  }
  return Object.freeze(env);
}

function createVerifiedRuntimeSnapshot({ sourceDirectory, userData }) {
  const source = validateEmbeddedRuntimeDirectory(sourceDirectory, {
    expectedPlatform: 'darwin-arm64', requireExecutable: true, requireTree: true,
    requiredFiles: REQUIRED_MACOS_RUNTIME_FILES,
  });
  const privateRoot = path.join(path.resolve(userData), 'runtime-snapshots');
  fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(privateRoot, path.resolve(userData));
  fs.chmodSync(privateRoot, 0o700);
  const directory = fs.mkdtempSync(path.join(privateRoot, 'launch-'));
  fs.chmodSync(directory, 0o700);
  try {
    fs.cpSync(source.runtimeDir, directory, { recursive: true, dereference: false, errorOnExist: true, force: false });
    const verified = validateEmbeddedRuntimeDirectory(directory, {
      expectedPlatform: 'darwin-arm64', requireExecutable: true, requireTree: true,
      requiredFiles: REQUIRED_MACOS_RUNTIME_FILES,
    });
    if (verified.treeSha256 !== source.treeSha256) throw new Error('RUNTIME_SNAPSHOT_TREE_MISMATCH');
    return Object.freeze({
      ...verified,
      directory: verified.runtimeDir,
      sourceDirectory: source.runtimeDir,
      privateRoot,
    });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function removeVerifiedRuntimeSnapshot(snapshot, userData) {
  const privateRoot = path.join(path.resolve(userData), 'runtime-snapshots');
  const directory = path.resolve(snapshot?.directory || snapshot?.runtimeDir || '');
  if (!contained(privateRoot, directory) || path.dirname(directory) !== privateRoot || !path.basename(directory).startsWith('launch-')) {
    throw new Error('REFUSE_UNSAFE_RUNTIME_SNAPSHOT_DELETE');
  }
  assertNoSymlinkComponents(privateRoot, path.resolve(userData));
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('REFUSE_UNSAFE_RUNTIME_SNAPSHOT_DELETE');
  fs.rmSync(directory, { recursive: true, force: true });
}

module.exports = {
  SYSTEM_ENV_ALLOWLIST,
  buildPackagedRuntimeEnvironment,
  createVerifiedRuntimeSnapshot,
  removeVerifiedRuntimeSnapshot,
  validateProductModelPath,
};
