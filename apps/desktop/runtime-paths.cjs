const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
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

function assertManagedPath(managedRoot, candidate) {
  const fs = require('node:fs');
  const root = path.resolve(managedRoot);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('MANAGED_PATH_ESCAPE');
  const volume = path.parse(target).root;
  let current = volume;
  for (const part of ['', ...target.slice(volume.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('MANAGED_PATH_LINK');
    if ((current !== target || current === root) && !stat.isDirectory()) throw new Error('MANAGED_PATH_NOT_DIRECTORY');
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('MANAGED_PATH_SPECIAL');
    // realpath additionally catches redirected paths observable by this platform.
    if (path.relative(current, fs.realpathSync(current)) !== '') throw new Error('MANAGED_PATH_LINK');
  }
  if (!fs.lstatSync(root).isDirectory()) throw new Error('MANAGED_PATH_NOT_DIRECTORY');
  return target;
}

function generationLayout(layout, generation = `g-${randomBytes(32).toString('hex')}`) {
  if (typeof generation !== 'string' || !/^g-[0-9a-f]{64}$/.test(generation)) throw new Error('INVALID_GENERATION');
  const generationRoot = path.join(layout.root, 'generations', generation);
  return Object.freeze({...layout, generation, generationRoot, staging: path.join(generationRoot, 'payload'),
    partial: path.join(generationRoot, 'archive.partial'), versionDir: path.join(generationRoot, 'payload')});
}

function ensureManagedDirectory(managedRoot, candidate) {
  const fs = require('node:fs');
  const root = path.resolve(managedRoot), target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('MANAGED_PATH_ESCAPE');
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, {mode: 0o700}); stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error('MANAGED_PATH_LINK');
    if (!stat.isDirectory()) throw new Error('ENOTDIR:MANAGED_PATH_NOT_DIRECTORY');
    if (path.relative(current, fs.realpathSync(current)) !== '') throw new Error('MANAGED_PATH_LINK');
  }
  return assertManagedPath(root, target);
}

module.exports = { runtimeLayout, generationLayout, ensureManagedDirectory, resolveActivatedEntrypoint, assertManagedPath };
