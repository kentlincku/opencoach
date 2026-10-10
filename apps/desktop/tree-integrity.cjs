const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function scanFiles(root, {exclude = new Set()} = {}) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('FILESET_ROOT_FORBIDDEN');
  const output = [];
  const nodes = new Map([['', {name: '', type: 'directory'}]]);
  let directoryCount = 1;
  const addNode = (relative, type) => {
    const folded = relative.toLowerCase();
    const previous = nodes.get(folded);
    if (previous && (previous.name !== relative || previous.type !== type || type === 'file')) {
      throw new Error(`FILESET_PATH_COLLISION:${relative}`);
    }
    nodes.set(folded, {name: relative, type});
  };
  const visit = (directory, depth) => {
    if (depth > ASSET_LIMITS.maxDepth) throw new Error('FILESET_DEPTH_LIMIT');
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error(`FILESET_SYMLINK_FORBIDDEN:${relative}`);
      if (entry.isDirectory()) {
        addNode(relative, 'directory');
        directoryCount += 1;
        if (directoryCount > ASSET_LIMITS.maxDirectories) throw new Error('FILESET_DIRECTORY_LIMIT');
        visit(full, depth + 1);
      }
      else if (entry.isFile()) {
        addNode(relative, 'file');
        if (!exclude.has(relative)) {
          const listed = fs.lstatSync(full);
          if (listed.nlink !== 1) throw new Error(`FILESET_HARDLINK_FORBIDDEN:${relative}`);
          const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          try {
            const opened = fs.fstatSync(fd);
            if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== listed.dev
              || opened.ino !== listed.ino || opened.size !== listed.size) {
              throw new Error(`FILESET_FILE_IDENTITY_CHANGED:${relative}`);
            }
            const hash = crypto.createHash('sha256');
            const buffer = Buffer.alloc(ASSET_LIMITS.streamBytes);
            let bytes = 0;
            let count;
            while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
              bytes += count;
              if (bytes > ASSET_LIMITS.maxTotalBytes) throw new Error('FILESET_TOTAL_LIMIT');
              hash.update(buffer.subarray(0, count));
            }
            const after = fs.fstatSync(fd);
            if (after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino
              || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
              || bytes !== opened.size) throw new Error(`FILESET_FILE_CHANGED:${relative}`);
            output.push({path: relative, bytes, sha256: hash.digest('hex')});
          } finally { fs.closeSync(fd); }
        }
      } else throw new Error(`FILESET_SPECIAL_FILE_FORBIDDEN:${relative}`);
    }
  };
  visit(root, 0);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(`${file.path}:${file.bytes}:${file.sha256}\n`);
  return hash.digest('hex');
}

function verifyFiles(root, expected, {exclude = new Set()} = {}) {
  if (!Array.isArray(expected) || !expected.length) throw new Error('FILESET_EXPECTATION_MISSING');
  const actual = scanFiles(root, {exclude});
  if (actual.length !== expected.length) throw new Error('FILESET_COUNT_MISMATCH');
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index];
    const right = expected[index];
    if (!right || left.path !== right.path) throw new Error('FILESET_PATH_MISMATCH');
    if (left.bytes !== right.bytes || left.sha256 !== right.sha256) throw new Error(`FILESET_FILE_MISMATCH:${left.path}`);
  }
  return {files: actual, fileCount: actual.length, treeDigest: digestFiles(actual)};
}

const ASSET_LIMITS = Object.freeze({maxFiles: 4096, maxDirectories: 4096, maxDepth: 64,
  maxTotalBytes: 8 * 1024 ** 3, maxMetadataBytes: 4 * 1024 ** 2, maxPathBytes: 240, maxSegmentBytes: 100,
  maxTextLength: 200, maxUrlLength: 2048, streamBytes: 64 * 1024});
const SHA256 = /^[0-9a-f]{64}$/;

