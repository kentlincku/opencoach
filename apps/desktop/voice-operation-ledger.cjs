const { normalize } = require('../web/runtime/desktop-voice-operation-contract.js');

// Tokens and native handles are Main-owned capabilities, never renderer input.
class VoiceOperationLedger {
  constructor() {
    this.owners = new Map();
    this.fault = null;
    this.generation = 0;
    this.generations = new WeakMap();
  }

  admit(owner, requestId, client, isAllowed) {
    normalize({ version: 1, type: 'observe', requestId });
    let history = this.owners.get(owner);
    if (history?.has(requestId)) throw new Error('VOICE_OPERATION_ID_REUSED');
    if (this.fault) throw new Error('VOICE_OPERATION_ADMISSION_CLOSED');
    if (!this.capacity(owner, 1, true)) {
      this.fault = 'quota-exceeded';
      this.notifyFailure();
      throw new Error('VOICE_OPERATION_QUOTA_EXCEEDED');
    }
    if (!history) { history = new Map(); this.owners.set(owner, history); }
    const record = { owner, requestId, client, isAllowed, state: {
      version: 1, type: 'state', requestId, knowledge: 'known', revision: 1,
      logical: 'accepted', revocation: 'live', receipt: { status: 'not-dispatched', binding: null },
      cleanup: 'pending', failure: null,
    } };
    history.set(requestId, record);
    try {
      record.operation = client.createOperation(() => this.allowed(record));
      record.detach = record.operation.subscribe?.(original => this.producer(record, original));
    }
    catch (error) {
      history.set(requestId, null);
      this.fault = 'quota-exceeded';
      this.notifyFailure();
      throw error;
    }
    return record;
  }

  allowed(record) {
    return !record.retired && !this.fault && record.state.revocation === 'live' && record.isAllowed() === true;
  }

  change(record, values) {
    if (record.retired) return;
    const next = normalize({ ...record.state, ...values });
    if (JSON.stringify(next) === JSON.stringify(record.state)) return;
    if (record.state.revision === 2147483647) {
      const error = new Error('VOICE_OPERATION_QUOTA_EXCEEDED');
      this.producerFailure(record, error);
      throw error;
    }
    record.state = { ...next, revision: record.state.revision + 1 };
  }

  preparing(record) { this.change(record, { logical: 'preparing' }); }

  producer(record, original) {
    if (record.retired) return;
    record.latestReceipt = original; // retain native evidence even if wire mapping fails
    if (record.producerError) return;
    try { this.receipt(record, original); }
    catch (error) { this.producerFailure(record, error); }
  }

  producerFailure(record, error) {
    record.producerError ||= error;
    this.fault ||= /QUOTA_EXCEEDED/.test(error.message) ? 'quota-exceeded' : 'admission-closed';
    this.notifyFailure();
  }

  notifyFailure() {
    if (this.notifyingFailure) return;
    this.notifyingFailure = true;
    try {
      for (const history of this.owners.values()) {
        for (const owned of history.values()) {
          // A broken delivery hook cannot suppress another accepted reply.
          try { owned?.failReply?.(); } catch {}
        }
      }
    } finally { this.notifyingFailure = false; }
  }

  producerFailureReply(record) {
    // No fabricated revision/binding: keep last valid observer state and owner.
    const code = (record.latestReceipt || record.original)?.status === 'unconfirmed' ? 'termination-unconfirmed'
      : /QUOTA_EXCEEDED/.test(record.producerError.message) || this.fault === 'quota-exceeded' ? 'quota-exceeded' : 'admission-closed';
    return normalize({ version: 1, type: 'failure', requestId: record.requestId,
      code, message: 'Voice operation producer failed closed.', binding: null, completion: null });
  }

