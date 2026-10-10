'use strict';
// Separate passive Main observation; never a helper/application terminal receipt.
const { createHmac, timingSafeEqual } = require('node:crypto');
const fields = ['version', 'launchNonce', 'mainPid', 'oldWindowId', 'newWindowId', 'oldWebContentsId', 'newWebContentsId', 'closedHelperPid', 'reopenedHelperPid', 'closed', 'mainStayedLive', 'challenge', 'closureChain', 'current', 'pending', 'expiresAt'];
function validateWindowCommand(payload, nonce) {
  if (!payload || Object.keys(payload).sort().join() !== 'challenge,launchNonce' || payload.launchNonce !== nonce ||
      typeof payload.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(payload.challenge)) throw new Error('WINDOW_CYCLE_INVALID_COMMAND');
}
function signature(value, secret) { return createHmac('sha256', secret).update(JSON.stringify(fields.map(k => value[k]))).digest('hex'); }
function createWindowCycleReceipt(state, challenge, secret) {
  const value = Object.fromEntries(fields.map(k => [k, k === 'challenge' ? challenge : state[k]]));
  return { ...value, signature: signature(value, secret) };
}
function verifyWindowCycleReceipt(value, expected, secret) {
  if (!value || Object.keys(value).sort().join() !== [...fields, 'signature'].sort().join() || value.version !== 1 ||
      value.launchNonce !== expected.launchNonce || value.mainPid !== expected.mainPid || value.challenge !== expected.challenge ||
      value.oldWebContentsId !== expected.oldWebContentsId || value.newWebContentsId !== expected.newWebContentsId ||
      value.closed !== true || value.mainStayedLive !== true || typeof value.pending !== 'boolean' ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 5000 ||
      !['closedHelperPid', 'reopenedHelperPid'].every(k => value[k] === null || (Number.isSafeInteger(value[k]) && value[k] > 0)) ||
      !['oldWindowId', 'newWindowId', 'oldWebContentsId', 'newWebContentsId'].every(k => Number.isSafeInteger(value[k]) && value[k] > 0) ||
      value.oldWindowId === value.newWindowId || value.oldWebContentsId === value.newWebContentsId ||
      typeof value.signature !== 'string' || !/^[a-f0-9]{64}$/.test(value.signature)) return false;
  if (!Array.isArray(value.closureChain) || value.closureChain.length > 1024 ||
      value.closureChain.some(r => !r || Object.keys(r).sort().join() !== 'drained,exitCode,exited,pid,reaped,signalCode' ||
        !Number.isSafeInteger(r.pid) || r.pid <= 0 || r.exited !== true || r.reaped !== true || r.drained !== true || r.exitCode !== 0 || r.signalCode !== null) ||
      (value.closureChain.at(-1)?.pid || null) !== value.closedHelperPid) return false;
  try {
    const contract = require('./receipt-contract.cjs');
    contract.validateCanonicalReceiptSchema(value.current, { requireSignature: true, expectedNonce: expected.launchNonce });
    if (!contract.verifyReceiptSignature(secret, value.current) || value.current.ownerId !== 'main-authority' ||
        value.current.sessionNonce !== expected.launchNonce || !['running', 'unobserved'].includes(value.current.status) ||
        value.reopenedHelperPid !== (value.current.helperPid || value.closedHelperPid) ||
        (value.current.status === 'running' && value.pending) ||
        (value.current.status === 'unobserved' && value.closedHelperPid !== null && !value.pending)) return false;
  } catch { return false; }
  return timingSafeEqual(Buffer.from(value.signature, 'hex'), Buffer.from(signature(value, secret), 'hex'));
}
module.exports = { validateWindowCommand, createWindowCycleReceipt, verifyWindowCycleReceipt };
