const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { SidecarClient } = require('../apps/desktop/sidecar-client.cjs');
const { normalize, canFallback } = require('../apps/web/runtime/desktop-voice-operation-contract.js');
const mainPath = path.resolve(__dirname, '../apps/desktop/main.cjs');
const realRequire = createRequire(mainPath);
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check) { for (let i = 0; i < 250; i++) { if (await check()) return; await delay(10); } throw new Error('fixture deadline'); }
const state = requestId => ({ version: 1, type: 'observe', requestId });
const revoke = requestIds => ({ version: 1, type: 'revoke', requestIds });
// Electron commit precedes DOM/bootstrap and finish; each new document has an
// original frame identity. Do not use finish alone to simulate navigation.
function commitDocument(wc) {
  wc.mainFrame = { ...wc.mainFrame, processId: 1, routingId: (wc.mainFrame.routingId || 0) + 1 };
  wc.emit('did-frame-navigate', {}, wc.mainFrame.url, -1, '', true, wc.mainFrame.processId, wc.mainFrame.routingId);
  wc.emit('did-finish-load');
}
test('producer advances Main receipt before a read-only observer sees dispatched work', { timeout: 6000 }, async t => {
  const h = await harness(t);
  const work = h.invoke('voice:tts', { requestId: 'producer-held', text: 'hold' });
  t.after(async () => { await h.clients[0].stop(); await work; });
  await until(async () => { try { return (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).includes('tts.synthesize'); } catch { return false; } });
  const observed = await h.invoke('voice:operation-state', state('producer-held'));
  assert.equal(observed.logical, 'dispatched');
  assert.equal(observed.receipt.status, 'running');
  assert.equal(typeof observed.receipt.binding.generation, 'number');
  const again = await h.invoke('voice:operation-state', state('producer-held'));
  assert.equal(again.revision, observed.revision, 'query cannot advance a producer revision');
});
test('invalid typed TTS releases its unused original permit without killing the healthy generation', { timeout: 6000 }, async t => {
  const h = await harness(t);
  const originalPid = h.children[0].pid;
  for (let i = 0; i < 129; i++) {
    const reply = await h.invoke('voice:tts', { requestId: `unused-${i}`, text: '' });
    assert.deepEqual(normalize(reply), reply);
    assert.equal(reply.completion, null);
    assert.equal(h.invoke('voice:operation-state', state(`unused-${i}`)).knowledge, 'retired');
    assert.equal(h.clients[0].operations.size, 0, 'retired Main record must release its unused original permit slot');
    assert.equal(h.clients[0].process.pid, originalPid, 'release is not generation cancellation');
  }
  const success = await h.invoke('voice:tts', { requestId: 'after-unused', text: 'hello' });
  assert.equal(success.pid, originalPid);
});
test('ordinary Main failure delivers its original proof although observer is already retired', { timeout: 6000 }, async t => {
  const h = await harness(t);
  const reply = await h.invoke('voice:tts', { requestId: 'ordinary', text: 'fail' });
  assert.deepEqual(normalize(reply), reply);
  assert.equal(reply.completion.receipt.status, 'completed');
  assert.equal((await h.invoke('voice:operation-state', state('ordinary'))).knowledge, 'retired');
  assert.equal(canFallback(reply, { requestId: 'ordinary', epoch: 1, currentEpoch: 1,
    stopped: false, ownerValid: true, admissionValid: true, domainFault: false, transportUncertain: false }), true);
  const result = await h.invoke('voice:tts', { requestId: 'healthy', text: 'hello' });
  assert.equal(result.success, true);
  assert.equal(result.pid, h.children[0].pid);
});
test('logical revoke reply is unique and prompt while original STT write remains physically owned', { timeout: 6000 }, async t => {
  const hold = gate(); let entered = false, replies = 0;
  const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => {
    entered = true; await hold.promise; return fs.writeFile(...args);
  } } });
  const work = h.invoke('voice:stt', { requestId: 'logical-drain', buffer: Buffer.from('owned') }).then(reply => { replies++; return reply; });
  await until(() => entered);
  await h.invoke('voice:operation-revoke', revoke(['logical-drain']));
  await until(() => replies === 1);
  const reply = await work; assert.deepEqual(normalize(reply), reply); assert.equal(reply.completion, null);
  const pending = await h.invoke('voice:operation-state', state('logical-drain'));
  assert.equal(pending.knowledge, 'known'); assert.equal(pending.cleanup, 'pending');
  h.app.quit(); await delay(30); assert.equal(h.quits.length, 0, 'Quit must still own held file task');
  hold.release(); await until(() => h.quits.length === 1);
  assert.equal(replies, 1);
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
});
test('same URL reload fences the captured owner while a held STT write drains', { timeout: 6000 }, async t => {
  const hold = gate(); let entered = false;
  const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => { entered = true; await hold.promise; return fs.writeFile(...args); } } });
  const original = h.invoke('voice:stt', { requestId: 'reloaded', buffer: Buffer.from('stale') });
  await until(() => entered);
  const wc = h.window.webContents;
  wc.emit('did-start-navigation', {}, wc.mainFrame.url, false, true);
  commitDocument(wc);
  assert.equal((await h.invoke('voice:operation-state', state('reloaded'))).knowledge, 'unknown');
  hold.release();
  assert.equal((await original).type, 'failure');
  await assert.rejects(fs.stat(path.join(h.root, 'requests')), { code: 'ENOENT' });
});
for (const boundary of ['reload', 'destroy', 'quit']) test(`original owner ${boundary} revokes running TTS and held STT before callbacks`, { timeout: 6000 }, async t => {
  const hold = gate(); let entered = false;
  const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => {
    entered = true; await hold.promise; return fs.writeFile(...args);
  } } });
  const tts = h.invoke('voice:tts', { requestId: 'owner-tts', text: 'hold' });
  const stt = h.invoke('voice:stt', { requestId: 'owner-stt', buffer: Buffer.from('owned') });
  await until(() => entered);
  await until(async () => (await h.invoke('voice:operation-state', state('owner-tts'))).logical === 'dispatched');
  // A completed stdin write is not a child-consumption ACK. Hold cancellation
  // until the actual original child has logged the request whose count we assert.
  await until(async () => { try { return (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).includes('tts.synthesize'); } catch { return false; } });
  const old = h.children[0];
  if (boundary === 'reload') h.window.webContents.emit('did-start-navigation', {}, h.window.webContents.mainFrame.url, false, true);
  if (boundary === 'destroy') h.window.webContents.emit('destroyed');
  if (boundary === 'quit') h.app.quit();
  for (const id of ['owner-tts', 'owner-stt']) {
    assert.equal(h.invoke('voice:operation-state', state(id)).revocation, 'revoked', 'synchronous original owner fence');
  }
  assert.equal((await tts).type, 'failure'); assert.equal((await stt).type, 'failure');
  await until(() => old.exitCode !== null || old.signalCode !== null);
  if (boundary === 'reload') {
    commitDocument(h.window.webContents);
    assert.equal(h.invoke('voice:operation-state', state('owner-tts')).knowledge, 'unknown');
    const fresh = await h.invoke('voice:tts', { requestId: 'fresh-owner', text: 'hello' });
    assert.equal(fresh.success, true); assert.notEqual(fresh.pid, old.pid, 'true replacement PID');
  }
  hold.release();
  await until(async () => (await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length === 0);
  const lines = (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, boundary === 'reload' ? 2 : 1, 'old held write never dispatches');
  if (boundary === 'quit') await until(() => h.quits.length === 1);
});
for (const kind of ['tts', 'stt']) test(`submitted ${kind} timeout waits for original confirmation and copies eligible proof before retirement`, { timeout: 6000 }, async t => {
  const hold = gate();
  const h = await harness(t, { release: hold.release });
  const client = h.clients[0], originalPid = h.children[0].pid;
  const terminate = client._terminate.bind(client);
  let terminating = false, replies = 0;
  client._terminate = async proc => { terminating = true; await hold.promise; return terminate(proc); };
  client.requestTimeoutMs = 150;
  const id = `timeout-${kind}`;
  const work = h.invoke(`voice:${kind}`, kind === 'tts' ? { requestId: id, text: 'hold' }
    : { requestId: id, buffer: Buffer.from('hold') }).then(reply => { replies++; return reply; });
  await until(async () => { try { return (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).includes(kind === 'tts' ? 'tts.synthesize' : 'stt.transcribe'); } catch { return false; } });
  await until(() => terminating); await delay(20);
  assert.equal(replies, 0, 'healthy timeout cannot deliver an early null or unsafe proof');
  if (kind === 'stt') assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 1);
  hold.release();
  const reply = await work;
  assert.deepEqual(normalize(reply), reply);
  assert.equal(reply.completion?.receipt.status, 'confirmed', 'original timeout confirmation, never forged completed');
  assert.equal(canFallback(reply, { requestId: id, epoch: 1, currentEpoch: 1, stopped: false,
    ownerValid: true, admissionValid: true, domainFault: false, transportUncertain: false }), true);
  assert.equal(h.invoke('voice:operation-state', state(id)).knowledge, 'retired');
  assert.equal(client.operations.size, 0);
  const fresh = await h.invoke('voice:tts', { requestId: `fresh-${kind}`, text: 'hello' });
  assert.notEqual(fresh.pid, originalPid); assert.equal(replies, 1);
});
test('STT file removal failure is normalized cleanup-failed and retains its full record', { timeout: 6000 }, async t => {
  const h = await harness(t, { fs: { rm: async (...args) => {
    if (/\.(webm|wav)$/.test(args[0])) throw new Error('CONTROLLED_FILE_CLEANUP_FAILURE');
    return fs.rm(...args);
  } } });
  const reply = await h.invoke('voice:stt', { requestId: 'cleanup-failure', buffer: Buffer.from('fail') });
  assert.deepEqual(normalize(reply), reply);
  assert.equal(reply.code, 'cleanup-failed');
  assert.equal(reply.completion, null, 'ordinary backend proof cannot hide failed owned cleanup');
  const retained = h.invoke('voice:operation-state', state('cleanup-failure'));
  assert.equal(retained.knowledge, 'known'); assert.equal(retained.cleanup, 'retained');
  assert.equal(retained.failure.code, 'cleanup-failed'); assert.equal(retained.receipt.status, 'completed');
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 1);
});
test('MEMORY failed TTS termination fences mixed held STT from another intent with one early valid reply', { timeout: 6000 }, async t => {
  const write = gate(), kill = gate(); let writing = false, terminating = false;
  const h = await harness(t, { release: () => { write.release(); kill.release(); }, fs: {
    writeFile: async (...args) => { writing = true; await write.promise; return fs.writeFile(...args); },
  } });
  const client = h.clients[0], terminate = client._terminate.bind(client);
  client._terminate = async () => { terminating = true; await kill.promise; throw new Error('MEMORY_TERMINATION_UNCONFIRMED'); };
  t.after(() => { client._terminate = terminate; });
  client.requestTimeoutMs = 100;
  let ttsReplies = 0, sttReplies = 0;
  const tts = h.invoke('voice:tts', { requestId: 'mixed-tts', text: 'hold' }).then(r => { ttsReplies++; return r; });
  await until(() => terminating);
  const stt = h.invoke('voice:stt', { requestId: 'mixed-stt', buffer: Buffer.from('held') }).then(r => { sttReplies++; return r; });
  await until(() => writing);
  kill.release(); await until(() => ttsReplies === 1);
  await delay(40);
  assert.equal(sttReplies, 1, 'domain fault must logically settle held work before write release');
  const original = await tts, other = await stt;
  assert.deepEqual(normalize(original), original); assert.equal(original.code, 'termination-unconfirmed');
  assert.deepEqual(normalize(other), other); assert.equal(other.code, 'admission-closed');
  assert.equal(other.completion, null);
  const observed = h.invoke('voice:operation-state', state('mixed-stt'));
  assert.notEqual(observed.receipt.status, 'unconfirmed', 'domain fault cannot forge another original receipt');
  assert.equal(observed.cleanup, 'pending');
  assert.throws(() => h.invoke('voice:tts', { requestId: 'after-fault', text: 'late' }), /CLOSED/);
  write.release(); await until(async () => (await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length === 0);
  const lines = (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1); assert.match(lines[0], /tts.synthesize/);
  assert.equal(ttsReplies, 1); assert.equal(sttReplies, 1); assert.equal(h.children.length, 1);
  client._terminate = terminate;
});
for (const kind of ['tts', 'stt']) test(`MEMORY submitted ${kind} unconfirmed keeps original receipt through correlated public Quit and owned cleanup retry`, { timeout: 8000 }, async t => {
  const drain = gate(); let failKill = true, failRm = true, removes = 0, stops = 0, replies = 0;
  const h = await harness(t, { release: () => { failKill = false; failRm = false; drain.release(); }, fs: {
    rm: async (...args) => {
      if (/\.(wav|webm)$/.test(args[0])) { removes++; if (failRm) throw new Error('MEMORY_RM_FAILED'); }
      return fs.rm(...args);
    },
  } });
  const client = h.clients[0], terminate = client._terminate.bind(client), stop = client.stop.bind(client);
  if (kind === 'stt') {
    const oldPid = client.process.pid;
    await h.stopOwnedClient(client);
    const healthy = await h.invoke('voice:tts', { requestId: 'before-unconfirmed', text: 'hello' });
    assert.notEqual(healthy.pid, oldPid, 'stale public confirmation belongs to a genuinely old PID');
  }
  client.stop = (...args) => { stops++; return stop(...args); };
  client._terminate = async proc => { if (failKill) throw new Error('MEMORY_TERMINATION_UNCONFIRMED'); await drain.promise; return terminate(proc); };
  client.requestTimeoutMs = 100;
  const id = `quit-${kind}`;
  const work = h.invoke(`voice:${kind}`, kind === 'tts' ? { requestId: id, text: 'hold' } : { requestId: id, buffer: Buffer.from('hold') })
    .then(r => { replies++; return r; });
  await until(() => replies === 1);
  const reply = await work, record = [...h.ledger.owners.values()][0].get(id);
  const original = record.operation.snapshot();
  assert.deepEqual(normalize(reply), reply); assert.equal(reply.code, 'termination-unconfirmed'); assert.equal(reply.completion, null);
  assert.equal(original.status, 'unconfirmed'); assert.equal(removes, 0);
  if (kind === 'stt') assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 1);
  h.app.quit(); await until(() => !h.shutdownPending());
  assert.equal(stops, 1); assert.equal(h.quits.length, 0); assert.equal(removes, 0);
  assert.deepEqual(record.operation.snapshot(), original);
  failKill = false;
  h.app.quit(); await until(() => stops === 2); await delay(30);
  assert.equal(h.quits.length, 0); assert.equal(removes, 0, 'file cannot be released by pending Quit');
  drain.release(); await until(() => !h.shutdownPending());
  assert.deepEqual(record.operation.snapshot(), original, 'new public stop evidence cannot rewrite original failed operation');
  await assert.rejects(record.operation.cancel(), /MEMORY_TERMINATION_UNCONFIRMED/);
  if (kind === 'stt') {
    assert.equal(h.quits.length, 0, 'failed owned rm retry must prevent Quit');
    assert.equal(h.invoke('voice:operation-state', state(id)).failure.code, 'termination-unconfirmed', 'original uncertainty outranks cleanup failure');
    assert.equal(typeof record.cleanupRetry, 'function', 'full record owns the actual path retry');
    assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 1);
    const failedRemoves = removes; failRm = false;
    h.app.quit(); await until(() => !h.shutdownPending());
    assert.ok(removes > failedRemoves); assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
  }
  assert.equal(h.quits.length, 1, 'successful public client/file drain completes without cyclic await');
  assert.equal(h.invoke('voice:operation-state', state(id)).knowledge, 'retired');
  assert.equal(replies, 1); assert.deepEqual(record.operation.snapshot(), original);
  assert.equal(record.finalDrain?.confirmed, true); assert.equal(record.finalDrain?.operation, record.operation);
  assert.equal(record.finalDrain?.client, client);
});
test('MEMORY completed STT cleanup failure retries its owned file on Quit and then automatically retires', { timeout: 6000 }, async t => {
  let failRm = true, removes = 0, replies = 0;
  const h = await harness(t, { fs: { rm: async (...args) => {
    if (/\.(wav|webm)$/.test(args[0])) { removes++; if (failRm) throw new Error('MEMORY_RM_FAILED'); }
    return fs.rm(...args);
  } } });
  const reply = await h.invoke('voice:stt', { requestId: 'rm-retry', buffer: Buffer.from('fail') }).then(r => { replies++; return r; });
  const record = [...h.ledger.owners.values()][0].get('rm-retry'), original = record.operation.snapshot();
  assert.equal(reply.code, 'cleanup-failed');
  h.app.quit(); await until(() => !h.shutdownPending());
  assert.equal(h.quits.length, 0, 'public client stop alone is not owned file cleanup');
  assert.ok(removes >= 2); assert.equal(typeof record.cleanupRetry, 'function');
  assert.deepEqual(record.operation.snapshot(), original);
  failRm = false; h.app.quit(); await until(() => !h.shutdownPending());
  assert.equal(h.quits.length, 1); assert.equal(replies, 1);
  assert.equal(h.invoke('voice:operation-state', state('rm-retry')).knowledge, 'retired');
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
});
test('MEMORY same-intent mixed held STT keeps its unconfirmed original file until public Quit', { timeout: 7000 }, async t => {
  const write = gate(); let writing = false, replies = 0;
  const h = await harness(t, { release: write.release, fs: { writeFile: async (...args) => {
    writing = true; await write.promise; return fs.writeFile(...args);
  } } });
  const client = h.clients[0], terminate = client._terminate.bind(client);
  client._terminate = async () => { throw new Error('MEMORY_TERMINATION_UNCONFIRMED'); };
  const stt = h.invoke('voice:stt', { requestId: 'shared-stt', buffer: Buffer.from('hold') }).then(r => { replies++; return r; });
  await until(() => writing);
  client.requestTimeoutMs = 100;
  const tts = await h.invoke('voice:tts', { requestId: 'shared-tts', text: 'hold' });
  await until(() => replies === 1);
  const reply = await stt;
  assert.deepEqual(normalize(reply), reply); assert.equal(reply.code, 'termination-unconfirmed');
  assert.equal(tts.code, 'termination-unconfirmed');
  const record = [...h.ledger.owners.values()][0].get('shared-stt'), original = record.operation.snapshot();
  assert.equal(original.status, 'unconfirmed');
  write.release(); await delay(80);
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 1, 'original unconfirmed held input remains owned after write drains');
  assert.equal((await fs.readFile(path.join(h.root, 'requests'), 'utf8')).trim().split('\n').length, 1);
  assert.deepEqual(record.operation.snapshot(), original);
  client._terminate = terminate;
  h.app.quit(); await until(() => !h.shutdownPending());
  assert.equal(h.quits.length, 1); assert.equal(replies, 1);
  assert.equal(h.invoke('voice:operation-state', state('shared-stt')).knowledge, 'retired');
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
});
for (const fault of ['normalize', 'generation', 'revision']) test(`MEMORY producer ${fault} failure settles once without swallowed callback hang or forged Counter`, { timeout: 7000 }, async t => {
  const write = gate(); let writing = false, replies = 0;
  const h = await harness(t, { release: write.release, fs: { writeFile: async (...args) => {
    writing = true; await write.promise; return fs.writeFile(...args);
  } } });
  const client = h.clients[0], rawSnapshot = client._operationSnapshot.bind(client);
  const pending = h.invoke('voice:stt', { requestId: `producer-${fault}`, buffer: Buffer.from('hold') }).then(r => { replies++; return r; });
  await until(() => writing);
  const record = [...h.ledger.owners.values()][0].get(`producer-${fault}`);
  if (fault === 'revision') record.state.revision = 2147483647;
  if (fault === 'generation') h.ledger.generation = 2147483647;
  if (fault === 'normalize') client._operationSnapshot = op => {
    const original = rawSnapshot(op);
    return original.status === 'starting' ? Object.freeze({ ...original, binding: { ...original.binding, clientId: 'invalid id' } }) : original;
  };
  const before = h.invoke('voice:operation-state', state(record.requestId));
  write.release();
  await delay(120);
  assert.equal(replies, 1, 'producer fault cannot disappear inside Sidecar listener isolation');
  const reply = await pending;
  assert.deepEqual(normalize(reply), reply); assert.equal(reply.completion, null);
  assert.equal(reply.code, fault === 'normalize' ? 'admission-closed' : 'quota-exceeded');
  assert.equal(h.ledger.allowed(record), false); assert.equal(record.retired, undefined);
  assert.ok(record.producerError, 'full record retains producer fault and native ownership');
  const seen = h.invoke('voice:operation-state', state(record.requestId));
  assert.deepEqual(normalize(seen), seen);
  const reads = Array.from({ length: 8 }, () => h.invoke('voice:operation-state', state(record.requestId)));
  assert.ok(reads.every(value => JSON.stringify(value) === JSON.stringify(seen)));
  if (fault === 'revision') {
    assert.equal(seen.revision, before.revision, 'cannot forge room in an exhausted Counter');
    h.invoke('voice:operation-revoke', revoke([record.requestId]));
    assert.deepEqual(h.invoke('voice:operation-state', state(record.requestId)), seen, 'exhausted revision cannot silently mutate revocation at the same Counter');
  }
  if (fault === 'generation') assert.equal(h.ledger.generation, 2147483647, 'no wrap or synthetic UUID mapping');
  await assert.rejects(fs.stat(path.join(h.root, 'requests')), { code: 'ENOENT' });
  assert.throws(() => h.invoke('voice:tts', { requestId: 'fresh-denied', text: 'late' }), /CLOSED/);
  client._operationSnapshot = rawSnapshot;
  h.app.quit(); await until(() => !h.shutdownPending());
  assert.equal(h.quits.length, 1); assert.equal(replies, 1);
  assert.equal(h.invoke('voice:operation-state', state(record.requestId)).knowledge, 'retired');
});
test('MEMORY failed batch handles every known member and fences outside-batch beforeSpawn work', { timeout: 7000 }, async t => {
  const spawn = gate(); let entered = false;
  const h = await harness(t, { release: spawn.release });
  const client = h.clients[0]; await client.stop();
  client.beforeSpawn = async () => { entered = true; await spawn.promise; };
  const ids = ['batch-a', 'batch-b', 'batch-c', 'outside'];
  const work = ids.map(requestId => h.invoke('voice:tts', { requestId, text: 'late' }));
  await until(() => entered);
  const records = [...h.ledger.owners.values()][0], observations = [];
  const cancel = client._cancelOperation.bind(client); let calls = 0;
  client._cancelOperation = operation => {
    observations.push(ids.slice(0, 3).map(id => records.get(id)?.state.revocation));
    calls++;
    if (calls === 1) throw new Error('MEMORY_CANCEL_SYNC_FAILURE');
    if (calls === 2) return Promise.reject(new Error('MEMORY_CANCEL_ASYNC_FAILURE'));
    return cancel(operation);
  };
  const ack = h.invoke('voice:operation-revoke', revoke(ids.slice(0, 3)));
  assert.deepEqual(normalize(ack), ack); assert.ok(calls >= 3);
  assert.ok(observations.every(values => values.every(value => value === 'revoked')), 'assertions outside isolated cancellation callbacks');
  assert.equal(h.ledger.allowed(records.get('outside')), false);
  spawn.release();
  for (const reply of await Promise.all(work)) {
    assert.deepEqual(normalize(reply), reply); assert.equal(reply.completion, null);
    assert.notEqual(reply.code, 'termination-unconfirmed', 'failed cancel invocation alone is not an unconfirmed native receipt');
  }
  await assert.rejects(fs.stat(path.join(h.root, 'requests')), { code: 'ENOENT' });
  assert.equal(h.children.length, 1, 'no after-fault late spawn');
  client._cancelOperation = cancel;
  h.app.quit(); await until(() => !h.shutdownPending()); assert.equal(h.quits.length, 1);
});
for (const kind of ['tts', 'stt']) test(`MEMORY sticky fault survives old PID natural exit and blocks fresh legacy ${kind}`, { timeout: 6000 }, async t => {
  const h = await harness(t), client = h.clients[0], original = h.children[0];
  const terminate = client._terminate.bind(client);
  client._terminate = async () => { throw new Error('MEMORY_TERMINATION_UNCONFIRMED'); };
  client.requestTimeoutMs = 100;
  const failed = await h.invoke('voice:tts', { requestId: 'old-fault', text: 'hold' });
  assert.equal(failed.code, 'termination-unconfirmed');
  original.stdin.end(); await until(() => original.exitCode !== null || original.signalCode !== null);
  assert.throws(() => h.invoke('voice:tts', { requestId: 'new-id', text: 'late' }), /CLOSED/);
  await assert.rejects(async () => h.invoke(`voice:${kind}`, kind === 'tts' ? { text: 'late' } : { buffer: Buffer.from('late') }), /ADMISSION_CLOSED/);
  assert.equal(h.children.length, 1);
  const requests = (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).trim().split('\n');
  assert.equal(requests.length, 1);
  client._terminate = terminate; h.app.quit(); await until(() => !h.shutdownPending()); assert.equal(h.quits.length, 1);
});
test('registered Main rejects wrong frame, sender and origin without admitting or touching native work', { timeout: 6000 }, async t => {
  const h = await harness(t), wc = h.window.webContents;
  for (const channel of ['voice:tts', 'voice:stt', 'voice:operation-state', 'voice:operation-revoke']) {
    const handler = h.handlers.get(channel);
    assert.throws(() => handler({ sender: {}, senderFrame: wc.mainFrame }, {}), /UNTRUSTED_IPC_SENDER/);
    assert.throws(() => handler({ sender: wc, senderFrame: { url: wc.mainFrame.url } }, {}), /UNTRUSTED_IPC_SENDER/);
    const url = wc.mainFrame.url; wc.mainFrame.url = 'https://invalid.test/';
    assert.throws(() => handler({ sender: wc, senderFrame: wc.mainFrame }, {}), /UNTRUSTED_IPC_ORIGIN/);
    wc.mainFrame.url = url;
  }
  assert.equal(h.ledger.owners.size, 0); assert.equal(h.clients[0].operations.size, 0);
  await assert.rejects(fs.stat(path.join(h.root, 'requests')), { code: 'ENOENT' });
});
// Finite risk classes: full-record admission vs tombstone overflow; no Cartesian claim.
for (const quota of ['owner-full', 'global-full', 'owner-history', 'global-history']) {
  test(`MATRIX Main actual ${quota} gate fences held outside work across reload and retirement`, { timeout: 10000 }, async t => {
    const hold = gate(); let writing = 0, entering = false, replies = 0;
    const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => {
      writing++; await hold.promise; return fs.writeFile(...args);
    } } });
    const client = h.clients[0], wc = h.window.webContents, works = [], oldRecords = [];
    const reload = () => {
      wc.emit('did-start-navigation', {}, wc.mainFrame.url, false, true); commitDocument(wc);
    };
    const tombstones = count => {
      for (let i = 0; i < count; i += 32) h.invoke('voice:operation-revoke', revoke(
        Array.from({ length: Math.min(32, count - i) }, (_, j) => `retired-${i + j}`)));
    };
    if (quota === 'global-full') {
      for (let owner = 0; owner < 4; owner++) {
        for (let i = 0; i < 31; i++) works.push(h.invoke('voice:stt', { requestId: `retained-${i}`, buffer: Buffer.from('held') }));
        await until(() => writing === (owner + 1) * 31);
        oldRecords.push(...[...h.ledger.owners.values()].at(-1).values());
        reload();
      }
      assert.equal(h.invoke('voice:operation-state', state('retained-0')).knowledge, 'unknown');
    }
    if (quota === 'global-history') {
      for (let owner = 0; owner < 3; owner++) { tombstones(1024); reload(); }
      tombstones(1023); reload();
      assert.equal(h.invoke('voice:operation-state', state('retired-0')).knowledge, 'unknown');
    }
    const history = quota.endsWith('history');
    if (quota === 'owner-history') {
      tombstones(1023);
      assert.throws(() => h.invoke('voice:tts', { requestId: 'retired-0', text: 'late' }), /REUSED/);
      assert.equal(h.ledger.fault, null, 'ID rejection is not quota overflow');
    }
    await client.stop();
    const readyFile = path.join(h.root, 'matrix-ready');
    if (history) client.env.MAIN_FIXTURE_READY_GATE = readyFile;
    else client.beforeSpawn = () => { entering = true; return hold.promise; };
    const count = history ? 1 : quota === 'global-full' ? 4 : 32;
    for (let i = 0; i < count; i++) works.push(h.invoke('voice:tts', { requestId: `outside-${i}`, text: 'late' })
      .then(r => { replies++; return r; }));
    await until(() => history ? h.children.length === 2 && !!client.readyPromise : entering);
    const owner = [...h.ledger.owners.keys()].at(-1), records = [...h.ledger.owners.get(owner).values()].filter(Boolean);
    assert.equal(records.length, count);
    assert.equal(h.ledger.fault, null);
    assert.ok(records.every(record => h.ledger.allowed(record)), 'outside work is live immediately before the actual quota gate');
    if (history) {
      assert.throws(() => h.invoke('voice:operation-revoke', revoke(['overflow'])), /QUOTA_EXCEEDED/);
      assert.equal(h.invoke('voice:operation-state', state('overflow')).knowledge, 'unknown', 'no emergency tombstone');
    } else assert.throws(() => h.invoke('voice:tts', { requestId: 'overflow', text: 'late' }), /QUOTA_EXCEEDED/);
    assert.equal(h.ledger.fault, 'quota-exceeded');
    assert.ok([...oldRecords, ...records].every(record => !h.ledger.allowed(record)));
    assert.equal(client.operations.size <= 32, true, 'Main global count includes physically retained old records, not Sidecar capacity');
    const childrenAtFault = h.children.length;
    assert.throws(() => h.invoke('voice:tts', { requestId: 'fresh-denied', text: 'late' }), /CLOSED/);
    await assert.rejects(async () => h.invoke('voice:stt', { buffer: Buffer.from('late') }), /CLOSED/);
    hold.release(); if (history) await fs.writeFile(readyFile, 'ready');
    for (const reply of await Promise.all(works)) {
      assert.deepEqual(normalize(reply), reply); assert.equal(reply.completion, null);
    }
    reload();
    assert.equal(h.invoke('voice:operation-state', state('outside-0')).knowledge, 'unknown');
    assert.throws(() => h.invoke('voice:tts', { requestId: 'retired-0', text: 'late' }), /CLOSED/, 'new document cannot reset sticky domain fault');
    h.app.quit(); await until(() => !h.shutdownPending());
    assert.equal(h.quits.length, 1); assert.equal(replies, count);
    assert.equal(h.children.length, childrenAtFault, 'released continuation cannot start a fresh generation');
    await assert.rejects(fs.stat(path.join(h.root, 'requests')), { code: 'ENOENT' });
    assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
  });
}

