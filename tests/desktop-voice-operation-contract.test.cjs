'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.resolve(__dirname, '../apps/web/runtime/desktop-voice-operation-contract.js');
const contract = fs.existsSync(modulePath) ? require(modulePath) : {};
const observe = (requestId = 'op-1') => ({ version: 1, type: 'observe', requestId });
const invalid = value => assert.throws(() => contract.normalize(value), { message: 'INVALID_VOICE_OPERATION_CONTRACT' });

test('batch revoke snapshots all bounded IDs, deduplicates in order; legacy is one explicit ID', () => {
  for (const type of ['revoke', 'revoked']) {
    const input = { version: 1, type, requestIds: ['a', 'b', 'a'] };
    const output = contract.normalize(input);
    assert.deepEqual(output, { version: 1, type, requestIds: ['a', 'b'] });
    assert.deepEqual(input.requestIds, ['a', 'b', 'a']);
    assert.deepEqual(contract.normalize(JSON.parse(JSON.stringify(output))), output);
    for (const requestIds of [[], new Array(1), ['a', 1], [''], Array(33).fill('a'), 'a', { 0: 'a', length: 1 }]) invalid({ version: 1, type, requestIds });
    const max = Array.from({ length: 32 }, (_, i) => String(i).padEnd(96, 'x'));
    assert.equal(contract.normalize({ version: 1, type, requestIds: max }).requestIds.length, 32);
    const extra = ['a']; extra.other = 'b'; invalid({ version: 1, type, requestIds: extra });
    let reads = 0; const getter = []; Object.defineProperty(getter, '0', { enumerable: true, get() { reads++; return 'a'; } });
    invalid({ version: 1, type, requestIds: getter }); assert.equal(reads, 0);
  }
  assert.deepEqual(contract.normalizeLegacyCancel({ requestId: 'old-1' }), { version: 1, type: 'revoke', requestIds: ['old-1'] });
  for (const input of [undefined, {}, 'old-1', { requestId: '' }, { requestId: 'a', pid: 4 }, Object.create({ requestId: 'a' })]) {
    assert.throws(() => contract.normalizeLegacyCancel(input), { message: 'INVALID_VOICE_OPERATION_CONTRACT' });
  }
});

const failureCodes = ['backend-error', 'termination-unconfirmed', 'cleanup-failed', 'admission-closed', 'quota-exceeded'];
const details = code => ({ code, message: 'Voice operation failed' });
const binding = generation => ({ clientId: 'client-1', intentId: 'intent-1', generation });
const state = () => ({ version: 1, type: 'state', requestId: 'op-1', knowledge: 'known', revision: 1, logical: 'accepted', revocation: 'live', receipt: { status: 'not-dispatched', binding: null }, cleanup: 'pending', failure: null });
function stateCorpus() {
  const cases = [];
  for (const logical of ['accepted', 'preparing', 'dispatched', 'settled'])
    for (const status of ['not-dispatched', 'starting', 'running', 'completed', 'stopping', 'confirmed', 'unconfirmed'])
      for (const cleanup of ['pending', 'retained', 'released'])
        for (const revocation of ['live', 'revoked'])
          for (const code of [null, 'backend-error', 'termination-unconfirmed', 'cleanup-failed'])
            for (const generation of [null, 1]) {
              const value = { ...state(), logical, cleanup, revocation, receipt: { status, binding: status === 'not-dispatched' ? null : binding(generation) }, failure: code && details(code) };
              const logicalReceipts = { accepted: ['not-dispatched'], preparing: ['not-dispatched', 'starting', 'stopping', 'confirmed', 'unconfirmed'], dispatched: ['running', 'stopping', 'confirmed', 'unconfirmed'], settled: ['not-dispatched', 'running', 'completed', 'stopping', 'confirmed', 'unconfirmed'] };
              const valid = logicalReceipts[logical].includes(status)
                && !(['running', 'completed'].includes(status) && generation === null)
                && !(logical === 'dispatched' && generation === null)
                && !(code && logical !== 'settled')
                && ((status === 'unconfirmed') === (code === 'termination-unconfirmed'))
                && !(code === 'cleanup-failed' && cleanup !== 'retained')
                && !(cleanup === 'retained' && !['stopping', 'unconfirmed'].includes(status) && code !== 'cleanup-failed')
                && !(cleanup === 'released' && (logical !== 'settled' || !['not-dispatched', 'completed', 'confirmed'].includes(status)));
              cases.push({ value, valid });
            }
  return cases;
}

