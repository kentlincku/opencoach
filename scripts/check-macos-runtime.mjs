import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateEmbeddedRuntimeDirectory, REQUIRED_MACOS_RUNTIME_FILES } = require('../apps/desktop/embedded-runtime-validator.cjs');

export { REQUIRED_MACOS_RUNTIME_FILES };

export function validateMacOsRuntimeDirectory(runtimeDir, { platform = 'darwin', arch = 'arm64' } = {}) {
  return validateEmbeddedRuntimeDirectory(runtimeDir, {
    expectedPlatform: `${platform}-${arch}`,
    requireExecutable: true,
    requireTree: true,
    requiredFiles: REQUIRED_MACOS_RUNTIME_FILES,
  });
}

export function checkMacOsRuntime(baseDir = process.cwd()) {
  return validateMacOsRuntimeDirectory(path.join(baseDir, 'dist', 'voice-runtime'));
}

export function checkPackagedMacOsRuntime(appPath) {
  if (!appPath || typeof appPath !== 'string') throw new Error('MISSING_APP_PATH');
  const resolvedApp = path.resolve(appPath);
  if (!fs.existsSync(resolvedApp)) throw new Error(`MISSING_PACKAGED_APP: ${resolvedApp}`);
  return validateMacOsRuntimeDirectory(path.join(resolvedApp, 'Contents', 'Resources', 'runtime'));
}

if (process.argv[1] && (process.argv[1].endsWith('check-macos-runtime.mjs') || process.argv[1].endsWith('check-macos-runtime'))) {
  try {
    const appFlag = process.argv.indexOf('--app');
    const result = appFlag >= 0
      ? checkPackagedMacOsRuntime(process.argv[appFlag + 1])
      : checkMacOsRuntime();
    console.log(`MACOS_RUNTIME_VALIDATED platform=${result.platform} bytes=${result.bytes} sha256=${result.sha256} entrypoint=${result.entrypoint}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
