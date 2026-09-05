'use strict';

const { ProviderBroker } = require('../apps/desktop/provider-broker.cjs');

const PROVIDER_CHECKS = Object.freeze([
  {
    id: 'ollama',
    label: 'OLLAMA',
    probeUrl: 'http://127.0.0.1:11434/v1/models',
  },
  {
    id: 'llamacpp',
    label: 'LLAMACPP',
    probeUrl: 'http://127.0.0.1:8080/v1/models',
    expectedModel: process.env.LLAMACPP_MODEL || 'ornith-9b',
  },
  {
    id: 'lmstudio',
    label: 'LMSTUDIO',
    probeUrl: 'http://127.0.0.1:1234/v1/models',
  },
]);

async function probeService(url, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyProvider(broker, config, fetchImpl = globalThis.fetch) {
  const isUp = await probeService(config.probeUrl, fetchImpl);
  if (!isUp) {
    console.log(`${config.label}_LIVE: NOT_RUN (Service not available at ${config.probeUrl})`);
    return { ran: false };
  }

  try {
    const modelsResult = await broker.models({ operation: 'models', providerId: config.id });
    let model = modelsResult.models[0];
    if (config.expectedModel) {
      if (!modelsResult.models.includes(config.expectedModel)) {
        throw new Error(`EXPECTED_MODEL_NOT_FOUND:${config.expectedModel}`);
      }
      model = config.expectedModel;
    }
    console.log(`${config.label}_LIVE_MODELS_OK:${model}`);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await broker.chat({
        operation: 'chat',
        providerId: config.id,
        model,
        messages: [{ role: 'user', content: `Reply with the word OK. Attempt ${attempt}.` }],
        maxTokens: 16,
      });
      console.log(`${config.label}_LIVE_CHAT_${attempt}_OK`);
    }
    return { ran: true };
  } catch (error) {
    console.error(`${config.label}_LIVE_FAILED:${error.message}`);
    return { ran: true, error };
  }
}

async function main() {
  let credentialReads = 0;
  const credentialStoreStub = {
    get: async () => {
      credentialReads += 1;
      throw new Error('FAIL_CREDENTIAL_ACCESSED_FOR_LOCAL_PROVIDER');
    },
  };

  const broker = new ProviderBroker({
    credentialStore: credentialStoreStub,
    fetchImpl: globalThis.fetch,
  });

  console.log('==> Checking live loopback providers through ProviderBroker');
  const results = [];
  for (const config of PROVIDER_CHECKS) {
    results.push(await verifyProvider(broker, config));
  }

  console.log(`LOCAL_PROVIDER_CREDENTIAL_READS=${credentialReads}`);
  if (credentialReads !== 0) {
    console.error('FAIL: Local providers accessed credential store');
    process.exitCode = 1;
    return;
  }
  if (results.some(result => result.error)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Unexpected failure:${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { PROVIDER_CHECKS, probeService, verifyProvider };
