'use strict';
// Existing Electron development UI, never npm/npx/build-web/signing or a Browser substitute.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { readBounded, exclusiveDirectory, json, digest, captureReceipt } = require('./build-foundation-models.cjs');
const { checkSource } = require('./verify-foundation-models-engineering.cjs');
const { helperLaunch } = require('../apps/desktop/foundation-models-service.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exercisePage(evaluate) {
  return evaluate(`(async () => {
    if (!voiceRuntime || voiceRuntime.kind !== 'electron') throw Error('FM_UI_RUNTIME');
    const speech = await voiceRuntime.capabilities();
    if (speech.ready) throw Error('FM_UI_EXPECTED_SPEECH_UNAVAILABLE');
    await openSettingsModal();
    const select = document.getElementById('providerSelect');
    const option = Array.from(select.options).find(x => x.value === 'apple-foundation-models');
    if (foundationModelsCapability?.state !== 'available') {
      if (option && !option.disabled) throw Error('FM_UI_FALSE_READY');
      return { status: 'UNAVAILABLE', reason: foundationModelsCapability?.reason || 'not-advertised', connectionTests: 0 };
    }
    if (!option || option.disabled || document.getElementById('settingsModal').style.display === 'none') throw Error('FM_UI_OPTION_HIDDEN');
    select.value = 'apple-foundation-models';
    await onProviderSelectChange();
    if (select.value !== 'apple-foundation-models' || document.getElementById('apiKeyGroup').style.display !== 'none') throw Error('FM_UI_API_FALLBACK');
    for (let i = 0; i < 2; i++) {
      await testApiConnection();
      const result = document.getElementById('testConnResult');
      if (localStorage.getItem('vp_verified_provider') !== 'apple-foundation-models' || !result.textContent.startsWith('✅') || result.style.display === 'none') throw Error('FM_UI_CONNECTION_FAILED');
    }
    await voiceRuntime.cancelGeneration();
    return { status: 'PASS', connectionTests: 2, runtime: voiceRuntime.kind, speechReady: false, stop: 'CONFIRMED' };
  })()`);
}
function admitElectron(root) {
  const lock = JSON.parse(readBounded(path.join(root, 'package-lock.json'), 4 * 1024 * 1024));
  for (const name of ['electron', 'yauzl']) {
    const installed = JSON.parse(readBounded(path.join(root, 'node_modules', name, 'package.json'), 65536));
    if (installed.version !== lock.packages['node_modules/' + name]?.version) throw Error('FM_LOCKED_DEPENDENCY_REQUIRED');
  }
  const command = fs.realpathSync(path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'));
  fs.accessSync(command, fs.constants.X_OK);
  return { command, args: [], version: lock.packages['node_modules/electron'].version, executableSha256: digest(readBounded(command)) };
}
async function connect(url) {
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/[A-Za-z0-9/-]+$/.test(url)) throw Error('FM_DEBUG_ORIGIN');
  let socket;
  try { socket = new WebSocket(url); } catch (cause) { throw Error('FM_CDP_CONNECT', { cause }); }
  const pending = new Map(); let id = 0, failure, opening;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  // One sticky terminal state owns all timers and promise settlement, including pre-open failure.
  const fail = (code, cause) => {
    if (failure) return;
    failure = Error(code, { cause });
    if (opening) { clearTimeout(opening.timer); opening.reject(failure); opening = null; }
    for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(failure); }
    pending.clear();
    try { socket.close(); } catch {} // preserve the first error; never throw out of an event callback
  };
  socket.addEventListener('message', event => {
    if (failure) return;
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 131072) { fail('FM_CDP_LIMIT'); return; }
    let reply;
    try { reply = JSON.parse(event.data); } catch (cause) { fail('FM_CDP_PARSE', cause); return; }
    if (!object(reply)) { fail('FM_CDP_SHAPE'); return; }
    if (!Object.hasOwn(reply, 'id')) {
      if (typeof reply.method !== 'string' || !reply.method || (Object.hasOwn(reply, 'params') && !object(reply.params))
        || Object.hasOwn(reply, 'result') || Object.hasOwn(reply, 'error')) fail('FM_CDP_SHAPE');
      return; // valid unsolicited CDP event
    }
    const hasResult = Object.hasOwn(reply, 'result'), hasError = Object.hasOwn(reply, 'error');
    if (!Number.isSafeInteger(reply.id) || reply.id <= 0 || hasResult === hasError || Object.hasOwn(reply, 'method')
      || (hasResult && !object(reply.result)) || (hasError && (!object(reply.error)
        || !Number.isInteger(reply.error.code) || typeof reply.error.message !== 'string'))) { fail('FM_CDP_SHAPE'); return; }
    if (hasError) { fail('FM_CDP_FAILED', Error(reply.error.message.slice(0, 1024))); return; }
    const slot = pending.get(reply.id);
    if (!slot) return;
    pending.delete(reply.id); clearTimeout(slot.timer); slot.resolve(reply.result);
  });
  socket.addEventListener('close', () => fail('FM_CDP_CLOSED'));
  socket.addEventListener('error', event => fail('FM_CDP_SOCKET', event.error instanceof Error ? event.error : undefined));
  await new Promise((resolve, reject) => {
    opening = { reject, timer: setTimeout(() => fail('FM_CDP_TIMEOUT'), 5000) };
    socket.addEventListener('open', () => {
      if (failure || !opening) return;
      clearTimeout(opening.timer); opening = null; resolve();
    }, { once: true });
  });
  return { close: () => fail('FM_CDP_CLOSED'), call(method, params = {}) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const requestId = ++id, timer = setTimeout(() => fail('FM_CDP_TIMEOUT'), 135000);
      pending.set(requestId, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id: requestId, method, params })); } catch (cause) { fail('FM_CDP_SEND', cause); }
    });
  } };
}
async function pageTarget(browserUrl, expected) {
  const url = new URL(browserUrl), end = Date.now() + 15000;
  while (Date.now() < end) {
    const response = await fetch(`http://127.0.0.1:${url.port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) throw Error('FM_CDP_LIMIT'); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel(); }
    const pages = JSON.parse(Buffer.concat(chunks).toString());
    const page = pages.find(x => x.type === 'page' && x.url === expected);
    if (page) return page.webSocketDebuggerUrl;
    await wait(100);
  }
  throw Error('FM_UI_ENTRY_TIMEOUT');
}
function installDevHelper(root, helperDirectory) {
  let base = root;
  for (const name of ['build', 'foundation-models']) {
    base = path.join(base, name);
    try { fs.mkdirSync(base, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fs.realpathSync(base) !== base || !fs.lstatSync(base).isDirectory()) throw Error('FM_UI_UNSAFE_BUILD');
  }
  const target = exclusiveDirectory(path.join(base, 'arm64'));
  for (const name of ['voice-foundation-models', 'manifest.json']) fs.writeFileSync(path.join(target, name), readBounded(path.join(helperDirectory, name)), { flag: 'wx', mode: name === 'manifest.json' ? 0o600 : 0o755 });
}
async function runUi({ root = path.resolve(__dirname, '..'), output, engineering, final, closure, platform = process.platform,
  check = checkSource, admit = admitElectron, connector = connect, target = pageTarget, install = installDevHelper } = {}) {
  root = fs.realpathSync(root);
  const directory = exclusiveDirectory(output);
  const result = { protocol: 1, status: 'STOP', tier: 'NOT_ADMITTED', visibleUi: 'NOT_RUN', native: 'NOT_RUN', owner: { started: false, closed: false, descendants: 'NOT_OBSERVED' } };
  let child, browser, page, closed, stderr = Buffer.alloc(0), stdout = Buffer.alloc(0), timer, anomaly = null;
  const observations = []; let failureDetail = null;
  try {
    if (platform !== 'darwin') throw Error('FM_MAC_ARM64_REQUIRED');
    Object.assign(result, await check({ root, directory, final, closure }));
    const previous = JSON.parse(readBounded(path.join(engineering, 'metadata.export.json'), 65536));
    if (previous.final !== final || previous.closure !== closure || !['PASS', 'UNAVAILABLE'].includes(previous.native?.status)) throw Error('FM_ENGINEERING_RECEIPT_REQUIRED');
    const engineeringRoot = readBounded(path.join(engineering, 'completion.root.json'), 65536);
    result.engineeringReceipt = { bytes: engineeringRoot.length, sha256: digest(engineeringRoot) };
    result.binary = previous.binary;
    const electron = admit(root); result.electron = { version: electron.version, executableSha256: electron.executableSha256 };
    const helperDirectory = fs.realpathSync(path.join(engineering, 'foundation-models'));
    await helperLaunch({ packaged: true, resourcesPath: fs.realpathSync(engineering), arch: 'arm64' });
    install(root, helperDirectory);
    await helperLaunch({ root, packaged: false, arch: 'arm64' });
    const args = [...electron.args, root, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + path.join(directory, 'user-data')];
    json(path.join(directory, 'launch.private.json'), { command: electron.command, args });
    child = spawn(electron.command, args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8',
        VOICE_RUNTIME_PYTHON: path.join(directory, 'speech-intentionally-absent') } });
    closed = new Promise(resolve => child.once('close', (code, signal) => { Object.assign(result.owner, { closed: true, exitCode: code, signal }); resolve(); }));
    const endpoint = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('FM_UI_START_TIMEOUT')), 20000);
      child.once('spawn', () => { result.owner.started = true; }); child.once('error', () => reject(Error('FM_UI_START_FAILED')));
      const overflow = () => { anomaly ||= 'FM_UI_OUTPUT_LIMIT'; try { child.kill('SIGTERM'); } catch {} reject(Error(anomaly)); };
      child.stdout.on('data', chunk => { if (stdout.length + chunk.length > 65536) overflow(); stdout = Buffer.concat([stdout, chunk]).subarray(0, 65536); });
      child.stderr.on('data', chunk => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > 65536) { stderr = stderr.subarray(0, 65536); overflow(); return; }
        const match = stderr.toString().match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);
        if (match) resolve(match[1]);
      });
    });
    const browserUrl = await endpoint; clearTimeout(timer);
    browser = await connector(browserUrl);
    page = await connector(await target(browserUrl, pathToFileURL(path.join(root, 'apps/web/index.html')).href));
    const evaluate = async expression => {
      const value = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (value.exceptionDetails) throw Error('FM_UI_SCRIPT_FAILED');
      if (observations.length >= 192 || Buffer.byteLength(JSON.stringify(value)) > 4096) throw Error('FM_UI_OBSERVATION_LIMIT');
      observations.push({ stage: expression.startsWith('typeof ') ? 'ready' : 'exercise', value: value.result.value });
      return value.result.value;
    };
    const end = Date.now() + 15000;
    while (!await evaluate('typeof voiceRuntime !== "undefined" && voiceRuntime?.kind === "electron" && !!foundationModelsCapability')) {
      if (Date.now() >= end) throw Error('FM_UI_BOOTSTRAP_TIMEOUT'); await wait(100);
    }
    result.visibleUi = await exercisePage(evaluate);
    result.status = result.visibleUi.status;
    result.native = previous.native.status;
    // Product Stop already ran in exercisePage; close this browser, not another user's instance.
    await browser.call('Browser.close').catch(error => { if (error.message !== 'FM_CDP_CLOSED') throw error; });
  } catch (error) {
    result.status = 'STOP'; result.error = /^FM_[A-Z_]+$/.test(error.message) ? error.message : 'FM_UI_PREREQUISITE_STOP';
    failureDetail = { message: String(error.message).slice(0, 1024), cause: error.cause ? String(error.cause.message).slice(0, 1024) : null };
  }
  finally {
    clearTimeout(timer); page?.close(); browser?.close();
    if (child && !result.owner.closed) {
      if (result.status === 'STOP') child.kill('SIGTERM');
      await Promise.race([closed, wait(3000)]);
      if (!result.owner.closed) { child.kill('SIGTERM'); await Promise.race([closed, wait(2000)]); result.status = 'STOP'; }
      if (!result.owner.closed) { result.owner.state = 'UNKNOWN'; child.unref(); child.stdout.destroy(); child.stderr.destroy(); }
    }
    for (const [name, bytes] of [['stdout', stdout], ['stderr', stderr]]) fs.writeFileSync(path.join(directory, 'electron.' + name), bytes, { flag: 'wx', mode: 0o600 });
    if (anomaly) { result.error = anomaly; result.status = 'STOP'; }
    if (result.owner.started && (!result.owner.closed || result.owner.exitCode !== 0 || result.owner.signal)) { result.status = 'STOP'; result.error ||= 'FM_UI_EXIT_FAILED'; }
    json(path.join(directory, 'ui.private.json'), { evidence: 'PROCESSED_CDP_RESULTS_NOT_RAW_WIRE', observations, owner: result.owner, anomaly, failureDetail });
    json(path.join(directory, 'ui.metadata.export.json'), result);
    result.receipt = captureReceipt(directory, 'ui');
  }
  return result;
}
module.exports = { exercisePage, runUi, admitElectron, installDevHelper, connect };
if (require.main === module) {
  const [output, engineering, final, closure] = process.argv.slice(2);
  runUi({ output, engineering, final, closure }).then(result => { console.log(JSON.stringify({ status: result.status, visibleUi: result.visibleUi, receipt: result.receipt })); if (!['PASS', 'UNAVAILABLE'].includes(result.status)) process.exitCode = 1; })
    .catch(() => { console.error('FM_UI_OUTPUT_ADMISSION_STOP'); process.exitCode = 1; });
}