for (const order of [['sync', 'async', 'sync'], ['async', 'sync', 'async']]) {
  test(`MATRIX failed batch all cancellations fail ${order.join('-')} with old owner and wrong frame isolated`, { timeout: 7000 }, async t => {
    const hold = gate(); let writing = false, entered = false;
    const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => {
      writing = true; await hold.promise; return fs.writeFile(...args);
    } } });
    const oldWork = h.invoke('voice:stt', { requestId: 'same-id', buffer: Buffer.from('held') });
    await until(() => writing);
    const oldOwner = [...h.ledger.owners.keys()][0], oldRecord = h.ledger.owners.get(oldOwner).get('same-id');
    const wc = h.window.webContents;
    wc.emit('did-start-navigation', {}, wc.mainFrame.url, false, true); commitDocument(wc);
    const oldProof = h.ledger.observe(oldOwner, state('same-id'));
    await h.clients[0].stop();
    h.clients[0].beforeSpawn = () => { entered = true; return hold.promise; };
    const ids = ['same-id', 'b', 'c', 'outside']; let replies = 0;
    const works = ids.map(requestId => h.invoke('voice:tts', { requestId, text: 'late' }).then(r => { replies++; return r; }));
    await until(() => entered);
    const records = [...h.ledger.owners.values()].at(-1), observations = [], calls = [];
    const client = h.clients[0], cancel = client._cancelOperation.bind(client);
    client._cancelOperation = operation => {
      const n = calls.push(operation) - 1;
      observations.push(ids.slice(0, 3).map(id => records.get(id).state.revocation));
      if (order[n % order.length] === 'sync') throw new Error('MATRIX_SYNC');
      return Promise.reject(new Error('MATRIX_ASYNC'));
    };
    assert.throws(() => h.handlers.get('voice:operation-revoke')({ sender: wc, senderFrame: { url: wc.mainFrame.url } }, revoke(ids)), /UNTRUSTED/);
    assert.equal(calls.length, 0);
    const ack = h.invoke('voice:operation-revoke', revoke(ids.slice(0, 3)));
    assert.deepEqual(normalize(ack), ack);
    assert.equal(calls.length, 3, 'each known member attempted despite earlier failure');
    assert.ok(observations.every(values => values.every(value => value === 'revoked')), 'outside callback assertions cannot be swallowed');
    assert.deepEqual(h.ledger.observe(oldOwner, state('same-id')), oldProof, 'same ID in new document has no authority over old record');
    assert.equal(oldRecord.owner, oldOwner);
    assert.equal(h.ledger.allowed(records.get('outside')), false);
    hold.release();
    for (const reply of await Promise.all([oldWork, ...works])) { assert.deepEqual(normalize(reply), reply); assert.equal(reply.completion, null); }
    client._cancelOperation = cancel;
    h.app.quit(); await until(() => !h.shutdownPending());
    assert.equal(replies, 4); assert.equal(h.quits.length, 1); assert.equal(h.children.length, 1);
    await assert.rejects(fs.stat(path.join(h.root, 'requests')), { code: 'ENOENT' });
  });
}

