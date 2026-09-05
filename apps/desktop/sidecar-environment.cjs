// Packaged commands and managed assets are absolute. Do not inherit PATH: on
// Windows it is also a DLL/subprocess search surface controlled by the parent.
const SAFE_HOST_KEYS = Object.freeze(['SYSTEMROOT', 'WINDIR']);
const TRUSTED_VOICE_KEYS = new Set([
  'VOICE_STT_BACKEND', 'VOICE_TTS_BACKEND',
  'VOICE_FASTER_WHISPER_MODEL', 'VOICE_FASTER_WHISPER_DEVICE',
  'VOICE_FASTER_WHISPER_COMPUTE_TYPE', 'VOICE_KOKORO_ONNX_MODEL',
  'VOICE_KOKORO_ONNX_VOICES', 'VOICE_KOKORO_EXECUTION_PROVIDER',
]);

function buildPackagedSidecarEnvironment({parent = process.env, tempRoot, trustedVoice = {}}) {
  if (typeof tempRoot !== 'string' || !tempRoot) throw new Error('INVALID_RUNTIME_TEMP_ROOT');
  const env = {};
  for (const key of SAFE_HOST_KEYS) {
    if (typeof parent[key] === 'string' && parent[key]) env[key] = parent[key];
  }
  for (const [key, value] of Object.entries(trustedVoice)) {
    if (!TRUSTED_VOICE_KEYS.has(key)) throw new Error(`UNTRUSTED_SIDECAR_ENV_KEY:${key}`);
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`INVALID_SIDECAR_ENV_VALUE:${key}`);
    env[key] = value;
  }
  env.TEMP = tempRoot;
  env.TMP = tempRoot;
  env.VOICE_RUNTIME_TEMP_DIR = tempRoot;
  return env;
}

function buildDevelopmentSidecarEnvironment({parent = process.env, tempRoot}) {
  return {...parent, VOICE_RUNTIME_TEMP_DIR: tempRoot};
}

module.exports = {SAFE_HOST_KEYS, TRUSTED_VOICE_KEYS, buildDevelopmentSidecarEnvironment, buildPackagedSidecarEnvironment};
