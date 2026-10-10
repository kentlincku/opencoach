const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceOperationLedger } = require('../apps/desktop/voice-operation-ledger.cjs');
const { normalize } = require('../apps/web/runtime/desktop-voice-operation-contract.js');
const observe = requestId => ({ version: 1, type: 'observe', requestId });
const revoke = requestIds => ({ version: 1, type: 'revoke', requestIds });
test('batch fencing precedes every reentrant cancellation; quota also fences work outside batch', async () => {
  const ledger = new VoiceOperationLedger(), owner = {}, other = {}, native = client();
  const records = Array.from({ length: 32 }, (_, i) => ledger.admit(owner, `id${i}`, native, () => true));
  let secondGateDuringCancel;
  records[0].operation.cancel = () => {
    secondGateDuringCancel = records[1].operation.gate();
    throw new Error('CONTROLLED_CANCEL_THROW');
  };
  assert.deepEqual(ledger.revoke(owner, revoke(['id0', 'id1', 'late', 'id1'])).requestIds, ['id0', 'id1', 'late']);
  assert.equal(secondGateDuringCancel, false, 'whole batch marked first; assertion outside isolated callback');
  assert.equal(records[1].operation.cancels, 1, 'throw cannot omit remaining cancellation');
  assert.equal(records[2].operation.gate(), false, 'fault also blocks batch-excluded preparation');
  assert.equal(ledger.observe(owner, observe('late')).knowledge, 'retired');
  assert.equal(ledger.observe(other, observe('late')).knowledge, 'unknown');
  assert.throws(() => ledger.admit(owner, 'late', native, () => true), /REUSED|CLOSED/);
  const q = new VoiceOperationLedger(), qn = client(), qo = {};
  const pending = q.admit(qo, 'pending', qn, () => true);
  for (let i = 0; i < 1023; i++) q.revoke(qo, revoke([`dead${i}`]));
  assert.throws(() => q.revoke(qo, revoke(['overflow'])), /QUOTA_EXCEEDED/);
  assert.equal(pending.operation.gate(), false, 'quota has no emergency bypass');
  assert.throws(() => q.admit({}, 'fresh', qn, () => true), /CLOSED/);
  const slots = new VoiceOperationLedger(), sn = client(), so = {};
  for (let i = 0; i < 32; i++) slots.admit(so, `active${i}`, sn, () => true);
  assert.throws(() => slots.admit(so, 'overflow', sn, () => true), /QUOTA_EXCEEDED/);
  assert.equal(sn.handles.length, 32);
  const lifetime = new VoiceOperationLedger();
  for (let o = 0; o < 4; o++) {
    const token = {};
    for (let i = 0; i < 1024; i++) lifetime.revoke(token, revoke([`t${i}`]));
  }
  assert.throws(() => lifetime.revoke({}, revoke(['overflow'])), /QUOTA_EXCEEDED/);
  assert.throws(() => ledger.revoke(owner, revoke(Array(33).fill('same'))), /INVALID/);
});
test('original correlated backend failure copies out normalized proof before record retirement', () => {
  const ledger = new VoiceOperationLedger(), owner = {}, native = client();
  const record = ledger.admit(owner, 'failure', native, () => true);
  ledger.preparing(record);
  const binding = { clientId: 'client', intentId: 'intent', generation: 'original-uuid' };
  ledger.receipt(record, { status: 'running', binding, nativeRequestId: 'request-uuid', terminal: null });
  ledger.receipt(record, { status: 'completed', binding, nativeRequestId: 'request-uuid', terminal: { ...binding, nativeRequestId: 'request-uuid', success: false } });
  const reply = ledger.finish(record, { error: true, released: true });
  assert.equal(reply.type, 'failure');
  assert.equal(reply.code, 'backend-error');
  assert.equal(reply.completion.receipt.status, 'completed');
  assert.equal(reply.binding.generation, 1);
  assert.deepEqual(normalize(reply), reply);
  assert.equal(ledger.observe(owner, observe('failure')).knowledge, 'retired');
  assert.equal(record.operation.gate(), false);
  assert.equal(reply.completion.cleanup, 'released');
  assert.throws(() => ledger.admit(owner, 'failure', native, () => true), /REUSED/);
  const transport = ledger.admit(owner, 'transport', native, () => true);
  ledger.preparing(transport);
  ledger.receipt(transport, { status: 'running', binding, nativeRequestId: 'transport-uuid', terminal: null });
  const uncertain = ledger.finish(transport, { error: true, released: false });
  assert.equal(uncertain.completion, null, 'promise rejection cannot prove terminal completion');
  assert.equal(ledger.observe(owner, observe('transport')).knowledge, 'known');
});
test('concurrently retained original generations reuse stable bounded counters', () => {
  const ledger = new VoiceOperationLedger(), native = client(), owner = {};
  const a = ledger.admit(owner, 'a', native, () => true);
  const b = ledger.admit(owner, 'b', native, () => true);
  const lateA = ledger.admit(owner, 'late-a', native, () => true);
  const receipt = generation => ({ status: 'running', binding: { clientId: 'client', intentId: 'intent', generation }, nativeRequestId: 'request', terminal: null });
  ledger.receipt(a, receipt('generation-a'));
  ledger.receipt(b, receipt('generation-b'));
  ledger.receipt(lateA, receipt('generation-a'));
  assert.equal(lateA.state.receipt.binding.generation, a.state.receipt.binding.generation);
  assert.notEqual(b.state.receipt.binding.generation, a.state.receipt.binding.generation);
  assert.equal(ledger.generation, 2, 'retained original UUID reuse cannot allocate');
});
test('identical producer receipts are revision-idempotent even at overflow boundary', () => {
  const ledger = new VoiceOperationLedger(), owner = {}, native = client();
  const record = ledger.admit(owner, 'revision', native, () => true);
  const outside = ledger.admit(owner, 'outside', native, () => true);
  const original = { status: 'running', binding: { clientId: 'client', intentId: 'intent', generation: 'generation' }, nativeRequestId: 'uuid', terminal: null };
  ledger.receipt(record, original);
  const revision = record.state.revision;
  ledger.receipt(record, structuredClone(original));
  assert.equal(record.state.revision, revision, 'identical producer state is not a transition');
  record.state.revision = 2147483647;
  ledger.receipt(record, structuredClone(original));
  assert.equal(ledger.fault, null);
  assert.throws(() => ledger.receipt(record, { ...original, status: 'stopping' }), /QUOTA_EXCEEDED/);
  assert.equal(outside.operation.gate(), false, 'overflow synchronously fences already admitted outside work');
  assert.equal(record.state.revision, 2147483647);
});
test('global full records stay bounded at 128 independently of 32 per owner', () => {
  const ledger = new VoiceOperationLedger(), native = client();
  const retained = [];
  for (let n = 0; n < 4; n++) {
    const owner = {};
    for (let i = 0; i < 32; i++) retained.push(ledger.admit(owner, `id-${i}`, native, () => true));
  }
  assert.throws(() => ledger.admit({}, 'overflow', native, () => true), /QUOTA_EXCEEDED/);
  assert.equal(native.handles.length, 128);
  assert.equal(retained.every(record => !record.operation.gate()), true);
});
test('MATRIX retained UUID mapping is client-isolated, retirement-stable and fail-closed at overflow', () => {
  const ledger = new VoiceOperationLedger(), owner = {}, a = client(), b = client();
  const receipt = (clientId, generation, status = 'running') => ({ status,
    binding: { clientId, intentId: 'intent', generation }, nativeRequestId: 'request', terminal: null });
  const first = ledger.admit(owner, 'first', a, () => true);
  const next = ledger.admit(owner, 'next', a, () => true);
  const other = ledger.admit(owner, 'other', b, () => true);
  const retained = ledger.admit(owner, 'retained', a, () => true);
  ledger.producer(first, receipt('a', 'same-uuid'));
  ledger.producer(next, receipt('a', 'next-uuid'));
  ledger.producer(other, receipt('b', 'same-uuid'));
  ledger.producer(retained, receipt('a', 'same-uuid'));
  assert.equal(retained.state.receipt.binding.generation, first.state.receipt.binding.generation);
  assert.notEqual(other.state.receipt.binding.generation, first.state.receipt.binding.generation);
  assert.equal(ledger.generation, 3);
  ledger.producer(first, receipt('a', 'same-uuid', 'confirmed'));
  ledger.finish(first, { error: true, released: true });
  const retiredState = structuredClone(first.state);
  ledger.producer(first, receipt('a', 'stale-uuid', 'unconfirmed'));
  assert.deepEqual(first.state, retiredState); assert.equal(ledger.fault, null);
  assert.equal(ledger.observe(owner, observe('first')).knowledge, 'retired');
  assert.throws(() => ledger.admit(owner, 'first', a, () => true), /REUSED/);
  const late = ledger.admit(owner, 'late', a, () => true), overflow = ledger.admit(owner, 'overflow', b, () => true);
  ledger.generation = 2147483647;
  ledger.producer(late, receipt('a', 'same-uuid'));
  assert.equal(late.state.receipt.binding.generation, retained.state.receipt.binding.generation, 'another retained full record anchors retired generation');
  assert.equal(ledger.fault, null);
  const before = ledger.observe(owner, observe('overflow')), mapping = ledger.generations.get(b);
  ledger.producer(overflow, receipt('b', 'new-uuid'));
  assert.equal(ledger.fault, 'quota-exceeded'); assert.equal(ledger.generation, 2147483647);
  assert.equal(ledger.generations.get(b), mapping); assert.deepEqual(ledger.observe(owner, observe('overflow')), before);
  assert.equal(ledger.allowed(late), false); assert.ok(overflow.producerError);
  assert.deepEqual(normalize(ledger.producerFailureReply(overflow)), ledger.producerFailureReply(overflow));
  assert.equal(ledger.producerFailureReply(overflow).completion, null);
});