test('MATRIX retired Main proof cannot be rewritten by old native events or producer callback', { timeout: 6000 }, async t => {
  const h = await harness(t), client = h.clients[0], old = h.children[0];
  const stale = { data: old.stdout.listeners('data'), exit: old.listeners('exit'), error: old.listeners('error') };
  let savedListener, savedRecord;
  const producer = h.ledger.producer.bind(h.ledger);
  h.ledger.producer = (record, receipt) => { savedRecord ||= record; savedListener ||= original => producer(record, original); return producer(record, receipt); };
  const failure = await h.invoke('voice:tts', { requestId: 'old-proof', text: 'fail' });
  const proof = JSON.stringify(failure), original = savedRecord.operation.snapshot();
  await client.stop();
  const fresh = await h.invoke('voice:tts', { requestId: 'fresh-proof', text: 'hello' });
  assert.notEqual(fresh.pid, old.pid);
  for (const callback of stale.data) callback(Buffer.from(JSON.stringify({ id: original.nativeRequestId, success: true, result: 'stale' }) + '\n'));
  for (const callback of stale.exit) callback(0, null);
  for (const callback of stale.error) callback(new Error('MATRIX_STALE'));
  savedListener({ ...original, status: 'unconfirmed' });
  assert.equal(JSON.stringify(failure), proof); assert.equal(h.ledger.fault, null);
  assert.equal(h.invoke('voice:operation-state', state('old-proof')).knowledge, 'retired');
  assert.deepEqual(savedRecord.operation.snapshot(), original);
  await assert.rejects(savedRecord.operation.request('echo'), /ALREADY_USED/);
  await savedRecord.operation.cancel();
  assert.equal(client.process.pid, fresh.pid); assert.equal(client.operations.size, 0);
  assert.equal((await fs.readFile(path.join(h.root, 'requests'), 'utf8')).trim().split('\n').length, 2);
});

