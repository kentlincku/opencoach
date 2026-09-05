const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assertRelativeSafe } = require('./runtime-manifest.cjs');

function safeSegment(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') throw new Error(`INVALID_${name}`);
  return value;
}

function runtimeLayout(userData, release, platformKey) {
  const root = path.resolve(userData, 'runtime');
  const versionDir = path.join(root, safeSegment(release, 'RELEASE'), safeSegment(platformKey, 'PLATFORM'));
  const downloads = path.join(root, '.downloads');
  return Object.freeze({
    root,
    versionDir,
    downloads,
    partial: path.join(downloads, `${release}-${platformKey}.partial`),
    staging: path.join(root, `.staging-${randomUUID()}`),
    metadata: path.join(root, 'current.json'),
  });
}

function resolveActivatedEntrypoint(directory, entrypoint) {
  assertRelativeSafe(entrypoint, 'entrypoint');
  const root = path.resolve(directory);
  const resolved = path.resolve(root, ...entrypoint.split('/'));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('ENTRYPOINT_ESCAPE');
  return resolved;
}

module.exports = { runtimeLayout, resolveActivatedEntrypoint };
