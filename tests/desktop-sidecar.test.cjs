const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');

const root = path.resolve(__dirname, '..');
const server = path.join(root, 'native/python/voice_runtime/server.py');
// The runtime only accepts audio inside VOICE_RUNTIME_TEMP_DIR. Bind it to the
// same directory the test writes into (realpath: macOS /var -> /private/var).
const runtimeTemp = require('node:fs').realpathSync(require('node:os').tmpdir());

async function withClient(fn) {
  const client = new SidecarClient({
    command: process.env.PYTHON || 'python3',
    args: ['-u', server],
    env: { ...process.env, VOICE_RUNTIME_FAKE: '1', VOICE_RUNTIME_TEMP_DIR: runtimeTemp },
    requestTimeoutMs: 3000,
  });
  await client.start();
  try { await fn(client); } finally { await client.stop(); }
}

test('sidecar starts and answers health', async () => {
  await withClient(async (client) => {
    const result = await client.request('runtime.health', {});
    assert.equal(result.protocol, 1);
    assert.equal(result.fake, true);
  });
});

test('missing sidecar executable rejects without crashing the process', async () => {
  const client = new SidecarClient({
    command: path.join(root, 'definitely-missing-python'),
    args: [],
    requestTimeoutMs: 200,
  });
  await assert.rejects(client.start(), /ENOENT|VOICE_RUNTIME/);
  await client.stop();
});

test('parallel requests are correlated by id', async () => {
  await withClient(async (client) => {
    const [a, b] = await Promise.all([
      client.request('tts.synthesize', { text: 'A', voice: 'af_heart' }),
      client.request('stt.transcribe', { audioPath: path.join(runtimeTemp, 'fake.webm') }),
    ]);
    assert.equal(a.format, 'audio/wav');
    assert.equal(b.text, 'Fake transcription');
  });
});
