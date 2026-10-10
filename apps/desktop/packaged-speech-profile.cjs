// Main-owned platform/architecture only; never renderer settings or parent env.
// Selection describes a packaged backend policy, not native/device readiness.
const ttsEnums = {VOICE_TTS_BACKEND: 'kokoro-onnx', VOICE_KOKORO_EXECUTION_PROVIDER: 'cpu'};
const ttsPaths = {VOICE_KOKORO_ONNX_MODEL: 'onnxModel', VOICE_KOKORO_ONNX_VOICES: 'onnxVoices'};
const windows = Object.freeze({
  enums: Object.freeze({...ttsEnums, VOICE_STT_BACKEND: 'faster-whisper',
    VOICE_FASTER_WHISPER_DEVICE: 'cpu', VOICE_FASTER_WHISPER_COMPUTE_TYPE: 'int8'}),
  paths: Object.freeze({...ttsPaths, VOICE_FASTER_WHISPER_MODEL: 'sttRoot'}),
});
// App-bundled Windows build: same backends, no fixed STT device; the runtime
// accelerator policy (explicit 'auto') tries the bundled CUDA libraries, then CPU.
const windowsBundled = Object.freeze({
  enums: Object.freeze({...ttsEnums, VOICE_STT_BACKEND: 'faster-whisper', VOICE_ACCELERATOR: 'auto'}),
  paths: windows.paths,
});
// Runtime-only Windows W1 (downloaded raw models): fixed CPU/int8, explicit cpu
// accelerator. No CUDA probing; GPU is a later, separately reviewed stage.
const windowsHybridCpu = Object.freeze({
  enums: Object.freeze({...windows.enums, VOICE_ACCELERATOR: 'cpu'}),
  paths: windows.paths,
});
const macos = Object.freeze({
  enums: Object.freeze({...ttsEnums, VOICE_STT_BACKEND: 'mlx-whisper'}),
  paths: Object.freeze({...ttsPaths, VOICE_MLX_WHISPER_MODEL: 'sttRoot'}),
});
function selectPackagedSpeechProfile(platform, arch, {bundled = false, hybrid = false} = {}) {
  if (bundled && hybrid) throw new Error('UNSUPPORTED_PACKAGED_SPEECH_PROFILE');
  if (platform === 'win32' && arch === 'x64') return hybrid ? windowsHybridCpu : bundled ? windowsBundled : windows;
  if (platform === 'darwin' && arch === 'arm64') return macos;
  throw new Error('UNSUPPORTED_PACKAGED_SPEECH_PLATFORM');
}
module.exports = {selectPackagedSpeechProfile};
