'use strict';
// Pure catalog validation. Runtime/model source authority still comes from the
// App's compiled trust root and asset-manifest-trust, never from this parser.
const { types: { isProxy } } = require('node:util');
const { loadTrust, sttChoiceIds } = require('./bundled-voice-assets.cjs');
const { parseModelManifest, artifactIdentity } = require('./runtime-manifest.cjs');
const { manifestDigest } = require('./asset-manifest-trust.cjs');
const { parseSpeechModelCapabilities, selectSpeechModel } = require('./speech-model-selection.cjs');

function exact(value, keys) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length
      || !keys.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
      })) throw new Error('MODEL_CATALOG_INVALID');
}

// Each native platform has exactly one fixed (trust platform, catalog key) pair.
const CATALOG_PLATFORMS = Object.freeze({
  darwin: Object.freeze({ trustPlatform: 'darwin', platformKey: 'darwin-arm64' }),
  win32: Object.freeze({ trustPlatform: 'win32', platformKey: 'win32-x64-cpu' }),
});

function parseMacosModelCatalog(input, expectedTrust, modelInput) {
  return parseNativeModelCatalog(CATALOG_PLATFORMS.darwin, input, expectedTrust, modelInput);
}

function parseWindowsModelCatalog(input, expectedTrust, modelInput) {
  return parseNativeModelCatalog(CATALOG_PLATFORMS.win32, input, expectedTrust, modelInput);
}

function parseNativeModelCatalog(platform, input, expectedTrust, modelInput) {
  exact(input, ['schemaVersion', 'platformKey', 'runtimeProfile', 'enabledLanguages', 'models']);
  const trust = loadTrust(expectedTrust, platform.trustPlatform);
  if (!trust || trust.schemaVersion !== 2 || trust.mode !== 'runtime-only'
      || input.schemaVersion !== 1 || input.platformKey !== platform.platformKey
      || input.runtimeProfile !== trust.runtimeProfile) throw new Error('MODEL_CATALOG_PROFILE');
  // English-only product admission is deliberate. Upstream model capabilities
  // do not by themselves authorize another language or its text/G2P policy.
  const enabled = input.enabledLanguages;
  if (isProxy(enabled) || !Array.isArray(enabled) || Object.getPrototypeOf(enabled) !== Array.prototype
      || enabled.length !== 1 || Reflect.ownKeys(enabled).length !== 2
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(enabled, '0') || {}, 'value')
      || enabled[0] !== 'en') throw new Error('MODEL_CATALOG_LANGUAGE');
  const models = parseSpeechModelCapabilities(input.models);
  const manifest = parseModelManifest(modelInput);
  if (manifest.schemaVersion !== 3) throw new Error('MODEL_CATALOG_FORMAT');
  if (manifestDigest(input) !== trust.capabilitiesDigest || manifestDigest(modelInput) !== trust.modelManifestDigest) {
    throw new Error('MODEL_CATALOG_UNTRUSTED');
  }
  const ids = models.map(model => model.id);
  // Every trusted model (TTS bindings + every allowed STT choice) must appear exactly
  // once in both catalog and manifest; nothing untrusted may be listed.
  const sttIds = sttChoiceIds(trust);
  const boundIds = [...new Set([...Object.entries(trust.modelBindings).filter(([role]) => role !== 'sttRoot')
    .map(([, binding]) => binding.modelId), ...sttIds])];
  if (ids.length !== Object.keys(manifest.models).length || ids.length !== boundIds.length
      || !ids.every(id => Object.hasOwn(manifest.models, id) && boundIds.includes(id))) throw new Error('MODEL_CATALOG_BINDING');
  const checks = [...Object.entries(trust.modelBindings).filter(([role]) => role !== 'sttRoot'),
    ...(trust.sttChoices || [trust.modelBindings.sttRoot]).map(choice => ['sttRoot', choice])];
  for (const [role, binding] of checks) {
    const artifact = manifest.models[binding.modelId]?.artifacts[input.platformKey];
    if (!artifact || artifact.transport !== 'raw-files') throw new Error('MODEL_CATALOG_BINDING');
    const identity = artifactIdentity(artifact);
    if (identity.kind !== binding.identity.kind || identity.treeDigest !== binding.identity.treeDigest
        || (role !== 'sttRoot' && !artifact.files.some(file => file.path === binding.path))) {
      throw new Error('MODEL_CATALOG_BINDING');
    }
    const selection = selectSpeechModel(models, {
      kind: role === 'sttRoot' ? 'stt' : 'tts', targetLanguage: 'en', runtimeProfile: input.platformKey,
      enabledLanguages: ['en'], modelId: binding.modelId,
    });
    if (selection.state !== 'compatible') throw new Error('MODEL_CATALOG_CAPABILITY');
  }

  return Object.freeze({ schemaVersion: 1, platformKey: input.platformKey, runtimeProfile: input.runtimeProfile,
    enabledLanguages: Object.freeze(['en']), models, sttChoices: sttIds,
    defaultSttModelId: trust.modelBindings.sttRoot.modelId });
}

// Main reads one fixed catalog file name per host platform.
const CATALOG_PARSERS = Object.freeze({ darwin: parseMacosModelCatalog, win32: parseWindowsModelCatalog });
function parseNativeModelCatalogFor(hostPlatform, input, expectedTrust, modelInput) {
  if (!Object.hasOwn(CATALOG_PARSERS, hostPlatform)) throw new Error('MODEL_CATALOG_PROFILE');
  return CATALOG_PARSERS[hostPlatform](input, expectedTrust, modelInput);
}

module.exports = { parseMacosModelCatalog, parseWindowsModelCatalog, parseNativeModelCatalogFor };
