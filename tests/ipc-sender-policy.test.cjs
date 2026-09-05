'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedMainFrame, assertTrustedSenderPolicy } = require('../apps/desktop/ipc-sender-policy.cjs');

test('accepts Electron wrappers for the same main frame identity', () => {
  const webContents = {
    mainFrame: { processId: 42, routingId: 7 },
  };
  const event = {
    sender: webContents,
    senderFrame: { processId: 42, routingId: 7 },
  };
  assert.equal(isTrustedMainFrame(event, webContents), true);
});

test('rejects a subframe, different sender, or missing stable frame identity', () => {
  const webContents = {
    mainFrame: { processId: 42, routingId: 7 },
  };
  assert.equal(isTrustedMainFrame({
    sender: webContents,
    senderFrame: { processId: 42, routingId: 8 },
  }, webContents), false);
  assert.equal(isTrustedMainFrame({
    sender: {},
    senderFrame: { processId: 42, routingId: 7 },
  }, webContents), false);
  assert.equal(isTrustedMainFrame({ sender: webContents, senderFrame: {} }, webContents), false);
});

test('assertTrustedSenderPolicy validates active window and handles teardown safely without false UNTRUSTED_IPC_SENDER', () => {
  const webContents = {
    mainFrame: { processId: 10, routingId: 1 },
  };
  const trustedWebContents = new WeakSet([webContents]);
  const activeWindow = {
    isDestroyed: () => false,
    webContents,
  };
  const validEvent = {
    sender: webContents,
    senderFrame: { processId: 10, routingId: 1, url: 'file:///app/index.html' },
  };
  const isTrustedOrigin = (url) => url === 'file:///app/index.html';

  // Active window success
  assert.equal(assertTrustedSenderPolicy({
    event: validEvent,
    activeWindow,
    trustedWebContents,
    isTrustedOrigin,
  }), true);

  // During window close/teardown (activeWindow is null or destroyed), in-flight IPC from trusted webContents succeeds
  const destroyedWindow = {
    isDestroyed: () => true,
    webContents,
  };
  assert.equal(assertTrustedSenderPolicy({
    event: validEvent,
    activeWindow: destroyedWindow,
    trustedWebContents,
    isTrustedOrigin,
  }), true);
  assert.equal(assertTrustedSenderPolicy({
    event: validEvent,
    activeWindow: null,
    trustedWebContents,
    isTrustedOrigin,
  }), true);

  // Rejects untrusted foreign sender even during teardown
  const foreignWebContents = {
    mainFrame: { processId: 99, routingId: 1 },
  };
  assert.throws(() => {
    assertTrustedSenderPolicy({
      event: {
        sender: foreignWebContents,
        senderFrame: { processId: 99, routingId: 1, url: 'file:///app/index.html' },
      },
      activeWindow: null,
      trustedWebContents,
      isTrustedOrigin,
    });
  }, /UNTRUSTED_IPC_SENDER/);

  // Rejects subframe even if sender is trusted
  assert.throws(() => {
    assertTrustedSenderPolicy({
      event: {
        sender: webContents,
        senderFrame: { processId: 10, routingId: 2, url: 'file:///app/index.html' },
      },
      activeWindow,
      trustedWebContents,
      isTrustedOrigin,
    });
  }, /UNTRUSTED_IPC_SENDER/);

  // Rejects untrusted origin even if sender is trusted
  assert.throws(() => {
    assertTrustedSenderPolicy({
      event: {
        sender: webContents,
        senderFrame: { processId: 10, routingId: 1, url: 'https://evil.example.com/' },
      },
      activeWindow,
      trustedWebContents,
      isTrustedOrigin,
    });
  }, /UNTRUSTED_IPC_ORIGIN/);
});