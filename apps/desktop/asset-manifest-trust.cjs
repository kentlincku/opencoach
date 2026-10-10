'use strict';
const {createHash} = require('node:crypto');
// Publication requires reviewed code changes here. No manifest can name its own root.
const compiledRoots = Object.freeze({runtime:Object.freeze([]),model:Object.freeze([])});
const authorities = new WeakMap();
function canonical(value) {
 if (Array.isArray(value)) return value.map(canonical);
 if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function manifestDigest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function authenticateAssetManifest(input, kind, {testOnlyTrustedDigests} = {}) {
 const {parseRuntimeManifest,parseModelManifest} = require('./runtime-manifest.cjs');
 if (!Object.hasOwn(compiledRoots,kind)) throw Error('ASSET_MANIFEST_KIND');
 const parsed = kind === 'runtime' ? parseRuntimeManifest(input) : parseModelManifest(input);
 const collection = kind === 'runtime' ? parsed.artifacts : parsed.models;
 const digest = manifestDigest(input);
 if (parsed.release === 'unpublished') {
  if (Object.keys(collection).length) throw Error('ASSET_UNPUBLISHED_NONEMPTY');
  authorities.set(input,Object.freeze({kind,digest,authority:'UNPUBLISHED'}));
 } else {
  let production = compiledRoots[kind].includes(digest);
  if (!production && kind === 'model') {
   // The runtime-only App authorizes a separate model catalog digest. This
   // fixed code-owned module is not supplied by metadata, renderer or network.
   const bundled = require('./bundled-voice-assets.cjs').loadTrust();
   production = bundled?.schemaVersion === 2 && bundled.mode === 'runtime-only'
     && bundled.modelManifestDigest === digest;
  }
  if (!production && !testOnlyTrustedDigests?.includes(digest)) throw Error('ASSET_MANIFEST_UNTRUSTED');
  authorities.set(input,Object.freeze({kind,digest,authority:production ? 'COMPILED_ROOT' : 'NON_NATIVE_TEST_ROOT'}));
 }
 return input;
}
function manifestAuthority(value) {
 const proof = value && authorities.get(value);
 return proof && proof.digest === manifestDigest(value) ? proof : null;
}
function inheritManifestAuthority(original, parsed) {
 const proof = manifestAuthority(original);
 if (proof && manifestDigest(parsed) === proof.digest) authorities.set(parsed,proof);
 return parsed;
}
module.exports = {authenticateAssetManifest,manifestAuthority,inheritManifestAuthority,manifestDigest};