// C6B-IND01/02: normative ports of the independent real-child schedules.
// Keep original reviewer characterization files/raw outside this permanent suite.
async function requests(h) {
  try { return (await fs.readFile(path.join(h.root, 'requests'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function history(h, count) {
  for (let i = 0; i < count; i += 32) h.invoke('voice:operation-revoke', revoke(
    Array.from({ length: Math.min(32, count - i) }, (_, j) => `cycle-history-${i + j}`)));
}
test('C6B-IND01 admitted legacy write cannot borrow new PID after old typed fault and true EOF', { timeout: 7000 }, async t => {
  const hold = gate(); let writing = false, replies = 0;
  const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => {
    writing = true; await hold.promise; return fs.writeFile(...args);
  } } });
  const c = h.clients[0], old = c.process, terminate = c._terminate.bind(c);
  const work = h.invoke('voice:stt', { buffer: Buffer.from('legacy-held') })
    .then(value => { replies++; return { value }; }, error => { replies++; return { error }; });
  await until(() => writing);
  c._terminate = async () => { throw new Error('MEMORY_CYCLE1_KILL_FAILURE'); }; c.requestTimeoutMs = 100;
  const failed = await h.invoke('voice:tts', { requestId: 'cycle-fault', text: 'hold' });
  assert.equal(failed.code, 'termination-unconfirmed');
  old.stdin.end(); await until(() => old.exitCode !== null || old.signalCode !== null);
  c._terminate = terminate; c.requestTimeoutMs = 1500;
  await assert.rejects(h.invoke('voice:tts', { text: 'fresh-denied' }), /ADMISSION_CLOSED/);
  hold.release(); const result = await work;
  assert.match(result.error?.message || '', /ADMISSION_CLOSED|PERMIT_DENIED|CANCELLED/);
  assert.equal(replies, 1); assert.equal(h.children.length, 1);
  assert.equal((await requests(h)).length, 1);
  h.app.quit(); await until(() => h.quits.length === 1);
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
});
for (const phase of ['beforeSpawn', 'ready']) for (const typed of [false, true]) {
  test(`C6B-IND01 actual quota denies already-starting ${phase} typed=${typed}`, { timeout: 7000 }, async t => {
    const hold = gate(), h = await harness(t, { release: hold.release }), c = h.clients[0];
    await c.stop(); history(h, 1023);
    let entered = false; const ready = path.join(h.root, 'cycle-ready');
    if (phase === 'ready') c.env.MAIN_FIXTURE_READY_GATE = ready;
    else c.beforeSpawn = () => { entered = true; return hold.promise; };
    const work = h.invoke('voice:tts', { ...(typed ? { requestId: 'cycle-starting' } : {}), text: 'late' })
      .then(value => ({ value }), error => ({ error }));
    await until(() => phase === 'ready' ? !!c.readyPromise : entered);
    if (!typed) h.invoke('voice:operation-revoke', revoke(['fill-last']));
    assert.throws(() => h.invoke('voice:operation-revoke', revoke(['overflow'])), /QUOTA_EXCEEDED/);
    const children = h.children.length;
    hold.release(); if (phase === 'ready') await fs.writeFile(ready, 'ready');
    const result = await work;
    if (typed) { assert.deepEqual(normalize(result.value), result.value); assert.equal(result.value.completion, null); }
    else assert.match(result.error?.message || '', /ADMISSION_CLOSED|PERMIT_DENIED/);
    assert.equal((await requests(h)).length, 0); assert.equal(h.children.length, children);
    h.app.quit(); await until(() => h.quits.length === 1);
  });
}
test('C6B-IND01 healthy no-ID API validation release and replacement PID keep old handles powerless', { timeout: 7000 }, async t => {
  const h = await harness(t), c = h.clients[0], old = c.process, handles = [];
  const create = c.createOperation.bind(c);
  c.createOperation = (...args) => { const handle = create(...args); handles.push(handle); return handle; };
  for (let i = 0; i < 129; i++) {
    await assert.rejects(h.invoke('voice:tts', { text: '' }), /INVALID_TTS_TEXT_LENGTH/);
    assert.equal(c.operations.size, 0); assert.equal(c.process, old);
  }
  await assert.rejects(h.invoke('voice:stt', {}), /MISSING_AUDIO_PAYLOAD/);
  await assert.rejects(h.invoke('voice:tts', { text: 'fail' }), /controlled backend failure/);
  const success = await h.invoke('voice:stt', { buffer: Buffer.from('healthy') });
  assert.equal(success.success, true); assert.equal(success.pid, old.pid);
  assert.equal(h.ledger.owners.size, 0, 'no synthetic wire IDs or unbounded legacy history');
  assert.equal(c.operations.size, 0);
  assert.ok(handles.length > 0, 'Main captures bounded original capabilities even without a wire ID');
  await c.stop(); await c.stop();
  const fresh = await h.invoke('voice:tts', { text: 'fresh' });
  assert.notEqual(fresh.pid, old.pid);
  for (const handle of handles) { await handle.cancel(); await handle.cancel(); }
  assert.equal(c.process.pid, fresh.pid); assert.equal(c.operations.size, 0);
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
});
test('C6B-IND01 no-ID owner captured before write survives reload only as original cleanup', { timeout: 7000 }, async t => {
  const hold = gate(); let writing = false;
  const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => {
    writing = true; await hold.promise; return fs.writeFile(...args);
  } } });
  const work = h.invoke('voice:stt', { buffer: Buffer.from('old-owner') }).then(value => ({ value }), error => ({ error }));
  await until(() => writing);
  h.window.webContents.emit('did-start-navigation', {}, h.window.webContents.mainFrame.url, false, true);
  commitDocument(h.window.webContents);
  const fresh = await h.invoke('voice:tts', { text: 'new-owner' }); assert.equal(fresh.success, true);
  hold.release(); const result = await work;
  assert.match(result.error?.message || '', /ADMISSION_CLOSED|PERMIT_DENIED|CANCELLED/);
  h.app.quit(); await until(() => h.quits.length === 1);
  assert.equal((await requests(h)).length, 1);
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
});
for (const trigger of ['admit', 'revoke']) test(`C6B-IND02 quota ${trigger} immediately replies to outside held write without physical release`, { timeout: 7000 }, async t => {
  const hold = gate(); let writing = false, replies = 0;
  const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => {
    writing = true; await hold.promise; return fs.writeFile(...args);
  } } });
  history(h, 1023);
  const work = h.invoke('voice:stt', { requestId: 'cycle-held', buffer: Buffer.from('owned') }).then(value => { replies++; return value; });
  await until(() => writing);
  const record = [...h.ledger.owners.values()][0].get('cycle-held'), original = record.operation.snapshot();
  assert.equal(h.ledger.allowed(record), true);
  assert.throws(() => trigger === 'admit' ? h.invoke('voice:tts', { requestId: 'overflow', text: 'late' })
    : h.invoke('voice:operation-revoke', revoke(['overflow'])), /QUOTA_EXCEEDED/);
  await delay(100);
  assert.equal(replies, 1, 'logical fault delivery must not await the held physical write or explicit revoke');
  const reply = await work; assert.deepEqual(normalize(reply), reply);
  assert.equal(reply.code, 'quota-exceeded'); assert.equal(reply.completion, null);
  assert.deepEqual(record.operation.snapshot(), original, 'fanout is not cancellation/termination proof');
  assert.equal(h.invoke('voice:operation-state', state('cycle-held')).cleanup, 'pending');
  h.invoke('voice:operation-revoke', revoke(['cycle-held']));
  h.app.quit(); await delay(30); assert.equal(h.quits.length, 0);
  hold.release(); await until(() => h.quits.length === 1);
  assert.equal(replies, 1); assert.equal((await requests(h)).length, 0);
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
});

