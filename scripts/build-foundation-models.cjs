'use strict';
// Engineering only. No xcrun, installer, keychain, signing, network or SDK selection.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const digest = data => createHash('sha256').update(data).digest('hex');
const CLT = '/Library/Developer/CommandLineTools';
function readBounded(file, max = 16 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw Error('FM_FILE_LIMIT');
    const buffer = Buffer.alloc(stat.size + 1);
    let n = 0, count;
    while (n < buffer.length && (count = fs.readSync(fd, buffer, n, buffer.length - n, n))) n += count;
    if (n !== stat.size) throw Error('FM_FILE_CHANGED');
    return buffer.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
function json(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function exclusiveDirectory(output) {
  if (!path.isAbsolute(output)) throw Error('FM_ABSOLUTE_OUTPUT_REQUIRED');
  const parent = fs.realpathSync(path.dirname(output)); // /var → /private/var is legitimate.
  const directory = path.join(parent, path.basename(output));
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw Error('FM_OUTPUT_EXISTS'); throw error; }
  return fs.realpathSync(directory);
}
function boundedRun(command, args, { directory, label, cwd, env = {}, timeoutMs = 180000, maxBytes = 65536 } = {}) {
  // One driver owner. Abnormal termination does NOT assert descendant reaping.
  return new Promise(resolve => {
    const streams = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
    const receipt = { state: 'NOT_STARTED', exitCode: null, signal: null, reason: null, descendants: 'NOT_OBSERVED' };
    let child, deadline, grace, done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(deadline); clearTimeout(grace);
      for (const name of Object.keys(streams)) fs.writeFileSync(path.join(directory, `${label}.${name}`), Buffer.concat(streams[name]), { flag: 'wx', mode: 0o600 });
      json(path.join(directory, `${label}.json`), receipt); resolve(receipt);
    };
    const stop = reason => {
      if (receipt.reason || done) return;
      receipt.reason = reason;
      try { child.kill('SIGTERM'); } catch {}
      grace = setTimeout(() => { receipt.state = 'UNKNOWN'; child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(); }, 2000);
    };
    try {
      child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('spawn', () => { receipt.state = 'STARTED'; });
      child.on('error', () => { receipt.reason ||= 'START_FAILED'; });
      for (const name of Object.keys(streams)) child[name].on('data', data => {
        const remaining = Math.max(0, maxBytes - sizes[name]);
        if (remaining) streams[name].push(data.subarray(0, remaining));
        sizes[name] += data.length;
        if (sizes[name] > maxBytes) stop('OUTPUT_LIMIT');
      });
      child.once('close', (code, signal) => { if (done) return; receipt.state = 'EXITED'; receipt.exitCode = code; receipt.signal = signal; finish(); });
      deadline = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    } catch { receipt.reason = 'START_FAILED'; finish(); }
  });
}
// Fixed finite receipt inventory. Absent artifacts are bound as null, never rediscovered recursively.
const CAPTURE_FILES = {
  engineering: ['metadata.export.json', 'source-map.json', ...['git-status', 'git-head', 'git-detached'].flatMap(x => [x + '.json', x + '.stdout', x + '.stderr']),
    'helper.private.json', ...['build.private.json', 'manifest.json', 'voice-foundation-models', 'compile-command.private.json',
      'version.json', 'version.stdout', 'version.stderr', 'compile.json', 'compile.stdout', 'compile.stderr'].map(x => 'foundation-models/' + x)],
  ui: ['ui.metadata.export.json', 'ui.private.json', 'launch.private.json', 'electron.stdout', 'electron.stderr', 'source-map.json',
    ...['git-status', 'git-head', 'git-detached'].flatMap(x => [x + '.json', x + '.stdout', x + '.stderr'])]
};
const captureCap = name => name.endsWith('/voice-foundation-models') ? 16 * 1024 * 1024 : name === 'source-map.json' ? 256 * 1024 : 65536;
function captureReceipt(directory, kind) {
  const receipts = {};
  for (const name of CAPTURE_FILES[kind]) {
    try {
      const bytes = readBounded(path.join(directory, name), captureCap(name));
      receipts[name] = { bytes: bytes.length, sha256: digest(bytes) };
    } catch (error) { if (error.code !== 'ENOENT') throw error; receipts[name] = null; }
  }
  const bytes = Buffer.from(JSON.stringify({ protocol: 1, kind, receipts }, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'completion.root.json'), bytes, { flag: 'wx', mode: 0o600 });
  return { bytes: bytes.length, sha256: digest(bytes) };
}
const REQUIRED_SOURCE = ['.gitignore', 'package.json', 'package-lock.json', 'electron-builder.yml', 'apps/web/index.html',
  'native/apple/FoundationModelsHelper.swift',
  ...['main', 'preload', 'foundation-models-client', 'foundation-models-service', 'runtime-manager', 'sidecar-client', 'managed-asset-lease'].map(x => 'apps/desktop/' + x + '.cjs'),
  ...['create-runtime', 'electron-runtime', 'llm-provider-contract', 'desktop-voice-work-scope'].map(x => 'apps/web/runtime/' + x + '.js'),
  ...['build', 'verify', 'readback'].map(x => 'scripts/' + x + '-foundation-models' + (x === 'build' ? '' : '-engineering') + '.cjs'),
  'scripts/verify-foundation-models-ui.cjs', 'scripts/verify-foundation-models-bundle.cjs',
  'tests/foundation-models-document.test.cjs',
  'tests/foundation-models-engineering.test.cjs', 'tests/foundation-models.test.cjs', 'tests/foundation-models-integrity.test.cjs',
  'tests/provider-settings.test.cjs', 'tests/desktop-voice-work-scope.test.cjs', 'tests/llm-provider-contract.test.cjs',
  'tests/fixtures/foundation-models-child.cjs', 'tests/fixtures/desktop-voice-stop-harness.cjs', 'tests/main-voice-operations.test.cjs'];
