const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SAFE_HOST_KEYS, TRUSTED_VOICE_KEYS,
  buildPackagedSidecarEnvironment: packaged,
  buildDevelopmentSidecarEnvironment: development,
} = require('../apps/desktop/sidecar-environment.cjs');
const macVoice = Object.freeze({VOICE_STT_BACKEND:'mlx-whisper', VOICE_TTS_BACKEND:'kokoro-onnx',
  VOICE_MLX_WHISPER_MODEL:'/private/snapshot/models/stt', VOICE_KOKORO_ONNX_MODEL:'/private/snapshot/models/kokoro.onnx',
  VOICE_KOKORO_ONNX_VOICES:'/private/snapshot/models/voices.bin', VOICE_KOKORO_EXECUTION_PROVIDER:'cpu'});
const macOptions = {platform:'darwin', arch:'arm64', tempRoot:'/private/snapshot/temp', cacheRoot:'/private/snapshot/cache'};

test('Mac profile environment rejects non-POSIX role roots while preserving Windows path compatibility', () => {
  for (const key of ['VOICE_MLX_WHISPER_MODEL','VOICE_KOKORO_ONNX_MODEL','VOICE_KOKORO_ONNX_VOICES']) {
    for (const value of ['C:/outside/model','C:\\outside\\model','relative','/private/../outside','/private/./model','/private/evil\nmodel','\\\\server\\model']) {
      assert.throws(() => packaged({...macOptions, trustedVoice:{...macVoice,[key]:value}}), /INVALID_SIDECAR_ENV_VALUE/, `${key}:${value}`);
    }
  }
  for (const key of ['tempRoot','cacheRoot']) assert.throws(() => packaged({...macOptions,[key]:'C:/outside'}), /INVALID_RUNTIME_.*_ROOT/);
  assert.equal(packaged({tempRoot,trustedVoice:voice}).VOICE_FASTER_WHISPER_MODEL,voice.VOICE_FASTER_WHISPER_MODEL);
});

