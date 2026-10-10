const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const ready = () => console.log(JSON.stringify({ event: 'ready' }));
if (process.env.MAIN_FIXTURE_READY_GATE) {
  const timer = setInterval(() => {
    if (fs.existsSync(process.env.MAIN_FIXTURE_READY_GATE)) { clearInterval(timer); ready(); }
  }, 5);
} else ready();
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(path.join(process.env.MAIN_FIXTURE_ROOT, 'requests'), line + '\n');
  console.error(`REQUEST_STARTED:${request.id}:${request.method}`);
  const text = request.params.text || (request.params.audioPath ? fs.readFileSync(request.params.audioPath, 'utf8') : 'health');
  if (text === 'hold') return;
  const result = { text, pid: process.pid };
  if (process.env.MAIN_FIXTURE_TTS_AUDIO === '1' && request.method === 'tts.synthesize' && text !== 'fail') {
    // Test-only inert PCM silence, not native inference. Default protocol is unchanged.
    const wav = Buffer.alloc(48);
    wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
    result.audio = wav.toString('base64'); result.format = 'audio/wav';
  }
  console.log(JSON.stringify(text === 'fail'
    ? { id: request.id, success: false, error: { message: 'controlled backend failure' } }
    : { id: request.id, success: true, result }));
});