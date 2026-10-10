(function (root, factory) {
  const contract = typeof module === 'object' && module.exports
    ? require('./desktop-voice-operation-contract.js') : root.DesktopVoiceOperationContract;
  const exports = factory(root, contract);
  if (typeof module === 'object' && module.exports) module.exports = exports;
  else root.DesktopVoiceWorkScope = Object.freeze(exports);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root, contract) {
  'use strict';
  // A replacement adapter on the same document bridge cannot reset its fault.
  const domains = new WeakMap();
  let namespace, sequence = 0;
  const error = () => new Error('VOICE_CLEANUP_UNCERTAIN');
  function deadline(promise, milliseconds = 2000) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(error()), milliseconds);
    })]).finally(() => clearTimeout(timer));
  }
  class DesktopVoiceWorkScope {
    constructor(api) {
      this.api = api;
      if (!domains.has(api)) domains.set(api, { fault: null, records: new Set() });
      this.domain = domains.get(api);
      this.records = new Set();
      this.epoch = 1;
      this.closed = false;
      this.disposed = false;
      this.stopPromise = null;
      this.stopSettled = false;
      this.stopCleanups = [];
      this.stopped = false;
    }
    fail() { this.domain.fault ||= error(); return this.domain.fault; }
    begin(nativePlanned) {
      if (this.domain.fault) throw this.domain.fault;
      if (this.disposed) throw new Error('RUNTIME_DISPOSED');
      if (this.closed && !this.stopped) throw new Error('RUNTIME_CANCELLED');
      if (this.domain.records.size >= 32 || sequence >= 2147483647) throw this.fail();
      if (this.closed) { this.closed = false; this.stopPromise = null; this.stopped = false; }
      namespace ||= root.crypto.randomUUID();
      const record = { requestId: namespace + ':' + (++sequence), epoch: this.epoch,
        nativePlanned, nativeDone: false, dispatched: false, revoked: false, proof: null, cleanup: null,
        localPending: false, finished: false, release: null,
        controller: new AbortController() };
      this.records.add(record);
      this.domain.records.add(record);
      return record;
    }
    context(record) {
      return { requestId: record.requestId, epoch: record.epoch, currentEpoch: this.epoch,
        stopped: record.revoked || this.closed, ownerValid: !this.disposed && this.records.has(record),
        admissionValid: !this.closed, domainFault: !!this.domain.fault, transportUncertain: !!record.uncertain };
    }
    check(record) {
      if (record.revoked || this.disposed || record.epoch !== this.epoch) throw new Error('RUNTIME_CANCELLED');
      if (this.domain.fault) throw this.domain.fault;
      if (!this.records.has(record) || this.closed) throw new Error('RUNTIME_CANCELLED');
      if (record.proof && !contract.canFallback(record.proof, this.context(record))) throw this.fail();
    }
    finish(record) {
      record.proof = null;
      record.finished = true;
      if (!this.domain.fault && !record.localPending && (!record.nativePlanned || record.nativeDone
          || (!record.dispatched && !record.revoked))) {
        this.records.delete(record); this.domain.records.delete(record);
      }
    }
    local(record, callback) {
      // Reserve the barrier BEFORE invoking a Blob/codec/fallback callback.
      record.localPending = true;
      const work = Promise.resolve().then(() => { this.check(record); return callback(); });
      record.cleanup = work.then(() => {}, failure => {
        if (failure?.code === 'VOICE_AUDIO_CLEANUP_FAILED') this.fail();
      }).then(() => {
        record.localPending = false;
        if (record.finished) this.finish(record);
      });
      return record.cleanup.then(() => work);
    }
    addStopCleanup(callback) {
      let done;
      const task = new Promise(resolve => { done = resolve; });
      this.stopCleanups.push(task); // reentrant dispose joins the already-owned batch
      try {
        const result = callback();
        if (result === this.stopPromise) done(); // a join is not a new cleanup obligation
        else Promise.resolve(result).then(done, () => { this.fail(); done(); });
      } catch (_) { this.fail(); done(); }
    }
    failure(record, value) {
      let reply;
      try { reply = contract.normalize(value); } catch (_) { throw this.fail(); }
      if (reply.type !== 'failure' || reply.requestId !== record.requestId) throw this.fail();
      if (!contract.canFallback(reply, this.context(record))) throw this.fail();
      record.nativeDone = true;
      record.proof = reply;
      return reply;
    }
    async observe(record) {
      let state;
      try {
        state = contract.normalize(await deadline(Promise.resolve().then(() =>
          this.api.voiceOperationState({ version: 1, type: 'observe', requestId: record.requestId }))));
        if (state.type !== 'state' || state.requestId !== record.requestId) throw error();
        if (state.knowledge === 'known') {
          if (record.revision && state.revision < record.revision) throw error();
          record.revision = state.revision;
          // Main reports ordinary revocation as admission-closed while the
          // original receipt/file cleanup drains. It is NOT fallback proof,
          // nor Stop confirmation: stop still requires its ACK + released state.
          const expectedRevocation = record.revoked && state.revocation === 'revoked'
            && state.failure?.code === 'admission-closed';
          if (state.failure && state.failure.code !== 'backend-error' && !expectedRevocation) this.fail();
        }
      } catch (_) { throw this.fail(); }
      return state;
    }
    stop(localStop = () => {}) {
      if (this.stopPromise) return this.stopPromise;
      this.closed = true;
      if (this.epoch >= 2147483647) this.fail(); else this.epoch++;
      let resolve, reject;
      this.stopPromise = new Promise((yes, no) => { resolve = yes; reject = no; });
      this.stopSettled = false;
      this.stopCleanups = [];
      // Join registration and ALL revocations precede any reentrant callback.
      const records = [...this.records];
      for (const record of records) { record.revoked = true; record.proof = null; }
      const initiate = callback => this.addStopCleanup(callback);
      for (const record of records) {
        initiate(() => record.controller.abort());
        if (record.cleanup) initiate(() => record.cleanup);
      }
      initiate(localStop);
      const native = records.filter(record => record.nativePlanned && !record.nativeDone);
      const ids = native.map(record => record.requestId);
      // Failure observation never substitutes for this explicit complete batch.
      const revoke = ids.length ? Promise.resolve().then(() => this.api.voiceOperationRevoke({
        version: 1, type: 'revoke', requestIds: ids,
      })) : Promise.resolve(null);
      const run = async () => {
        try {
          try {
            if (ids.length) {
              const ack = contract.normalize(await deadline(revoke));
              if (ack.type !== 'revoked' || JSON.stringify(ack.requestIds) !== JSON.stringify(ids)) throw error();
            }
          } catch (_) { this.fail(); }
          // A native/local failure must not skip the remaining local obligations.
          await deadline((async () => {
            let count = 0;
            do {
              const batch = this.stopCleanups.slice(count); count += batch.length;
              await Promise.all(batch);
            } while (count !== this.stopCleanups.length);
          })());
          const end = Date.now() + 2000;
          for (const record of native) {
            for (;;) {
              if (this.domain.fault) throw this.domain.fault;
              const state = await this.observe(record);
              // ACK + safe retirement together: neither an unknown nor a passive
              // retired observation alone is authority to cancel/complete work.
              if (state.knowledge === 'retired') break;
              if (state.knowledge !== 'known') throw error();
              if (state.revocation === 'revoked' && state.logical === 'settled' && state.cleanup === 'released'
                  && ['not-dispatched', 'completed', 'confirmed'].includes(state.receipt.status)) break;
              if (Date.now() >= end) throw error();
              await new Promise(done => setTimeout(done, 10));
            }
          }
        } catch (_) { this.fail(); }
        finally {
          // dispose can arrive while an observer is pending (including rejection).
          // Recheck the queue in THIS continuation before resolving the join.
          const end = Date.now() + 2000;
          try {
            let count;
            do {
              count = this.stopCleanups.length;
              await deadline(Promise.all(this.stopCleanups), Math.max(0, end - Date.now()));
            } while (count !== this.stopCleanups.length);
          } catch (_) { this.fail(); }
          this.stopSettled = true;
          if (this.domain.fault) reject(this.domain.fault);
          else {
            for (const record of records) this.domain.records.delete(record);
            this.records.clear(); this.stopped = true;
            resolve();
          }
        }
      };
      void Promise.resolve().then(run);
      // Keep ignored HTML callers observable through runtime.fault, not an
      // unhandled rejection. The original promise still rejects for its joiners.
      this.stopPromise.catch(() => {});
      return this.stopPromise;
    }
  }
  return { DesktopVoiceWorkScope, deadline };
}));
