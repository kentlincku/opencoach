'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { FoundationModelsClient } = require('./foundation-models-client.cjs');
const { normalizeFoundationModelsRequest } = require('../web/runtime/llm-provider-contract.js');

async function helperLaunch({ root, packaged, resourcesPath, arch }) {
  const directory = packaged ? path.join(resourcesPath, 'foundation-models') : path.join(root, 'build/foundation-models', arch);
  const command = path.join(directory, 'voice-foundation-models');
  const manifestPath = path.join(directory, 'manifest.json');
  try {
    for (const file of [command, manifestPath]) {
      if (await fs.realpath(file) !== file) throw new Error('FM_HELPER_INTEGRITY');
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > (file === command ? 16 * 1024 * 1024 : 4096)) throw new Error('FM_HELPER_INTEGRITY');
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (Object.keys(manifest).sort().join() !== 'arch,protocol,sha256,sourceSha256' || manifest.protocol !== 1 || manifest.arch !== arch
      || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)) throw new Error('FM_HELPER_INTEGRITY');
    const hash = createHash('sha256').update(await fs.readFile(command)).digest('hex');
    if (hash !== manifest.sha256) throw new Error('FM_HELPER_INTEGRITY');
    // Always verify the actual helper bytes, including packaged execution.
    // A signing step that changes those bytes needs a reviewed final-byte binding;
    // do not accept a stale pre-sign manifest by skipping this check.
    await fs.access(command, fs.constants.X_OK);
    // Hashes detect stale/corrupted bundle bytes, not publisher authenticity.
    // Packaged authenticity belongs to the signed app bundle. Dev is NOT that boundary.
    return { command, args: [], env: { LANG: 'en_US.UTF-8' } };
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? 'FM_HELPER_MISSING' : 'FM_HELPER_INTEGRITY');
  }
}
class FoundationModelsService {
  constructor(config) {
    this.platform = config.platform; this.arch = config.arch; this.closed = false;
    this.owners = new WeakMap(); this.active = null;
    this.client = config.client || new FoundationModelsClient({ resolveLaunch: () => helperLaunch(config) });
  }
  _owner(owner) {
    if (this.closed || !owner?.live) throw new Error('FM_CLOSED');
    let state = this.owners.get(owner);
    if (!state) { state = { sessionId: randomUUID(), seen: new Set(), intents: new Map() }; this.owners.set(owner, state); }
    if (state.closed) throw new Error('FM_CLOSED');
    return state;
  }
  _preparation(payload) {
    if (!payload || Object.keys(payload).join() !== 'preparationId' || typeof payload.preparationId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(payload.preparationId)) throw new Error('INVALID_FM_PAYLOAD');
    return payload.preparationId;
  }
  _intent(state, id) {
    if (!state.intents.has(id)) {
      // Document-lifetime bounded correlation, never TTL/FIFO eviction. Main
      // owns document identity/session authority; renderer IDs only correlate.
      if (state.intents.size >= 4096) { state.exhausted = true; throw new Error('FM_REQUEST_REUSED_OR_QUOTA'); }
      state.intents.set(id, { id, revoked: false });
    }
    return state.intents.get(id);
  }
  async capabilities(owner, payload) {
    const id = payload == null ? randomUUID() : this._preparation(payload);
    const state = this._owner(owner);
    const intent = this._intent(state, id);
    if (intent.revoked) throw new Error('FM_CANCELLED');
    if (state.exhausted) throw new Error('FM_REQUEST_REUSED_OR_QUOTA');
    if (this.active || this.client.stopping || (state.current && !state.current.revoked)) throw new Error('FM_BUSY');
    const record = { owner, intent }; this.active = record;
    state.current = intent;
    state.sessionId = randomUUID(); state.seen.clear();
    let reason = 'unsupported-platform';
    try {
    if (this.platform === 'darwin' && this.arch === 'arm64') {
      this.clientOwner = owner;
      try { reason = (await this.client.request('availability')).reason; }
      catch (error) { reason = ({ FM_HELPER_MISSING: 'helper-missing', FM_HELPER_INTEGRITY: 'helper-integrity', FM_BUSY: 'busy' })[error.message] || 'helper-failed'; }
    }
    this._owner(owner);
    if (intent.revoked || state.current !== intent) throw new Error('FM_CANCELLED');
    return { protocol: 1, platform: this.platform === 'darwin' ? 'macos' : this.platform === 'win32' ? 'windows' : 'desktop',
      state: reason === 'available' ? 'available' : 'unavailable', reason, sessionId: state.sessionId };
    } finally { if (this.active === record) this.active = null; }
  }
  async generate(owner, payload) {
    const input = normalizeFoundationModelsRequest(payload);
    const state = this._owner(owner);
    if (this.platform !== 'darwin' || this.arch !== 'arm64') throw new Error('FM_UNAVAILABLE');
    if (input.sessionId !== state.sessionId || !state.current || state.current.revoked) throw new Error('FM_CANCELLED');
    if (state.exhausted) throw new Error('FM_REQUEST_REUSED_OR_QUOTA');
    if (state.seen.has(input.requestId) || state.seen.size >= 4096) throw new Error('FM_REQUEST_REUSED_OR_QUOTA');
    if (this.active) throw new Error('FM_BUSY');
    state.seen.add(input.requestId);
    const record = { owner, state, sessionId: state.sessionId, requestId: input.requestId }; this.active = record;
    const check = () => {
      this._owner(owner);
      if (state.sessionId !== record.sessionId || this.active !== record) throw new Error('FM_CANCELLED');
    };
    try {
      check();
      const work = this.client.request('generate', { messages: input.messages, maxTokens: input.maxTokens });
      record.native = this.client.pending;
      state.lastGeneration = record; // One passive record per document, no model text.
      const result = await work;
      check(); return { requestId: input.requestId, text: result.text };
    } catch (error) { check(); throw error; }
    finally { if (this.active === record) this.active = null; }
  }
  async cancel(owner, payload) {
    const id = this._preparation(payload);
    const state = this._owner(owner);
    const intent = this._intent(state, id);
    intent.revoked = true; // Also fences capability IPC that has not arrived yet.
    if (intent.stop) return intent.stop;
    if (state.current !== intent) return { state: 'helper-exited' };
    state.sessionId = randomUUID(); state.seen.clear();
    intent.stop = this.client.stop().then(result => ({ state: result.state }));
    return intent.stop;
  }
  closeOwner(owner) {
    const state = this.owners.get(owner);
    if (state) { state.closed = true; state.sessionId = randomUUID(); }
    if (this.clientOwner === owner) return this.client.stop();
    return Promise.resolve();
  }
  shutdown() { this.closed = true; return this.client.shutdown(); }
}
module.exports = { FoundationModelsService, helperLaunch };
