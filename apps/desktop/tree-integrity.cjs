const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function scanFiles(root, {exclude = new Set()} = {}) {
  const output = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error(`FILESET_SYMLINK_FORBIDDEN:${relative}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        if (!exclude.has(relative)) {
          const bytes = fs.statSync(full).size;
          const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          output.push({path: relative, bytes, sha256});
        }
      } else throw new Error(`FILESET_SPECIAL_FILE_FORBIDDEN:${relative}`);
    }
  };
  visit(root);
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

module.exports = {digestFiles, scanFiles, verifyFiles};
