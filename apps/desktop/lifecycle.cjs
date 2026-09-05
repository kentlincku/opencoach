'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function enforceSingleInstance({ hasLock, isSmokeTest, app }) {
  if (hasLock) return true;
  if (isSmokeTest) app.exit(1);
  else app.quit();
  return false;
}

async function writeSmokeResult({ filePath, tempRoot, marker, fsImpl = fs }) {
  if (typeof filePath !== 'string' || !filePath || typeof tempRoot !== 'string' || !tempRoot
    || typeof marker !== 'string' || !marker.startsWith('PACKAGED_APP_SMOKE_OK:')) {
    throw new Error('INVALID_SMOKE_RESULT');
  }
  const resolvedRoot = path.resolve(tempRoot);
  const resolvedFile = path.resolve(filePath);
  if (path.dirname(resolvedFile) !== resolvedRoot) throw new Error('INVALID_SMOKE_RESULT_PATH');
  await fsImpl.writeFile(resolvedFile, `${marker}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function restoreOrCreateWindow({ getWindow, createWindow, canCreate = true }) {
  const window = getWindow();
  if (!window || window.isDestroyed()) {
    if (!canCreate) return;
    await createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.focus();
}

module.exports = { enforceSingleInstance, restoreOrCreateWindow, writeSmokeResult };
