const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');

const root = path.resolve(__dirname, '..');
const server = path.join(root, 'native/python/voice_runtime/server.py');

test('SidecarClient abort signal rejects immediately and recycles sidecar process', async () => {
  const client = new SidecarClient({
    command: process.env.PYTHON || 'python3',
    args: ['-u', server],
    env: { ...process.env, VOICE_RUNTIME_FAKE: '1' },
    requestTimeoutMs: 10000,
  });

  await client.start();
  const initialPid = client.process.pid;
  assert.ok(initialPid > 0, 'Sidecar process must have valid PID');

  const controller = new AbortController();
  const reqPromise = client.request('tts.synthesize', { text: 'Long text...', voice: 'af_heart' }, { signal: controller.signal });
  setImmediate(() => controller.abort());

  await assert.rejects(reqPromise, { name: 'AbortError' });

  // Verify next request restarts sidecar with a new PID and answers successfully
  const health = await client.request('runtime.health', {});
  assert.equal(health.protocol, 1);
  const newPid = client.process.pid;
  assert.ok(newPid > 0, 'New process must have valid PID');
  assert.notEqual(newPid, initialPid, 'Old process must be terminated and PID changed');

  await client.stop();
});

test('SidecarClient rejects immediately if AbortSignal is already aborted', async () => {
  const client = new SidecarClient({
    command: process.env.PYTHON || 'python3',
    args: ['-u', server],
    env: { ...process.env, VOICE_RUNTIME_FAKE: '1' },
    requestTimeoutMs: 10000,
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.request('runtime.health', {}, { signal: controller.signal }),
    { name: 'AbortError' }
  );

  await client.stop();
});

test('SidecarClient validates synchronously immediately before spawn', async () => {
  let checked = false;
  const client = new SidecarClient({
    command: 'must-not-be-spawned',
    beforeSpawn: () => {
      checked = true;
      throw new Error('RUNTIME_CHANGED_BEFORE_SPAWN');
    },
  });

  await assert.rejects(client.start(), /RUNTIME_CHANGED_BEFORE_SPAWN/);
  assert.equal(checked, true);
  assert.equal(client.process, null);
});

test('SidecarClient stop rejects and retains the child when no exit is observed', async () => {
  const client = new SidecarClient({
    command: 'unused',
    stopGraceMs: 5,
    stopKillWaitMs: 10,
  });
  const child = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => true;
  client.process = child;
  client.readyPromise = Promise.resolve({ protocol: 1 });

  await assert.rejects(client.stop(), /VOICE_RUNTIME_TERMINATION_TIMEOUT/);
  assert.equal(client.process, child, 'Unconfirmed child must remain tracked');
});