for (const trigger of ['sync', 'async', 'quota']) test(`C6B-IND02 ${trigger} fault fanout isolates throwing delivery and cancels every fenced member`, async () => {
  const ledger = new VoiceOperationLedger(), owner = {}, native = client();
  const records = ['a', 'b', 'outside'].map(id => ledger.admit(owner, id, native, () => true));
  const seen = [], delivered = [];
  records[0].failReply = () => { seen.push(records.slice(0, 2).map(r => r.state.revocation)); throw Error('DELIVERY_THROW'); };
  records[1].failReply = () => delivered.push('b');
  records[2].failReply = () => delivered.push('outside');
  if (trigger === 'quota') {
    for (let i = 0; i < 1021; i++) ledger.revoke(owner, revoke([`retired-${i}`]));
  } else records[0].operation.cancel = () => {
    if (trigger === 'sync') throw Error('CANCEL_THROW');
    return Promise.reject(Error('CANCEL_REJECT'));
  };
  if (trigger === 'quota') assert.throws(() => ledger.revoke(owner, revoke(['a', 'b', 'overflow'])), /QUOTA_EXCEEDED/);
  else assert.doesNotThrow(() => ledger.revoke(owner, revoke(['a', 'b'])));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(records[1].operation.cancels, 1);
  assert.ok(seen.length && seen.every(batch => batch.every(v => v === 'revoked')));
  assert.ok(delivered.includes('b')); assert.ok(delivered.includes('outside'));
  assert.equal(records[2].operation.cancels, 0, 'logical fanout does not invent native confirmation');
});

