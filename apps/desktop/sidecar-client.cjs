const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const operationKey = Symbol('sidecar operation');

class SidecarClient {
  #assetLifetime = null;
  #managedSource = null;
  #darwinProducer = null;

  static bindDarwinAssets(client, bundle) {
    if (client && #darwinProducer in client && client.#darwinProducer) {
      require('./darwin-owned-lifetime.cjs').bindDarwinLease(client.#darwinProducer,client,bundle);
    }
  }

  static retireDarwinAssets(client) {
    if (client && #darwinProducer in client && client.#darwinProducer) {
      require('./darwin-owned-lifetime.cjs').revokeDarwin(client.#darwinProducer,client);
    }
  }
  static authorizeDarwinAssets(client,bundle) {
    if (client && #darwinProducer in client && client.#darwinProducer) {
      require('./darwin-owned-lifetime.cjs').authorizeDarwinDispatch(client.#darwinProducer,client,bundle);
    }
  }

  static observeManagedAssets(client) {
    const missing = reason => Object.freeze({version:1,status:'NOT_PROVEN',reason});
    if (!client || !(#managedSource in client)) return missing('NO_MANAGED_LAUNCH');
    const lifetime = client.#assetLifetime, source = client.#managedSource;
    if (!lifetime || lifetime.unknown || lifetime.fault) return missing('ASSET_HISTORY_UNCONFIRMED');
    const darwinEvidence = client.#darwinProducer ? require('./darwin-owned-lifetime.cjs').darwinSnapshot(
      client.#darwinProducer, client, lifetime.preparations) : null;
    if (darwinEvidence?.unknown || darwinEvidence?.fault) return missing('ASSET_HISTORY_UNCONFIRMED');
    if (!source?.proof) return missing('MANIFEST_AUTHORITY_MISSING');
    if (!source.spawned || source.proc !== client.process || source.generation !== client.processGeneration ||
        lifetime.clientId !== client.clientId || source.proc.exitCode !== null || source.proc.signalCode !== null) return missing('SOURCE_NOT_CURRENT');
    return Object.freeze({version:source.proof.version ?? (client.#darwinProducer ? 2 : 1),status:'SOURCE_BOUND',authority:source.proof.authority,
      clientId:lifetime.clientId,generation:source.generation,pid:source.proc.pid,
      coverage:client.#darwinProducer ? 'darwin-owned-handles' : lifetime.coverage,
      ...(darwinEvidence ? {qualificationScope:darwinEvidence.qualificationScope} : {}),
      assets:source.proof.assets,dispatch:source.dispatch});
  }

  constructor({ command, args = [], env = process.env, requestTimeoutMs = 120000,
    beforeSpawn = null, afterExit = null, onStderr = null, onOwnedProcess = null,
    stopGraceMs = 2000, stopKillWaitMs = 3000, trackAssetLifetime = false, lifetimePurpose = null, lifetimeDeadline = null,
    nativeRuntime = null }) {
    this.onStderr = onStderr;
    this.onOwnedProcess = onOwnedProcess;
    this.processGeneration = null;
    this.afterExit = afterExit;
    this.cleanupPromise = null;
    this.stopPromise = null;
    this.cleanupQueued = false;
    this.terminationFailure = null;
    this.stopGraceMs = stopGraceMs;
    this.stopKillWaitMs = stopKillWaitMs;
    this.beforeSpawn = beforeSpawn;
    this.startPromise = null;
    this.startWork = null;
    this.startToken = null;
    this.startIntent = { error: null };
    this.operations = new Set();
    this.clientId = randomUUID();
    if (trackAssetLifetime === true) this.#assetLifetime = {
      clientId: this.clientId, coverage: process.platform === 'win32' ? 'windows-tree' : 'leader-only',
      preparations: 0, records: new Map(), unknown: false, fault: false,
    };
    this.command = command;
    this.args = args;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.process = null;
    this.pending = new Map();
    this.readyPromise = null;
    if (trackAssetLifetime && process.platform === 'darwin') {
      this.#darwinProducer = require('./darwin-owned-lifetime.cjs').createDarwinProducer(this,
        {command,args,env,purpose:lifetimePurpose,deadline:lifetimeDeadline,nativeRuntime});
    }
  }

  // Observation reads only producer-owned data; no process polling or mutation.
  assetLifetimeSnapshot() {
    const state = this.#assetLifetime;
    if (!state) return null;
    if (this.#darwinProducer) return require('./darwin-owned-lifetime.cjs').darwinSnapshot(
      this.#darwinProducer,this,state.preparations);
    return Object.freeze({ schemaVersion: 1, clientId: state.clientId, coverage: state.coverage,
      pendingPreparation: state.preparations > 0, unresolvedGenerations: state.records.size,
      unknown: state.unknown, fault: state.fault });
  }

  #assetEvidence(update) {
    const state = this.#assetLifetime;
    if (!state) return;
    try {
      const result=update(state);
      if (this.#darwinProducer) require('./darwin-owned-lifetime.cjs').updateDarwinPreparation(
        this.#darwinProducer,this,state.preparations);
      return result;
    }
    catch { state.fault = true; state.unknown = true; }
  }

  _rejectPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  createOperation(isAllowed) {
    if (typeof isAllowed !== 'function') throw new TypeError('VOICE_OPERATION_GATE_REQUIRED');
    if (this.operations.size >= 128) throw new Error('VOICE_OPERATION_CAPACITY');
    this.startIntent.id ||= randomUUID();
    const operation = { intent: this.startIntent, isAllowed, used: false, denied: false,
      status: 'not-dispatched', generation: null, nativeRequestId: null, terminal: null };
    this.operations.add(operation);
    return Object.freeze({
      snapshot: () => this._operationSnapshot(operation),
      // One bounded producer listener; subscribing/reading never samples work.
      subscribe: listener => {
        if (typeof listener !== 'function') throw new TypeError('VOICE_OPERATION_LISTENER_REQUIRED');
        if (this.operations.has(operation)) operation.listener = listener;
        return () => { if (operation.listener === listener) operation.listener = null; };
      },
      cancel: () => this._cancelOperation(operation),
      request: (method, params = {}, options = {}) => {
        if (operation.used || operation.denied) return Promise.reject(new Error('VOICE_OPERATION_ALREADY_USED'));
        operation.used = true;
        operation.status = 'starting';
        operation.generation = operation.intent.generation || null;
        const request = this.request(method, params, { ...options, [operationKey]: operation });
        this._notifyOperations([operation]); // startup ownership is installed first
        return request;
      },
    });
  }

  _cancelOperation(operation) {
    operation.denied = true; // revoke before any reentrant callback or await
    operation.rejectStartup?.(new Error('VOICE_RUNTIME_CANCELLED'));
    if (operation.status === 'completed' || operation.status === 'confirmed') {
      return Promise.resolve(this._operationSnapshot(operation));
    }
    if (!operation.used) {
      operation.status = 'confirmed';
      this.operations.delete(operation);
      this._notifyOperations([operation]);
      return Promise.resolve(this._operationSnapshot(operation));
    }
    const intent = operation.intent;
    const proc = intent.proc;
    if (intent.error && !intent.confirmation && (!proc?.pid ||
        (process.platform !== 'win32' && (proc.exitCode !== null || proc.signalCode !== null)))) {
      // Failed spawn or observed POSIX exit: drain only the original startup.
      // Never direct a retired receipt to the current client.cancel().
      operation.status = 'stopping';
      intent.confirmation = Promise.resolve(intent.work).catch(() => {}).then(() => {
        const affected = [];
        for (const owned of this.operations) {
          if (owned.intent !== intent) continue;
          owned.denied = true;
          owned.status = 'confirmed';
          this.operations.delete(owned);
          affected.push(owned);
        }
        this._notifyOperations(affected);
      });
      this._notifyOperations([operation]);
    }
    if (!intent.confirmation && intent === this.startIntent) this.cancel().catch(() => {});
    // cancel() still exposes the shared stop barrier; this handle joins only
    // its original receipt, whose failure must never be swallowed or replaced.
    const confirmation = intent.confirmation || Promise.reject(new Error('VOICE_OPERATION_ORIGINAL_UNCONFIRMED'));
    return confirmation.then(() => this._operationSnapshot(operation));
  }

  _notifyOperations(operations) {
    for (const operation of operations) {
      const snapshot = this._operationSnapshot(operation);
      const key = JSON.stringify(snapshot);
      if (operation.notification === key) continue;
      operation.notification = key; // reentry cannot replay an obsolete transition
      const listener = operation.listener;
      if (!this.operations.has(operation)) operation.listener = null;
      try { listener?.(snapshot); } catch {} // observers cannot take native ownership
    }
  }

  _operationSnapshot(operation) {
    const binding = operation.status === 'not-dispatched' ? null : Object.freeze({
      clientId: this.clientId, intentId: operation.intent.id, generation: operation.generation,
    });
    return Object.freeze({ status: operation.status, binding,
      nativeRequestId: operation.nativeRequestId,
      terminal: operation.terminal ? Object.freeze({ ...operation.terminal }) : null });
  }

  _checkOperation(operation, waitingForStop = false) {
    if (!operation) return;
    let allowed = false;
    try { allowed = operation.isAllowed() === true; } catch {}
    if (!allowed || operation.denied || operation.intent.error ||
        operation.intent !== this.startIntent || this.terminationFailure ||
        (this.process && operation.intent.proc !== this.process &&
          !(waitingForStop && !operation.intent.proc))) {
      operation.denied = true;
      throw new Error('VOICE_OPERATION_PERMIT_DENIED');
    }
  }

  async start(operation = null) {
    // Own the intent before waiting: a later cancel/stop revokes queued starts,
    // but a start requested after that stop belongs to the next lifecycle.
    const intent = operation?.intent || this.startIntent;
    // A fresh, unbound intent may wait behind the old process's stop, but may
    // never attach to it. Caller/revocation gates still execute synchronously.
    this._checkOperation(operation, !!this.stopPromise);
    while (this.stopPromise) {
      await this.stopPromise;
      this._checkOperation(operation, !!this.stopPromise);
    }
    if (intent.error) throw intent.error;
    if (this.terminationFailure) throw this.terminationFailure;
    if (this.startPromise) return this.startPromise;
    if (this.process) return this.readyPromise;
    const token = { error: null, rejectReady: null };
    const cancelled = new Promise((_, reject) => {
      token.cancel = error => {
        token.error = error;
        token.rejectReady?.(error);
        reject(error);
      };
    });
    this.startToken = token;
    // Caller rejection is prompt; ownership lasts until the underlying validator
    // and startup actually settle. Stop must not mistake the race for completion.
    // Defer user code until work, caller promise and token are all registered:
    // a synchronous validator abort must capture this work in the stop barrier.
    this.#assetEvidence(state => { state.preparations++; });
    this.startWork = Promise.resolve().then(() => {
      if (token.error) throw token.error;
      this._checkOperation(operation);
      return this._start(token, operation, intent);
    });
    intent.work = this.startWork;
    if (this.#assetLifetime) {
      const drained = () => this.#assetEvidence(state => { state.preparations--; });
      // Side reactions, never a replacement for work, race or intent promises.
      this.startWork.then(drained, drained);
    }
    const starting = Promise.race([this.startWork, cancelled]);
    this.startPromise = starting;
    try { return await starting; }
    finally {
      if (this.startPromise === starting) this.startPromise = null;
      if (this.startToken === token) this.startToken = null;
    }
  }

  async _start(token, operation, intent) {
    // Preparation itself can acquire assets, even if validation later fails.
    this.cleanupPromise = null;
    // Optional sync/async validator: false or a thrown/rejected error denies spawn.
    // true/undefined permits spawn; run again on EVERY new process, never on reuse.
    if (await this.beforeSpawn?.() === false) throw new Error('VOICE_RUNTIME_VALIDATION_FAILED');
    this._checkOperation(operation);
    if (token.error) throw token.error;
    const command = this.command, args = [...this.args], env = {...this.env};
    const proof = require('./managed-asset-lease.cjs').verifyManagedAssetLaunch(this,command,args,env);
    const generation = randomUUID();
    const proc = this.#darwinProducer ? require('./darwin-owned-lifetime.cjs').spawnDarwinLeader(
      this.#darwinProducer,this,{command,args,env,generation}) : spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // POSIX stop requests SIGTERM as its normal cooperative protocol. A handled
    // signal followed by exit0 + close + drained pipes is not forced recovery.
    if (!this.#darwinProducer) require('./owned-process-lifetime.cjs').trackOwnedProcess(this, proc, { gracefulSignal: process.platform !== 'win32' });
    this.process = proc;
    this.onOwnedProcess?.(proc);
    this.processGeneration = generation;
    const managedSource = this.#managedSource = {proof,proc,generation,spawned:false,dispatch:null};
    proc.once('spawn', () => { managedSource.spawned = true; });
    const assetRecord = this.#assetEvidence(state => {
      if (state.records.size >= 32) {
        // Retain bounded unresolved history; lost detail can never mean empty.
        state.fault = true;
        state.unknown = true;
        return;
      }
      const record = { proc, generation, hadPid: !!proc.pid };
      state.records.set(proc, record);
      return record;
    });
    intent.generation = generation;
    intent.proc = proc;
    for (const owned of this.operations) {
      if (owned.intent === intent && owned.used) owned.generation = generation;
    }

    this.readyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finishResolve = value => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        resolve(value);
      };
      const finishReject = error => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        reject(error);
      };
      const startupTimer = setTimeout(() => {
        const error = new Error('VOICE_RUNTIME_START_TIMEOUT');
        finishReject(error);
        // Use the same tracked cancellation barrier as request timeout. In
        // particular, Windows leader exit alone cannot authorize asset cleanup.
        this._stop(error, false).catch(() => {});
      }, 30000);
      token.rejectReady = finishReject;

      const onError = error => {
        this.#assetEvidence(state => {
          if (!assetRecord || state.records.get(proc) !== assetRecord) return;
          // Only the original failed-spawn error proves an absent child. A
          // live-child signal/stdio error or mere missing PID is not no-spawn.
          if (!assetRecord.hadPid && !proc.pid && typeof error.syscall === 'string' &&
              error.syscall.startsWith('spawn ')) state.records.delete(proc);
          else state.unknown = true;
        });
        finishReject(error);
        if (this.process === proc) {
          this._rejectPending(error);
          // An error on a live child (e.g. failed signal) is not an observed exit.
          if (!proc.pid) {
            intent.error ||= error;
            if (this.startIntent === intent) this.startIntent = { error: null };
            this.process = null;
            this.readyPromise = null;
            this.processGeneration = null;
          }
        }
      };
      proc.on('error', onError);
      const onStdinError = error => {
        if (this.process === proc) this._rejectPending(error);
      };
      proc.stdin.on('error', onStdinError);
      proc.once('close', () => {
        lines.close();
        lines.removeAllListeners('line');
        proc.stderr.removeListener('data', onStderr);
        proc.stdin.removeListener('error', onStdinError);
        proc.removeListener('error', onError);
      });
      proc.once('exit', (code, signal) => {
        this.#assetEvidence(state => {
          if (!assetRecord || state.records.get(proc) !== assetRecord) return;
          assetRecord.exited = true;
          if (!assetRecord.attempt && !this.#darwinProducer) state.unknown = true;
        });
        const error = new Error(`VOICE_RUNTIME_EXITED code=${code} signal=${signal}`);
        finishReject(error);
        // An admission fixed to this generation cannot borrow its replacement.
        // A stop already owns its own (possibly Windows-unknown) confirmation.
        if (!intent.error) {
          intent.error = error;
          if (this.startIntent === intent) this.startIntent = { error: null };
          const affected = [...this.operations].filter(owned => owned.intent === intent && owned.used);
          if (process.platform === 'win32' && affected.length) {
            // An unsolicited leader exit cannot confirm descendants for an
            // outstanding opt-in receipt. Legacy-only lifecycles are unchanged.
            const unknown = new Error('VOICE_OPERATION_ORIGINAL_TREE_UNCONFIRMED');
            this.terminationFailure ||= unknown;
            intent.confirmation = Promise.reject(this.terminationFailure);
            intent.confirmation.catch(() => {});
            for (const owned of affected) { owned.denied = true; owned.status = 'unconfirmed'; }
          }
        }
        lines.close();
        lines.removeAllListeners('line');
        proc.stderr.removeListener('data', onStderr);
        if (this.#darwinProducer) {proc.stdout.resume();proc.stderr.resume();}
        if (this.process === proc) {
          this._rejectPending(error);
          this.process = null;
          this.readyPromise = null;
          this.processGeneration = null;
        }
        this._notifyOperations([...this.operations].filter(owned => owned.intent === intent));
      });

      const onStderr = chunk => {
        if (this.process !== proc) return;
        const text = chunk.toString();
        try { this.onStderr?.(text); } catch {}
        for (const match of text.matchAll(/REQUEST_STARTED:([a-zA-Z0-9_-]+):(\S+)/g)) {
          const entry = this.pending.get(match[1]);
          try { entry?.onStarted?.({ id: match[1], method: match[2] }); } catch {}
        }
        console.error(`[voice-runtime] ${text.trimEnd()}`);
      };
      proc.stderr.on('data', onStderr);
      const lines = readline.createInterface({ input: proc.stdout });
      lines.on('line', line => {
        if (this.process !== proc) return;
        let message;
        try { message = JSON.parse(line); }
        catch { return console.error(`[voice-runtime] ignored non-JSON stdout: ${line}`); }
        if (!message || typeof message !== 'object') return;
        if (message.event === 'ready') {
          finishResolve(message);
          return;
        }
        if (!message.id) return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        if (entry.operation) {
          const owned = entry.operation;
          if (owned.status !== 'running' || owned.nativeRequestId !== message.id ||
              owned.generation !== generation || owned.intent.proc !== proc ||
              (message.success !== true && !(message.success === false && typeof message.error?.message === 'string'))) return;
          owned.status = 'completed';
          owned.terminal = { ...this._operationSnapshot(owned).binding,
            nativeRequestId: message.id, success: message.success };
          this.operations.delete(owned);
        }
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.success) entry.resolve(message.result);
        else {
          const error = new Error(message.error?.message || 'VOICE_RUNTIME_ERROR');
          error.code = message.error?.code;
          entry.reject(error);
        }
        if (entry.operation) this._notifyOperations([entry.operation]);
      });
    });

    const ready = this.readyPromise;
    this._notifyOperations([...this.operations].filter(owned => owned.intent === intent && owned.used));
    return ready;
  }

  identity() {
    const proc = this.process;
    if (!proc || !Number.isSafeInteger(proc.pid) || proc.pid <= 0 ||
        proc.exitCode !== null || proc.signalCode !== null) return null;
    return Object.freeze({ pid: proc.pid, processGeneration: this.processGeneration, executable: this.command });
  }

  async request(method, params = {}, { signal, onStarted, [operationKey]: operation } = {}) {
    const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    if (signal?.aborted) throw abortError();
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        if (operation?.rejectStartup === fail) operation.rejectStartup = null;
      };
      const fail = error => { cleanup(); reject(error); };
      const onAbort = () => {
        fail(abortError());
        // An opt-in listener owns only its original receipt, never the current
        // client intent. Original confirmation failure remains on that receipt.
        (operation ? this._cancelOperation(operation) : this.cancel()).catch(() => {});
      };
      if (operation) operation.rejectStartup = fail;
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      this.start(operation).then(value => {
        cleanup();
        resolve(value);
      }, fail);
    });
    if (signal?.aborted) throw abortError();
    this._checkOperation(operation);
    // The trusted synchronous gate may itself abort the original request.
    if (signal?.aborted) {
      (operation ? this._cancelOperation(operation) : this.cancel()).catch(() => {});
      throw abortError();
    }
    if (!this.process?.stdin?.writable) throw new Error('VOICE_RUNTIME_NOT_RUNNING');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const fail = error => { cleanup(); reject(error); };
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        fail(abortError());
        this.cancel().catch(() => {});
      };
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        fail(new Error(`VOICE_RUNTIME_REQUEST_TIMEOUT:${method}`));
        this.cancel().catch(() => {});
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: fail, timer, onStarted, operation });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      try {
        const payload = `${JSON.stringify({ id, method, params })}\n`;
        // User serialization can synchronously abort/stop and settle this entry.
        if (!this.pending.has(id)) return;
        this._checkOperation(operation);
        if (signal?.aborted) { onAbort(); return; }
        if (!this.pending.has(id)) return;
        if (operation) {
          operation.status = 'running';
          operation.nativeRequestId = id;
        }
        this.process.stdin.write(payload, error => {
          if (error) fail(error);
        });
        if (this.#managedSource?.proc === this.process && ['runtime.health','stt.transcribe','tts.synthesize'].includes(method)) {
          this.#managedSource.dispatch = Object.freeze({method,nativeRequestId:id,intentId:operation?.intent.id || null});
        }
        if (operation) this._notifyOperations([operation]);
      } catch (error) { fail(error); }
    });
  }

  _cleanup() {
    if (!this.cleanupPromise) {
      const cleanup = Promise.resolve().then(() => this.afterExit?.()).catch(error => {
        if (this.cleanupPromise === cleanup) this.cleanupPromise = null;
        throw error;
      });
      this.cleanupPromise = cleanup;
    }
    return this.cleanupPromise;
  }

  cancel() {
    return this._stop(new Error('VOICE_RUNTIME_CANCELLED'), false);
  }

  stop(pendingError = new Error('VOICE_RUNTIME_STOPPED')) {
    return this._stop(pendingError, true);
  }

  _trackStop(operation) {
    const barrier = operation.finally(() => {
      if (this.stopPromise === barrier) {
        this.stopPromise = null;
        this.cleanupQueued = false;
      }
    });
    this.stopPromise = barrier;
    return barrier;
  }

  _stop(pendingError, releaseAssets) {
    const intent = this.startIntent;
    intent.error = pendingError;
    const affected = [...this.operations].filter(owned => owned.intent === intent);
    for (const owned of affected) {
      owned.denied = true;
      owned.status = 'stopping';
      // Settle/detach the logical wait, without releasing intent.work or assets.
      owned.rejectStartup?.(pendingError);
    }
    let confirm, unconfirm;
    intent.confirmation = new Promise((resolve, reject) => { confirm = resolve; unconfirm = reject; });
    intent.confirmation.catch(() => {});
    const trackReceipts = barrier => {
      barrier.then(() => {
        for (const owned of affected) {
          owned.status = 'confirmed';
          this.operations.delete(owned);
        }
        confirm();
        this._notifyOperations(affected);
      }, error => {
        for (const owned of affected) owned.status = 'unconfirmed';
        unconfirm(error);
        this._notifyOperations(affected);
      });
      return barrier;
    };
    this.startIntent = { error: null };
    this.startToken?.cancel(pendingError);
    this._rejectPending(pendingError);
    const publish = barrier => { this._notifyOperations(affected); return barrier; };
    if (this.terminationFailure) return publish(trackReceipts(Promise.reject(this.terminationFailure)));
    if (this.stopPromise) {
      // This new intent cannot have spawned/prepared while the old stop is
      // outstanding. Drain only its own work, not the old native/asset result.
      // The old intent keeps its independent, possibly unconfirmed receipt.
      trackReceipts(Promise.resolve(intent.work).catch(() => {}));
      if (releaseAssets && !this.cleanupQueued) {
        this.cleanupQueued = true;
        return publish(this._trackStop(this.stopPromise.then(() => this._cleanup())));
      }
      return publish(this.stopPromise);
    }
    const proc = this.process;
    let operation = Promise.all([
      proc ? this._terminate(proc) : this.#darwinProducer ? require('./darwin-owned-lifetime.cjs').closeDarwinOwner(
        this.#darwinProducer,this,this.stopGraceMs,this.stopKillWaitMs) : Promise.resolve(),
      this.startWork?.catch(() => {}),
    ]);
    trackReceipts(operation); // native/preparation drain is distinct from asset cleanup
    if (releaseAssets) {
      this.cleanupQueued = true;
      operation = operation.then(() => this._cleanup());
    }
    return publish(this._trackStop(operation));
  }

  _terminate(proc) {
    if (this.#darwinProducer) return require('./darwin-owned-lifetime.cjs').closeDarwinGeneration(
      this.#darwinProducer,this,proc,this.stopGraceMs,this.stopKillWaitMs);
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    const assetAttempt = this.#assetEvidence(state => {
      const record = state.records.get(proc);
      if (!record) return;
      if (record.attempt || (process.platform === 'win32' &&
          (!Number.isSafeInteger(proc.pid) || proc.pid <= 0))) {
        state.unknown = true;
        return;
      }
      // Bind before the original utility/signal call can synchronously reenter.
      const attempt = { record };
      record.attempt = attempt;
      return attempt;
    });
    return new Promise((resolve, reject) => {
      let done = false;
      let forceTimer;
      let finalTimer;
      let utility;
      let utilityDone = process.platform !== 'win32';
      let exited = false;
      const finish = error => {
        if (done) return;
        done = true;
        this.#assetEvidence(state => {
          if (!assetAttempt) return;
          const record = assetAttempt.record;
          if (state.records.get(proc) !== record || record.attempt !== assetAttempt) return;
          // The existing finish path supplies utility success AND original exit.
          // Late outcomes can compact only this original record, never history.
          if (!error && utilityDone && exited && record.exited) state.records.delete(proc);
          else state.unknown = true;
        });
        clearTimeout(forceTimer);
        clearTimeout(finalTimer);
        proc.removeListener('exit', onExit);
        proc.removeListener('error', onError);
        if (!utilityDone) { try { utility?.kill('SIGKILL'); } catch {} }
        if (error) {
          // Leader exit cannot establish Windows descendant termination. Preserve
          // an unknown tree verdict even after the lifecycle clears this.process.
          if (process.platform === 'win32') this.terminationFailure = error;
          reject(error);
        } else resolve();
      };
      const onExit = () => { exited = true; if (utilityDone) finish(); };
      const onError = error => finish(error);
      proc.once('exit', onExit);
      proc.once('error', onError);
      finalTimer = setTimeout(() => finish(new Error('VOICE_RUNTIME_TERMINATION_TIMEOUT')),
        this.stopGraceMs + this.stopKillWaitMs);
      if (process.platform === 'win32' && proc.pid) {
        // Keep the leader alive for tree enumeration: do not request EOF first.
        // Utility success is not child-exit confirmation. Both must be observed.
        // Async + an independent deadline: a hung taskkill never blocks Electron.
        try {
          utility = require('node:child_process').execFile('taskkill.exe',
            ['/PID', String(proc.pid), '/T', '/F'], {
              windowsHide: true, shell: false,
              timeout: this.stopGraceMs + this.stopKillWaitMs, killSignal: 'SIGKILL',
            }, error => {
              if (done) return;
              utilityDone = true;
              if (error) finish(error);
              else if (exited) finish();
            });
        } catch (error) { finish(error); }
      } else {
        try { proc.stdin.end(); } catch {}
        forceTimer = setTimeout(() => {
          // killed only means a signal was sent, not that the child exited.
          try { proc.kill('SIGKILL'); } catch (error) { finish(error); }
        }, this.stopGraceMs);
        try { proc.kill('SIGTERM'); } catch (error) { finish(error); }
      }
    });
  }
}

module.exports = { SidecarClient };