function validateSourceMap(source) {
  const invalid = () => { throw Error('FM_SOURCE_MAP_SCHEMA'); };
  if (!source || source.schema !== 1 || source.scope !== 'FM_ENGINEERING' || Object.keys(source).sort().join() !== 'files,schema,scope'
    || !source.files || Array.isArray(source.files) || typeof source.files !== 'object') invalid();
  const entries = Object.entries(source.files);
  if (entries.length > 128 || REQUIRED_SOURCE.some(x => !Object.hasOwn(source.files, x))) invalid();
  for (const [file, r] of entries) {
    if ((!/^(apps|native|scripts|tests)\/[A-Za-z0-9_./-]+$/.test(file) && !['.gitignore', 'package.json', 'package-lock.json', 'electron-builder.yml'].includes(file))
      || file.split('/').some(x => !x || x === '.' || x === '..') || file === 'scripts/foundation-models-engineering-source.json'
      || !r || Object.keys(r).sort().join() !== 'bytes,sha256' || !Number.isInteger(r.bytes) || r.bytes <= 0 || r.bytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(r.sha256)) invalid();
  }
  return source;
}
async function preflight({ toolchainRoot = CLT } = {}) {
  try {
    const initialRoot = fs.realpathSync(toolchainRoot);
    const defaultAlias = toolchainRoot === CLT && initialRoot.startsWith('/private/var/');
    const suppliedRoot = path.resolve(defaultAlias ? initialRoot.slice('/private'.length) : toolchainRoot);
    const root = fs.realpathSync(suppliedRoot);
    const canonicalRoot = root;
    // Keep the caller's verified spelling for child argv and receipts. macOS
    // commonly presents a /var path through /private/var; canonicalize only
    // for containment checks so source fixtures and tool argv stay stable.
    const compiler = path.join(suppliedRoot, 'usr/bin/swiftc');
    const compilerResolved = fs.realpathSync(compiler);
    const sdk = path.join(suppliedRoot, 'SDKs/MacOSX.sdk');
    const sdkResolved = fs.realpathSync(sdk);
    if (!compilerResolved.startsWith(canonicalRoot + path.sep) || !sdkResolved.startsWith(canonicalRoot + path.sep)) throw Error('outside');
    if (!fs.statSync(compiler).isFile() || !fs.statSync(sdk).isDirectory()) throw Error('type');
    fs.accessSync(compiler, fs.constants.X_OK);
    fs.accessSync(path.join(sdk, 'System/Library/Frameworks/FoundationModels.framework'));
    return { root, compiler, compilerResolved, sdk };
  } catch { throw new Error('FM_EXISTING_TOOLCHAIN_REQUIRED'); }
}
function generatedParent(root) {
  let current = root;
  for (const name of ['build', 'foundation-models']) {
    current = path.join(current, name);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== current) throw Error('FM_UNSAFE_OUTPUT');
  }
  return current;
}
async function buildHelper({ platform = process.platform, arch = process.arch, root = path.resolve(__dirname, '..'), output, toolchainRoot = CLT } = {}) {
  if (platform !== 'darwin') throw Error('MAC_BUILD_REQUIRED');
  if (arch !== 'arm64') throw Error('FM_UNSUPPORTED_ARCH');
  root = fs.realpathSync(root);
  const tools = await preflight({ toolchainRoot }); // Never invokes xcrun/CLT GUI admission.
  const directory = exclusiveDirectory(output || path.join(generatedParent(root), arch));
  const receipt = { protocol: 1, status: 'NOT_RUN', platform, arch, toolchain: tools, node: process.version,
    signing: 'NOT_REQUESTED', source: null, binary: null, compiler: null };
  try {
    const source = path.join(root, 'native/apple/FoundationModelsHelper.swift');
    if (fs.realpathSync(source) !== source) throw Error('FM_SOURCE_SYMLINK');
    const sourceBytes = readBounded(source, 128 * 1024);
    receipt.source = { bytes: sourceBytes.length, sha256: digest(sourceBytes) };
    const env = { PATH: path.join(tools.root, 'usr/bin') + ':/usr/bin:/bin', LANG: 'en_US.UTF-8',
      DEVELOPER_DIR: tools.root, SDKROOT: tools.sdk, TMPDIR: directory, HOME: directory,
      CLANG_MODULE_CACHE_PATH: path.join(directory, 'module-cache') };
    receipt.version = await boundedRun(tools.compiler, ['-version'], { directory, label: 'version', cwd: root, env, timeoutMs: 10000 });
    if (receipt.version.reason || receipt.version.exitCode !== 0) throw Error('FM_COMPILER_VERSION_FAILED');
    const temporary = path.join(directory, 'voice-foundation-models.building');
    const args = ['-parse-as-library', '-O', '-swift-version', '6', '-sdk', tools.sdk,
      '-target', 'arm64-apple-macosx14.0', '-Xlinker', '-weak_framework', '-Xlinker', 'FoundationModels', source, '-o', temporary];
    json(path.join(directory, 'compile-command.private.json'), { command: tools.compiler, args });
    receipt.compiler = await boundedRun(tools.compiler, args, { directory, label: 'compile', cwd: root, env });
    if (receipt.compiler.reason || receipt.compiler.exitCode !== 0) throw Error('FM_COMPILE_FAILED');
    if (digest(readBounded(source, 128 * 1024)) !== receipt.source.sha256) throw Error('FM_SOURCE_CHANGED');
    const binary = readBounded(temporary);
    if (!binary.length) throw Error('FM_EMPTY_BINARY');
    receipt.binary = { bytes: binary.length, sha256: digest(binary) };
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, path.join(directory, 'voice-foundation-models'));
    json(path.join(directory, 'manifest.json'), { protocol: 1, arch, sha256: receipt.binary.sha256, sourceSha256: receipt.source.sha256 });
    receipt.status = 'PASS'; return receipt;
  } catch (error) { receipt.status = 'STOP'; receipt.error = /^FM_[A-Z_]+$/.test(error.message) ? error.message : 'FM_BUILD_IO_FAILED'; throw error; }
  finally { json(path.join(directory, 'build.private.json'), receipt); }
}
async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') throw Error('MAC_BUILD_REQUIRED');
  if (context.arch !== 3) throw Error('FM_UNSUPPORTED_ARCH');
  if (context.packager.config.mac?.identity !== null || process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') throw Error('FM_SIGNING_NOT_AUTHORIZED');
  return buildHelper({ root: context.packager.projectDir, arch: 'arm64' });
}
module.exports = beforePack;
Object.assign(module.exports, { buildHelper, preflight, boundedRun, readBounded, exclusiveDirectory, json, digest, captureReceipt, CAPTURE_FILES, captureCap, validateSourceMap });
if (require.main === module) buildHelper({ output: process.argv[2] }).catch(() => { console.error('FM_BUILD_STOP: see private receipt when output was admitted'); process.exitCode = 1; });
