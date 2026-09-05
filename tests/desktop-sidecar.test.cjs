const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');

const root = path.resolve(__dirname, '..');
const server = path.join(root, 'native/python/voice_runtime/server.py');

async function withClient(fn) {
  const client = new SidecarClient({
    command: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    args: ['-u', server],
    env: { ...process.env, VOICE_RUNTIME_FAKE: '1' },
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
      client.request('stt.transcribe', { audioPath: path.join(require('os').tmpdir(), 'fake.webm') }),
    ]);
    assert.equal(a.format, 'audio/wav');
    assert.equal(b.text, 'Fake transcription');
  });
});

test('cancel immediately rejects in-flight requests, terminates work, and restarts cleanly', async () => {
  await withClient(async (client) => {
    const req = client.request('tts.synthesize', { text: 'Cancel me', voice: 'af_heart' });
    const rejectionPromise = assert.rejects(req, /VOICE_RUNTIME_CANCELLED/);
    await new Promise(resolve => setImmediate(resolve));
    const originalPid = client.process.pid;
    await client.cancel();
    await rejectionPromise;
    assert.equal(client.process, null);
    await client.start();
    assert.ok(client.process.pid > 0);
    assert.notEqual(client.process.pid, originalPid);
  });
});

test('stop terminates sidecar process and rejects pending requests', async () => {
  const client = new SidecarClient({
    command: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    args: ['-u', server],
    env: { ...process.env, VOICE_RUNTIME_FAKE: '1' },
    requestTimeoutMs: 5000,
  });
  await client.start();
  assert.ok(client.process);
  const child = client.process;
  const pid = client.process.pid;
  assert.ok(pid > 0);

  const pending = client.request('tts.synthesize', { text: 'Will be stopped', voice: 'af_heart' });
  const rejectionPromise = assert.rejects(pending, /VOICE_RUNTIME_STOPPED/);
  await new Promise(resolve => setImmediate(resolve));
  await client.stop();
  assert.equal(client.process, null);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await rejectionPromise;
});
