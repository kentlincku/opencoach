'use strict';

const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { CredentialStore } = require('../apps/desktop/credential-store.cjs');

app.whenReady().then(async () => {
  try {
    const isAvailable = safeStorage.isEncryptionAvailable();
    if (!isAvailable) {
      console.error('DPAPI_UNAVAILABLE');
      app.exit(1);
      return;
    }

    const testUserData = path.join(os.tmpdir(), `dpapi-verify-${Date.now()}`);
    fs.mkdirSync(testUserData, { recursive: true });

    const store = new CredentialStore({
      userData: testUserData,
      safeStorage,
    });

    // 1. Verify saving credential with DPAPI
    const testSecret = 'sk-windows-live-dpapi-verification-token-987';
    await store.set('openai', testSecret);

    // 2. Check disk file content: must NOT contain plaintext
    const credFile = store.filePath('openai');
    const rawContent = fs.readFileSync(credFile, 'utf8');
    if (rawContent.includes(testSecret)) {
      console.error('FAIL_PLAINTEXT_FOUND_ON_DISK');
      app.exit(2);
      return;
    }

    const parsed = JSON.parse(rawContent);
    if (parsed.version !== 1 || typeof parsed.ciphertext !== 'string') {
      console.error('FAIL_INVALID_STORED_SCHEMA');
      app.exit(3);
      return;
    }

    // 3. Verify decryption
    const recovered = await store.get('openai');
    if (recovered !== testSecret) {
      console.error('FAIL_DECRYPT_MISMATCH');
      app.exit(4);
      return;
    }

    // 4. Verify local provider rejected
    try {
      await store.set('ollama', 'secret');
      console.error('FAIL_LOCAL_PROVIDER_NOT_REJECTED');
      app.exit(5);
      return;
    } catch (e) {
      if (e.message !== 'PROVIDER_NOT_ALLOWED') {
        console.error('FAIL_UNEXPECTED_ERROR_LOCAL_PROVIDER', e);
        app.exit(6);
        return;
      }
    }

    // 5. Verify clear removes file
    await store.clear('openai');
    if (fs.existsSync(credFile)) {
      console.error('FAIL_CLEAR_DID_NOT_REMOVE_FILE');
      app.exit(7);
      return;
    }

    // Clean up
    fs.rmSync(testUserData, { recursive: true, force: true });

    console.log('REAL_DPAPI_VERIFICATION_OK');
    app.exit(0);
  } catch (error) {
    console.error('UNEXPECTED_ERROR', error);
    app.exit(99);
  }
});
