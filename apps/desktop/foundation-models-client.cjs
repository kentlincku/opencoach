'use strict';
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const CODES = new Set(['FM_UNAVAILABLE', 'FM_CONTEXT_LIMIT', 'FM_GENERATION_FAILED', 'FM_CANCELLED', 'FM_INVALID_REQUEST', 'FM_BUSY']);
const fail = code => new Error(code);

// A single first-party text helper, NOT a speech lease/process-tree authority.
// resolveLaunch/spawnImpl are Main-side dependency seams, never IPC arguments.
class FoundationModelsClient {
  constructor({ resolveLaunch, spawnImpl = spawn, timeoutMs = 60000, stopMs = 1000 }) {
    this.resolveLaunch = resolveLaunch; this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs; this.stopMs = stopMs;
    this.epoch = 0; this.closed = false; this.proc = null; this.pending = null; this.stopping = null; this.fault = false;
  }
  async request(method, params = {}) {
    if (this.closed || this.fault) throw fail('FM_CLOSED');
    if (this.pending || this.stopping) throw fail('FM_BUSY');
    const epoch = this.epoch;
    const id = randomUUID();
    let resolve, reject;
    const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
    const slot = { id, method, epoch, resolve, reject, timer: null };
    this.pending = slot;
    slot.timer = setTimeout(() => { this._settle(slot, fail('FM_TIMEOUT')); this.stop().catch(() => {}); }, this.timeoutMs);
    // The caller owns settlement before preparation, including missing executables.
    const preparation = Promise.resolve().then(async () => {
      if (!this.proc) {
        const launch = await this.resolveLaunch();
        if (this.closed || this.fault || this.epoch !== epoch || this.pending !== slot) return;
        const child = this.spawnImpl(launch.command, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        require('./owned-process-lifetime.cjs').trackOwnedProcess(this, child);
        const record = { child, generation: randomUUID(), buffer: Buffer.alloc(0), exited: false };
        record.exit = new Promise(ok => { record.resolveExit = ok; });
        this.proc = record;
        child.stdout.on('data', chunk => this._data(record, chunk));
        let stderrBytes = 0;
        child.stderr.on('data', chunk => {
          if (this.proc !== record || this.stopping) return;
          stderrBytes = Math.min(65537, stderrBytes + chunk.length);
          if (stderrBytes > 65536) this._break(record, 'FM_PROTOCOL_ERROR');
        }); // Count only; never retain/forward diagnostics, prompts or host paths.
        child.on('error', () => { if (this.proc === record) this._break(record, 'FM_START_FAILED'); });
        child.stdin.on('error', () => this._break(record, 'FM_TRANSPORT_FAILED'));
        child.once('close', () => {
          record.exited = true; record.resolveExit();
          if (this.proc !== record) return;
          if (!this.stopping) this.fault = true; // Unexpected process loss is not a healthy Stop/restart receipt.
          this.proc = null;
          if (this.pending) this._settle(this.pending, fail('FM_HELPER_EXITED'));
        });
      }
      if (this.closed || this.epoch !== epoch || this.pending !== slot) return;
      const record = this.proc;
      slot.process = record; // Passive exact dispatch ownership, never caller supplied.
      try {
        record.child.stdin.write(JSON.stringify({ protocol: 1, id, method, params }) + '\n', error => {
          if (error && this.proc === record && this.pending === slot) this._break(record, 'FM_TRANSPORT_FAILED');
        });
      } catch { this._break(record, 'FM_TRANSPORT_FAILED'); }
    }).catch(error => {
      if (this.pending !== slot) return;
      this._settle(slot, fail(['FM_HELPER_MISSING', 'FM_HELPER_INTEGRITY'].includes(error.message) ? error.message : 'FM_START_FAILED'));
      this.stop().catch(() => {});
    });
    this.preparing = preparation;
    preparation.finally(() => { if (this.preparing === preparation) this.preparing = null; });
    return promise;
  }
  _settle(slot, error, result) {
    if (this.pending !== slot) return;
    slot.outcome = error ? error.message : 'success';
    this.pending = null; clearTimeout(slot.timer);
    if (error) slot.reject(error); else slot.resolve(result);
  }
  _break(record, code) {
    if (this.proc !== record) return;
    if (this.pending) this._settle(this.pending, fail(code));
    this.stop().catch(() => {});
  }
  _data(record, chunk) {
    if (this.proc !== record || this.stopping) return;
    record.buffer = Buffer.concat([record.buffer, chunk]);
    if (record.buffer.length > 32768) { this._break(record, 'FM_PROTOCOL_ERROR'); return; }
    let end;
    while ((end = record.buffer.indexOf(10)) !== -1) {
      const line = record.buffer.subarray(0, end); record.buffer = record.buffer.subarray(end + 1);
      try {
        const reply = JSON.parse(line.toString('utf8')), slot = this.pending;
        if (!slot || !reply || Object.keys(reply).sort().join(',') !== 'id,protocol,result,success'
          || reply.protocol !== 1 || reply.id !== slot.id || typeof reply.success !== 'boolean') throw fail('FM_PROTOCOL_ERROR');
        if (!reply.success) {
          if (!reply.result || Object.keys(reply.result).join() !== 'code' || !CODES.has(reply.result.code)) throw fail('FM_PROTOCOL_ERROR');
          this._settle(slot, fail(reply.result.code));
        } else {
          const result = reply.result;
          if (slot.method === 'availability') {
            const reasons = ['available', 'unsupported-os', 'device-not-eligible', 'intelligence-disabled', 'model-not-ready', 'unavailable'];
            if (!result || Object.keys(result).join() !== 'reason' || !reasons.includes(result.reason)) throw fail('FM_PROTOCOL_ERROR');
          } else if (!result || Object.keys(result).join() !== 'text' || typeof result.text !== 'string'
              || !result.text.trim() || Buffer.byteLength(result.text) > 8192) throw fail('FM_PROTOCOL_ERROR');
          this._settle(slot, null, result);
        }
      } catch { this._break(record, 'FM_PROTOCOL_ERROR'); return; }
    }
  }
  stop() {
    this.epoch++; // Fences preparation even on repeated stop / shutdown.
    const slot = this.pending;
    if (slot) this._settle(slot, fail('FM_CANCELLED'));
    if (this.stopping) return this.stopping;
    const record = this.proc, preparation = this.preparing;
    this.stopping = Promise.resolve().then(async () => {
      // Logical cancellation is prompt; the drain still owns the actual validator.
      await preparation;
      if (!record) return { state: 'helper-exited' };
      // Request cooperative task cancellation/quit first. This is NOT confirmation.
      try { record.child.stdin.end(JSON.stringify({ protocol: 1, id: randomUUID(), method: 'quit', params: {} }) + '\n'); } catch {}
      const wait = async () => {
        let timer;
        const done = await Promise.race([record.exit.then(() => true), new Promise(ok => { timer = setTimeout(() => ok(false), this.stopMs); })]);
        clearTimeout(timer); return done;
      };
      if (!await wait()) { try { record.child.kill('SIGTERM'); } catch {} }
      if (!record.exited && !await wait()) { try { record.child.kill('SIGKILL'); } catch {} }
      if (!record.exited && !await wait()) { this.fault = true; throw fail('FM_EXIT_UNCONFIRMED'); }
      return { state: 'helper-exited' };
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
  shutdown() { this.closed = true; return this.stop(); }
}
module.exports = { FoundationModelsClient };