  // Producer-only: observers never read a native handle or allocate UUID mappings.
  receipt(record, original) {
    if (record.retired) return;
    let binding = null;
    let newMapping = null;
    if (original.binding) {
      const native = original.binding;
      let generation = null;
      if (native.generation) {
        let mapping = record.original?.binding?.generation === native.generation
          ? { uuid: native.generation, counter: record.state.receipt.binding.generation }
          : this.generations.get(record.client);
        if (mapping?.uuid !== native.generation) {
          // Reuse original generations still owned by the bounded full records.
          // The WeakMap retains only the latest mapping per client; no UUID history.
          for (const history of this.owners.values()) {
            for (const retained of history.values()) {
              if (retained?.client === record.client
                  && retained.original?.binding?.generation === native.generation) {
                mapping = { uuid: native.generation, counter: retained.state.receipt.binding.generation };
                break;
              }
            }
            if (mapping?.uuid === native.generation) break;
          }
        }
        if (mapping?.uuid !== native.generation) {
          if (this.generation === 2147483647) {
            const error = new Error('VOICE_OPERATION_QUOTA_EXCEEDED');
            this.producerFailure(record, error);
            throw error;
          }
          mapping = { uuid: native.generation, counter: this.generation + 1 };
          newMapping = mapping;
        }
        generation = mapping.counter;
      }
      binding = { clientId: native.clientId, intentId: native.intentId, generation };
    }
    const status = original.status;
    const values = { receipt: { status, binding } };
    if (status === 'completed' || status === 'confirmed') values.logical = 'settled';
    if (status === 'running' && record.state.logical !== 'settled') values.logical = 'dispatched';
    if (status === 'starting') values.logical = 'preparing';
    if (status === 'unconfirmed') {
      this.fault ||= 'termination-unconfirmed';
      Object.assign(values, { logical: 'settled', cleanup: 'retained', failure: {
        code: 'termination-unconfirmed', message: 'Native termination is unconfirmed.',
      } });
    }
    this.change(record, values);
    record.original = original;
    if (newMapping) {
      this.generation = newMapping.counter;
      this.generations.set(record.client, newMapping);
    }
    if (status === 'unconfirmed') {
      // The domain fence is shared, but each failure keeps its own receipt.
      this.notifyFailure();
    }
  }

  finish(record, { error, released }) {
    if (record.producerError) return this.producerFailureReply(record);
    const safe = ['not-dispatched', 'completed', 'confirmed'].includes(record.state.receipt.status);
    const code = record.state.receipt.status === 'unconfirmed' ? 'termination-unconfirmed'
      : record.cleanupFailed ? 'cleanup-failed' : record.state.failure?.code ||
      (this.fault === 'termination-unconfirmed' ? 'admission-closed' : this.fault ||
      (record.state.revocation === 'revoked' || !record.isAllowed() ? 'admission-closed' : 'backend-error'));
    const message = {
      'backend-error': 'Native voice operation failed.',
      'admission-closed': 'Voice operation admission is closed.',
      'quota-exceeded': 'Voice operation quota exceeded.',
      'termination-unconfirmed': 'Native termination is unconfirmed.',
      'cleanup-failed': 'Voice operation cleanup failed.',
    }[code];
    // Starting cannot be logically settled in C6. Deliver the detached failure
    // now; the original producer later supplies its stopping/confirmed evidence.
    if (error && record.state.receipt.status === 'starting') return normalize({
      version: 1, type: 'failure', requestId: record.requestId, code, message,
      binding: record.state.receipt.binding, completion: null,
    });
    try {
      this.change(record, { logical: 'settled', cleanup: code === 'cleanup-failed' ? 'retained'
        : released && safe ? 'released' : record.state.cleanup,
        failure: error ? { code, message } : record.state.failure });
    } catch (failure) {
      this.producerFailure(record, failure);
      return this.producerFailureReply(record);
    }
    const original = record.original;
    const terminal = original?.terminal;
    const correlated = terminal?.success === false && original.status === 'completed'
      && terminal.nativeRequestId === original.nativeRequestId
      && ['clientId', 'intentId', 'generation'].every(key => terminal[key] === original.binding[key]);
    const confirmedTimeout = record.requestTimedOut && original?.status === 'confirmed'
      && original.nativeRequestId && original.binding?.generation;
    const proof = error && code === 'backend-error' && (correlated || confirmedTimeout) && this.allowed(record)
      && record.state.cleanup === 'released' ? record.state : null;
    const reply = error ? normalize({ version: 1, type: 'failure', requestId: record.requestId,
      code, message, binding: record.state.receipt.binding, completion: proof }) : null;
    // The detached original reply exists before its full-record slot is reclaimed.
    if (record.state.cleanup === 'released' && safe) {
      record.retired = true;
      this.owners.get(record.owner).set(record.requestId, null);
    }
    return reply;
  }

  capacity(owner, added, full) {
    let total = 0, active = 0, ownerActive = 0;
    for (const [token, history] of this.owners) {
      total += history.size;
      for (const record of history.values()) if (record) {
        active++;
        if (token === owner) ownerActive++;
      }
    }
    return total + added <= 4096 && (this.owners.get(owner)?.size || 0) + added <= 1024
      && (!full || (active < 128 && ownerActive < 32));
  }

  // NEW public-stop evidence, never an upgrade of an original failed receipt.
  finalStop(client, barrier) {
    const drains = [];
    for (const history of this.owners.values()) {
      for (const record of history.values()) {
        if (!record || record.client !== client) continue;
        const drain = { client, operation: record.operation, barrier, confirmed: false };
        record.finalDrain = drain;
        drains.push([record, drain]);
      }
    }
    return barrier.then(() => {
      for (const [record, drain] of drains) {
        drain.confirmed = true;
        if (record.finalDrain === drain) record.confirmFinalStop?.();
      }
    });
  }

