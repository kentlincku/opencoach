'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CANONICAL_FIELD_NAMES = [
  'version',
  'type',
  'launchNonce',
  'sessionNonce',
  'ownerId',
  'component',
  'helperKind',
  'binaryName',
  'helperPid',
  'status',
  'exited',
  'reaped',
  'exitCode',
  'signalCode',
  'seq',
  'issuedAt'
];

const ALLOWED_RECEIPT_KEYS = new Set([
  ...CANONICAL_FIELD_NAMES,
  'authSignature'
]);

function validateReceiptPathPolicy(targetPath, { trustedRoot = null } = {}) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('INVALID_PATH');
  }
  const resolvedPath = path.resolve(targetPath);
  const targetDir = path.dirname(resolvedPath);

  if (trustedRoot) {
    if (typeof trustedRoot !== 'string') {
      throw new Error('TRUSTED_ROOT_REQUIRED');
    }
    const resolvedRoot = path.resolve(trustedRoot);

    if (!fs.existsSync(resolvedRoot)) {
      throw new Error('TRUSTED_ROOT_NOT_FOUND');
    }
    const rootStat = fs.lstatSync(resolvedRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error('ROOT_SYMLINK_DETECTED');
    }
    if (!rootStat.isDirectory()) {
      throw new Error('ROOT_NOT_DIRECTORY');
    }

    // Check any intermediate symlinks in the path to resolvedRoot (excluding canonical macOS /private prefix)
    const rootSegments = resolvedRoot.split(path.sep).filter(Boolean);
    let rootCheckCurrent = path.parse(resolvedRoot).root || '/';
    for (let i = 0; i < rootSegments.length; i++) {
      const seg = rootSegments[i];
      rootCheckCurrent = path.join(rootCheckCurrent, seg);
      if (process.platform === 'darwin' && (rootCheckCurrent === '/tmp' || rootCheckCurrent === '/var' || rootCheckCurrent === '/etc')) {
        continue;
      }
      if (fs.existsSync(rootCheckCurrent)) {
        const segStat = fs.lstatSync(rootCheckCurrent);
        if (segStat.isSymbolicLink()) {
          throw new Error('ANCESTOR_SYMLINK_DETECTED');
        }
      }
    }

    const realRoot = fs.realpathSync(resolvedRoot);

    if (!fs.existsSync(targetDir)) {
      throw new Error('TARGET_DIR_NOT_FOUND');
    }

    const realTargetDir = fs.realpathSync(targetDir);
    if (realTargetDir !== realRoot && !realTargetDir.startsWith(realRoot + path.sep)) {
      throw new Error('PATH_OUTSIDE_TRUSTED_ROOT');
    }

    const relative = path.relative(resolvedRoot, targetDir);
    if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
      throw new Error('PATH_OUTSIDE_TRUSTED_ROOT');
    }

    if (relative) {
      const parts = relative.split(path.sep).filter(Boolean);
      let current = resolvedRoot;
      for (const part of parts) {
        if (part === '..' || part === '.') {
          throw new Error('PATH_OUTSIDE_TRUSTED_ROOT');
        }
        current = path.join(current, part);
        if (!fs.existsSync(current)) {
          throw new Error('TARGET_DIR_NOT_FOUND');
        }
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new Error('ANCESTOR_SYMLINK_DETECTED');
        }
        if (!stat.isDirectory()) {
          throw new Error('ANCESTOR_NOT_DIRECTORY');
        }
        const realCurrent = fs.realpathSync(current);
        if (realCurrent !== realRoot && !realCurrent.startsWith(realRoot + path.sep)) {
          throw new Error('PATH_OUTSIDE_TRUSTED_ROOT');
        }
      }
    }
  } else {
    if (fs.existsSync(targetDir)) {
      const dirStat = fs.lstatSync(targetDir);
      if (dirStat.isSymbolicLink()) {
        throw new Error('ANCESTOR_SYMLINK_DETECTED');
      }
    }
  }

  if (fs.existsSync(resolvedPath)) {
    const fileStat = fs.lstatSync(resolvedPath);
    if (fileStat.isSymbolicLink()) {
      throw new Error('DESTINATION_SYMLINK_DETECTED');
    }
    if (!fileStat.isFile()) {
      throw new Error('DESTINATION_NOT_REGULAR_FILE');
    }
  }

  return true;
}