test('observation DTO keeps knowledge, logical, receipt, cleanup and operational failure independent', t => {
  for (const knowledge of ['unknown', 'retired']) {
    const value = { version: 1, type: 'state', requestId: 'a', knowledge };
    assert.deepEqual(contract.normalize(value), value);
    invalid({ ...value, receipt: { status: 'confirmed', binding: null } });
  }
  for (const code of failureCodes) {
    const value = { version: 1, type: 'failure', binding: null, completion: null, requestId: 'a', ...details(code) };
    assert.deepEqual(contract.normalize(JSON.parse(JSON.stringify(value))), value);
  }
  const messageOnly = new Error('Electron retained only this message');
  invalid(messageOnly); // no inference from Error.code/cause or message text
  for (const message of ['', '\n', 'é', 'x'.repeat(257), { toString() { throw Error('coercion'); } }]) invalid({ version: 1, type: 'failure', binding: null, completion: null, requestId: 'a', code: 'backend-error', message });
  invalid({ version: 1, type: 'failure', binding: null, completion: null, requestId: 'a', code: 'toString', message: 'x' });
  const maxMessage = { version: 1, type: 'failure', binding: null, completion: null, requestId: 'a', code: 'backend-error', message: 'x'.repeat(256) };
  assert.deepEqual(contract.normalize(maxMessage), maxMessage);
  const corpus = stateCorpus();
  for (const { value, valid } of corpus) {
    if (valid) {
      const output = contract.normalize(value);
      assert.deepEqual(output, value);
      assert.notEqual(output.receipt, value.receipt);
      if (value.receipt.binding) assert.notEqual(output.receipt.binding, value.receipt.binding);
      if (value.failure) assert.notEqual(output.failure, value.failure);
      assert.deepEqual(contract.normalize(JSON.parse(JSON.stringify(output))), output);
    } else invalid(value);
  }
  t.diagnostic(`state validity corpus: ${corpus.length} cases, ${corpus.filter(x => x.valid).length} valid`);
  for (const field of ['knowledge', 'logical', 'revocation', 'cleanup']) invalid({ ...state(), [field]: 'toString' });
  for (const revision of [0, -1, 1.5, '1', NaN, Infinity, 2147483648]) invalid({ ...state(), revision });
  assert.equal(contract.normalize({ ...state(), revision: 2147483647 }).revision, 2147483647);
  const running = { ...state(), logical: 'dispatched', receipt: { status: 'running', binding: binding(1) } };
  for (const generation of [0, -1, 1.5, '1', Infinity, 2147483648]) invalid({ ...running, receipt: { status: 'running', binding: binding(generation) } });
  invalid({ ...state(), receipt: { status: 'not-dispatched', binding: binding(1) } });
  invalid({ ...running, receipt: { status: 'running', binding: null } });
  invalid({ ...running, receipt: { status: 'running', binding: { ...binding(1), pid: 123 } } });
  invalid({ ...running, receipt: { ...running.receipt, extra: 1 } });
  let reads = 0;
  const receipt = { get status() { reads++; return 'not-dispatched'; }, binding: null };
  invalid({ ...state(), receipt }); assert.equal(reads, 0);
  invalid({ ...state(), failure: Object.create(details('backend-error')) });
});