  waitForFinalStop(record) {
    if (record.finalDrain?.confirmed) return Promise.resolve();
    record.finalStopWait ||= new Promise(resolve => { record.confirmFinalStop = resolve; });
    return record.finalStopWait;
  }

  async drainFiles() {
    // After public stops AND physical tasks; no task awaits this shutdown drain.
    for (const history of this.owners.values()) {
      for (const [id, record] of history) {
        if (!record) continue;
        const drain = record.finalDrain;
        if (!drain?.confirmed || drain.client !== record.client || drain.operation !== record.operation) {
          throw new Error('VOICE_OPERATION_FINAL_DRAIN_UNCONFIRMED');
        }
        if (record.cleanupRetry) await record.cleanupRetry();
        if (record.filesReleased === false) throw new Error('VOICE_OPERATION_CLEANUP_PENDING');
        // C6 cannot express released cleanup on an unconfirmed ORIGINAL receipt.
        // Retire directly using independent final-drain evidence instead.
        record.retired = true;
        record.detach?.();
        record.cleanupRetry = null;
        history.set(id, null);
      }
    }
  }

  cancel(record) {
    if (record.cancellation) return record.cancellation;
    // Install a joinable original-outcome slot before invoking the capability.
    let resolve, reject;
    record.cancellation = new Promise((yes, no) => { resolve = yes; reject = no; });
    const failed = () => {
      this.fault ||= 'termination-unconfirmed';
      this.notifyFailure(); // invocation failure fences all, but proves no receipt
    };
    record.cancellation.catch(failed);
    try { resolve(record.operation.cancel()); }
    catch (error) { failed(); reject(error); }
    return record.cancellation;
  }

  revoke(owner, command) {
    const input = normalize(command);
    if (input.type !== 'revoke') throw new Error('INVALID_VOICE_OPERATION_COMMAND');
    let history = this.owners.get(owner);
    const unknown = input.requestIds.filter(id => !history?.has(id));
    const overflow = !this.capacity(owner, unknown.length, false);
    if (overflow) this.fault = 'quota-exceeded';
    if (!history && !overflow) { history = new Map(); this.owners.set(owner, history); }
    const affected = [];
    // No external callback is permitted until every known member is fenced.
    for (const id of input.requestIds) {
      const record = history?.get(id);
      if (record) {
        if (record.state.revocation === 'live') {
          if (record.state.revision === 2147483647) {
            // The private domain fence revokes admission without forging a new
            // state under an already exhausted public revision.
            this.fault = 'quota-exceeded';
            record.producerError ||= new Error('VOICE_OPERATION_QUOTA_EXCEEDED');
          } else {
            record.state.revocation = 'revoked';
            record.state.revision++;
          }
        }
        affected.push(record);
      } else if (!overflow && !history.has(id)) history.set(id, null);
    }
    // Every member is marked before external hooks; overflow also reaches
    // accepted work outside this batch, without cancelling or releasing it.
    if (this.fault) this.notifyFailure();
    for (const record of affected) {
      // An observed failed original cancellation is already terminal evidence.
      // In particular, do not turn an unused collateral receipt into confirmed.
      try {
        if (record.operation.snapshot().status !== 'unconfirmed') this.cancel(record);
      } catch (error) {
        this.producerFailure(record, error);
        this.cancel(record);
      }
      try { record.failReply?.(); } catch (error) { this.producerFailure(record, error); }
    }
    if (overflow) throw new Error('VOICE_OPERATION_QUOTA_EXCEEDED');
    return normalize({ version: 1, type: 'revoked', requestIds: input.requestIds });
  }

  closeOwner(owner) {
    if (!owner) return;
    owner.live = false;
    const requestIds = [...(this.owners.get(owner)?.values() || [])]
      .filter(record => record && !record.retired).map(record => record.requestId);
    if (requestIds.length) this.revoke(owner, { version: 1, type: 'revoke', requestIds });
  }

  observe(owner, command) {
    const input = normalize(command);
    if (input.type !== 'observe') throw new Error('INVALID_VOICE_OPERATION_COMMAND');
    const history = this.owners.get(owner);
    const record = history?.get(input.requestId);
    return normalize(record ? record.state : {
      version: 1, type: 'state', requestId: input.requestId,
      knowledge: history?.has(input.requestId) ? 'retired' : 'unknown',
    });
  }
}
module.exports = { VoiceOperationLedger };
