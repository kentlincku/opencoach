'use strict';
// Test-only browser-global loader. No CommonJS injection into the renderer realm.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
function loadRuntimeScripts(context, html, root, { legacyOrder = false } = {}) {
  const scripts = [...html.matchAll(/<script\s+src="(\.\/runtime\/[^"<>]+)"\s*>\s*<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  assert.equal(new Set(scripts).size, scripts.length);
  if (legacyOrder) {
    const contract = './runtime/llm-provider-contract.js';
    assert.ok(scripts.includes(contract));
    scripts.splice(scripts.indexOf(contract), 1);
    const predecessor = scripts.indexOf('./runtime/lesson-library.js');
    assert.ok(predecessor >= 0);
    scripts.splice(predecessor + 1, 0, contract);
  }
  context.crypto = webcrypto;
  vm.runInContext(`(() => {
    if (typeof module !== 'undefined' || typeof require !== 'undefined') throw Error('BROWSER_REALM_HAS_COMMONJS');
    if (globalThis.window) Object.assign(globalThis, window);
    globalThis.window = globalThis;
    // Discard provider fixtures' CommonJS globals BEFORE any inline UI code executes.
    for (const key of Object.keys(globalThis)) {
      if (key.startsWith('Voice') || key === 'DesktopVoiceWorkScope') delete globalThis[key];
    }
    if (globalThis.electronAPI) {
      const bridge = globalThis.electronAPI;
      // Electron's context bridge copies reply data into the renderer realm.
      globalThis.electronAPI = Object.freeze(Object.fromEntries(Object.keys(bridge).map(key => [key,
        (...args) => Promise.resolve(bridge[key](...args)).then(value => value === undefined ? value : JSON.parse(JSON.stringify(value)))
      ])));
    }
  })()`, context);
  for (const script of scripts) {
    assert.match(script, /^\.\/runtime\/[a-z0-9-]+\.js$/);
    vm.runInContext(fs.readFileSync(path.join(root, 'apps/web', script), 'utf8'), context, { filename: script, timeout: 1000 });
  }
  return scripts;
}
module.exports = { loadRuntimeScripts };
