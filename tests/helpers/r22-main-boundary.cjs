'use strict';
// Full real Main + sandbox preload; only Electron boundary is doubled. NON_NATIVE.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { createRequire } = require('node:module');
module.exports = async function mainBoundary(t, { client, service, testMode = true, closeEvent = true, reopenDelay = 0, onReopen, startupSpawn } = {}) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'r22-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.resolve(__dirname, '../../apps/desktop/main.cjs'), req = createRequire(filename);
  const windows = [], handlers = new Map(), errors = [], quits = [];
  const nonce = 'NON_NATIVE-launch', secret = 'a'.repeat(64);
  const app = Object.assign(new EventEmitter(), { isPackaged: !startupSpawn, requestSingleInstanceLock: () => true,
    getPath: () => root, getAppPath: () => path.resolve(__dirname, '../..'), whenReady: () => new Promise(() => {}),
    quit() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; app.emit('before-quit', event); if (!event.prevented) { quits.push(true); app.emit('exited'); } },
  });
  class Window extends EventEmitter {
    constructor() {
      super(); this.id = windows.length + 1; this.destroyed = false; windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), { id: this.id + 100, mainFrame: { url: '' },
        session: { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, setPermissionRequestHandler() {} }, setWindowOpenHandler() {} });
    }
    async loadFile(file) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href;
      if (this.id > 1 && reopenDelay) await new Promise(resolve => setTimeout(resolve, reopenDelay));
      if (this.id > 1) await onReopen?.(); }
    isDestroyed() { return this.destroyed; }
    close() { this.closeRequested = true; if (!closeEvent) return; this.destroyed = true;
      this.webContents.emit('destroyed'); this.emit('closed'); app.emit('window-all-closed'); }
    static getAllWindows() { return windows.filter(w => !w.destroyed); }
  }
  let sidecarModule;
  if (startupSpawn) {
    const filename = path.resolve(__dirname, '../../apps/desktop/sidecar-client.cjs');
    const context = { module: { exports: {} }, require: id => id === 'node:child_process' ? { ...req(id), spawn: startupSpawn } : req(id),
      process, Buffer, setTimeout, clearTimeout };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    sidecarModule = context.module.exports;
  }
  const Menu = { buildFromTemplate: items => ({ items, append() {} }), getApplicationMenu: () => null, setApplicationMenu() {} };
  const ctx = { require: id => id === 'electron' ? { app, BrowserWindow: Window, Menu, MenuItem: class { constructor(value) { Object.assign(this, value); } }, ipcMain: { handle: (k, f) => handlers.set(k, f) }, safeStorage: {}, shell: {}, dialog: {} } : id === './sidecar-client.cjs' && sidecarModule ? sidecarModule : req(id),
    __dirname: path.dirname(filename), Buffer, URL, AbortController, setTimeout, clearTimeout, setImmediate,
    process: { ...process, platform: 'darwin', argv: testMode ? ['node', '--acceptance-window-cycle'] : ['node'],
      env: { VOICE_LAUNCH_NONCE: nonce, VOICE_LIFECYCLE_SECRET: secret, VOICE_TRUSTED_ROOT: root } },
    console: { log() {}, error: (...v) => errors.push(v.map(String).join(' ')) } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nthis.api = { startApplication, ownClient, releaseClientAssets, stopOwnedClient, ownedClients, createWindow, registerIpc, setFM(value) { foundationModels = value; }, getWindow() { return mainWindow; } };', ctx, { filename });
  if (service) ctx.api.setFM(service);
  else if (client) ctx.api.setFM({ client, closeOwner: () => client.stop(), shutdown: () => client.shutdown() });
  if (!startupSpawn) { ctx.api.registerIpc(); await ctx.api.createWindow(); }
  function ipc(window, channel, payload, event) { return handlers.get(channel)(event || { sender: window.webContents, senderFrame: window.webContents.mainFrame }, payload); }
  function connection(window) {
    let electronAPI;
    vm.runInNewContext(fs.readFileSync(path.join(path.dirname(filename), 'preload.cjs'), 'utf8'), { require: id => {
      if (id !== 'electron') throw Error('SANDBOX_REQUIRE');
      return { contextBridge: { exposeInMainWorld: (_key, value) => { electronAPI = value; } }, ipcRenderer: { invoke: (channel, payload) => ipc(window, channel, payload) } };
    } });
    return { electronAPI, evaluate: expression => vm.runInNewContext(expression, { window: { electronAPI } }),
      close() {}, quit: () => electronAPI.quit() };
  }
  return { root, app, windows, handlers, errors, quits, nonce, secret, api: ctx.api, ipc, connection,
    transport: {
      fetchImpl: async () => ({ ok: true, json: async () => Window.getAllWindows().map(w => ({ id: String(w.id), type: 'page', url: w.webContents.mainFrame.url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${w.id}` })) }),
      connect: async url => connection(windows.find(w => String(w.id) === new URL(url).pathname.split('/').at(-1))),
    },
  };
};