test('JSON Schema agrees with pure validation for the dimensional corpus and wire boundaries', t => {
  const schemaPath = path.resolve(__dirname, '../contracts/desktop-voice-operation.schema.json');
  assert.equal(fs.existsSync(schemaPath), true, 'versioned wire schema must exist');
  const Ajv = require('ajv'); // existing lockfile dependency, no added dependency
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false });
  const validate = ajv.compile(schema);
  const corpus = stateCorpus();
  for (const value of [observe(), { version: 1, type: 'revoke', requestIds: ['a', 'a'] }, { version: 1, type: 'revoked', requestIds: ['a'] }, ...['unknown', 'retired'].map(knowledge => ({ version: 1, type: 'state', requestId: 'a', knowledge })), ...failureCodes.map(code => ({ version: 1, type: 'failure', binding: null, completion: null, requestId: 'a', ...details(code) }))]) corpus.push({ value, valid: true });
  const seeds = corpus.filter(x => x.valid).map(x => x.value);
  for (const seed of seeds) {
    for (const key of Object.keys(seed)) {
      const missing = { ...seed }; delete missing[key]; corpus.push({ value: missing, valid: false });
      corpus.push({ value: { ...seed, [key]: [null] }, valid: false });
    }
    corpus.push({ value: { ...seed, unexpected: 1 }, valid: false });
  }
  for (const requestId of ['', 'a\n', 'é', 'x'.repeat(97), 42, '__proto__']) corpus.push({ value: observe(requestId), valid: false });
  for (const requestIds of [[], ['a', 1], Array(33).fill('a')]) corpus.push({ value: { version: 1, type: 'revoke', requestIds }, valid: false });
  const max = Array.from({ length: 32 }, (_, i) => String(i).padEnd(96, 'x'));
  corpus.push({ value: { version: 1, type: 'revoke', requestIds: max }, valid: true });
  const safe = { ...state(), logical: 'settled', receipt: { status: 'confirmed', binding: binding(1) }, cleanup: 'released' };
  for (const generation of [0, -1, 1.5, '1', 2147483648]) corpus.push({ value: { ...safe, receipt: { status: 'confirmed', binding: binding(generation) } }, valid: false });
  for (const code of ['toString', '', 1]) corpus.push({ value: { ...safe, cleanup: 'pending', failure: details(code) }, valid: false });
  for (const message of ['', '\n', 'é', 'x'.repeat(257)]) corpus.push({ value: { version: 1, type: 'failure', binding: null, completion: null, requestId: 'a', code: 'backend-error', message }, valid: false });
  corpus.push({ value: { version: 1, type: 'failure', binding: null, completion: null, requestId: 'a', code: 'backend-error', message: 'x'.repeat(256) }, valid: true });
  for (const { value, valid } of corpus) {
    const wire = JSON.parse(JSON.stringify(value));
    assert.equal(validate(wire), valid, JSON.stringify({ wire, errors: validate.errors }));
    if (valid) assert.equal(validate(contract.normalize(wire)), true);
    else invalid(wire);
  }
  const legacy = ajv.compile({ $ref: schema.$id + '#/definitions/legacyCancel' });
  assert.equal(legacy({ requestId: 'a' }), true);
  for (const value of [{}, { requestId: '' }, { requestId: 'a', pid: 1 }]) assert.equal(legacy(value), false);
  t.diagnostic(`schema/pure JSON corpus: ${corpus.length} cases; Ajv ${require('ajv/package.json').version}`);
});

test('UMD browser and AMD exports normalize without host capabilities', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(modulePath, 'utf8');
  const browser = vm.createContext({}); vm.runInContext(source, browser);
  assert.equal(vm.runInContext('JSON.stringify(DesktopVoiceOperationContract.normalize({version:1,type:"observe",requestId:"a"}))', browser), JSON.stringify(observe('a')));
  const amd = vm.createContext({});
  vm.runInContext('function define(deps, factory) { globalThis.api = factory(); } define.amd = true;', amd);
  vm.runInContext(source, amd);
  assert.equal(vm.runInContext('JSON.stringify(api.normalizeLegacyCancel({requestId:"a"}))', amd), JSON.stringify({ version: 1, type: 'revoke', requestIds: ['a'] }));
});

