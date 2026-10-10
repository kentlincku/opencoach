const test = require('node:test');
const assert = require('node:assert/strict');

for (const [modulePath, expected] of [
  ['../apps/desktop/credential-store.cjs', ['CredentialStore', 'ALLOWED_CREDENTIAL_PROVIDERS']],

  ['../apps/desktop/runtime-manager.cjs', ['RuntimeManager', 'extractZipSecure', 'validateZipEntry']],
  ['../apps/desktop/runtime-manifest.cjs', ['ASSET_LIMITS', 'artifactIdentity', 'assertRelativeSafe', 'parseArtifact', 'parseModelManifest', 'parseRuntimeManifest', 'resolveModelBindings', 'selectRuntimeArtifact', 'validateRawModelUrl', 'validateUrl']],
  ['../apps/web/runtime/runtime-contract.js', ['normalizeRuntimeCapabilities']],
]) {
  test(`internal validators remain private: ${modulePath}`, () => {
    assert.deepEqual(Object.keys(require(modulePath)).sort(), [...expected].sort());
  });
}