function validateReceiptFileMetadata(filePath, { expectedUid = null } = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error('RECEIPT_FILE_NOT_FOUND');
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error('SYMLINK_RECEIPT_REJECTED');
  }
  if (!stat.isFile()) {
    throw new Error('NOT_A_REGULAR_FILE');
  }
  if (stat.size <= 0 || stat.size > 16384) {
    throw new Error('INVALID_RECEIPT_SIZE');
  }

  if (process.platform !== 'win32') {
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(`INSECURE_RECEIPT_PERMISSIONS: mode 0o${mode.toString(8)} allows group or other access`);
    }
  }

  const currentUid = expectedUid !== null ? expectedUid : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (currentUid !== null && typeof stat.uid === 'number') {
    if (stat.uid !== currentUid) {
      throw new Error(`UNTRUSTED_RECEIPT_OWNER: file owner ${stat.uid} does not match expected uid ${currentUid}`);
    }
  }

  return stat;
}

function validateCanonicalReceiptSchema(receipt, { requireSignature = false, expectedNonce = null, allowOperation = false } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('INVALID_LIFECYCLE_RECEIPT');
  }

  const keys = Object.keys(receipt);
  for (const key of keys) {
    if (!ALLOWED_RECEIPT_KEYS.has(key) && !(allowOperation && key === 'operation')) {
      throw new Error(`UNKNOWN_PROPERTY_REJECTED: ${key}`);
    }
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'version') || receipt.version !== 1 || typeof receipt.version !== 'number') {
    throw new Error('INVALID_RECEIPT_VERSION');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'type') || receipt.type !== 'MAIN_HELPER_LIFECYCLE_RECEIPT') {
    throw new Error('INVALID_RECEIPT_TYPE');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'launchNonce') || typeof receipt.launchNonce !== 'string' || receipt.launchNonce.trim() === '') {
    throw new Error('INVALID_LAUNCH_NONCE');
  }
  if (expectedNonce && receipt.launchNonce !== expectedNonce) {
    throw new Error('STALE_OR_CROSS_LAUNCH_RECEIPT');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'sessionNonce') || typeof receipt.sessionNonce !== 'string' || receipt.sessionNonce.trim() === '') {
    throw new Error('INVALID_SESSION_NONCE');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'ownerId') || typeof receipt.ownerId !== 'string' || receipt.ownerId.trim() === '') {
    throw new Error('INVALID_OWNER_ID');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'component') || receipt.component !== 'voice-foundation-models') {
    throw new Error('COMPONENT_IDENTITY_MISMATCH');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'helperKind') || receipt.helperKind !== 'foundation-models') {
    throw new Error('HELPER_KIND_MISMATCH');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'binaryName') || receipt.binaryName !== 'voice-foundation-models') {
    throw new Error('BINARY_NAME_MISMATCH');
  }

  const validStatuses = ['unobserved', 'running', 'exited'];
  if (!Object.prototype.hasOwnProperty.call(receipt, 'status') || !validStatuses.includes(receipt.status)) {
    throw new Error('INVALID_LIFECYCLE_STATUS');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'helperPid')) {
    throw new Error('MISSING_CANONICAL_FIELD: helperPid');
  }
  if (!Object.prototype.hasOwnProperty.call(receipt, 'exited')) {
    throw new Error('MISSING_CANONICAL_FIELD: exited');
  }
  if (!Object.prototype.hasOwnProperty.call(receipt, 'reaped')) {
    throw new Error('MISSING_CANONICAL_FIELD: reaped');
  }
  if (!Object.prototype.hasOwnProperty.call(receipt, 'exitCode')) {
    throw new Error('MISSING_CANONICAL_FIELD: exitCode');
  }
  if (!Object.prototype.hasOwnProperty.call(receipt, 'signalCode')) {
    throw new Error('MISSING_CANONICAL_FIELD: signalCode');
  }

  if (receipt.status === 'unobserved') {
    if (receipt.helperPid !== null) {
      throw new Error('UNOBSERVED_STATUS_PID_MUST_BE_NULL');
    }
    if (receipt.exited !== false || receipt.reaped !== false) {
      throw new Error('STATUS_CONTRADICTION: unobserved exited and reaped must be false');
    }
    if (receipt.exitCode !== null || receipt.signalCode !== null) {
      throw new Error('STATUS_CONTRADICTION: unobserved exitCode and signalCode must be null');
    }
  } else if (receipt.status === 'running') {
    if (!Number.isSafeInteger(receipt.helperPid) || receipt.helperPid <= 0) {
      throw new Error('INVALID_HELPER_PID: running helperPid must be positive integer');
    }
    if (receipt.exited !== false || receipt.reaped !== false) {
      throw new Error('STATUS_CONTRADICTION: running exited and reaped must be false');
    }
    if (receipt.exitCode !== null || receipt.signalCode !== null) {
      throw new Error('STATUS_CONTRADICTION: running exitCode and signalCode must be null');
    }
  } else if (receipt.status === 'exited') {
    if (receipt.helperPid !== null && (!Number.isSafeInteger(receipt.helperPid) || receipt.helperPid <= 0)) {
      throw new Error('INVALID_HELPER_PID: exited helperPid must be positive integer or null');
    }
    if (receipt.exited !== true || receipt.reaped !== true) {
      throw new Error('STATUS_CONTRADICTION: exited must have exited=true and reaped=true');
    }
    if (receipt.exitCode !== null && !Number.isSafeInteger(receipt.exitCode)) {
      throw new Error('INVALID_EXIT_CODE');
    }
    if (receipt.signalCode !== null && (typeof receipt.signalCode !== 'string' || receipt.signalCode.trim() === '')) {
      throw new Error('INVALID_SIGNAL_CODE');
    }
    if (receipt.exitCode === null && receipt.signalCode === null) {
      throw new Error('STATUS_CONTRADICTION: exited must have exitCode or signalCode');
    }
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'seq') || !Number.isSafeInteger(receipt.seq) || receipt.seq < 1) {
    throw new Error('INVALID_LIFECYCLE_SEQ: seq must be safe positive integer >= 1');
  }

  if (!Object.prototype.hasOwnProperty.call(receipt, 'issuedAt') || !Number.isSafeInteger(receipt.issuedAt) || receipt.issuedAt <= 0) {
    throw new Error('INVALID_LIFECYCLE_ISSUED_AT: issuedAt must be positive integer timestamp');
  }

  if (Object.hasOwn(receipt, 'operation')) {
    const o = receipt.operation;
    const keys = ['phase', 'observationId', 'challenge', 'requestId', 'sessionId', 'nativeRequestId', 'generation'];
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join() !== keys.sort().join()
      || !['pending', 'closed', 'recovered'].includes(o.phase)
      || !keys.filter(k => k !== 'phase').every(k => typeof o[k] === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(o[k]))
      || receipt.helperPid === null || receipt.status !== (o.phase === 'closed' ? 'exited' : 'running')) throw new Error('INVALID_OPERATION_OBSERVATION');
  }
  if (requireSignature) {
    if (typeof receipt.authSignature !== 'string' || receipt.authSignature.trim() === '') {
      throw new Error('MISSING_AUTH_SIGNATURE');
    }
  }

  return true;
}

