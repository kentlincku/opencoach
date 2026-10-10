'use strict';
// NODE_NOT_NATIVE: actual Main/preload/HTML/runtime/service/client, inert Node helper.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
async function runControl({ root, output, mode = 'normal' }) {
  const file = path.join(root, 'tests/fm-ui-diagnostic-fixture.cjs');
  let source = fs.readFileSync(file, 'utf8');
  const replace = (a, b) => { if (source.split(a).length !== 2) throw Error('CONTROL_ANCHOR'); source = source.replace(a, b); };
  replace('tests/fm-ui-diagnostic-child.cjs', 'tests/fixtures/fm-ui-acceptance-child.cjs');
  if (mode === 'unavailable') replace("args: [path.join(root, 'tests/fixtures/fm-ui-acceptance-child.cjs')]", "args: [path.join(root, 'tests/fixtures/fm-ui-acceptance-child.cjs'), '--unavailable']");
  replace("require('../scripts/fm-ui-diagnostic-entry.cjs')", "require('../scripts/fm-ui-acceptance-collector.cjs')");
  replace('limits: { marker: 150, observe: 450, poll: 10 }', 'limits: { ready: 1200, poll: 10 }');
  replace('class Window extends EventEmitter {', `class Window extends EventEmitter {
    isVisible() { return ${mode !== 'hidden'} && ${mode === 'second-hidden' ? '(entry?.boot.hooks.stats.completions || 0) < 2' : 'true'}; }
    isMinimized() { return false; }
    async capturePage() { return { isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.from('89504e470d0a1a0a00000000', 'hex') }; }`);
  replace('const sample = () =>', `
    page.elements.ttsEngineLabel ||= { textContent: '' };
    page.elements.ttsEngineLabel.textContent = '🔊 語音引擎：準備中';
    page.context.setTTSEngineStatus = label => { ${mode === 'not-ready' ? '' : "page.elements.ttsEngineLabel.textContent = '🔊 語音引擎：' + label;"} };
    const sample = () =>`);
  if (mode === 'snapshot-error') replace('const capability = page.run', `fs.mkdirSync(path.join(output, 'entry.snapshot.tmp'), { recursive: true });
    const capability = page.run`);
  if (mode === 'cleanup') replace('const capability = page.run', `fs.writeFileSync(path.join(output, 'cleanup.request'), '');
    const capability = page.run`);
  const loaded = new Module(file, module); loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file)); loaded._compile(source, file);
  return loaded.exports.runFixture({ root, output, entryControl: true, browserGlobals: true });
}
module.exports = { runControl };
if (require.main === module) {
  const [root, output, mode = 'normal'] = process.argv.slice(2);
  if (mode === 'early-exit') process.exitCode = 7;
  else if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); }
  else if (mode === 'flood') { process.stdout.write(Buffer.alloc(65537)); setInterval(() => {}, 100); }
  else runControl({ root, output, mode }).then(result => {
    fs.writeFileSync(path.join(output, 'control.receipt.json'), JSON.stringify({ tier: 'NODE_NOT_NATIVE', helpersClosed: result.helpersClosed, speechSpawnAttempts: result.speechSpawnAttempts.length, status: result.entry.status, stop: result.entry.stop, snapshotReadable: result.entry.snapshotReadable }));
    process.exitCode = result.entry.status === 'STOP' ? 1 : 0;
  }, () => { process.exitCode = 1; });
}
