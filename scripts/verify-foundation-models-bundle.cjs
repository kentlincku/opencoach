'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { helperLaunch } = require('../apps/desktop/foundation-models-service.cjs');
// afterPack AND afterSign: refuse changed helper bytes, never rewrite the manifest.
module.exports = async function verifyBundle(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resourcesPath = await fs.realpath(path.join(context.appOutDir,
    context.packager.appInfo.productFilename + '.app', 'Contents/Resources'));
  await helperLaunch({ packaged: true, resourcesPath, arch: 'arm64' });
};
