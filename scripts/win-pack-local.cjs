'use strict';
// Local single-machine Windows x64 package (NOT a signed release build).
// Inputs: committed HEAD + build/voice-assets staged by scripts/win-stage-bundled-assets.py,
// which also generated the trust root in apps/desktop/bundled-voice-trust.cjs. That one
// file is the only permitted working-tree difference; restore it to null after packaging.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('WIN_PACK_PLATFORM');
  const root = path.resolve(__dirname, '..');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  if (dirty.length !== 1 || dirty[0] !== ' M apps/desktop/bundled-voice-trust.cjs') throw Error('WIN_PACK_DIRTY:' + dirty.join('|'));
  const trust = require('../apps/desktop/bundled-voice-trust.cjs');
  const { loadTrust } = require('../apps/desktop/bundled-voice-assets.cjs');
  if (!loadTrust(trust, 'win32')) throw Error('WIN_PACK_TRUST_MISSING');
  // NSIS (installer and portable) cannot embed more than 2 GB; the bundled runtime + models
  // are ~4 GB, so the deliverable is a ZIP64 of the unpacked App (or the unpacked dir).
  const target = process.argv[2] || 'dir';
  if (!['dir', 'zip'].includes(target)) throw Error('WIN_PACK_TARGET');
  for (const p of ['dist/win-unpacked']) if (fs.existsSync(path.join(root, p))) fs.rmSync(path.join(root, p), { recursive: true });
  execFileSync(process.execPath, [path.join(root, 'scripts/build-web.mjs')], { cwd: root, stdio: 'inherit' });
  const builder = require('electron-builder');
  await builder.build({ projectDir: root, targets: builder.Platform.WINDOWS.createTarget([target], builder.Arch.x64), config: {
    extends: path.join(root, 'electron-builder.yml'),
    electronDist: path.join(root, 'node_modules/electron/dist'),
    npmRebuild: false,
    beforePack: null, afterPack: null, afterSign: null,
    win: { signAndEditExecutable: false,
      extraResources: [
        { from: 'build/voice-assets', to: 'voice-assets' },
        { from: 'build/voice-assets-inventory.json', to: 'voice-assets-inventory.json' },
      ] },
    compression: 'normal',
  } });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  console.log(JSON.stringify({ type: 'WIN_LOCAL_PACKAGE', target, commit, treeDigest: trust.treeDigest, fileCount: trust.fileCount }));
}
main().then(() => process.exit(0), error => { console.error(error.stack || error.message); process.exit(1); });