for (const typed of [false, true]) test(`C6B-C1-IND03 SAFE transport input waits for original physical drain typed=${typed}`, { timeout: 7000 }, async t => {
  const hold = gate();
  const h = await harness(t, { release: hold.release }), c = h.clients[0], old = c.process;
  const terminate = c._terminate.bind(c); let terminating = false, replies = 0;
  c._terminate = async proc => { terminating = true; await hold.promise; return terminate(proc); };
  c.requestTimeoutMs = 3000;
  const work = h.invoke('voice:stt', { ...(typed ? { requestId: 'transport-control' } : {}), buffer: Buffer.from('hold') })
    .then(value => { replies++; return { value }; }, error => { replies++; return { error }; });
  await until(async () => (await requests(h)).length === 1);
  const original = (await requests(h))[0];
  assert.equal(await fs.readFile(original.params.audioPath, 'utf8'), 'hold');
  old.stdin.emit('error', Error('FRESH_TRANSPORT_FAILURE')); // MEMORY stream boundary only
  await until(() => terminating); await delay(30);
  const inputExists = await fs.stat(original.params.audioPath).then(() => true, () => false);
  const alive = old.exitCode === null && old.signalCode === null, beforeReplies = replies;
  console.log('TRANSPORT_DRAIN_OBSERVATION:' + JSON.stringify({ typed, oldPid: old.pid, alive, terminating, replies, inputExists, original }));
  // Drain before asserting SAFE, so even RED owns and reaps its original child.
  hold.release(); const result = await work;
  c._terminate = terminate; h.app.quit(); await until(() => h.quits.length === 1);
  assert.equal(inputExists, true, 'accepted input remains until original physical confirmation');
  assert.equal(alive, true); assert.equal(beforeReplies, 0); assert.equal(replies, 1);
  if (typed) { assert.deepEqual(normalize(result.value), result.value); assert.equal(result.value.completion, null); }
  else { assert.equal(result.error?.message, 'FRESH_TRANSPORT_FAILURE'); assert.equal(result.error?.name, 'Error'); }
  await assert.rejects(fs.stat(original.params.audioPath), { code: 'ENOENT' });
});

