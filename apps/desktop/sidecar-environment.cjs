// Packaged commands and managed assets are absolute. Do not inherit PATH: on
// Windows it is also a DLL/subprocess search surface controlled by the parent.
const SAFE_HOST_KEYS = Object.freeze(['SYSTEMROOT', 'WINDIR']);
const { selectPackagedSpeechProfile } = require('./packaged-speech-profile.cjs');
const legacyProfile = selectPackagedSpeechProfile('win32', 'x64');
// Preserve the exported legacy Windows key set; validation uses the selected profile.
const TRUSTED_VOICE_KEYS = new Set([...Object.keys(legacyProfile.enums), ...Object.keys(legacyProfile.paths)]);

function absoluteRolePath(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return false;
  const path = require('node:path');
  const windows = /^[A-Za-z]:[\\/]/.test(value);
  const api = windows ? path.win32 : path.posix;
  return api.isAbsolute(value) && !value.split(/[\\/]/).some(part => part === '.' || part === '..')
    && (windows || !value.includes('\\')) && !value.startsWith('\\\\');
}
function buildPackagedSidecarEnvironment({parent = process.env, tempRoot, cacheRoot, trustedVoice = {}, platform = 'win32', arch = 'x64', bundled = false, hybrid = false}) {
  // Omitted host tuple preserves the original helper's Windows partial/probe API.
  // Main explicitly supplies its trusted runtime-manager tuple on both launch paths.
  const profile = selectPackagedSpeechProfile(platform, arch, {bundled, hybrid});
  const validPath = value => absoluteRolePath(value) && (platform !== 'darwin' || value.startsWith('/'));
  if (!validPath(tempRoot)) throw new Error('INVALID_RUNTIME_TEMP_ROOT');
  const env = {};
  for (const key of SAFE_HOST_KEYS) {
    if (absoluteRolePath(parent[key])) env[key] = parent[key];
  }
  for (const [key, value] of Object.entries(trustedVoice)) {
    if (!Object.hasOwn(profile.enums, key) && !Object.hasOwn(profile.paths, key)) throw new Error(`UNTRUSTED_SIDECAR_ENV_KEY:${key}`);
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`INVALID_SIDECAR_ENV_VALUE:${key}`);
    if (Object.hasOwn(profile.enums, key) ? value !== profile.enums[key] : !validPath(value)) throw new Error(`INVALID_SIDECAR_ENV_VALUE:${key}`);
    env[key] = value;
  }
  env.TEMP = tempRoot;
  env.TMP = tempRoot;
  env.VOICE_RUNTIME_TEMP_DIR = tempRoot;
  // Main always supplies its distinct owned cache. Omission preserves the older
  // exported helper's minimal environment contract, not Main's packaged policy.
  if (cacheRoot !== undefined) {
    if (!validPath(cacheRoot) || cacheRoot === tempRoot) throw new Error('INVALID_RUNTIME_CACHE_ROOT');
    env.HF_HOME = cacheRoot; env.XDG_CACHE_HOME = cacheRoot;
    env.HF_HUB_OFFLINE = '1'; env.TRANSFORMERS_OFFLINE = '1'; env.PYTHONDONTWRITEBYTECODE = '1';
  }
  return env;
}

function buildDevelopmentSidecarEnvironment({parent = process.env, tempRoot}) {
  return {...parent, VOICE_RUNTIME_TEMP_DIR: tempRoot};
}

module.exports = {SAFE_HOST_KEYS, TRUSTED_VOICE_KEYS, buildDevelopmentSidecarEnvironment, buildPackagedSidecarEnvironment};