// Execute published Sidecar code; only OS/stream/timer boundaries are in-memory.
// Wire generation 1 maps the actual randomUUID value, never the fixture PID.
function sidecarFixture(beforeSpawn) {
  const { EventEmitter } = require('node:events');
  const vm = require('node:vm');
  const children = [], writes = [], timers = new Map(); let timerId = 0;
  const lines = new EventEmitter(); lines.close = () => {};
  const spawn = () => {
    const child = new EventEmitter(); Object.assign(child, { pid: 100, exitCode: null, signalCode: null });
    child.stdin = new EventEmitter(); child.stdin.writable = true; child.stdin.end = () => {};
    child.stdin.write = (data, callback) => { writes.push(JSON.parse(data)); callback?.(); };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { child.signalCode = signal; child.emit('exit', null, signal); return true; };
    children.push(child); return child;
  };
  const context = { module: { exports: {} }, require: name => {
    if (name === 'node:child_process') return { spawn };
    if (name === 'node:readline') return { createInterface: () => lines };
    return require(name);
  }, process: { platform: 'linux', env: {} }, console,
  setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../apps/desktop/sidecar-client.cjs'), 'utf8'), context);
  return { client: new context.module.exports.SidecarClient({ command: 'memory-only', beforeSpawn }), children, writes, lines, timers };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const wireValidate = () => new (require('ajv'))({ strict: false, coerceTypes: false }).compile(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../contracts/desktop-voice-operation.schema.json'), 'utf8')));

test('C6-IND-01 actual Sidecar traces: beforeSpawn, waiting/reused child, ready-before-request and cancel', async t => {
  const validate = wireValidate(); let checkpoints = 0;
  function check(label, value) {
    assert.equal(validate(value), true, label + ': schema');
    assert.deepEqual(contract.normalize(value), value, label + ': pure'); checkpoints++;
  }
  for (const phase of ['beforeSpawn', 'waiting-ready', 'reused-waiting', 'ready-before-request']) {
    let release;
    const f = sidecarFixture(() => new Promise(resolve => { release = resolve; }));
    const originalIntent = f.client.startIntent;
    const starts = [f.client.start().then(() => 'ready', e => e.message)];
    await tick();
    assert.equal(f.children.length, 0); assert.equal(f.client.processGeneration, null);
    const before = { ...state(), logical: 'preparing', receipt: { status: 'starting', binding: binding(null) } };
    check(phase + ': validator pending', before);
    let generation = null, uuid = null;
    if (phase !== 'beforeSpawn') {
      release(true); await tick();
      uuid = f.client.processGeneration;
      assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f-]{27}$/); generation = 1;
      assert.equal(f.children.length, 1); assert.equal(f.client.startIntent, originalIntent);
      if (phase === 'reused-waiting') { starts.push(f.client.start().then(() => 'ready', e => e.message)); await tick(); }
      let settled = false; starts[0].then(() => { settled = true; }); await tick();
      assert.equal(settled, false); assert.equal(f.client.pending.size, 0); assert.equal(f.writes.length, 0);
      const waiting = { ...before, receipt: { status: 'starting', binding: binding(generation) } };
      check(phase + ': spawned but not dispatched', waiting);
      invalid({ ...waiting, receipt: { status: 'running', binding: binding(generation) } });
      invalid({ ...waiting, logical: 'dispatched' });
      if (phase === 'ready-before-request') {
        f.lines.emit('line', JSON.stringify({ event: 'ready' })); assert.equal(await starts[0], 'ready');
        await f.client.start(); // already-ready persistent child is reused without another spawn
        assert.equal(f.children.length, 1); assert.equal(f.writes.length, 0);
        check('ready is not request dispatch', waiting);
      }
    }
    const stop = f.client.cancel();
    assert.ok(originalIntent.error); assert.notEqual(f.client.startIntent, originalIntent);
    check(phase + ': cancellation owns original receipt', { ...before, logical: 'settled', revocation: 'revoked', cleanup: 'retained', receipt: { status: 'stopping', binding: binding(generation) } });
    if (phase === 'beforeSpawn') release(true);
    await stop;
    check(phase + ': original barrier drained', { ...before, logical: 'settled', revocation: 'revoked', cleanup: 'released', receipt: { status: 'confirmed', binding: binding(generation) } });
    const results = await Promise.all(starts);
    assert.ok(results.every(x => x === (phase === 'ready-before-request' ? 'ready' : 'VOICE_RUNTIME_CANCELLED')));
    assert.equal(f.writes.length, 0); assert.equal(f.client.pending.size, 0);
    t.diagnostic(JSON.stringify({ phase, actualSourceGenerationUUID: uuid, wireGeneration: generation, spawnedFixtures: f.children.length, nativeWrites: f.writes.length, realChild: false }));
  }
  t.diagnostic(`source-derived P1 checkpoints: ${checkpoints}; no ledger/permit wiring proved`);
});

const clone = value => JSON.parse(JSON.stringify(value));
const fallbackContext = () => ({ requestId: 'op-1', epoch: 1, currentEpoch: 1, stopped: false, ownerValid: true, admissionValid: true, domainFault: false, transportUncertain: false });
const completedFailure = () => {
  const completion = { ...state(), logical: 'settled', receipt: { status: 'completed', binding: binding(1) }, cleanup: 'released', failure: details('backend-error') };
  return { version: 1, type: 'failure', requestId: completion.requestId, ...completion.failure, binding: binding(1), completion };
};

test('C6-IND-02 actual correlated backend response travels with evidence before observer retirement', async t => {
  const f = sidecarFixture(); const start = f.client.start(); await tick();
  f.lines.emit('line', JSON.stringify({ event: 'ready' })); await start;
  const uuid = f.client.processGeneration, intent = f.client.startIntent;
  let settled = false;
  const operation = f.client.request('tts', {}).then(() => { throw Error('unexpected success'); }, error => { settled = true; return error; });
  await tick(); assert.equal(f.writes.length, 1); assert.equal(f.client.pending.size, 1);
  const nativeId = f.writes[0].id;
  f.lines.emit('line', JSON.stringify({ id: 'unrelated', success: false, error: { code: 'BACKEND', message: 'Voice operation failed' } }));
  await tick(); assert.equal(settled, false); assert.equal(f.client.pending.size, 1);
  f.lines.emit('line', JSON.stringify({ id: nativeId, success: false, error: { code: 'BACKEND', message: 'Voice operation failed' } }));
  const error = await operation;
  assert.equal(error.code, 'BACKEND'); assert.equal(f.client.pending.size, 0);
  assert.equal(f.client.processGeneration, uuid); assert.equal(f.client.startIntent, intent); assert.ok(f.client.process);
  // Normative Main mapping: pending native UUID -> op-1 and captured client/intent/generation.
  // This constructs the proposed DTO, not a claim that existing Main already emits it.
  const result = completedFailure(); result.message = result.completion.failure.message = error.message;
  const validate = wireValidate(); assert.equal(validate(result), true);
  const delivery = contract.normalize(result); // detached into original operational reply BEFORE compaction
  result.completion.receipt.binding.generation = 2; result.completion.failure.message = 'mutated ledger';
  const retired = contract.normalize({ version: 1, type: 'state', requestId: 'op-1', knowledge: 'retired' });
  assert.equal(contract.canFallback(retired, fallbackContext()), false);
  assert.equal(contract.canFallback({ ...retired, knowledge: 'unknown' }, fallbackContext()), false);
  assert.equal(contract.canFallback({ ...delivery, completion: null }, fallbackContext()), false);
  assert.equal(contract.canFallback(delivery, fallbackContext()), true, 'retired observer cannot erase delivered original evidence');
  for (const change of [{ stopped: true }, { currentEpoch: 2 }, { domainFault: true }, { ownerValid: false }, { admissionValid: false }, { transportUncertain: true }, { requestId: 'other' }]) {
    assert.equal(contract.canFallback(delivery, { ...fallbackContext(), ...change }), false, JSON.stringify(change));
  }
  await f.client.cancel();
  t.diagnostic(JSON.stringify({ nativeId, actualSourceGenerationUUID: uuid, wireGeneration: 1, boundaryWrites: f.writes.length, realChild: false, retirement: 'normative DTO schedule, not ledger execution' }));
});

test('C6-IND-02 completion shape, correlation residuals, cleanup and strict own-data semantics', t => {
  const validate = wireValidate(); const good = completedFailure(); let cases = 0;
  function rejected(value, schemaExpected = false) {
    invalid(value); assert.equal(validate(clone(value)), schemaExpected, JSON.stringify(value)); cases++;
    assert.equal(contract.canFallback(value, fallbackContext()), false);
  }
  assert.deepEqual(contract.normalize(good), good); assert.equal(validate(good), true);
  for (const status of ['not-dispatched', 'confirmed']) {
    const value = clone(good); value.binding = status === 'not-dispatched' ? null : binding(null);
    value.completion.receipt = { status, binding: clone(value.binding) };
    assert.equal(validate(value), true); assert.equal(contract.canFallback(value, fallbackContext()), true);
  }
  for (const change of [{ logical: 'dispatched' }, { revocation: 'revoked' }, { knowledge: 'retired' }, { cleanup: 'pending' }, { cleanup: 'retained' }, { failure: null }, { type: 'failure' }, { version: 2 }]) {
    rejected({ ...good, completion: { ...good.completion, ...change } });
  }
  for (const status of ['starting', 'running', 'stopping', 'unconfirmed']) {
    const value = clone(good); value.completion.receipt.status = status;
    if (status === 'unconfirmed') { value.completion.failure = details('termination-unconfirmed'); value.completion.cleanup = 'retained'; }
    rejected(value);
  }
  for (const code of failureCodes.filter(x => x !== 'backend-error')) {
    rejected({ ...good, code });
    rejected({ ...good, completion: { ...good.completion, failure: details(code) } });
  }
  // Standard draft-07 cannot compare arbitrary sibling values; pure rejects these.
  for (const change of [{ requestId: 'other' }, { message: 'other' }, { binding: binding(2) }, { binding: { ...binding(1), clientId: 'other' } }, { binding: { ...binding(1), intentId: 'other' } }, { binding: null }]) rejected({ ...good, ...change }, true);
  for (const key of Object.keys(good)) { const value = clone(good); delete value[key]; rejected(value); }
  rejected({ ...good, completion: { ...good.completion, extra: true } });
  rejected({ ...good, binding: { ...binding(1), pid: 123 } });
  rejected({ ...good, completion: { ...good.completion, receipt: { status: 'completed', binding: binding(null) } } });
  let getterCalls = 0, strictCases = 0;
  for (const loc of [[], ['binding'], ['completion'], ['completion', 'receipt'], ['completion', 'receipt', 'binding'], ['completion', 'failure']]) {
    for (const kind of ['getter', 'setter', 'hidden', 'symbol', 'prototype', 'coercion']) {
      const value = clone(good); let obj = value; for (const key of loc) obj = obj[key];
      const key = Object.keys(obj)[0];
      if (kind === 'getter') Object.defineProperty(obj, key, { enumerable: true, get() { getterCalls++; return 1; } });
      if (kind === 'setter') Object.defineProperty(obj, key, { enumerable: true, set(_) { getterCalls++; } });
      if (kind === 'hidden') Object.defineProperty(obj, 'hidden', { value: 1 });
      if (kind === 'symbol') obj[Symbol('x')] = 1;
      if (kind === 'prototype') Object.setPrototypeOf(obj, null);
      if (kind === 'coercion') obj[key] = { toString() { getterCalls++; return '1'; } };
      invalid(value); assert.equal(contract.canFallback(value, fallbackContext()), false); strictCases++;
    }
  }
  for (const change of [{ epoch: '1' }, { currentEpoch: 0 }, { stopped: 0 }, { extra: 1 }, { get domainFault() { getterCalls++; return false; } }]) {
    // Preserve descriptors instead of object spread, which would invoke a test getter.
    const context = Object.defineProperties(fallbackContext(), Object.getOwnPropertyDescriptors(change));
    assert.equal(contract.canFallback(good, context), false); strictCases++;
  }
  assert.equal(getterCalls, 0);
  const output = contract.normalize(good); output.completion.receipt.binding.intentId = 'changed'; output.binding.generation = 2;
  assert.equal(good.binding.generation, 1); assert.equal(good.completion.receipt.binding.intentId, 'intent-1');
  t.diagnostic(`P2 invalid proof cases: ${cases} (6 documented JSON-schema correlation residuals); strict cases: ${strictCases}; getter/coercion calls: ${getterCalls}`);
});

test('observe is a detached strict versioned ID snapshot', () => {
  assert.equal(typeof contract.normalize, 'function');
  const input = observe();
  const output = contract.normalize(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.deepEqual(contract.normalize(JSON.parse(JSON.stringify(output))), output);
  for (const id of ['', ' x', 'x\n', 'x/y', 'é', 'x'.repeat(97), 1, null, new String('x'), { toString() { throw Error('coercion'); } }]) invalid(observe(id));
  assert.equal(contract.normalize(observe('a'.repeat(96))).requestId.length, 96);
  for (const input of [null, [], 'op-1', {}, { ...observe(), version: '1' }, { ...observe(), type: 'toString' }, { ...observe(), extra: 1 }, { ...observe(), pid: 1 }, { ...observe(), generation: 1 }]) invalid(input);
  for (const key of ['__proto__', 'constructor', 'prototype']) invalid(JSON.parse(`{"version":1,"type":"observe","requestId":"x","${key}":{}}`));
  let reads = 0;
  const inherited = Object.create({ get requestId() { reads++; throw Error('inherited'); } });
  Object.assign(inherited, { version: 1, type: 'observe' });
  invalid(inherited);
  const accessor = { ...observe(), get requestId() { reads++; return 'x'; } };
  invalid(accessor);
  assert.equal(reads, 0, 'accessors rejected without evaluation');
  invalid(Object.assign(Object.create(null), observe()));
  invalid({ ...observe(), [Symbol('hidden')]: 1 });
  const hidden = observe(); Object.defineProperty(hidden, 'extra', { value: 1 }); invalid(hidden);
  const counts = {};
  const proxy = new Proxy(observe(), { get() { throw Error('direct property read'); }, getOwnPropertyDescriptor(target, key) { counts[key] = (counts[key] || 0) + 1; return Reflect.getOwnPropertyDescriptor(target, key); } });
  assert.deepEqual(contract.normalize(proxy), observe());
  assert.deepEqual(counts, { version: 1, type: 1, requestId: 1 });
});