for (const earlierStop of [false, true]) test(`C6B-C1-IND03 failed transport cancellation retains input through failed Quit and correlated retry earlierStop=${earlierStop}`, { timeout: 7000 }, async t => {
  const hold = gate(); let fail = true, terminating = 0, removes = 0, replies = 0;
  let c, terminate;
  const h = await harness(t, { release: () => { hold.release(); if (c) c._terminate = terminate; }, fs: {
    rm: async (...args) => { if (/\.(webm|wav)$/.test(args[0])) removes++; return fs.rm(...args); },
  } });
  c = h.clients[0]; terminate = c._terminate.bind(c);
  if (earlierStop) {
    const priorPid = c.process.pid;
    await h.stopOwnedClient(c);
    const fresh = await h.invoke('voice:tts', { text: 'healthy new generation' });
    assert.notEqual(fresh.pid, priorPid, 'stale client-wide exited promise is genuinely from a prior PID');
  }
  const old = c.process, handles = [], create = c.createOperation.bind(c);
  c.createOperation = (...args) => { const operation = create(...args); handles.push(operation); return operation; };
  c._terminate = async proc => {
    terminating++; assert.equal(proc, old);
    if (fail) throw Error('MEMORY_TERMINATION_UNCONFIRMED');
    await hold.promise; return terminate(proc);
  };
  c.requestTimeoutMs = 3000;
  const before = (await requests(h)).length;
  const work = h.invoke('voice:stt', { buffer: Buffer.from('hold') })
    .then(value => { replies++; return { value }; }, error => { replies++; return { error }; });
  await until(async () => (await requests(h)).length === before + 1);
  const original = (await requests(h))[before], operation = handles[0];
  old.stdin.emit('error', Error('FRESH_TRANSPORT_FAILURE'));
  await until(() => operation.snapshot().status === 'unconfirmed'); await delay(30);
  const failed = operation.snapshot();
  assert.equal(removes, 0); assert.equal(replies, 0);
  assert.equal(await fs.readFile(original.params.audioPath, 'utf8'), 'hold');
  assert.equal(old.exitCode, null); assert.equal(old.signalCode, null);
  h.app.quit(); await until(() => !h.shutdownPending());
  assert.equal(h.quits.length, 0); assert.equal(terminating, 2);
  assert.equal(removes, 0); assert.equal(replies, 0); assert.deepEqual(operation.snapshot(), failed);
  assert.equal(await fs.readFile(original.params.audioPath, 'utf8'), 'hold');
  fail = false; h.app.quit(); await until(() => terminating === 3); await delay(30);
  assert.equal(removes, 0); assert.equal(replies, 0); assert.equal(h.quits.length, 0);
  assert.equal(old.exitCode, null); assert.equal(old.signalCode, null);
  console.log('LEGACY_QUIT_RETRY_HELD:' + JSON.stringify({ earlierStop, oldPid: old.pid, original, failed, terminating, removes, replies }));
  hold.release(); await until(() => h.quits.length === 1);
  const result = await work;
  assert.equal(result.error?.message, 'FRESH_TRANSPORT_FAILURE', 'cleanup cancellation error cannot replace original Error API');
  assert.equal(result.error?.name, 'Error'); assert.equal(replies, 1); assert.equal(removes, 1);
  assert.deepEqual(operation.snapshot(), failed, 'new public drain never rewrites the failed original receipt');
  await assert.rejects(operation.cancel(), /MEMORY_TERMINATION_UNCONFIRMED/);
  assert.equal(terminating, 3, 'old handle cannot start another current-client stop');
  await assert.rejects(fs.stat(original.params.audioPath), { code: 'ENOENT' });
  assert.equal(h.ledger.owners.size, 0, 'no legacy wire history');
});
test('C6B-C1-IND03 completed legacy STT success and backend Error keep healthy native generation', { timeout: 7000 }, async t => {
  const h = await harness(t), c = h.clients[0], old = c.process;
  let kills = 0; const terminate = c._terminate.bind(c);
  c._terminate = proc => { kills++; return terminate(proc); };
  await assert.rejects(h.invoke('voice:stt', { buffer: Buffer.from('fail') }), /controlled backend failure/);
  const success = await h.invoke('voice:stt', { buffer: Buffer.from('healthy') });
  assert.equal(success.success, true); assert.equal(success.pid, old.pid);
  assert.equal(kills, 0); assert.equal(c.process, old); assert.equal(c.operations.size, 0);
  assert.equal((await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length, 0);
});

async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'main-voice-operations-'));
  const handlers = new Map(), clients = [], children = [], quits = [];
  let window;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), getPath: () => root,
    quit() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; app.emit('before-quit', event); if (!event.prevented) quits.push(true); },
  });
  class Window extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, session: { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, setPermissionRequestHandler() {} }, setWindowOpenHandler() {} });
    }
    async loadFile(file) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href; }
  }
  class Controlled extends SidecarClient {
    constructor(config) {
      super({ ...config, command: process.execPath, args: [path.join(__dirname, 'fixtures/main-voice-operation-child.cjs')], env: { MAIN_FIXTURE_ROOT: root }, stopGraceMs: 40, stopKillWaitMs: 100 });
      clients.push(this);
      let child;
      Object.defineProperty(this, 'process', { get: () => child, set(value) { child = value; if (value) children.push(value); } });
    }
  }
  const context = vm.createContext({ require: name => name === 'electron' ? { app, BrowserWindow: Window, ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, safeStorage: {}, shell: {} }
    : name === './sidecar-client.cjs' ? { SidecarClient: Controlled }
    : name === 'node:fs/promises' ? { ...fs, ...options.fs } : realRequire(name),
    __dirname: path.dirname(mainPath), Buffer, URL, setTimeout, clearTimeout, process: { ...process, argv: [], env: {} }, console,
  });
  vm.runInContext(`${await fs.readFile(mainPath, 'utf8')}\nglobalThis.api = { startRuntime, createWindow, registerIpc, voiceOperations, stopOwnedClient, shutdownPending: () => !!shutdownPromise };`, context, { filename: mainPath });
  t.after(async () => {
    options.release?.();
    for (const c of clients) { try { await c.stop(); } catch {} }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await until(() => child.exitCode !== null || child.signalCode !== null);
      await until(() => { try { process.kill(child.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    }
    console.log(`OWNED_NODE_PIDS_REAPED:${children.map(c => c.pid).join(',')}`);
    await fs.rm(root, { recursive: true, force: true });
  });
  await context.api.startRuntime(); await context.api.createWindow(); context.api.registerIpc();
  const invoke = (channel, payload) => handlers.get(channel)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, payload);
  return { root, clients, children, app, quits, window, invoke, handlers, ledger: context.api.voiceOperations, stopOwnedClient: context.api.stopOwnedClient, shutdownPending: context.api.shutdownPending };
}

test('registered Main held STT write is fenced by immediate batch revoke without late request', { timeout: 6000 }, async t => {
  const hold = gate(); let entered = false;
  const h = await harness(t, { release: hold.release, fs: { writeFile: async (...args) => { entered = true; await hold.promise; return fs.writeFile(...args); } } });
  assert.equal(typeof h.handlers.get('voice:operation-state'), 'function');
  const work = h.invoke('voice:stt', { requestId: 'held', buffer: Buffer.from('held'), mimeType: 'audio/wav' });
  const settled = Promise.resolve(work);
  await until(() => entered);
  const before = await h.invoke('voice:operation-state', state('held'));
  assert.equal(before.logical, 'preparing');
  const ack = await h.invoke('voice:operation-revoke', revoke(['held', 'before-admission']));
  assert.equal(ack.type, 'revoked');
  await assert.rejects(async () => h.invoke('voice:tts', { requestId: 'before-admission', text: 'late' }), /REUSED/);
  hold.release();
  const reply = await settled;
  assert.equal(reply.type, 'failure'); assert.equal(reply.completion, null);
  assert.deepEqual(normalize(reply), reply);
  await until(async () => (await fs.readdir(path.join(h.root, 'voice-practice-runtime'))).length === 0);
  await assert.rejects(fs.stat(path.join(h.root, 'requests')), { code: 'ENOENT' });
  assert.equal(h.children.length, 1);
  h.app.quit(); await until(() => h.quits.length === 1);
});