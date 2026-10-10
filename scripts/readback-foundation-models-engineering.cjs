'use strict';
// Read-only: no compiler, helper, Electron, model, git or other child execution.
const fs = require('node:fs');
const path = require('node:path');
const { readBounded, digest, CAPTURE_FILES, captureCap, validateSourceMap } = require('./build-foundation-models.cjs');
const fail = () => { throw Error('FM_READBACK_BINDING'); };
const requireThat = value => { if (!value) fail(); };
const equal = require('node:util').isDeepStrictEqual;
const unavailable = ['unsupported-os', 'device-not-eligible', 'intelligence-disabled', 'model-not-ready', 'unavailable'];
function readUi(output, expectedReceipt, engineering, metadata) {
  const directory = fs.realpathSync(output), receipts = {}, cache = new Map(); let readBytes = 0;
  const raw = (name, cap = 65536) => {
    if (cache.has(name)) return cache.get(name);
    const file = path.join(directory, name); requireThat(fs.realpathSync(file) === file);
    const bytes = readBounded(file, cap); readBytes += bytes.length; requireThat(readBytes <= 1024 * 1024);
    receipts[name] = { bytes: bytes.length, sha256: digest(bytes) }; cache.set(name, bytes); return bytes;
  };
  const capture = JSON.parse(raw('completion.root.json'));
  requireThat(expectedReceipt && equal(expectedReceipt, receipts['completion.root.json']));
  requireThat(capture.protocol === 1 && capture.kind === 'ui' && equal(Object.keys(capture.receipts).sort(), [...CAPTURE_FILES.ui].sort()));
  for (const name of CAPTURE_FILES.ui) {
    if (capture.receipts[name] === null) { requireThat(!fs.existsSync(path.join(directory, name))); continue; }
    raw(name, captureCap(name)); requireThat(equal(capture.receipts[name], receipts[name]));
  }
  const u = JSON.parse(raw('ui.metadata.export.json')), p = JSON.parse(raw('ui.private.json'));
  requireThat(u.protocol === 1 && equal(p.owner, u.owner) && p.evidence === 'PROCESSED_CDP_RESULTS_NOT_RAW_WIRE');
  requireThat(Array.isArray(p.observations) && p.observations.length <= 192 && ['PASS', 'UNAVAILABLE', 'STOP'].includes(u.status));
  if (u.final !== undefined) requireThat(u.final === metadata.final && u.closure === metadata.closure && u.tier === metadata.tier);
  if (u.engineeringReceipt !== undefined) requireThat(equal(u.engineeringReceipt, engineering['completion.root.json']) && equal(u.binary, metadata.binary));
  requireThat(typeof u.owner.started === 'boolean' && typeof u.owner.closed === 'boolean' && u.owner.descendants === 'NOT_OBSERVED');
  if (u.owner.started) requireThat(u.owner.closed === true && u.owner.state !== 'UNKNOWN');
  if (u.status === 'STOP') {
    requireThat(/^FM_[A-Z_]+$/.test(u.error || '') && (!p.anomaly || u.error === p.anomaly));
    return { status: 'READBACK_STOP', producerStatus: u.status, reason: u.error, receipts, readBytes };
  }
  requireThat(!u.error && p.anomaly === null && u.owner.started === true && u.owner.closed === true && u.owner.exitCode === 0 && u.owner.signal === null);
  requireThat(u.final === metadata.final && u.closure === metadata.closure && u.native === metadata.native.status && equal(u.engineeringReceipt, engineering['completion.root.json']));
  if (u.tier === 'MAC_ENGINEERING_NOT_RELEASE') {
    requireThat(receipts['source-map.json']?.sha256 === metadata.closure);
    for (const [label, value] of [['git-status', ''], ['git-head', metadata.final], ['git-detached', 'HEAD']]) {
      const owner = JSON.parse(raw(label + '.json'));
      requireThat(owner.state === 'EXITED' && owner.exitCode === 0 && owner.reason === null && owner.signal === null && raw(label + '.stdout').toString().trim() === value);
    }
  }
  const rows = p.observations;
  requireThat(rows.length >= 2 && rows.at(-1).stage === 'exercise' && equal(rows.at(-1).value, u.visibleUi));
  requireThat(rows.slice(0, -1).every((r, i) => r.stage === 'ready' && r.value === (i === rows.length - 2)));
  const v = u.visibleUi; requireThat(v.status === u.status);
  if (v.status === 'PASS') requireThat(v.connectionTests === 2 && v.runtime === 'electron' && v.speechReady === false && v.stop === 'CONFIRMED');
  else requireThat(v.connectionTests === 0 && typeof v.reason === 'string' && v.reason.length <= 128);
  requireThat(receipts['launch.private.json'] && receipts['electron.stdout'] && receipts['electron.stderr']);
  return { status: 'READBACK_VERIFIED', producerStatus: u.status, visibleUi: v.status, scope: 'SETTINGS_TWO_CONNECTION_TESTS_CANCEL_GENERATION_ONLY', receipts, readBytes };
}
function readback(output, { root = path.resolve(__dirname, '..'), expectedReceipt, final, closure, uiOutput, uiExpectedReceipt } = {}) {
  try {
    const directory = fs.realpathSync(output), receipts = {};
    let readBytes = 0; const cache = new Map();
    function raw(name, cap = 65536) {
      if (cache.has(name)) return cache.get(name);
      const file = path.join(directory, name);
      requireThat(fs.realpathSync(file) === file);
      const bytes = readBounded(file, cap); readBytes += bytes.length;
      requireThat(readBytes <= 20 * 1024 * 1024);
      receipts[name] = { bytes: bytes.length, sha256: digest(bytes) }; cache.set(name, bytes); return bytes;
    }
    const decode = name => JSON.parse(raw(name));
    const rootBytes = raw('completion.root.json');
    if (expectedReceipt) requireThat(equal(expectedReceipt, receipts['completion.root.json']));
    const capture = JSON.parse(rootBytes);
    requireThat(capture.protocol === 1 && capture.kind === 'engineering' && equal(Object.keys(capture.receipts).sort(), [...CAPTURE_FILES.engineering].sort()));
    for (const name of CAPTURE_FILES.engineering) {
      if (capture.receipts[name] === null) { requireThat(!fs.existsSync(path.join(directory, name))); continue; }
      raw(name, captureCap(name)); requireThat(equal(capture.receipts[name], receipts[name]));
    }
    const binding = expectedReceipt ? 'EXTERNAL_CAPTURE_ROOT' : 'LOCAL_CONSISTENCY_ONLY';
    const metadata = decode('metadata.export.json');
    if (final !== undefined && metadata.final !== undefined) requireThat(metadata.final === final);
    if (closure !== undefined && metadata.closure !== undefined) requireThat(metadata.closure === closure);
    requireThat(metadata.protocol === 1 && metadata.signing === 'NOT_REQUESTED' && metadata.visibleUi === 'NOT_RUN');
    if (metadata.build === 'NOT_RUN') {
      requireThat(metadata.status === 'STOP' && metadata.native.status === 'NOT_RUN' && /^FM_[A-Z_]+$/.test(metadata.error));
      return { status: 'READBACK_STOP', producerStatus: metadata.status, native: 'NOT_RUN', reason: metadata.error, binding, receipts, readBytes };
    }
    requireThat(metadata.build === 'PASS' && metadata.platform === 'darwin' && metadata.arch === 'arm64');
    requireThat(/^[a-f0-9]{40}$/.test(metadata.final) && /^[a-f0-9]{64}$/.test(metadata.closure));
    requireThat(['MAC_ENGINEERING_NOT_RELEASE', 'CONTROLLED_FIXTURE_NOT_NATIVE'].includes(metadata.tier));
    if (metadata.tier === 'MAC_ENGINEERING_NOT_RELEASE') {
      requireThat(receipts['source-map.json']?.sha256 === metadata.closure);
      const map = validateSourceMap(JSON.parse(raw('source-map.json', 256 * 1024)));
      for (const [name, expected] of Object.entries(map.files)) {
        const file = path.join(fs.realpathSync(root), name); requireThat(fs.realpathSync(file) === file);
        const bytes = readBounded(file); readBytes += bytes.length; requireThat(readBytes <= 20 * 1024 * 1024);
        requireThat(equal(expected, { bytes: bytes.length, sha256: digest(bytes) }));
      }
      for (const [label, value] of [['git-status', ''], ['git-head', metadata.final], ['git-detached', 'HEAD']]) {
        const owner = decode(label + '.json');
        requireThat(owner.state === 'EXITED' && owner.exitCode === 0 && owner.reason === null && owner.signal === null);
        requireThat(raw(label + '.stdout').toString().trim() === value);
      }
    }
    const build = decode('foundation-models/build.private.json');
    const manifest = decode('foundation-models/manifest.json');
    const binary = raw('foundation-models/voice-foundation-models', 16 * 1024 * 1024);
    requireThat(build.protocol === 1 && build.status === 'PASS' && build.platform === 'darwin' && build.arch === 'arm64' && build.signing === metadata.signing);
    requireThat(equal(build.binary, metadata.binary) && equal(build.source, metadata.source));
    requireThat(binary.length > 0 && equal(build.binary, receipts['foundation-models/voice-foundation-models']));
    const source = readBounded(path.join(fs.realpathSync(root), 'native/apple/FoundationModelsHelper.swift'), 128 * 1024); readBytes += source.length;
    requireThat(equal(build.source, { bytes: source.length, sha256: digest(source) }));
    requireThat(manifest.protocol === 1 && manifest.arch === 'arm64' && manifest.sha256 === build.binary.sha256 && manifest.sourceSha256 === build.source.sha256);
    for (const [label, summary] of [['version', build.version], ['compile', build.compiler]]) {
      const owner = decode('foundation-models/' + label + '.json');
      requireThat(equal(owner, summary) && owner.state === 'EXITED' && owner.exitCode === 0 && owner.signal === null && owner.reason === null && owner.descendants === 'NOT_OBSERVED');
      raw('foundation-models/' + label + '.stdout'); raw('foundation-models/' + label + '.stderr');
    }
    requireThat(equal(metadata.compiler, { state: build.compiler.state, exitCode: build.compiler.exitCode, reason: build.compiler.reason, descendants: build.compiler.descendants }));
    const helper = decode('helper.private.json'), n = helper.result;
    requireThat(equal(n, metadata.native) && Array.isArray(helper.owners) && helper.owners.length <= 1 && Array.isArray(helper.responses) && helper.responses.length <= 4);
    requireThat(n.exit === 'EXITED' && helper.owners.every(o => o.started === true && o.closed === true && (o.exitCode === 0 && o.signal === null || o.exitCode === null && ['SIGTERM', 'SIGKILL'].includes(o.signal))));
    const replies = helper.responses;
    for (let i = 0; i < replies.length; i++) {
      const r = replies[i]; requireThat(r.method === (i ? 'generate' : 'availability'));
      if (r.error !== undefined) requireThat(typeof r.error === 'string' && /^FM_[A-Z_]+$/.test(r.error) && r.reply === undefined);
      else if (i === 0) requireThat(r.reply && Object.keys(r.reply).join() === 'reason' && ['available', ...unavailable].includes(r.reply.reason));
      else requireThat(r.reply && Object.keys(r.reply).join() === 'text' && typeof r.reply.text === 'string' && r.reply.text.trim() && Buffer.byteLength(r.reply.text) <= 8192);
    }
    requireThat(Number.isInteger(n.generations) && n.generations >= 0 && n.generations <= 2);
    if (n.status === 'PASS') {
      requireThat(metadata.status === 'ENGINEERING_HELPER_PASS_UI_NOT_RUN' && helper.owners.length === 1 && replies.length === 4 && replies[0].reply?.reason === 'available');
      requireThat(replies[1].reply?.text && replies[2].reply?.text && n.generations === 2 && n.reason === 'available' && n.cancel === 'helper-exited');
      requireThat(n.cancelOutcome === 'FM_CANCELLED' && (replies[3].error === 'FM_CANCELLED' || replies[3].reply?.text) || n.cancelOutcome === 'COMPLETED_BEFORE_STOP' && replies[3].reply?.text);
    } else if (n.status === 'UNAVAILABLE') {
      requireThat(metadata.status === 'UNAVAILABLE' && helper.owners.length === 1 && replies.length === 1 && unavailable.includes(n.reason) && replies[0].reply?.reason === n.reason && n.generations === 0 && n.cancel === 'NOT_RUN');
    } else {
      requireThat(n.status === 'STOP' && metadata.status === 'STOP' && (n.error || replies.some(r => r.error)));
    }
    const ui = uiOutput ? readUi(uiOutput, uiExpectedReceipt, receipts, metadata) : undefined;
    return { status: n.status === 'STOP' || ui?.status === 'READBACK_STOP' ? 'READBACK_STOP' : 'READBACK_VERIFIED', producerStatus: metadata.status, native: n.status, reason: n.error || n.reason, ui,
      final: metadata.final, closure: metadata.closure, tier: metadata.tier, binding,
      replyEvidence: 'PROCESSED_CLIENT_VALIDATED_RESULTS_NOT_RAW_JSONL_OR_ID_RECEIPTS', owners: 'FIRST_PARTY_MAIN_PROCESSES_ONLY_NOT_DESCENDANTS', receipts, readBytes };
  } catch { fail(); }
}
module.exports = { readback };
if (require.main === module) {
  try {
    const expected = JSON.parse(readBounded(process.argv[3], 65536)); requireThat(expected.receipt);
    const uiExpected = process.argv[7] ? JSON.parse(readBounded(process.argv[7], 65536)) : undefined;
    const result = readback(process.argv[2], { expectedReceipt: expected.receipt, final: process.argv[4], closure: process.argv[5], uiOutput: process.argv[6], uiExpectedReceipt: uiExpected?.receipt });
    requireThat(expected.status === result.producerStatus && expected.native === result.native);
    if (uiExpected) requireThat(uiExpected.status === result.ui.producerStatus);
    console.log(JSON.stringify(result)); if (result.status === 'READBACK_STOP') process.exitCode = 1;
  }
  catch { console.log(JSON.stringify({ status: 'READBACK_REFUSED', error: 'FM_READBACK_BINDING' })); process.exitCode = 1; }
}