function assertPortablePath(value) {
  if (typeof value !== 'string' || !value || value.length > ASSET_LIMITS.maxPathBytes) throw new Error('INVALID_INVENTORY_PATH');
  for (const part of value.split('/')) {
    if (!/^[A-Za-z0-9_.-]+$/.test(part) || part.length > ASSET_LIMITS.maxSegmentBytes
      || part === '.' || part === '..' || part.endsWith('.')
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('INVALID_INVENTORY_PATH');
  }
  return value;
}

function canonicalInventory(input) {
  if (!Array.isArray(input) || !input.length || input.length > ASSET_LIMITS.maxFiles) throw new Error('INVALID_INVENTORY_COUNT');
  const nodes = new Map();
  let directoryCount = 0;
  let totalBytes = 0;
  const files = input.map(file => {
    const keys = ['path', 'bytes', 'sha256'];
    if (!file || typeof file !== 'object' || Array.isArray(file) || Reflect.ownKeys(file).length !== 3
      || !keys.every(key => Object.hasOwn(file, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(file, key), 'value'))) throw new Error('INVALID_INVENTORY_FILE');
    assertPortablePath(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw new Error('INVALID_INVENTORY_FILE');
    totalBytes += file.bytes;
    if (totalBytes > ASSET_LIMITS.maxTotalBytes) throw new Error('INVENTORY_TOTAL_LIMIT');
    const parts = file.path.split('/');
    if (parts.length > ASSET_LIMITS.maxDepth + 1) throw new Error('INVENTORY_DEPTH_LIMIT');
    for (let i = 1; i <= parts.length; i += 1) {
      const name = parts.slice(0, i).join('/');
      const type = i === parts.length ? 'file' : 'directory';
      if (type === 'directory' && !nodes.has(name.toLowerCase())) {
        directoryCount += 1;
        if (directoryCount > ASSET_LIMITS.maxDirectories) throw new Error('INVENTORY_DIRECTORY_LIMIT');
      }
      const previous = nodes.get(name.toLowerCase());
      if (previous && (previous.name !== name || previous.type !== type || type === 'file')) throw new Error('INVENTORY_PATH_COLLISION');
      nodes.set(name.toLowerCase(), {name, type});
    }
    return Object.freeze({path: file.path, bytes: file.bytes, sha256: file.sha256});
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Object.freeze({files: Object.freeze(files), fileCount: files.length, totalBytes, treeDigest: digestFiles(files)});
}

function validateInventory(files, treeDigest) {
  const result = canonicalInventory(files);
  if (typeof treeDigest !== 'string' || !SHA256.test(treeDigest) || treeDigest !== result.treeDigest) throw new Error('INVENTORY_DIGEST_MISMATCH');
  return result;
}

function allowedSystemAlias(candidate) {
  if (process.platform !== 'darwin' || !['/var', '/tmp', '/etc', '/dev'].includes(candidate)) return false;
  try { return fs.realpathSync(candidate) === `/private${candidate}`; } catch { return false; }
}

// Check the lexical path while it still contains the caller's spelling. Once
// realpath runs, an arbitrary ancestor link is indistinguishable from a
// physical directory. Only Apple's fixed /private aliases are accepted on
// Darwin; review fixtures and managed roots cannot introduce their own alias.
function canonicalVerifiedRoot(value) {
  const supplied = path.resolve(value);
  const volume = path.parse(supplied).root;
  let current = volume;
  for (const part of supplied.slice(volume.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() && !allowedSystemAlias(current)) throw new Error('INVENTORY_LINK');
    if (!stat.isDirectory() && !(stat.isSymbolicLink() && allowedSystemAlias(current)) && current !== supplied) {
      throw new Error('INVENTORY_ROOT');
    }
  }
  const final = fs.lstatSync(supplied);
  if ((!final.isDirectory()) || (final.isSymbolicLink() && !allowedSystemAlias(supplied))) {
    throw new Error('INVENTORY_LINK');
  }
  return fs.realpathSync(supplied);
}

async function verifyInventory(root, trustedArtifact, {signal} = {}) {
  const checkAbort = () => { if (signal?.aborted) throw new Error('INVENTORY_ABORTED'); };
  checkAbort();
  const { assertManagedPath } = require('./runtime-paths.cjs');
  root = canonicalVerifiedRoot(root);
  const expected = validateInventory(trustedArtifact?.files, trustedArtifact?.treeDigest);
  root = assertManagedPath(root, root);
  const wanted = new Map(expected.files.map(file => [file.path, file]));
  const directories = new Set();
  for (const file of expected.files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const actual = [];
  const actualNodes = new Map([['', {name: '', type: 'directory'}]]);
  let directoryCount = 1;
  const buffer = Buffer.alloc(ASSET_LIMITS.streamBytes);
  const addActualNode = (name, type) => {
    const folded = name.toLowerCase();
    const previous = actualNodes.get(folded);
    if (previous && (previous.name !== name || previous.type !== type || type === 'file')) {
      throw new Error(`INVENTORY_PATH_COLLISION:${name}`);
    }
    actualNodes.set(folded, {name, type});
  };
  async function visit(relative, depth) {
    checkAbort();
    if (depth > ASSET_LIMITS.maxDepth) throw new Error('INVENTORY_DEPTH_LIMIT');
    const directory = assertManagedPath(root, path.join(root, relative));
    const entries = await fs.promises.opendir(directory);
    for await (const entry of entries) {
      checkAbort();
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      assertPortablePath(name);
      if (name.split('/').length > ASSET_LIMITS.maxDepth + 1) throw new Error('INVENTORY_DEPTH_LIMIT');
      const full = assertManagedPath(root, path.join(root, name));
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink()) throw new Error('INVENTORY_LINK');
      if (stat.isDirectory()) {
        addActualNode(name, 'directory');
        directoryCount += 1;
        if (directoryCount > ASSET_LIMITS.maxDirectories) throw new Error('INVENTORY_DIRECTORY_LIMIT');
        if (!directories.has(name)) throw new Error(`INVENTORY_UNLISTED_DIRECTORY:${name}`);
        await visit(name, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new Error(`INVENTORY_SPECIAL_FILE:${name}`);
      addActualNode(name, 'file');
      if (stat.nlink !== 1) throw new Error(`INVENTORY_HARDLINK:${name}`);
      const file = wanted.get(name);
      if (!file) throw new Error(`INVENTORY_UNLISTED_FILE:${name}`);
      const handle = await fs.promises.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        checkAbort();
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.size !== file.bytes || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error(`INVENTORY_FILE_MISMATCH:${name}`);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        for (;;) {
          checkAbort();
          const result = await handle.read(buffer, 0, buffer.length, null);
          checkAbort();
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
          if (bytes > file.bytes) throw new Error(`INVENTORY_FILE_MISMATCH:${name}`);
          hash.update(buffer.subarray(0, result.bytesRead));
        }
        const sha256 = hash.digest('hex');
        const after = await handle.stat();
        if (after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino
          || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
          || bytes !== file.bytes || sha256 !== file.sha256) throw new Error(`INVENTORY_FILE_MISMATCH:${name}`);
        actual.push({path: name, bytes, sha256});
      } finally { await handle.close(); }
    }
  }
  await visit('', 0);
  checkAbort();
  if (actual.length !== expected.fileCount) throw new Error('INVENTORY_COUNT_MISMATCH');
  assertManagedPath(root, root);
  return validateInventory(actual, expected.treeDigest);
}

// Final same-stack check for a managed snapshot immediately before the OS spawn.
// Bounded streaming, exact directory set; never readFile a model into memory.
function verifyInventorySync(root, trustedArtifact) {
  const {assertManagedPath} = require('./runtime-paths.cjs');
  root = canonicalVerifiedRoot(root);
  const expected = validateInventory(trustedArtifact.files, trustedArtifact.treeDigest);
  const wanted = new Map(expected.files.map(f=>[f.path,f]));
  const directories = new Set(['']);
  const actualNodes = new Map([['', {name: '', type: 'directory'}]]);
  let directoryCount = 1;
  for (const f of expected.files) {
    const parts = f.path.split('/');
    for (let i=1;i<parts.length;i++) directories.add(parts.slice(0,i).join('/'));
  }
  const buffer = Buffer.alloc(ASSET_LIMITS.streamBytes);
  let count = 0;
  const addActualNode = (name, type) => {
    const folded = name.toLowerCase();
    const previous = actualNodes.get(folded);
    if (previous && (previous.name !== name || previous.type !== type || type === 'file')) throw Error('INVENTORY_PATH_COLLISION');
    actualNodes.set(folded, {name, type});
  };
  function visit(relative, depth) {
    if (depth > ASSET_LIMITS.maxDepth) throw Error('INVENTORY_DEPTH_LIMIT');
    const directory = fs.opendirSync(assertManagedPath(root,path.join(root,relative)));
    try {
      let entry;
      while ((entry=directory.readSync())) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (name.split('/').length > ASSET_LIMITS.maxDepth + 1) throw Error('INVENTORY_DEPTH_LIMIT');
        const full = assertManagedPath(root,path.join(root,name));
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) throw Error('INVENTORY_LINK');
        if (stat.isDirectory()) {
          addActualNode(name, 'directory');
          directoryCount += 1;
          if (directoryCount > ASSET_LIMITS.maxDirectories) throw Error('INVENTORY_DIRECTORY_LIMIT');
          if (!directories.has(name)) throw Error('INVENTORY_UNLISTED_DIRECTORY');
          visit(name, depth + 1); continue;
        }
        const file = wanted.get(name);
        addActualNode(name, 'file');
        if (!file || !stat.isFile()) throw Error('INVENTORY_UNLISTED_FILE');
        if (stat.nlink !== 1) throw Error('INVENTORY_HARDLINK');
        const fd=fs.openSync(full,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW||0));
        try {
          const opened=fs.fstatSync(fd), hash=crypto.createHash('sha256'); let bytes=0,n;
          if (!opened.isFile() || opened.nlink!==1 || opened.dev!==stat.dev || opened.ino!==stat.ino || opened.size!==file.bytes) throw Error('INVENTORY_FILE_MISMATCH');
          while ((n=fs.readSync(fd,buffer,0,buffer.length,null))) {
            bytes+=n; if (bytes>file.bytes) throw Error('INVENTORY_FILE_MISMATCH');
            hash.update(buffer.subarray(0,n));
          }
          const after=fs.fstatSync(fd);
          if (after.nlink!==1 || after.dev!==opened.dev || after.ino!==opened.ino || after.size!==opened.size
            || after.mtimeMs!==opened.mtimeMs || after.ctimeMs!==opened.ctimeMs
            || bytes!==file.bytes || hash.digest('hex')!==file.sha256) throw Error('INVENTORY_FILE_MISMATCH');
          count++;
        } finally {fs.closeSync(fd);}
      }
    } finally {directory.closeSync();}
  }
  visit('', 0);
  if (count!==expected.fileCount) throw Error('INVENTORY_COUNT_MISMATCH');
  return expected;
}
module.exports = {digestFiles, scanFiles, verifyFiles, ASSET_LIMITS, assertPortablePath, canonicalInventory, validateInventory, verifyInventory, verifyInventorySync};
