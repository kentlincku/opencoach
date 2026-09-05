import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { checkPackagedMacOsRuntime } from './check-macos-runtime.mjs';

const require = createRequire(import.meta.url);
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');
const { isHealthyRuntimeResponse } = require('../apps/desktop/runtime-health.cjs');

const EXPECTED_TEXT = 'The quick brown fox jumps over the lazy dog.';

function fail(code) {
  throw new Error(code);
}

export function validateMacNativeHealth(health) {
  if (!isHealthyRuntimeResponse(health)
      || health.fake === true
      || health.platform !== 'darwin'
      || health.arch !== 'arm64'
      || health.selectedStt !== 'mlx-whisper'
      || health.selectedTts !== 'kokoro-python') {
    fail('PACKAGED_RUNTIME_HEALTH_INVALID');
  }
  return health;
}

function strictBase64(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    fail('INVALID_TTS_AUDIO');
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.toString('base64') !== raw) fail('INVALID_TTS_AUDIO');
  return decoded;
}

export function validateTtsResult(result) {
  if (!result || result.format !== 'audio/wav' || !Number.isInteger(result.sampleRate) || result.sampleRate <= 0) {
    fail('INVALID_TTS_RESULT');
  }
  const audio = strictBase64(result.audio);
  if (audio.length < 44 || audio.subarray(0, 4).toString('ascii') !== 'RIFF' || audio.subarray(8, 12).toString('ascii') !== 'WAVE') {
    fail('INVALID_TTS_WAV');
  }

  let formatValid = false;
  let nonZeroPcm = false;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const id = audio.subarray(offset, offset + 4).toString('ascii');
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > audio.length) fail('INVALID_TTS_WAV');
    if (id === 'fmt ' && size >= 16) {
      formatValid = audio.readUInt16LE(start) === 1
        && audio.readUInt16LE(start + 2) >= 1
        && audio.readUInt32LE(start + 4) === result.sampleRate
        && audio.readUInt16LE(start + 14) === 16;
    }
    if (id === 'data') {
      dataBytes += size;
      for (let index = start; index + 1 < end; index += 2) {
        if (audio.readInt16LE(index) !== 0) { nonZeroPcm = true; break; }
      }
    }
    offset = end + (size % 2);
  }
  if (!formatValid || dataBytes < 4800 || !nonZeroPcm) fail('INVALID_TTS_PCM');
  return audio;
}

function normalizedWords(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function validateSttResult(result, expectedText = EXPECTED_TEXT) {
  if (!result || typeof result.text !== 'string' || !result.text.trim()) fail('EMPTY_STT_RESULT');
  const expected = normalizedWords(expectedText);
  const actual = new Set(normalizedWords(result.text));
  const matched = expected.filter(word => actual.has(word)).length;
  if (!expected.length || matched / expected.length < 0.6) fail('STT_TRANSCRIPT_MISMATCH');
  return result.text.trim().length;
}

function runtimeEnvironment(tempRoot, offline) {
  const allowed = [
    'HOME', 'USERPROFILE', 'PATH', 'SYSTEMROOT', 'TMP', 'TEMP',
    'XDG_CACHE_HOME', 'HF_HOME', 'VOICE_MLX_WHISPER_MODEL',
    'VOICE_FASTER_WHISPER_MODEL', 'VOICE_WHISPER_MODEL',
    'VOICE_KOKORO_ONNX_MODEL', 'VOICE_KOKORO_ONNX_VOICES',
  ];
  const env = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  env.VOICE_RUNTIME_TEMP_DIR = tempRoot;
  if (offline) {
    env.HF_HUB_OFFLINE = '1';
    env.TRANSFORMERS_OFFLINE = '1';
  }
  return env;
}

export async function verifyPackagedRuntime({ appPath, offline = true } = {}) {
  const runtime = checkPackagedMacOsRuntime(appPath);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-practice-packaged-runtime-'));
  const wavPath = path.join(tempRoot, 'roundtrip.wav');
  const client = new SidecarClient({
    command: runtime.entrypoint,
    env: runtimeEnvironment(tempRoot, offline),
    requestTimeoutMs: 300_000,
  });
  try {
    await client.start();
    const health = validateMacNativeHealth(await client.request('runtime.health'));

    const tts = await client.request('tts.synthesize', {
      text: EXPECTED_TEXT,
      voice: 'af_heart',
      speed: 1,
    });
    const audio = validateTtsResult(tts);
    await fs.writeFile(wavPath, audio, { mode: 0o600 });

    const stt = await client.request('stt.transcribe', { audioPath: wavPath, language: 'en' });
    const transcriptLength = validateSttResult(stt);
    return Object.freeze({
      platform: health.platform,
      arch: health.arch,
      sttBackend: health.selectedStt,
      ttsBackend: health.selectedTts,
      audioBytes: audio.length,
      transcriptLength,
      runtimeSha256: runtime.sha256,
      offline,
    });
  } finally {
    await client.stop().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('verify-macos-packaged-voice.mjs')) {
  const appFlag = process.argv.indexOf('--app');
  const appPath = appFlag >= 0 ? process.argv[appFlag + 1] : '';
  const allowDownload = process.argv.includes('--allow-model-download');
  try {
    const result = await verifyPackagedRuntime({ appPath, offline: !allowDownload });
    console.log(`PACKAGED_RUNTIME_HEALTH_OK platform=${result.platform} arch=${result.arch} stt=${result.sttBackend} tts=${result.ttsBackend}`);
    console.log(`PACKAGED_RUNTIME_TTS_OK audioBytes=${result.audioBytes}`);
    console.log(`PACKAGED_RUNTIME_STT_OK transcriptLength=${result.transcriptLength}`);
    console.log(`PACKAGED_RUNTIME_ROUNDTRIP_OK offline=${result.offline} runtimeSha256=${result.runtimeSha256}`);
  } catch (error) {
    console.error(`PACKAGED_RUNTIME_VERIFY_FAILED:${error.message}`);
    process.exit(1);
  }
}
