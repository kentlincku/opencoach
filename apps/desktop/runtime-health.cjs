'use strict';

const { normalizeRuntimeCapabilities } = require('../web/runtime/runtime-contract.js');

function isHealthyRuntimeResponse(health) {
  return normalizeRuntimeCapabilities(health).ready === true;
}

function isCompatibleRuntimeProbe(raw, expectedPlatform, expectedArch) {
  const platforms = {win32: 'windows', darwin: 'darwin'};
  if (!Object.hasOwn(platforms, expectedPlatform) || expectedArch !== (expectedPlatform === 'win32' ? 'x64' : 'arm64')) return false;
  const keys = ['probeVersion', 'protocol', 'platform', 'arch', 'executable'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Reflect.ownKeys(raw).length !== keys.length) return false;
  if (!keys.every(key => Object.hasOwn(raw, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key), 'value'))) return false;
  return raw.probeVersion === 1 && raw.protocol === 1 && raw.executable === true
    && raw.platform === platforms[expectedPlatform] && raw.arch === expectedArch;
}

module.exports = { isHealthyRuntimeResponse, isCompatibleRuntimeProbe };
