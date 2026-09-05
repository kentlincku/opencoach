const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

function killProcessTree(pid) {
  if (!pid || process.platform !== 'win32') return;
  try {
    const { spawnSync } = require('node:child_process');
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {}
}

class SidecarClient {
  constructor({
    command,
    args = [],
    env = process.env,
    requestTimeoutMs = 120000,
    stopGraceMs = 2000,
    stopKillWaitMs = 3000,
    beforeSpawn = null,
    afterExit = null,
    onStderr = null,
  }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stopGraceMs = stopGraceMs;
    this.stopKillWaitMs = stopKillWaitMs;
    this.beforeSpawn = beforeSpawn;
    this.afterExit = afterExit;
    this.onStderr = onStderr;
    this.cleanupPromise = null;
    this.process = null;
    this.pending = new Map();
    this.readyPromise = null;
    this.processGeneration = null;
    this.stopPromise = null;
  }

  _cleanup() {
    if (!this.cleanupPromise) this.cleanupPromise = Promise.resolve().then(() => this.afterExit?.());
    return this.cleanupPromise;
  }

  _rejectPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async start() {
    if (this.stopPromise) await this.stopPromise;
    if (this.process) return this.readyPromise;

    if (this.beforeSpawn) this.beforeSpawn();
    const proc = spawn(this.command, this.args, {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = proc;
    this.processGeneration = randomUUID();

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
        if (!proc.killed) proc.kill();
      }, 30000);

      proc.once('error', error => {
        finishReject(error);
        this._rejectPending(error);
        if (this.process === proc) {
          this.process = null;
          this.readyPromise = null;
        }
      });
      proc.once('exit', (code, signal) => {
        const error = new Error(`VOICE_RUNTIME_EXITED code=${code} signal=${signal}`);
        finishReject(error);
        this._rejectPending(error);
        if (this.process === proc) {
          this.process = null;
          this.readyPromise = null;
        }
      });

      proc.stderr.on('data', chunk => {
        const text = chunk.toString();
        if (typeof this.onStderr === 'function') {
          try { this.onStderr(text); } catch {}
        }
        const match = text.match(/REQUEST_STARTED:([a-zA-Z0-9_-]+):(\S+)/);
        if (match) {
          const [, startedId, startedMethod] = match;
          const entry = this.pending.get(startedId);
          if (entry && typeof entry.onStarted === 'function') {
            try { entry.onStarted({ id: startedId, method: startedMethod }); } catch {}
          }
        }
        console.error(`[voice-runtime] ${text.trimEnd()}`);
      });
      const lines = readline.createInterface({ input: proc.stdout });
      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); }
        catch { return console.error(`[voice-runtime] ignored non-JSON stdout: ${line}`); }
        if (message.event === 'ready') {
          finishResolve(message);
          return;
        }
        if (!message.id) return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.success) entry.resolve(message.result);
        else {
          const error = new Error(message.error?.message || 'VOICE_RUNTIME_ERROR');
          error.code = message.error?.code;
          entry.reject(error);
        }
      });
    });

    return this.readyPromise;
  }

  async request(method, params = {}, { signal, onStarted } = {}) {
    if (signal?.aborted) {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    await this.start();
    if (signal?.aborted) {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (!this.process?.stdin?.writable) throw new Error('VOICE_RUNTIME_NOT_RUNNING');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let abortHandler = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        this.pending.delete(id);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`VOICE_RUNTIME_REQUEST_TIMEOUT:${method}`));
      }, this.requestTimeoutMs);

      if (signal) {
        abortHandler = () => {
          cleanup();
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
          this.stop().catch(() => {});
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      this.pending.set(id, {
        resolve: result => {
          cleanup();
          resolve(result);
        },
        reject: error => {
          cleanup();
          reject(error);
        },
        onStarted,
        timer,
      });

      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (!error) return;
        cleanup();
        reject(error);
      });
    });
  }

  identity() {
    const proc = this.process;
    if (!proc || !Number.isSafeInteger(proc.pid) || proc.pid <= 0 || proc.exitCode !== null) return null;
    return Object.freeze({
      pid: proc.pid,
      processGeneration: this.processGeneration,
      executable: this.command,
    });
  }

  async cancel() {
    return this.stop(new Error('VOICE_RUNTIME_CANCELLED'));
  }

  async stop(pendingError = new Error('VOICE_RUNTIME_STOPPED')) {
    if (this.stopPromise) return this.stopPromise;
    const proc = this.process;
    if (!proc) return this._cleanup();
    const pid = proc.pid;
    this._rejectPending(pendingError);

    this.stopPromise = new Promise((resolve, reject) => {
      let settled = false;
      let forceTimer;
      let finalTimer;
      const clearTimers = () => {
        clearTimeout(forceTimer);
        clearTimeout(finalTimer);
      };
      const observedExit = () => {
        clearTimers();
        if (this.process === proc) {
          this.process = null;
          this.readyPromise = null;
        }
        if (settled) return;
        settled = true;
        this.stopPromise = null;
        resolve();
      };
      const terminationError = error => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.stopPromise = null;
        reject(error);
      };
      proc.once('exit', observedExit);
      proc.once('close', observedExit);
      proc.once('error', error => terminationError(error));
      try { proc.stdin.end(); } catch {}
      if (process.platform === 'win32' && pid) {
        killProcessTree(pid);
      } else {
        try { proc.kill('SIGTERM'); }
        catch (error) { return terminationError(error); }
        forceTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); }
          catch (error) { terminationError(error); }
        }, this.stopGraceMs);
      }
      finalTimer = setTimeout(() => {
        terminationError(new Error('VOICE_RUNTIME_TERMINATION_TIMEOUT'));
      }, this.stopGraceMs + this.stopKillWaitMs);
    });
    try {
      await this.stopPromise;
      if (pendingError.message !== 'VOICE_RUNTIME_CANCELLED') await this._cleanup();
    } finally {
      this.stopPromise = null;
    }
  }
}

module.exports = { SidecarClient, killProcessTree };