test('trusted platform tuple gates Mac keys/enums; poisoned parent cannot select a profile', () => {
  const parent = Object.freeze({PATH:'/poison',DYLD_LIBRARY_PATH:'/poison',DYLD_INSERT_LIBRARIES:'/poison',
    PYTHONPATH:'/poison',HOME:'/poison',OPENAI_API_KEY:'fixture-only',VOICE_MLX_WHISPER_MODEL:'/poison',
    VOICE_FASTER_WHISPER_MODEL:'/poison',VOICE_STT_BACKEND:'fake',VOICE_TTS_BACKEND:'kokoro-python',
    VOICE_KOKORO_EXECUTION_PROVIDER:'cuda',VOICE_SPEECH_PROFILE:'win32-x64-cuda'});
  assert.deepEqual(packaged({...macOptions,parent,trustedVoice:macVoice}), {...macVoice,
    TEMP:macOptions.tempRoot,TMP:macOptions.tempRoot,VOICE_RUNTIME_TEMP_DIR:macOptions.tempRoot,
    HF_HOME:macOptions.cacheRoot,XDG_CACHE_HOME:macOptions.cacheRoot,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',PYTHONDONTWRITEBYTECODE:'1'});
  assert.equal(packaged({...macOptions,parent}).VOICE_STT_BACKEND,undefined,'empty probe stays empty');
  for (const tuple of [{platform:'win32',arch:'x64'},{}]) {
    for (const trustedVoice of [macVoice,{VOICE_STT_BACKEND:'mlx-whisper'},{VOICE_MLX_WHISPER_MODEL:'/private/model'}])
      assert.throws(() => packaged({tempRoot,...tuple,trustedVoice}), /INVALID_SIDECAR_ENV_VALUE|UNTRUSTED_SIDECAR_ENV_KEY/);
  }
  for (const tuple of [{platform:'darwin',arch:'x64'},{platform:'linux',arch:'arm64'},{platform:'unknown',arch:'x64'},{platform:'win32',arch:'arm64'}])
    assert.throws(() => packaged({...macOptions,...tuple}), /UNSUPPORTED_PACKAGED_SPEECH_PLATFORM/);
  for (const [key,value] of [['VOICE_STT_BACKEND','faster-whisper'],['VOICE_STT_BACKEND','unknown'],['VOICE_TTS_BACKEND','kokoro-python'],['VOICE_KOKORO_EXECUTION_PROVIDER','cuda'],
    ['VOICE_FASTER_WHISPER_MODEL','/private/model'],['VOICE_FASTER_WHISPER_DEVICE','cpu'],['VOICE_FASTER_WHISPER_COMPUTE_TYPE','int8'],
    ['VOICE_SPEECH_PROFILE','darwin-arm64'],['VOICE_UNKNOWN','/private/model'],['PATH','/poison']])
    assert.throws(() => packaged({...macOptions,trustedVoice:{...macVoice,[key]:value}}), /INVALID_SIDECAR_ENV_VALUE|UNTRUSTED_SIDECAR_ENV_KEY/);
});

const tempRoot = 'C:\\trusted-temp';
const voice = Object.freeze({
  VOICE_STT_BACKEND: 'faster-whisper', VOICE_TTS_BACKEND: 'kokoro-onnx',
  VOICE_FASTER_WHISPER_MODEL: 'C:\\models\\whisper', VOICE_FASTER_WHISPER_DEVICE: 'cpu',
  VOICE_FASTER_WHISPER_COMPUTE_TYPE: 'int8', VOICE_KOKORO_ONNX_MODEL: 'C:\\models\\kokoro.onnx',
  VOICE_KOKORO_ONNX_VOICES: 'C:\\models\\voices.bin', VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu',
});

test('packaged environment is an exact allowlist, not inherited secrets or search paths', () => {
  const parent = Object.freeze({
    SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows',
    PATH: 'untrusted', Path: 'untrusted-case', PYTHONPATH: 'inject', PYTHONHOME: 'inject',
    NODE_OPTIONS: '--require untrusted', ELECTRON_RUN_AS_NODE: '1',
    OPENAI_API_KEY: 'fixture-only', OAUTH_TOKEN: 'fixture-only', AWS_SECRET_ACCESS_KEY: 'fixture-only',
    VOICE_RUNTIME_FAKE: '1', VOICE_RUNTIME_DEBUG: '1', VOICE_STT_BACKEND: 'untrusted',
    VOICE_KOKORO_ONNX_MODEL: 'untrusted', VOICE_KOKORO_EXECUTION_PROVIDER: 'cuda',
    TEMP: 'untrusted', TMP: 'untrusted', VOICE_RUNTIME_TEMP_DIR: 'untrusted',
  });
  assert.deepEqual(packaged({ parent, tempRoot, trustedVoice: voice }), {
    SYSTEMROOT: parent.SYSTEMROOT, WINDIR: parent.WINDIR, ...voice,
    TEMP: tempRoot, TMP: tempRoot, VOICE_RUNTIME_TEMP_DIR: tempRoot,
  });
  assert.deepEqual(SAFE_HOST_KEYS, ['SYSTEMROOT', 'WINDIR']);
  assert.ok(Object.isFrozen(SAFE_HOST_KEYS));
  assert.deepEqual([...TRUSTED_VOICE_KEYS].sort(), Object.keys(voice).sort());
});

test('packaged defaults emit only controlled temporary roots for an empty parent', () => {
  const expected = { TEMP: tempRoot, TMP: tempRoot, VOICE_RUNTIME_TEMP_DIR: tempRoot };
  assert.deepEqual(packaged({ parent: {}, tempRoot }), expected);
  assert.deepEqual(packaged({ parent: { SYSTEMROOT: '', WINDIR: 7 }, tempRoot }), expected);
});

test('packaged environment rejects unknown trusted keys and invalid voice values', () => {
  for (const key of ['PATH', 'OPENAI_API_KEY', 'PYTHONPATH', 'VOICE_RUNTIME_FAKE', 'UNKNOWN']) {
    assert.throws(() => packaged({ parent: {}, tempRoot, trustedVoice: { [key]: 'fixture' } }),
      { message: `UNTRUSTED_SIDECAR_ENV_KEY:${key}` });
  }
  for (const key of Object.keys(voice)) {
    for (const value of ['', '\0injected', 'embedded\0nul', 0, true, null, undefined, {}, []]) {
      assert.throws(() => packaged({ parent: {}, tempRoot, trustedVoice: { [key]: value } }),
        { message: `INVALID_SIDECAR_ENV_VALUE:${key}` });
    }
  }
  for (const value of ['', null, undefined, 7, {}]) {
    assert.throws(() => packaged({ parent: {}, tempRoot: value }), /INVALID_RUNTIME_TEMP_ROOT/);
  }
});

test('development helper explicitly copies the development environment without mutating it', () => {
  // Development inheritance is intentional; this API must not be used for packaged launch.
  const parent = Object.freeze({ PATH: 'dev-path', VOICE_STT_BACKEND: 'fake', VOICE_RUNTIME_TEMP_DIR: 'old' });
  const env = development({ parent, tempRoot });
  assert.deepEqual(env, { PATH: 'dev-path', VOICE_STT_BACKEND: 'fake', VOICE_RUNTIME_TEMP_DIR: tempRoot });
  assert.notEqual(env, parent);
  assert.equal(parent.VOICE_RUNTIME_TEMP_DIR, 'old');
});

test('packaged verified roles reject relative paths and noncanonical enums; private caches are offline', () => {
  for (const [key, value] of [['VOICE_FASTER_WHISPER_MODEL','relative/model'], ['VOICE_KOKORO_ONNX_MODEL','C:\\models\\..\\evil.onnx'],
    ['VOICE_STT_BACKEND','fake'], ['VOICE_TTS_BACKEND','cloud'], ['VOICE_FASTER_WHISPER_DEVICE','cuda'],
    ['VOICE_FASTER_WHISPER_COMPUTE_TYPE','float16'], ['VOICE_KOKORO_EXECUTION_PROVIDER','cuda']]) {
    assert.throws(() => packaged({parent:{},tempRoot,trustedVoice:{[key]:value}}), /INVALID_SIDECAR_ENV_VALUE/);
  }
  assert.throws(() => packaged({parent:{},tempRoot:'relative'}), /INVALID_RUNTIME_TEMP_ROOT/);
  const cacheRoot='C:\\private-cache';
  const env=packaged({parent:{},tempRoot,cacheRoot,trustedVoice:voice});
  assert.equal(env.HF_HOME,cacheRoot);assert.equal(env.XDG_CACHE_HOME,cacheRoot);
  assert.equal(env.HF_HUB_OFFLINE,'1');assert.equal(env.TRANSFORMERS_OFFLINE,'1');assert.equal(env.PYTHONDONTWRITEBYTECODE,'1');
});

test('bundled Windows profile admits VOICE_ACCELERATOR=auto only, and only when bundled', () => {
  const voice = { VOICE_STT_BACKEND: 'faster-whisper', VOICE_TTS_BACKEND: 'kokoro-onnx', VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu',
    VOICE_ACCELERATOR: 'auto', VOICE_FASTER_WHISPER_MODEL: 'C:\\app\\models\\whisper',
    VOICE_KOKORO_ONNX_MODEL: 'C:\\app\\models\\k.onnx', VOICE_KOKORO_ONNX_VOICES: 'C:\\app\\models\\v.bin' };
  const env = packaged({ parent: { VOICE_ACCELERATOR: 'cuda' }, tempRoot, trustedVoice: voice, bundled: true });
  assert.equal(env.VOICE_ACCELERATOR, 'auto');
  assert.throws(() => packaged({ parent: {}, tempRoot, trustedVoice: { VOICE_ACCELERATOR: 'cuda' }, bundled: true }),
    { message: 'INVALID_SIDECAR_ENV_VALUE:VOICE_ACCELERATOR' });
  assert.throws(() => packaged({ parent: {}, tempRoot, trustedVoice: { VOICE_ACCELERATOR: 'auto' } }),
    { message: 'UNTRUSTED_SIDECAR_ENV_KEY:VOICE_ACCELERATOR' });
  assert.equal(packaged({ parent: { VOICE_ACCELERATOR: 'cuda' }, tempRoot }).VOICE_ACCELERATOR, undefined);
});