function canonicalReceiptPayload(data) {
  validateCanonicalReceiptSchema(data, { requireSignature: false, allowOperation: true });
  return [
    String(data.version),
    data.type,
    data.launchNonce,
    data.sessionNonce,
    data.ownerId,
    data.component,
    data.helperKind,
    data.binaryName,
    data.helperPid === null ? '' : String(data.helperPid),
    data.status,
    data.exited ? 'true' : 'false',
    data.reaped ? 'true' : 'false',
    data.exitCode === null ? '' : String(data.exitCode),
    data.signalCode === null ? '' : String(data.signalCode),
    String(data.seq),
    String(data.issuedAt)
  ].join(':') + (data.operation ? ':operation-v1:' + ['phase', 'observationId', 'challenge', 'requestId', 'sessionId', 'nativeRequestId', 'generation'].map(k => data.operation[k]).join(':') : '');
}

function computeReceiptSignature(secret, data) {
  if (!secret || typeof secret !== 'string') return '';
  const payload = canonicalReceiptPayload(data);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function verifyReceiptSignature(secret, receipt) {
  if (!secret || !receipt || typeof receipt !== 'object' || !receipt.authSignature) return false;
  try {
    const expected = computeReceiptSignature(secret, receipt);
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(receipt.authSignature, 'hex');
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

const CONTRACT_DIGEST = crypto.createHash('sha256')
  .update(CANONICAL_FIELD_NAMES.join(':') + ':v1:closed-schema:path-policy:metadata-policy:opt-in-operation-v1')
  .digest('hex');

function getContractDigest() {
  return CONTRACT_DIGEST;
}

module.exports = {
  CANONICAL_FIELD_NAMES,
  ALLOWED_RECEIPT_KEYS,
  validateReceiptPathPolicy,
  validateReceiptFileMetadata,
  validateCanonicalReceiptSchema,
  canonicalReceiptPayload,
  computeReceiptSignature,
  verifyReceiptSignature,
  CONTRACT_DIGEST,
  getContractDigest
};
