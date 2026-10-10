'use strict';
// Main-owned STT model preference (spec docs/contracts/stt-model-choice.md).
// Stored per practice language in userData; never read from the renderer.
// The stored value is only a request: Main still checks it against the
// compiled trust allow-list. The trust default is used ONLY when no
// preference file exists or the language has no entry. A file that exists but
// is unreadable, malformed, oversized or holds an unknown ID is reported
// (STT_PREFERENCE_* / STT_MODEL_NOT_ALLOWED), never silently replaced.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const FILE = 'stt-model-preference.json';
const MAX_BYTES = 4096;
const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function emptyPreference() { return { schemaVersion: 1, stt: {} }; }

// Strict: throws STT_PREFERENCE_INVALID on any malformed content.
function parsePreference(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('STT_PREFERENCE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
      || !value.stt || typeof value.stt !== 'object' || Array.isArray(value.stt)
      || Object.keys(value).length !== 2) throw new Error('STT_PREFERENCE_INVALID');
  const stt = {};
  for (const [language, id] of Object.entries(value.stt)) {
    if (!LANG.test(language) || typeof id !== 'string' || !ID.test(id)) throw new Error('STT_PREFERENCE_INVALID');
    stt[language] = id;
  }
  return { schemaVersion: 1, stt };
}

// No symlink following; bounded read on the opened descriptor (no lstat/read race).
function readPreference(userData, fsImpl = fs) {
  const file = path.join(userData, FILE);
  let fd;
  try {
    fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyPreference();
    throw new Error('STT_PREFERENCE_UNREADABLE');
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile()) throw new Error('STT_PREFERENCE_UNREADABLE');
    if (stat.size > MAX_BYTES) throw new Error('STT_PREFERENCE_INVALID');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let n = 0, count;
    while (n < buffer.length && (count = fsImpl.readSync(fd, buffer, n, buffer.length - n, n))) n += count;
    if (n > MAX_BYTES) throw new Error('STT_PREFERENCE_INVALID');
    return parsePreference(buffer.subarray(0, n).toString('utf8'));
  } catch (error) {
    if (/^STT_PREFERENCE_/.test(error?.message)) throw error;
    throw new Error('STT_PREFERENCE_UNREADABLE');
  } finally { fsImpl.closeSync(fd); }
}

// Exclusive random temp file (never follows a pre-placed link), fsync, then rename.
function writePreference(userData, preference, fsImpl = fs) {
  const clean = parsePreference(JSON.stringify(preference));
  const file = path.join(userData, FILE);
  const temp = path.join(userData, `.${FILE}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = fsImpl.openSync(temp, 'wx', 0o600);
  try {
    fsImpl.writeSync(fd, `${JSON.stringify(clean)}\n`);
    fsImpl.fsyncSync(fd);
  } catch (error) {
    fsImpl.closeSync(fd);
    fsImpl.rmSync(temp, { force: true });
    throw error;
  }
  fsImpl.closeSync(fd);
  fsImpl.renameSync(temp, file);
  return clean;
}

// {modelId, source}: source 'preference' | 'default'. Throws STT_MODEL_NOT_ALLOWED
// when the stored preference is not in the allow-list (no silent fallback).
function selectedSttModel({ preference, language, allowed, defaultId }) {
  const stt = preference?.stt || {};
  const stored = Object.hasOwn(stt, language) ? stt[language] : undefined;
  if (stored === undefined) return Object.freeze({ modelId: defaultId, source: 'default' });
  if (!allowed.includes(stored)) throw new Error('STT_MODEL_NOT_ALLOWED');
  return Object.freeze({ modelId: stored, source: 'preference' });
}

function setSttPreference(preference, language, modelId, allowed) {
  if (!LANG.test(language)) throw new Error('INVALID_LANGUAGE_TAG');
  if (typeof modelId !== 'string' || !allowed.includes(modelId)) throw new Error('STT_MODEL_NOT_ALLOWED');
  return { schemaVersion: 1, stt: { ...preference.stt, [language]: modelId } };
}

module.exports = { readPreference, writePreference, parsePreference, selectedSttModel, setSttPreference, FILE, MAX_BYTES };
