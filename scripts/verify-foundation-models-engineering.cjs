'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { buildHelper, boundedRun, readBounded, exclusiveDirectory, json, digest, captureReceipt, validateSourceMap } = require('./build-foundation-models.cjs');
const { FoundationModelsClient } = require('../apps/desktop/foundation-models-client.cjs');
const { FoundationModelsService, helperLaunch } = require('../apps/desktop/foundation-models-service.cjs');
const MAP = 'scripts/foundation-models-engineering-source.json';
const PUBLIC_MESSAGES = [{ role: 'user', content: 'Say hello in one short English sentence.' }];
async function checkSource({ root, directory, final, closure }) {
  if (!/^[a-f0-9]{40}$/.test(final || '') || !/^[a-f0-9]{64}$/.test(closure || '')) throw Error('FM_SOURCE_PIN_REQUIRED');
  const bytes = readBounded(path.join(root, MAP), 256 * 1024);
  if (digest(bytes) !== closure) throw Error('FM_CLOSURE_PIN_MISMATCH');
  const source = validateSourceMap(JSON.parse(bytes));
  fs.writeFileSync(path.join(directory, 'source-map.json'), bytes, { flag: 'wx', mode: 0o600 });
  for (const [file, expected] of Object.entries(source.files)) {
    if (!/^(apps|native|scripts|tests)\/[A-Za-z0-9_./-]+$/.test(file) && !['.gitignore', 'package.json', 'package-lock.json', 'electron-builder.yml'].includes(file)) throw Error('FM_SOURCE_MAP_SCHEMA');
    const resolved = path.resolve(root, file);
    if (!resolved.startsWith(root + path.sep) || fs.realpathSync(resolved) !== resolved) throw Error('FM_SOURCE_CHANGED');
    const actual = readBounded(resolved);
    if (actual.length !== expected.bytes || digest(actual) !== expected.sha256) throw Error('FM_SOURCE_CHANGED');
  }
  const r = await boundedRun('/usr/bin/git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, directory, label: 'git-status', env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 10000 });
  if (r.reason || r.exitCode !== 0 || readBounded(path.join(directory, 'git-status.stdout'), 65536).length) throw Error('FM_DIRTY_SOURCE');
  for (const [label, args, expected] of [['git-head', ['rev-parse', 'HEAD'], final], ['git-detached', ['rev-parse', '--abbrev-ref', 'HEAD'], 'HEAD']]) {
    const run = await boundedRun('/usr/bin/git', args, { cwd: root, directory, label, env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 10000 });
    if (run.reason || run.exitCode !== 0 || readBounded(path.join(directory, label + '.stdout'), 65536).toString().trim() !== expected) throw Error('FM_FINAL_PIN_MISMATCH');
  }
  return { final, closure, tier: 'MAC_ENGINEERING_NOT_RELEASE' };
}
async function probeHelper({ root, directory, arch = 'arm64', timeoutMs = 60000, stopMs = 1000 }) {
  const responses = [], owners = [], result = { status: 'NOT_RUN', generations: 0, cancel: 'NOT_RUN', exit: 'NOT_RUN' };
  let sent;
  const dispatched = new Promise(resolve => { sent = resolve; });
  const client = new FoundationModelsClient({ timeoutMs, stopMs,
    resolveLaunch: () => helperLaunch({ root, packaged: true, resourcesPath: directory, arch }),
    spawnImpl: (...args) => {
      const child = spawn(...args), owner = { started: false, closed: false, exitCode: null, signal: null };
      owners.push(owner); child.once('spawn', () => { owner.started = true; });
      child.once('close', (code, signal) => { Object.assign(owner, { closed: true, exitCode: code, signal }); });
      const write = child.stdin.write.bind(child.stdin); let generations = 0;
      child.stdin.write = (bytes, ...rest) => { const r = write(bytes, ...rest); if (JSON.parse(bytes).method === 'generate' && ++generations === 3) sent(); return r; };
      return child;
    } });
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    try { const reply = await request(method, params); responses.push({ method, reply }); return reply; }
    catch (error) { responses.push({ method, error: error.message }); throw error; }
  };
  const service = new FoundationModelsService({ platform: 'darwin', arch, client });
  const owner = { live: true }, preparationId = 'engineering-availability';
  try {
    const capability = await service.capabilities(owner, { preparationId });
    result.reason = capability.reason;
    if (capability.state !== 'available') {
      result.status = ['unsupported-os', 'device-not-eligible', 'intelligence-disabled', 'model-not-ready', 'unavailable'].includes(capability.reason) ? 'UNAVAILABLE' : 'STOP';
      return result;
    }
    for (let i = 0; i < 2; i++) {
      const reply = await service.generate(owner, { sessionId: capability.sessionId, requestId: 'engineering-' + i, messages: PUBLIC_MESSAGES, maxTokens: 32 });
      if (!reply.text.trim()) throw Error('FM_EMPTY_REPLY'); result.generations++;
    }
    const active = service.generate(owner, { sessionId: capability.sessionId, requestId: 'engineering-cancel', messages: PUBLIC_MESSAGES, maxTokens: 32 });
    const outcome = active.then(() => 'COMPLETED_BEFORE_STOP', error => error.message);
    // Observe the actual third write, not a sleep or a made-up native cancellation receipt.
    await Promise.race([dispatched, active.then(() => {}, () => {})]);
    result.cancel = (await service.cancel(owner, { preparationId })).state;
    result.cancelOutcome = await outcome;
    if (result.cancel !== 'helper-exited' || !['FM_CANCELLED', 'COMPLETED_BEFORE_STOP'].includes(result.cancelOutcome)) throw Error('FM_CANCEL_FAILED');
    result.status = 'PASS';
  } catch (error) { result.status = 'STOP'; result.error = /^FM_[A-Z_]+$/.test(error.message) ? error.message : 'FM_PROBE_FAILED'; }
  finally {
    try { await service.shutdown(); result.exit = client.proc === null && owners.every(x => x.closed) ? 'EXITED' : 'UNKNOWN'; }
    catch { result.exit = 'UNKNOWN'; result.status = 'STOP'; }
    json(path.join(directory, 'helper.private.json'), { responses, owners, result });
  }
  return result;
}
async function runEngineering({ platform = process.platform, arch = process.arch, root = path.resolve(__dirname, '..'), output,
  final, closure, toolchainRoot, checkSource: check = checkSource, probe = probeHelper } = {}) {
  root = fs.realpathSync(root);
  const directory = exclusiveDirectory(output);
  const metadata = { protocol: 1, status: 'STOP', tier: 'NOT_ADMITTED', node: process.version, platform, arch, osRelease: os.release(),
    build: 'NOT_RUN', native: { status: 'NOT_RUN' }, visibleUi: 'NOT_RUN', signing: 'NOT_REQUESTED' };
  try {
    if (platform !== 'darwin' || arch !== 'arm64') throw Error('FM_MAC_ARM64_REQUIRED');
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('FM_NODE_22_REQUIRED');
    Object.assign(metadata, await check({ root, directory, final, closure }));
    const built = await buildHelper({ platform, arch, root, output: path.join(directory, 'foundation-models'), toolchainRoot });
    metadata.build = built.status;
    metadata.source = built.source; metadata.binary = built.binary;
    metadata.compiler = { state: built.compiler.state, exitCode: built.compiler.exitCode, reason: built.compiler.reason, descendants: built.compiler.descendants };
    const version = readBounded(path.join(directory, 'foundation-models/version.stdout'), 65536).toString();
    metadata.swiftVersion = version.match(/Swift version ([0-9]+(?:\.[0-9]+){1,2})/)?.[1] || 'UNRECOGNIZED';
    metadata.toolchain = 'EXISTING_CLT'; metadata.sdk = path.basename(built.toolchain.sdk);
    metadata.native = await probe({ root, directory, arch });
    metadata.status = metadata.native.status === 'PASS' ? 'ENGINEERING_HELPER_PASS_UI_NOT_RUN' : metadata.native.status;
  } catch (error) { metadata.error = /^FM_[A-Z_]+$/.test(error.message) ? error.message : 'FM_ENGINEERING_IO_FAILED'; }
  finally { json(path.join(directory, 'metadata.export.json'), metadata); metadata.receipt = captureReceipt(directory, 'engineering'); }
  return metadata;
}
module.exports = { runEngineering, probeHelper, checkSource, PUBLIC_MESSAGES };
if (require.main === module) {
  const [output, final, closure] = process.argv.slice(2);
  runEngineering({ output, final, closure }).then(result => {
    console.log(JSON.stringify({ status: result.status, native: result.native.status, visibleUi: result.visibleUi, receipt: result.receipt }));
    if (!['ENGINEERING_HELPER_PASS_UI_NOT_RUN', 'UNAVAILABLE'].includes(result.status)) process.exitCode = 1;
  }).catch(() => { console.error('FM_OUTPUT_ADMISSION_STOP'); process.exitCode = 1; });
}
