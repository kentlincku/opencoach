'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PROVIDER_NAMESPACES = Object.freeze({
  api: Object.freeze({ directory: 'provider-credentials', providers: new Set(['claude', 'openai', 'gemini', 'groq', 'deepseek']) }),
  subscription: Object.freeze({ directory: 'subscription-tokens', providers: new Set(['chatgpt-subscription', 'grok-subscription']) }),
});
const MAX_CREDENTIAL_CHARS = 16 * 1024;

class CredentialStore {
  constructor({ userData, safeStorage, fsImpl = fs, namespace = 'api' }) {
    const policy = PROVIDER_NAMESPACES[namespace];
    if (!userData || !safeStorage || !policy) throw new Error('INVALID_CREDENTIAL_STORE_CONFIG');
    this.directory = path.join(userData, policy.directory);
    this.allowedProviders = policy.providers;
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
  }

  available() {
    return this.safeStorage.isEncryptionAvailable() === true;
  }

  filePath(providerId) {
    if (!this.allowedProviders.has(providerId)) throw new Error('PROVIDER_NOT_ALLOWED');
    return path.join(this.directory, `${providerId}.json`);
  }

  async has(providerId) {
    const file = this.filePath(providerId);
    if (!this.available()) return { hasCredential: false, unavailable: true };
    try {
      await this.fs.access(file);
      return { hasCredential: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { hasCredential: false };
      throw error;
    }
  }

  async set(providerId, credential) {
    const file = this.filePath(providerId);
    if (!this.available()) throw new Error('SAFE_STORAGE_UNAVAILABLE');
    if (typeof credential !== 'string' || !credential.trim() || credential.length > MAX_CREDENTIAL_CHARS) {
      throw new Error('INVALID_CREDENTIAL');
    }
    const encrypted = this.safeStorage.encryptString(credential);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('CREDENTIAL_ENCRYPTION_FAILED');
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.fs.chmod(this.directory, 0o700);
    const temporary = path.join(this.directory, `.${providerId}.${randomUUID()}.tmp`);
    const serialized = JSON.stringify({ version: 1, ciphertext: encrypted.toString('base64') });
    try {
      await this.fs.writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
      await this.fs.chmod(temporary, 0o600);
      await this.fs.rename(temporary, file);
      await this.fs.chmod(file, 0o600);
    } finally {
      await this.fs.rm(temporary, { force: true }).catch(() => {});
    }
    return { stored: true };
  }

  async get(providerId) {
    const file = this.filePath(providerId);
    if (!this.available()) throw new Error('SAFE_STORAGE_UNAVAILABLE');
    let parsed;
    try {
      parsed = JSON.parse(await this.fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('CREDENTIAL_REQUIRED');
      throw new Error('CREDENTIAL_STORE_CORRUPT');
    }
    if (parsed?.version !== 1 || typeof parsed.ciphertext !== 'string') throw new Error('CREDENTIAL_STORE_CORRUPT');
    try {
      const plaintext = this.safeStorage.decryptString(Buffer.from(parsed.ciphertext, 'base64'));
      if (typeof plaintext !== 'string' || !plaintext) throw new Error('invalid');
      return plaintext;
    } catch {
      throw new Error('CREDENTIAL_DECRYPTION_FAILED');
    }
  }

  async clear(providerId) {
    const file = this.filePath(providerId);
    await this.fs.rm(file, { force: true });
    return { cleared: true };
  }
}

module.exports = { CredentialStore };
