'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../apps/desktop/credential-store.cjs');

function createMockCredentialStore({ encryptionAvailable = true } = {}) {
  const disk = new Map();
  const temporaryFiles = [];

  const mockSafeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (plaintext) => {
      // Emulate DPAPI ciphertext buffer
      return Buffer.from(`dpapi-cipher:${Buffer.from(plaintext).toString('hex')}`);
    },
    decryptString: (buffer) => {
      const str = Buffer.from(buffer).toString('utf8');
      if (!str.startsWith('dpapi-cipher:')) throw new Error('Decryption failed');
      return Buffer.from(str.slice('dpapi-cipher:'.length), 'hex').toString('utf8');
    },
  };

  const fsImpl = {
    async access(filePath) {
      if (!disk.has(filePath)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
    },
    async mkdir(dirPath) {
      disk.set(dirPath, { isDir: true });
    },
    async chmod() {},
    async writeFile(filePath, content) {
      if (filePath.includes('.tmp')) temporaryFiles.push(filePath);
      disk.set(filePath, content);
    },
    async readFile(filePath) {
      if (!disk.has(filePath)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return disk.get(filePath);
    },
    async rm(filePath) {
      disk.delete(filePath);
    },
    async rename(oldPath, newPath) {
      if (!disk.has(oldPath)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      disk.set(newPath, disk.get(oldPath));
      disk.delete(oldPath);
    },
  };

  const userDataDir = path.join(os.tmpdir(), `windows-dpapi-test-${Math.random().toString(36).slice(2)}`);
  const store = new CredentialStore({
    userData: userDataDir,
    safeStorage: mockSafeStorage,
    fsImpl,
  });

  return { store, disk, temporaryFiles, mockSafeStorage };
}

test('Windows DPAPI contract: fail-closed when safeStorage encryption is unavailable', async () => {
  const { store } = createMockCredentialStore({ encryptionAvailable: false });

  assert.equal(store.available(), false);
  const status = await store.has('openai');
  assert.equal(status.hasCredential, false);
  assert.equal(status.unavailable, true);

  await assert.rejects(
    store.set('openai', 'sk-test-key'),
    { message: 'SAFE_STORAGE_UNAVAILABLE' }
  );

  await assert.rejects(
    store.get('openai'),
    { message: 'SAFE_STORAGE_UNAVAILABLE' }
  );
});

test('Windows DPAPI contract: provider allowlist excludes local loopback providers', async () => {
  const { store } = createMockCredentialStore();

  for (const localProvider of ['ollama', 'lmstudio', 'omlx', 'llamacpp']) {
    assert.ok(!store.allowedProviders.has(localProvider), `${localProvider} must not be in credential allowlist`);
    assert.throws(() => store.filePath(localProvider), { message: 'PROVIDER_NOT_ALLOWED' });
    await assert.rejects(store.set(localProvider, 'key'), { message: 'PROVIDER_NOT_ALLOWED' });
    await assert.rejects(store.get(localProvider), { message: 'PROVIDER_NOT_ALLOWED' });
    await assert.rejects(store.has(localProvider), { message: 'PROVIDER_NOT_ALLOWED' });
    await assert.rejects(store.clear(localProvider), { message: 'PROVIDER_NOT_ALLOWED' });
  }

  for (const cloudProvider of ['claude', 'openai', 'gemini', 'groq', 'deepseek']) {
    assert.ok(store.allowedProviders.has(cloudProvider), `${cloudProvider} must be in credential allowlist`);
    assert.doesNotThrow(() => store.filePath(cloudProvider));
  }
});

test('Windows DPAPI contract: encrypted JSON schema version 1, zero plaintext on disk', async () => {
  const { store, disk } = createMockCredentialStore();
  const secretKey = 'sk-windows-dpapi-very-secret-token-12345';

  await store.set('openai', secretKey);

  const targetFile = store.filePath('openai');
  assert.ok(disk.has(targetFile), 'Target credential file must exist on disk');

  const rawDiskContent = disk.get(targetFile);
  assert.ok(!rawDiskContent.includes(secretKey), 'Plaintext secret must never appear on disk');

  const parsed = JSON.parse(rawDiskContent);
  assert.equal(parsed.version, 1, 'Credential record must declare schema version 1');
  assert.equal(typeof parsed.ciphertext, 'string', 'Ciphertext must be base64-encoded string');

  // Verify round-trip decryption
  const retrieved = await store.get('openai');
  assert.equal(retrieved, secretKey);
});

test('Windows DPAPI contract: atomic write uses temporary file before replace', async () => {
  const { store, temporaryFiles } = createMockCredentialStore();

  await store.set('groq', 'gsk-test-groq-key');

  assert.ok(temporaryFiles.length > 0, 'At least one temporary file must be used during write');
  const tempFile = temporaryFiles[0];
  assert.match(tempFile, /\.tmp$/, 'Temporary file must have .tmp suffix');
  assert.match(tempFile, /\.groq\./, 'Temporary file must contain provider ID');
});

test('Windows DPAPI contract: corrupt record fails closed without deleting other credentials', async () => {
  const { store, disk } = createMockCredentialStore();

  await store.set('openai', 'openai-secret');
  await store.set('deepseek', 'deepseek-secret');

  // Corrupt openai credential record
  const openaiFile = store.filePath('openai');
  disk.set(openaiFile, JSON.stringify({ version: 999, ciphertext: 'invalid-version' }));

  await assert.rejects(store.get('openai'), { message: 'CREDENTIAL_STORE_CORRUPT' });

  // Other credentials must remain intact and accessible
  const deepseekSecret = await store.get('deepseek');
  assert.equal(deepseekSecret, 'deepseek-secret');
});

test('Windows DPAPI contract: clear removes credential file cleanly', async () => {
  const { store, disk } = createMockCredentialStore();

  await store.set('gemini', 'gemini-key');
  assert.equal((await store.has('gemini')).hasCredential, true);

  await store.clear('gemini');
  assert.equal((await store.has('gemini')).hasCredential, false);
  assert.ok(!disk.has(store.filePath('gemini')));
});
