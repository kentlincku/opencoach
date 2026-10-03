'use strict';
// NON_NATIVE: Main installs a renderer CSP for the trusted file:// renderer.
// Live verification (Electron 44, macOS): response header present on index.html,
// string eval blocked with a CSP violation, chat/TTS/STT/lessons unaffected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../apps/desktop/main.cjs'), 'utf8');

function policy() {
  const start = main.indexOf('const RENDERER_CSP = [');
  const end = main.indexOf("].join('; ');", start);
  assert(start >= 0 && end > start, 'RENDERER_CSP must be declared in main.cjs');
  // eslint-disable-next-line no-new-func -- test-only evaluation of a literal array
  return Function(`return ${main.slice(start + 'const RENDERER_CSP = '.length, end + 1)};`)()
    .map(directive => directive.trim());
}

test('renderer CSP forbids string eval, plugins, framing, base and form hijack', () => {
  const directives = Object.fromEntries(policy().map(d => { const [name, ...values] = d.split(/\s+/); return [name, values]; }));
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.ok(directives['script-src'].includes("'self'"));
  assert.ok(!directives['script-src'].includes("'unsafe-eval'"), 'no string eval / new Function');
  assert.ok(directives['script-src'].includes("'wasm-unsafe-eval'"), 'local ORT/Whisper wasm only');
  assert.ok(!directives['script-src'].some(v => /^https?:|^\*$/.test(v)), 'no remote script origins');
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.deepEqual(directives['frame-src'], ["'none'"]);
  assert.ok(!directives['connect-src'].some(v => /^https?:|^\*$/.test(v)), 'network goes through the Main broker');
});

test('Main installs the CSP header for file:// renderer responses before loading the renderer', () => {
  const hook = main.indexOf("webRequest.onHeadersReceived({ urls: ['file://*/*'] }");
  assert.ok(hook > 0, 'CSP header hook missing');
  assert.match(main.slice(hook, hook + 300), /'Content-Security-Policy': \[RENDERER_CSP\]/);
  assert.ok(hook < main.indexOf('await mainWindow.loadFile(rendererPath)'), 'hook must precede renderer load');
});