function client() {
  const handles = [];
  return { handles, createOperation(gate) {
    const handle = { gate, cancels: 0, snapshot: () => ({ status: 'not-dispatched', binding: null, nativeRequestId: null, terminal: null }), cancel() { this.cancels++; return Promise.resolve(this.snapshot()); } };
    handles.push(handle); return handle;
  } };
}
test('admission fixes owner and permit; observation is detached and does not allocate or cancel', () => {
  const ledger = new VoiceOperationLedger();
  const owner = {}, other = {}, native = client();
  assert.equal(ledger.observe(owner, observe('one')).knowledge, 'unknown');
  const record = ledger.admit(owner, 'one', native, () => true);
  const state = ledger.observe(owner, observe('one'));
  assert.deepEqual(normalize(state), state);
  assert.equal(state.logical, 'accepted');
  state.revocation = 'revoked';
  for (let i = 0; i < 50; i++) assert.equal(ledger.observe(owner, observe('one')).revision, 1);
  assert.equal(ledger.observe(other, observe('one')).knowledge, 'unknown');
  assert.equal(native.handles.length, 1);
  assert.equal(native.handles[0].cancels, 0);
  assert.equal(record.operation, native.handles[0]);
  assert.equal(record.operation.gate(), true);
  assert.throws(() => ledger.admit(owner, 'one', native, () => true), /REUSED/);
  assert.throws(() => ledger.observe(owner, { version: 1, type: 'revoke', requestIds: ['one'] }), /COMMAND/);
});
