'use strict';
// R55 finite first-party graph. No child creation, network, models or asset I/O.
const fs = require('node:fs');
const readline = require('node:readline');
const [role, mode, token] = process.argv.slice(2);
if (!['leader','worker'].includes(role) || !token) process.exit(64);
const lines = readline.createInterface({input: process.stdin});
let ended = false, delayed = false;
function finish() {
  if (ended) return;
  if (role==='leader' && mode==='worker-first' && !delayed) {delayed=true;setTimeout(finish,50);return;}
  ended = true;
  const receipt = {token, role, mode};
  if (mode === 'forged-receipt') receipt.token = 'forged';
  if (mode !== 'missing-receipt') fs.writeSync(3, JSON.stringify(receipt)+'\n');
  fs.closeSync(3);
  lines.close();
  process.exitCode = 0;
}
process.on('SIGTERM', () => {
  if (mode !== 'deadline-kill') finish();
});
lines.on('close', () => {
  if (mode === 'deadline-kill') return;
  if (role === 'worker' && mode === 'held-stream') setTimeout(finish, 200);
  else if (mode === 'late-receipt') setTimeout(finish, 50);
  else finish();
});
lines.on('line', line => {
  const request = JSON.parse(line);
  if (mode.startsWith('deadline-') || mode==='cancel') return;
  if (request.method !== 'runtime.probe' || Object.keys(request.params).length) process.exitCode = 65;
  else process.stdout.write(JSON.stringify({id:request.id,success:true,result:{control:true}})+'\n');
});
process.stdout.write(JSON.stringify({event:'ready',protocol:1})+'\n');
// A bounded kill-control must remain live after EOF while ignoring TERM.
if (mode === 'deadline-kill') setInterval(() => {}, 1000);
