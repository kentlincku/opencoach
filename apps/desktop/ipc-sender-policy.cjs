'use strict';

function validFrameId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTrustedMainFrame(event, webContents) {
  if (!event || !webContents || event.sender !== webContents) return false;
  const senderFrame = event.senderFrame;
  const mainFrame = webContents.mainFrame;
  if (!senderFrame || !mainFrame) return false;
  if (senderFrame === mainFrame) return true;
  if (!validFrameId(senderFrame.processId) || !validFrameId(senderFrame.routingId)
      || !validFrameId(mainFrame.processId) || !validFrameId(mainFrame.routingId)) {
    return false;
  }
  return senderFrame.processId === mainFrame.processId
    && senderFrame.routingId === mainFrame.routingId;
}

function assertTrustedSenderPolicy({ event, activeWindow, trustedWebContents, isTrustedOrigin }) {
  const targetWebContents = (activeWindow && typeof activeWindow.isDestroyed === 'function' && !activeWindow.isDestroyed())
    ? activeWindow.webContents
    : (activeWindow && typeof activeWindow.isDestroyed !== 'function' && activeWindow.webContents)
      ? activeWindow.webContents
      : (trustedWebContents && trustedWebContents.has(event?.sender) ? event.sender : null);
  if (!targetWebContents || !isTrustedMainFrame(event, targetWebContents)) {
    throw new Error('UNTRUSTED_IPC_SENDER');
  }
  const senderUrl = String(event?.senderFrame?.url || '');
  if (typeof isTrustedOrigin === 'function' && !isTrustedOrigin(senderUrl)) {
    throw new Error('UNTRUSTED_IPC_ORIGIN');
  }
  return true;
}

module.exports = { isTrustedMainFrame, assertTrustedSenderPolicy };