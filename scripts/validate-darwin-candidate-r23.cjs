'use strict';

// R23 A consumer. The Python producer is only a byte inventory writer. This
// validator owns the candidate contract, rechecks the real tree with the
// shared runtime inventory verifier, and performs descriptor-bound readback.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { canonicalInventory, scanFiles, verifyInventory } = require('../apps/desktop/tree-integrity.cjs');
const { selectPackagedSpeechProfile } = require('../apps/desktop/packaged-speech-profile.cjs');

const CONTRACT = 'R23_DARWIN_CANDIDATE_V2';
const SCHEMA_VERSION = 2;
const MAX_CANDIDATE_BYTES = 4 * 1024 * 1024;
const ENTRYPOINT = 'bin/voice-runtime';
const STT_ROOT = 'models/mlx-whisper';
const ONNX_MODEL = 'models/kokoro-onnx/model.onnx';
const ONNX_VOICES = 'models/kokoro-onnx/voices.bin';
const REQUIRED_ROLES = Object.freeze({
  entrypoint: ENTRYPOINT,
  sttRoot: STT_ROOT,
  onnxModel: ONNX_MODEL,
  onnxVoices: ONNX_VOICES,
  license: 'LICENSE',
  notice: 'NOTICE',
});
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`R23_DARWIN_CANDIDATE: ${message}`);
}

function keys(value, expected, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`object required at ${context}`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || actual.some(key => typeof key !== 'string')
    || !expected.every(key => Object.hasOwn(value, key))) fail(`schema mismatch at ${context}`);
}

function text(value, context, max = 2048) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`invalid text at ${context}`);
}

function https(value, context) {
  text(value, context);
  let url;
  try { url = new URL(value); } catch { fail(`invalid URL at ${context}`); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(`invalid HTTPS URL at ${context}`);
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameIdentity(left, right) {
  return isDeepStrictEqual(identity(left), identity(right));
}

function readExact(filePath) {
  const listed = fs.lstatSync(filePath);
  if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1) fail('candidate file identity rejected');
  if (listed.size > MAX_CANDIDATE_BYTES) fail('candidate file too large');
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(listed, opened)) fail('candidate changed before read');
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_CANDIDATE_BYTES) fail('candidate grew during read');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fs.fstatSync(fd);
    if (!sameIdentity(opened, after) || total !== opened.size) fail('candidate changed during read');
    return Buffer.concat(chunks, total);
  } finally { fs.closeSync(fd); }
}

function canonicalRoot(inputRoot) {
  const supplied = path.resolve(inputRoot);
  const listed = fs.lstatSync(supplied);
  if (!listed.isDirectory() || listed.isSymbolicLink()) fail('input root must be a physical directory');
  const root = fs.realpathSync(supplied);
  const owner = fs.lstatSync(root);
  if (!owner.isDirectory() || owner.isSymbolicLink()) fail('canonical input root is not physical');
  if (typeof process.getuid === 'function' && owner.uid !== process.getuid()) fail('input root is not caller-owned');
  return root;
}

function candidateJson(candidatePath) {
  const raw = readExact(candidatePath);
  try { return JSON.parse(raw.toString('utf8')); } catch { fail('candidate JSON is invalid'); }
}

