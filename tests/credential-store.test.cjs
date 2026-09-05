const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../apps/desktop/credential-store.cjs');

function safeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: buffer => buffer.toString('utf8').replace(/^encrypted:/, ''),
  };
}

async function fixture(t, available = true, namespace = 'api') {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-store-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  return { userData, store: new CredentialStore({ userData, safeStorage: safeStorage(available), namespace }) };
}

test('stores encrypted provider credential atomically without plaintext', async t => {
  const { userData, store } = await fixture(t);
  assert.deepEqual(await store.set('openai', 'top-secret'), { stored: true });
  assert.deepEqual(await store.has('openai'), { hasCredential: true });
  assert.equal(await store.get('openai'), 'top-secret');
  const file = path.join(userData, 'provider-credentials', 'openai.json');
  const raw = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(raw, /top-secret/);
  assert.deepEqual((await fs.readdir(path.dirname(file))).sort(), ['openai.json']);
});

test('uses 0600 credential file permissions on POSIX', { skip: process.platform === 'win32' }, async t => {
  const { userData, store } = await fixture(t);
  await store.set('openai', 'top-secret');
  const file = path.join(userData, 'provider-credentials', 'openai.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('rejects providers outside the credential allowlist and never stores local/custom secrets', async t => {
  const { store } = await fixture(t);
  for (const provider of ['custom', 'omlx', 'ollama', 'lmstudio', '../openai']) {
    await assert.rejects(store.set(provider, 'secret'), /PROVIDER_NOT_ALLOWED/);
  }
});

test('fails closed when OS encryption is unavailable', async t => {
  const { store } = await fixture(t, false);
  await assert.rejects(store.set('openai', 'secret'), /SAFE_STORAGE_UNAVAILABLE/);
  await assert.rejects(store.get('openai'), /SAFE_STORAGE_UNAVAILABLE/);
  assert.deepEqual(await store.has('openai'), { hasCredential: false, unavailable: true });
});

test('clear removes credential without returning plaintext', async t => {
  const { store } = await fixture(t);
  await store.set('groq', 'secret');
  assert.deepEqual(await store.clear('groq'), { cleared: true });
  assert.deepEqual(await store.has('groq'), { hasCredential: false });
});

test('stores encrypted subscription token bundles only for supported account providers', async t => {
  const { userData, store } = await fixture(t, true, 'subscription');
  for (const providerId of ['chatgpt-subscription', 'grok-subscription']) {
    const bundle = JSON.stringify({ accessToken: `${providerId}-access`, refreshToken: `${providerId}-refresh` });
    assert.deepEqual(await store.set(providerId, bundle), { stored: true });
    assert.equal(await store.get(providerId), bundle);
  }
  assert.equal((await fs.readdir(path.join(userData, 'subscription-tokens'))).length, 2);
  await assert.rejects(store.set('openai', 'blocked'), /PROVIDER_NOT_ALLOWED/);
});

test('default API namespace rejects subscription token providers', async t => {
  const { store } = await fixture(t);
  for (const providerId of ['chatgpt-subscription', 'grok-subscription']) {
    await assert.rejects(store.set(providerId, '{"token":"blocked"}'), /PROVIDER_NOT_ALLOWED/);
    await assert.rejects(store.has(providerId), /PROVIDER_NOT_ALLOWED/);
    await assert.rejects(store.clear(providerId), /PROVIDER_NOT_ALLOWED/);
  }
});
