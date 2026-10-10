const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../apps/desktop/preload.cjs'), 'utf8');
function sandbox() {
  const calls = [], required = [];
  const context = vm.createContext({ require(name) {
    required.push(name); assert.equal(name, 'electron', 'sandbox forbids relative/Node helper requires');
    return { contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'electronAPI'); context.api = api; } },
      ipcRenderer: { invoke(channel, payload) { calls.push({ channel, payload: structuredClone(payload) }); return Promise.resolve(null); } } };
  } });
  vm.runInContext(source, context);
  return { context, calls, required, run: code => vm.runInContext(code, context) };
}

test('sandboxed real preload loads with only Electron require; fixed typed channels snapshot IDs', async () => {
  const h = sandbox();
  assert.deepEqual(h.required, ['electron']);
  assert.equal(h.run('Object.isFrozen(api)'), true);
  assert.equal(h.run('typeof api.invoke'), 'undefined');
  await h.run(`api.voiceOperationState({ version: 1, type: 'observe', requestId: 'op:1' })`);
  await h.run(`const ids = ['op:1','op:2','op:1']; api.voiceOperationRevoke({version:1,type:'revoke',requestIds:ids}); ids[0]='changed'`);
  assert.deepEqual(h.calls, [
    { channel: 'voice:operation-state', payload: { version: 1, type: 'observe', requestId: 'op:1' } },
    { channel: 'voice:operation-revoke', payload: { version: 1, type: 'revoke', requestIds: ['op:1', 'op:2'] } },
  ]);
  await h.run(`api.transcribeAudio({requestId:'op:3', buffer:'bytes'}); api.synthKokoro({requestId:'op:4',text:'hello'})`);
  assert.equal(h.calls[2].payload.requestId, 'op:3');
  assert.equal(h.calls[3].payload.requestId, 'op:4');
});

test('strict own ID: invalid/inherited/getter IDs never become no-ID legacy IPC or invoke getters', () => {
  const h = sandbox();
  h.run('globalThis.getters = 0');
  const bad = [
    `({requestId:''})`, `({requestId:null})`, `({requestId:1})`, `({requestId:'bad/id'})`, `({requestId:'a'.repeat(97)})`,
    `Object.create({requestId:'inherited'})`, `({get requestId(){getters++;return 'getter'}})`,
    `Object.defineProperty({},'requestId',{value:'hidden'})`,
    `({requestId:{toString(){getters++;return 'coerced'}}})`,
  ];
  for (const method of ['transcribeAudio', 'synthKokoro']) for (const value of bad) {
    assert.throws(() => h.run(`api.${method}(${value})`), /INVALID_VOICE_OPERATION_CONTRACT/, method + value);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.run('getters'), 0);
});

test('commands reject extra keys, inherited/symbol/accessor fields and malformed arrays with zero getter/IPC effects', () => {
  const h = sandbox(); h.run('globalThis.getters = 0');
  const commands = [
    `({version:1,type:'observe',requestId:'a',channel:'voice:tts'})`,
    `({version:1,type:'revoke',requestId:'a'})`,
    `Object.create({version:1,type:'observe',requestId:'a'})`,
    `({version:2,type:'observe',requestId:'a'})`,
    `({version:1,type:'observe',get requestId(){getters++;return 'a'}})`,
    `({version:1,type:'observe',requestId:'a',[Symbol()]:1})`,
  ];
  for (const code of commands) assert.throws(() => h.run(`api.voiceOperationState(${code})`), /INVALID_VOICE_OPERATION_CONTRACT/);
  for (const ids of [`[]`, `new Array(2)`, `Array(33).fill('a')`, `['a',null]`,
    `Object.assign(['a'],{extra:1})`, `Object.defineProperty(['a'],'0',{get(){getters++;return 'a'}})`,
    `Object.assign(['a'],{[Symbol()]:1})`]) {
    assert.throws(() => h.run(`api.voiceOperationRevoke({version:1,type:'revoke',requestIds:${ids}})`), /INVALID_VOICE_OPERATION_CONTRACT/);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.run('getters'), 0);
});
