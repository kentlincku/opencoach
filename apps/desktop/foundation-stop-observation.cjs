'use strict';
// Passive Main-only observation. No cancellation, signal, PID lookup or App Quit.
const {randomUUID}=require('node:crypto');
const {ownedProcessSnapshot}=require('./owned-process-lifetime.cjs');
const opaque=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(v);
const reject=()=>{throw new Error('FM_OPERATION_UNPROVEN');};
function observeFoundationStop(observations,service,owner,payload,launchNonce){
 const q=payload.operation;
 if(!owner?.live||!service||!q||typeof q!=='object'||Array.isArray(q)||payload.launchNonce!==launchNonce||payload.sessionNonce!==launchNonce||payload.component!=='voice-foundation-models'||
  Object.keys(payload).sort().join()!=='component,launchNonce,operation,sessionNonce')reject();
 const phase=q.phase;
 const keys=phase==='pending'?['phase','challenge','requestId','sessionId']:phase==='closed'?['phase','challenge','observationId']:['phase','challenge','observationId','requestId','sessionId'];
 if(!['pending','closed','recovered'].includes(phase)||Object.keys(q).sort().join()!==keys.sort().join()||!keys.filter(k=>k!=='phase').every(k=>opaque(q[k])))reject();
 const client=service.client;let s=observations.get(owner),record;
 if(phase==='pending'){
  record=service.active;
  if(!record||record.owner!==owner||record.requestId!==q.requestId||record.sessionId!==q.sessionId||!record.native||record.native!==client.pending||record.native.method!=='generate'||record.native.outcome||record.native.process!==client.proc||!client.proc)reject();
  // Replace only a proven closed capture. Unknown keeps the original handles.
  if(s&&!s.closed)reject();
  s={id:randomUUID(),service,record,process:record.native.process,intent:record.state.current,challenges:new Set(),closed:false};
 }else{
  if(!s||s.service!==service||s.id!==q.observationId)reject();
  record=s.record;
  const old=ownedProcessSnapshot(client,s.process.child);
  if(old.length!==1||!old[0].exited||!old[0].reaped||!old[0].drained||old[0].error||old[0].signalRequested||old[0].code!==0||old[0].signal!==null||record.native.outcome!=='FM_CANCELLED'||!s.intent.revoked||!s.intent.stop)reject();
  if(phase==='recovered'){
   if(!s.closed)reject();
   record=service.owners.get(owner)?.lastGeneration;
   if(!record||record===s.record||record.owner!==owner||record.requestId!==q.requestId||record.sessionId!==q.sessionId||record.requestId===s.record.requestId||record.native?.outcome!=='success'||record.native.process!==client.proc||record.native.process===s.process||record.native.process.generation===s.process.generation||record.native.process.child.pid===s.process.child.pid)reject();
  }
 }
 const proc=record.native.process, facts=ownedProcessSnapshot(client,proc.child);
 if(facts.length!==1||!Number.isSafeInteger(facts[0].pid)||facts[0].pid<=0)reject();
 if(phase!=='closed'&&(facts[0].exited||facts[0].reaped||facts[0].error||facts[0].signalRequested||client.fault||client.stopping))reject();
 if(s.challenges.has(q.challenge)||s.challenges.size>=128)reject();
 s.challenges.add(q.challenge);if(phase==='closed')s.closed=true;
 observations.set(owner,s);
 return {pid:facts[0].pid,closed:phase==='closed',operation:{phase,observationId:s.id,challenge:q.challenge,requestId:record.requestId,sessionId:record.sessionId,nativeRequestId:record.native.id,generation:proc.generation}};
}
module.exports={observeFoundationStop};