function validateCandidate(candidate, root, candidatePath) {
  keys(candidate, [
    'schemaVersion', 'contract', 'label', 'status', 'platform', 'arch', 'backend', 'entrypoint',
    'modelBindings', 'requiredRoles', 'files', 'treeDigest', 'bytes', 'archive', 'provenance',
  ], 'candidate');
  if (candidate.schemaVersion !== SCHEMA_VERSION || candidate.contract !== CONTRACT
    || candidate.label !== 'CANDIDATE_NOT_TRUSTED' || candidate.platform !== 'darwin' || candidate.arch !== 'arm64') {
    fail('candidate identity mismatch');
  }
  const profile = selectPackagedSpeechProfile('darwin', 'arm64');
  keys(candidate.backend, ['stt', 'tts', 'ttsExecutionProvider'], 'backend');
  if (!isDeepStrictEqual(candidate.backend, {
    stt: profile.enums.VOICE_STT_BACKEND,
    tts: profile.enums.VOICE_TTS_BACKEND,
    ttsExecutionProvider: profile.enums.VOICE_KOKORO_EXECUTION_PROVIDER,
  })) fail('backend profile mismatch');
  if (candidate.entrypoint !== ENTRYPOINT) fail('entrypoint profile mismatch');
  keys(candidate.modelBindings, ['sttRoot', 'onnxModel', 'onnxVoices'], 'modelBindings');
  for (const [role, value] of Object.entries(candidate.modelBindings)) {
    keys(value, ['path'], `modelBindings.${role}`);
    if (value.path !== { sttRoot: STT_ROOT, onnxModel: ONNX_MODEL, onnxVoices: ONNX_VOICES }[role]) fail(`model binding mismatch: ${role}`);
  }
  keys(candidate.requiredRoles, Object.keys(REQUIRED_ROLES), 'requiredRoles');
  if (!isDeepStrictEqual(candidate.requiredRoles, REQUIRED_ROLES)) fail('required role profile mismatch');

  if (!Array.isArray(candidate.files)) fail('files must be an array');
  let inventory = null;
  if (candidate.files.length) {
    inventory = canonicalInventory(candidate.files);
    if (!isDeepStrictEqual(inventory.files, candidate.files)) fail('files are not canonical');
    if (candidate.treeDigest !== inventory.treeDigest) fail('tree digest mismatch');
    if (candidate.bytes !== inventory.totalBytes) fail('candidate byte count mismatch');
  } else {
    if (candidate.treeDigest !== crypto.createHash('sha256').update('').digest('hex') || candidate.bytes !== 0) fail('empty inventory mismatch');
    if (scanFiles(root).length !== 0) fail('candidate omitted real files');
  }
  if (candidate.files.length) {
    const paths = new Set(candidate.files.map(value => value.path));
    const completeProfile = paths.has(ENTRYPOINT) && paths.has(ONNX_MODEL) && paths.has(ONNX_VOICES)
      && paths.has('LICENSE') && paths.has('NOTICE')
      && [...paths].some(value => value.startsWith(`${STT_ROOT}/`));
    // Complete candidates use the exact runtime verifier. An incomplete local
    // tree may contain empty staging directories, which the file inventory
    // contract does not serialize; scanFiles still applies the same bounded,
    // descriptor and special-file rules while preserving INPUTS_MISSING.
    const verification = completeProfile
      ? verifyInventory(root, inventory)
      : Promise.resolve(canonicalInventory(scanFiles(root)));
    return verification.then(verified => {
      if (!isDeepStrictEqual(verified.files, inventory.files) || verified.treeDigest !== candidate.treeDigest) {
        fail('real tree readback mismatch');
      }
      return finishCandidateChecks(candidate, candidatePath);
    });
  }
  return Promise.resolve(finishCandidateChecks(candidate, candidatePath));
}

function finishCandidateChecks(candidate, candidatePath) {
  keys(candidate.archive, ['status', 'bytes', 'sha256'], 'archive');
  if (candidate.archive.status !== 'NOT_PRODUCED' || candidate.archive.bytes !== null || candidate.archive.sha256 !== null) fail('archive status mismatch');
  keys(candidate.provenance, ['sourceRevision', 'sourceUrl', 'sourceVerification', 'license', 'notice'], 'provenance');
  if (!HEX40.test(candidate.provenance.sourceRevision || '') && !HEX64.test(candidate.provenance.sourceRevision || '')) fail('source revision is not a SHA');
  https(candidate.provenance.sourceUrl, 'provenance.sourceUrl');
  if (candidate.provenance.sourceVerification !== 'UNVERIFIED') fail('source verification was overstated');
  keys(candidate.provenance.license, ['spdx', 'url', 'verification'], 'provenance.license');
  text(candidate.provenance.license.spdx, 'provenance.license.spdx', 200);
  https(candidate.provenance.license.url, 'provenance.license.url');
  if (candidate.provenance.license.verification !== 'UNVERIFIED') fail('license verification was overstated');
  keys(candidate.provenance.notice, ['path', 'status'], 'provenance.notice');
  if (candidate.provenance.notice.path !== 'NOTICE') fail('notice path mismatch');
  const paths = new Set(candidate.files.map(value => value.path));
  const complete = paths.has(ENTRYPOINT) && paths.has(ONNX_MODEL) && paths.has(ONNX_VOICES)
    && paths.has('LICENSE') && paths.has('NOTICE')
    && [...paths].some(value => value.startsWith(`${STT_ROOT}/`));
  const expectedStatus = complete ? 'CANDIDATE_NOT_TRUSTED' : 'INPUTS_MISSING';
  if (candidate.status !== expectedStatus) fail('missing profile status mismatch');
  if (candidate.provenance.notice.status !== (paths.has('NOTICE') ? 'PRESENT' : 'MISSING')) fail('notice status mismatch');
  if (complete && candidate.entrypoint && !paths.has(candidate.entrypoint)) fail('entrypoint is absent from fileset');
  return { status: candidate.status, contract: candidate.contract, files: candidate.files.length, treeDigest: candidate.treeDigest };
}

async function main(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i] || !argv[i].startsWith('--') || argv[i + 1] === undefined) fail('arguments must be --key value pairs');
    args.set(argv[i], argv[i + 1]);
  }
  if (args.size !== 2 || !args.has('--input-root') || !args.has('--candidate')) fail('input root and candidate are required');
  const root = canonicalRoot(args.get('--input-root'));
  const candidatePath = path.resolve(args.get('--candidate'));
  const candidate = candidateJson(candidatePath);
  const result = await validateCandidate(candidate, root, candidatePath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = { validateCandidate, canonicalRoot, candidateJson };
