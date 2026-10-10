'use strict';
// Passive lifetime ledger. Only actual owned ChildProcess events grant closure;
// a signal request, stop promise, cleared client.proc or dispose grants nothing.
const owners = new WeakMap();
function trackOwnedProcess(owner, child, { gracefulSignal = false } = {}) {
  let records = owners.get(owner);
  if (!records) owners.set(owner, records = []);
  const record = { child, gracefulSignal, pid: child.pid, started: false, hadPid: Number.isSafeInteger(child.pid) && child.pid > 0, spawnError: false, exit: false, close: false, error: false, code: null, signal: null };
  records.push(record);
  child.once('spawn', () => { record.started = true; record.hadPid = true; record.pid = child.pid; });
  child.once('exit', (code, signal) => { record.exit = true; record.code = code; record.signal = signal; });
  child.once('close', () => { record.close = true; });
  child.on('error', error => {
    record.error = true;
    record.hadPid ||= Number.isSafeInteger(child.pid) && child.pid > 0;
    // Only the original Node spawn syscall failure can prove no process existed.
    // Generic errors, kill errors, cleared proc and deadlines grant no authority.
    if (child instanceof require('node:child_process').ChildProcess && !record.started && !record.hadPid
      && typeof child.spawnfile === 'string' && error?.syscall === `spawn ${child.spawnfile}`
      && Number.isInteger(error.errno) && error.errno < 0
      && ['ENOENT', 'EACCES', 'EAGAIN', 'ENOEXEC', 'ENOMEM', 'ETXTBSY', 'EMFILE', 'ENFILE', 'E2BIG'].includes(error.code)) record.spawnError = true;
  });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => { record.error = true; });
}
function ownedProcessSnapshot(owner, child = null) {
  const records = owners.get(owner) || [];
  return records.filter(r => child === null || r.child === child).map(r => Object.freeze({ pid: r.pid, exited: r.exit, reaped: r.close,
    noSpawn: r.spawnError && !r.started && !r.hadPid && !r.exit && r.child.pid === undefined && r.close
      && [r.child.stdin, r.child.stdout, r.child.stderr].every(s => !s || s.destroyed === true),
    drained: [r.child.stdout, r.child.stderr].every(s => !s || s.readableEnded === true),
    error: r.error, code: r.code, signal: r.signal, signalRequested: r.child.killed === true, gracefulSignal: r.gracefulSignal }));
}
function requireOwnedProcessClosure(owner) {
  const records = ownedProcessSnapshot(owner);
  if (records.some(r => !r.exited || !r.reaped || !r.drained || r.error || (r.signalRequested && !r.gracefulSignal) || r.code !== 0 || r.signal !== null)) {
    throw new Error('OWNED_RUNTIME_LIFECYCLE_UNCONFIRMED');
  }
  return records;
}
async function waitOwnedProcessClosure(owner, timeoutMs = 1500) {
  // Physical product shutdown is distinct from a clean acceptance attestation.
  // A historical forced but fully closed child cannot strand the user's App.
  const deadline = Date.now() + timeoutMs;
  while (ownedProcessSnapshot(owner).some(r => !r.noSpawn && (!r.exited || !r.reaped || !r.drained))) {
    if (Date.now() >= deadline) throw new Error('OWNED_RUNTIME_LIFECYCLE_UNCONFIRMED');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
module.exports = { trackOwnedProcess, ownedProcessSnapshot, requireOwnedProcessClosure, waitOwnedProcessClosure };
