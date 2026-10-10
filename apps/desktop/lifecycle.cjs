'use strict';

function enforceSingleInstance({ hasLock, isSmokeTest, app }) {
  if (hasLock) return true;
  if (isSmokeTest) app.exit(1);
  else app.quit();
  return false;
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

module.exports = { enforceSingleInstance, restoreOrCreateWindow };
