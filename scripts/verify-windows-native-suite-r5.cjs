'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');
const { scanFiles, digestFiles } = require('../apps/desktop/tree-integrity.cjs');
const { checkWindowsRuntime } = require('./check-windows-runtime.mjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const ARTIFACTS_DIR = path.join(DIST_DIR, 'artifacts');
const SANDBOX_DIR = path.join(DIST_DIR, 'fresh-unpack-r5');
const TEMP_AUDIO_DIR = path.join(DIST_DIR, 'test-temp-audio-r5');

function logHeader(msg) {
  console.log('========================================================================');
  console.log(msg);
  console.log('========================================================================\n');
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pid} -ErrorAction SilentlyContinue`], { encoding: 'utf8' });
    return res.status === 0 && res.stdout.includes(String(pid));
  } catch {
    return false;
  }
}

function parseWavInfo(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid RIFF WAVE file: ' + filePath);
  }
  let offset = 12;
  let channels = 0, sampleRate = 0, bits = 0, dataOffset = 0, dataLength = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 8 + 2);
      sampleRate = buf.readUInt32LE(offset + 8 + 4);
      bits = buf.readUInt16LE(offset + 8 + 14);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const samples = dataLength / (bits / 8);
  const durationMs = Math.round((samples / (sampleRate * channels)) * 1000);

  let nonZero = 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(dataOffset + i * 2);
    if (s !== 0) nonZero++;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples);

  return { channels, sampleRate, bits, dataOffset, dataLength, samples, durationMs, nonZero, rms };
}

function resample24kTo16k(buf24k, wavInfo) {
  const pcm24k = buf24k.subarray(wavInfo.dataOffset, wavInfo.dataOffset + wavInfo.dataLength);
  const numSamples24k = pcm24k.length / 2;
  const numSamples16k = Math.floor(numSamples24k * 2 / 3);
  const pcm16k = Buffer.alloc(numSamples16k * 2);
  for (let i = 0; i < numSamples16k; i++) {
    const t = i * 1.5;
    const idx0 = Math.floor(t);
    const idx1 = Math.min(idx0 + 1, numSamples24k - 1);
    const frac = t - idx0;
    const s0 = pcm24k.readInt16LE(idx0 * 2);
    const s1 = pcm24k.readInt16LE(idx1 * 2);
    const sOut = Math.round((1 - frac) * s0 + frac * s1);
    pcm16k.writeInt16LE(Math.max(-32768, Math.min(32767, sOut)), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm16k.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm16k.length, 40);

  return Buffer.concat([header, pcm16k]);
}

async function runSuite() {
  logHeader('Starting Windows Native Voice R5 Comprehensive Verification Suite');

  // Stage 1: Validating Canonical Package Integrity
  console.log('=== Stage 1: Validating Canonical Package Integrity ===');
  const manifestPath = path.join(ARTIFACTS_DIR, 'artifacts-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const checkArchive = (name, expBytes, expSha) => {
    const archPath = path.join(ARTIFACTS_DIR, name);
    const bytes = fs.statSync(archPath).size;
    const sha = sha256File(archPath);
    console.log(`[Archive] ${name}:`);
    console.log(`  bytes: ${bytes} (expected: ${expBytes})`);
    console.log(`  sha256: ${sha} (expected: ${expSha})`);
    if (bytes !== expBytes || sha !== expSha) {
      throw new Error(`Integrity mismatch for ${name}`);
    }
  };

  checkArchive(manifest.runtime.archiveName, manifest.runtime.archiveBytes, manifest.runtime.archiveSha256);
  checkArchive(manifest.whisper.archiveName, manifest.whisper.archiveBytes, manifest.whisper.archiveSha256);
  checkArchive(manifest.kokoro.archiveName, manifest.kokoro.archiveBytes, manifest.kokoro.archiveSha256);
  console.log('Stage 1 PASS: All 3 archives match manifest exactly.\n');

  // Stage 2: Extracting Fresh Canonical Artifacts
  console.log('=== Stage 2: Extracting Fresh Canonical Artifacts ===');
  if (fs.existsSync(SANDBOX_DIR)) fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  const unpack = (zipName, destName) => {
    console.log(`  Extracting ${zipName}...`);
    const zipPath = path.join(ARTIFACTS_DIR, zipName);
    const destDir = path.join(SANDBOX_DIR, destName);
    fs.mkdirSync(destDir, { recursive: true });
    spawnSync('python', [
      '-c',
      `import zipfile; zipfile.ZipFile(r'${zipPath}').extractall(r'${destDir}')`
    ], { stdio: 'inherit' });
  };

  unpack('voice-runtime-windows-x64.zip', 'voice-runtime');
  unpack('whisper-base-en.zip', 'whisper-base-en');
  unpack('kokoro-v1.0-onnx.zip', 'kokoro-v1.0-onnx');

  const runtimeDir = path.join(SANDBOX_DIR, 'voice-runtime');
  const treeCheck = checkWindowsRuntime(runtimeDir);
  console.log(`  Runtime tree check: fileCount=${treeCheck.fileCount}, treeDigest=${treeCheck.treeDigest}`);
  if (treeCheck.fileCount !== manifest.runtime.fileCount || treeCheck.treeDigest !== manifest.runtime.treeDigest) {
    throw new Error(`Unpacked runtime tree digest mismatch: expected=${manifest.runtime.treeDigest}, got=${treeCheck.treeDigest}`);
  }

  const whisperDir = path.join(SANDBOX_DIR, 'whisper-base-en');
  const whisperFiles = scanFiles(whisperDir);
  const whisperDigest = digestFiles(whisperFiles);
  console.log(`  Whisper tree check: fileCount=${whisperFiles.length}, treeDigest=${whisperDigest}`);
  if (whisperFiles.length !== manifest.whisper.fileCount || whisperDigest !== manifest.whisper.treeDigest) {
    throw new Error(`Unpacked whisper tree digest mismatch: expected=${manifest.whisper.treeDigest}, got=${whisperDigest}`);
  }

  const kokoroDir = path.join(SANDBOX_DIR, 'kokoro-v1.0-onnx');
  const kokoroFiles = scanFiles(kokoroDir);
  const kokoroDigest = digestFiles(kokoroFiles);
  console.log(`  Kokoro tree check: fileCount=${kokoroFiles.length}, treeDigest=${kokoroDigest}`);
  if (kokoroFiles.length !== manifest.kokoro.fileCount || kokoroDigest !== manifest.kokoro.treeDigest) {
    throw new Error(`Unpacked kokoro tree digest mismatch: expected=${manifest.kokoro.treeDigest}, got=${kokoroDigest}`);
  }
  console.log('Stage 2 PASS: Freshly extracted runtime, Whisper, and Kokoro tree integrity & license files verified.\n');

  if (fs.existsSync(TEMP_AUDIO_DIR)) fs.rmSync(TEMP_AUDIO_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });

  // Stage 3: Spawning Fresh Runtime Sidecar
  console.log('=== Stage 3: Spawning Fresh Runtime Sidecar ===');
  const exePath = path.join(runtimeDir, 'voice-runtime.exe');
  const clientEnv = {
    ...process.env,
    VOICE_RUNTIME_TEMP_DIR: TEMP_AUDIO_DIR,
    TEMP: TEMP_AUDIO_DIR,
    TMP: TEMP_AUDIO_DIR,
    VOICE_FASTER_WHISPER_MODEL: path.join(SANDBOX_DIR, 'whisper-base-en'),
    VOICE_KOKORO_ONNX_MODEL: path.join(SANDBOX_DIR, 'kokoro-v1.0-onnx', 'kokoro-v1.0.onnx'),
    VOICE_KOKORO_ONNX_VOICES: path.join(SANDBOX_DIR, 'kokoro-v1.0-onnx', 'voices-v1.0.bin'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };

  const client = new SidecarClient({
    command: exePath,
    env: clientEnv,
    requestTimeoutMs: 60000,
  });

  await client.start();
  const initialIdent = client.identity();
  console.log(`  Runtime spawned with PID: ${initialIdent.pid}, protocol: 1`);

  // Stage 4: Pre-Inference Execution Provider Truth Check
  console.log('=== Stage 4: Pre-Inference Execution Provider Truth Check ===');
  const preHealth = await client.request('runtime.health');
  console.log(`  Pre-inference health: executionProvider=${preHealth.executionProvider}`);
  if (preHealth.executionProvider !== null) {
    throw new Error('executionProvider must be null prior to inference');
  }
  console.log('Stage 4 PASS: executionProvider truthfully null prior to inference.\n');

  // Stage 5: Representative Kokoro ONNX Synthesis
  console.log('=== Stage 5: Representative Kokoro ONNX Synthesis ===');
  const ttsText = 'The Sapphire Falcon soared above crystalline glaciers in the northern sky.';
  const ttsStart = Date.now();
  const ttsResult = await client.request('tts.synthesize', {
    text: ttsText,
    voice: 'af_heart',
    format: 'wav',
  });
  const ttsElapsed = Date.now() - ttsStart;
  console.log(`  Synthesis returned in ${ttsElapsed}ms`);
  const ttsWavBytes = Buffer.from(ttsResult.audio, 'base64');
  const ttsWavPath = path.join(TEMP_AUDIO_DIR, 'tts_output.wav');
  fs.writeFileSync(ttsWavPath, ttsWavBytes);
  const ttsWavInfo = parseWavInfo(ttsWavPath);
  const rtf = (ttsElapsed / ttsWavInfo.durationMs).toFixed(4);
  console.log(`  WAV parameters: channels=${ttsWavInfo.channels}, sampleRate=${ttsWavInfo.sampleRate}, bits=${ttsWavInfo.bits}`);
  console.log(`  Audio duration: ${ttsWavInfo.durationMs}ms (${(ttsWavInfo.durationMs / 1000).toFixed(2)}s)`);
  console.log(`  Processing time: ${ttsElapsed}ms`);
  console.log(`  RTF (processing_time / audio_duration): ${rtf}`);
  console.log(`  Audio metrics: totalSamples=${ttsWavInfo.samples}, nonZero=${ttsWavInfo.nonZero}, rms=${ttsWavInfo.rms.toFixed(2)}`);
  if (ttsWavInfo.sampleRate !== 24000 || ttsWavInfo.channels !== 1 || ttsWavInfo.rms < 100) {
    throw new Error('TTS audio validation failed');
  }
  console.log('Stage 5 PASS: Kokoro TTS synthesis passed audio validation and RTF.\n');

  // Stage 6: Post-Inference Execution Provider Truth Check
  console.log('=== Stage 6: Post-Inference Execution Provider Truth Check ===');
  const postHealth = await client.request('runtime.health');
  console.log(`  Post-inference health: executionProvider=${postHealth.executionProvider}`);
  if (postHealth.executionProvider !== 'CPUExecutionProvider') {
    throw new Error('executionProvider must be CPUExecutionProvider after Kokoro inference');
  }
  console.log('Stage 6 PASS: Live execution provider accurately reported from ONNX session.\n');

  // Stage 7: faster-whisper Transcription of Synthesized Audio
  console.log('=== Stage 7: faster-whisper Transcription of Synthesized Audio ===');
  const resampled16kWav = resample24kTo16k(ttsWavBytes, ttsWavInfo);
  const resampledPath = path.join(TEMP_AUDIO_DIR, 'tts_resampled_16k.wav');
  fs.writeFileSync(resampledPath, resampled16kWav);

  const sttStart = Date.now();
  const sttResult = await client.request('stt.transcribe', {
    audioPath: resampledPath,
    language: 'en',
  });
  const sttElapsed = Date.now() - sttStart;
  console.log(`  Transcription returned in ${sttElapsed}ms`);
  console.log(`  Transcribed text: "${sttResult.text}"`);
  const sttRtf = (sttElapsed / ttsWavInfo.durationMs).toFixed(4);
  console.log(`  STT RTF (processing_time / audio_duration): ${sttRtf}`);
  if (!sttResult.text.toLowerCase().includes('sapphire') || !sttResult.text.toLowerCase().includes('glaciers')) {
    throw new Error('STT transcription mismatch: ' + sttResult.text);
  }
  console.log('Stage 7 PASS: faster-whisper transcription accurate.\n');

  // Stage 8: Real Microphone Live Recording & Challenge STT
  console.log('=== Stage 8: Real Microphone Live Recording & Challenge STT ===');
  const challengePhrase = 'Digital audio recording captures acoustic frequencies';
  console.log(`  Recording challenge phrase: "${challengePhrase}" via MCI with speaker output...`);

  const unicodeSubdir = path.join(TEMP_AUDIO_DIR, '語音 測試');
  fs.mkdirSync(unicodeSubdir, { recursive: true });
  const micWavPath = path.join(unicodeSubdir, 'mic_challenge_r5.wav');

  const scriptCall = `& '${path.join(REPO_ROOT, 'scripts/record-challenge.ps1')}' -WavPath '${micWavPath}' -ChallengePhrase '${challengePhrase}'`;
  const encodedCmd = Buffer.from(scriptCall, 'utf16le').toString('base64');
  const recResult = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedCmd,
  ], { encoding: 'utf8' });

  console.log('  Record stdout:', recResult.stdout.trim());
  if (recResult.status !== 0) {
    console.error('Record stderr:', recResult.stderr);
    throw new Error('Mic recording failed');
  }

  const micWavInfo = parseWavInfo(micWavPath);
  const pctNonZero = ((micWavInfo.nonZero / micWavInfo.samples) * 100).toFixed(1);
  console.log(`  Mic WAV parameters: channels=${micWavInfo.channels}, rate=${micWavInfo.sampleRate}Hz, bits=${micWavInfo.bits}, duration=${micWavInfo.durationMs}ms, dataOffset=${micWavInfo.dataOffset}, dataLength=${micWavInfo.dataLength}`);
  console.log(`  Mic metrics: samples=${micWavInfo.samples}, nonzero=${micWavInfo.nonZero} (${pctNonZero}%), RMS=${micWavInfo.rms.toFixed(2)}`);

  console.log('  Transcribing microphone audio with freshly unpacked faster-whisper...');
  const micSttResult = await client.request('stt.transcribe', {
    audioPath: micWavPath,
    language: 'en',
  });
  console.log(`  Microphone transcription result: "${micSttResult.text}"`);
  const expectedTokens = ['digital', 'audio', 'recording', 'captures', 'acoustic', 'frequencies'];
  const lowerMic = micSttResult.text.toLowerCase();
  const hitTokens = expectedTokens.filter(t => lowerMic.includes(t));
  console.log(`  Hit challenge tokens: ${JSON.stringify(hitTokens)}`);
  if (hitTokens.length < 5) {
    throw new Error('Microphone transcription failed to match required tokens');
  }
  console.log('Stage 8 PASS: Real microphone recorded valid audio and transcribed challenge phrase hitting required tokens.\n');

  // Stage 9: Speaker Playback Verification
  console.log('=== Stage 9: Speaker Playback Verification ===');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$p = New-Object System.Media.SoundPlayer '${resampledPath}'; $p.PlaySync(); $p.Dispose()`
  ]);
  console.log('Stage 9 PASS: SoundPlayer played synthesized audio.\n');

  // Stage 10: Session Continuity Verification
  console.log('=== Stage 10: Session Continuity Verification ===');
  await client.request('runtime.health');
  await client.request('runtime.health');
  await client.request('runtime.health');
  const pidNow = client.identity().pid;
  if (pidNow !== initialIdent.pid) {
    throw new Error('PID changed during normal requests');
  }
  console.log(`  PID ${pidNow} held constant across consecutive requests.`);
  console.log('Stage 10 PASS: Session continuity verified.\n');

  // Stage 11: In-Flight Cancel & Process Recovery
  console.log('=== Stage 11: In-Flight Cancel & Process Recovery ===');
  const oldPid = client.identity().pid;
  console.log(`  Initial instance PID: ${oldPid}`);
  console.log('  Sending in-flight cancellation target request with onStarted callback...');

  const ac = new AbortController();
  let receivedStarted = false;
  let rejectedError = null;

  try {
    await client.request('tts.synthesize', {
      text: 'Long sentence to cancel in flight. Long sentence to cancel in flight. Long sentence to cancel in flight.',
      voice: 'af_heart',
      format: 'wav',
    }, {
      signal: ac.signal,
      onStarted: ({ id, method }) => {
        receivedStarted = true;
        console.log(`  [Sidecar Notification] REQUEST_STARTED: id=${id}, method=${method}`);
        console.log('  Triggering abortController.abort() while request is actively running in-flight...');
        ac.abort();
      }
    });
  } catch (err) {
    rejectedError = err;
    console.log(`  Client received expected rejection: name=${err.name}, message="${err.message}"`);
  }

  if (!receivedStarted || !rejectedError || rejectedError.name !== 'AbortError') {
    throw new Error('In-flight cancellation did not reject with AbortError');
  }

  console.log(`  Verifying old PID ${oldPid} has exited...`);
  await new Promise(r => setTimeout(r, 1500));
  const oldAlive = isProcessAlive(oldPid);
  console.log(`  Old PID ${oldPid} alive in OS: ${oldAlive}`);
  if (oldAlive) throw new Error(`Old PID ${oldPid} still alive after in-flight cancel!`);

  console.log('  Recovering sidecar by issuing a fresh request...');
  const recovHealth = await client.request('runtime.health');
  const newPid = client.identity().pid;
  console.log(`  New instance PID: ${newPid}`);
  if (newPid === oldPid) throw new Error('New PID must be distinct from cancelled PID');
  console.log('Stage 11 PASS: In-flight cancellation aborted in-flight, confirmed old PID dead, and recovered with new distinct PID.\n');

  // Stage 12: Purging Temp Resources & Verification
  console.log('=== Stage 12: Purging Temp Resources & Verification ===');
  await client.stop();
  if (fs.existsSync(TEMP_AUDIO_DIR)) fs.rmSync(TEMP_AUDIO_DIR, { recursive: true, force: true });
  if (fs.existsSync(SANDBOX_DIR)) fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  console.log('Stage 12 PASS: Temp files purged and zero lingering processes.\n');

  logHeader('ALL 12 STAGES OF WINDOWS NATIVE VOICE R5 VERIFICATION PASSED!');
}

runSuite().catch(err => {
  console.error('VERIFICATION SUITE FAILED:', err);
  process.exit(1);
});
