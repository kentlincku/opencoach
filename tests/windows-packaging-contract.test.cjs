const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

test('Windows package verifier is UTF-8 BOM encoded for Windows PowerShell 5.1', () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'scripts/verify-windows-package.ps1'));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
});

test('windows-beta.yml runs full x64 engineering verification', () => {
  const workflow = read('.github/workflows/windows-beta.yml');
  assert.match(workflow, /workflow_dispatch/, 'windows-beta.yml must trigger on workflow_dispatch');
  assert.doesNotMatch(workflow, /push:/, 'windows-beta.yml must not trigger on push');
  assert.doesNotMatch(workflow, /tags:/, 'windows-beta.yml must not trigger on tags');
  const actions = workflow.match(/uses:\s*(\S+)/g) || [];
  assert.ok(actions.length > 0, 'windows-beta.yml must pin every uses to a full commit SHA');
  for (const line of actions) {
    const value = line.replace(/uses:\s*/, '');
    assert.match(value, /^[^@]+@[0-9a-f]{40}$/, `action pinned to full 40-char SHA: ${value}`);
  }
  assert.match(workflow, /windows-latest/, 'windows-beta.yml must run on windows-latest');
});

test('windows-beta.yml runs ci, tests and x64 packaging without publishing binaries', () => {
  const workflow = read('.github/workflows/windows-beta.yml');
  assert.match(workflow, /npm ci/, 'must run npm ci');
  assert.match(workflow, /npm run build:icons/, 'must run npm run build:icons');
  assert.match(workflow, /npm test/, 'must run npm test');
  assert.match(workflow, /node --check/, 'must run Node syntax checks');
  const packageDriver = read('scripts/build-and-verify-windows-package.ps1');
  assert.match(workflow, /build-and-verify-windows-package\.ps1/, 'must invoke fresh package driver');
  assert.match(packageDriver, /npm run pack:win/, 'fresh package driver must run npm run pack:win');
  assert.doesNotMatch(workflow, /arm64|\.dmg|macOS|darwin/i, 'windows-beta.yml must never reference darwin/arm64 artifacts');
  assert.match(workflow, /write-checksums.mjs/, 'must generate checksums');
  assert.doesNotMatch(workflow, /upload-artifact/, 'public source CI must not publish binaries');
  assert.match(workflow, /unsigned|engineering/i, 'must label artifacts as unsigned engineering build');
});

test('windows packaging config includes NSIS and portable executable targets', () => {
  const config = read('electron-builder.yml');
  assert.match(config, /target:\s*nsis/i, 'must include NSIS target');
  assert.match(config, /target:\s*portable/i, 'must include portable target');
  assert.match(config, /x64/, 'must declare x64 arch');
});

test('windows packaging excludes venv, runtime, tests and node_modules', () => {
  const config = read('electron-builder.yml');
  for (const forbidden of ['.venv/**', '.runtime/**', 'tests/**', 'node_modules/**']) {
    assert.doesNotMatch(config, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `must not include ${forbidden}`);
  }
});

test('Windows lifecycle verification never removes a pre-existing user installation', () => {
  const script = read('scripts/verify-windows-package.ps1');
  assert.doesNotMatch(script, /LOCALAPPDATA\\Programs\\Voice Practice/);
  assert.doesNotMatch(script, /Pre-clean any prior leftover install/);
  assert.match(script, /GetTempPath/);
  assert.match(script, /voice-practice-lifecycle-/);
  assert.match(script, /Test lifecycle directory already exists/);
});

test('Windows portable smoke verifies an application-owned sentinel', () => {
  const script = read('scripts/verify-windows-package.ps1');
  const main = read('apps/desktop/main.cjs');
  assert.doesNotMatch(script, /&&\s*echo\s+PACKAGED_APP_SMOKE_OK/i);
  assert.match(script, /VOICE_PRACTICE_SMOKE_RESULT_FILE/);
  assert.match(script, /Get-Content[^\n]*-Encoding\s+UTF8/);
  assert.match(script, /PACKAGED_APP_SMOKE_OK:Voice Practice/);
  assert.match(script, /Wait-PathState -Path \$portableResultFile -ShouldExist \$true/);
  assert.match(script, /\$portableOutput\s*=\s*Get-Content/);
  assert.match(script, /Portable smoke test marker\/title did not match the expected UTF-8 product title/);
  assert.match(main, /writeSmokeResult/);
  assert.match(main, /VOICE_PRACTICE_SMOKE_RESULT_FILE/);
});

test('Windows packaging verifier validates checksum contents', () => {
  const script = read('scripts/verify-windows-package.ps1');
  assert.match(script, /SHA256SUMS\.txt not found/);
  assert.match(script, /Checksum mismatch or missing entry/);
  assert.doesNotMatch(script, /Write-Warning "SHA256SUMS\.txt not found/);
});

test('Windows fresh package driver only deletes the canonical repository dist directory', () => {
  const driver = read('scripts/build-and-verify-windows-package.ps1');
  assert.match(driver, /git\s+rev-parse\s+--show-toplevel/);
  assert.match(driver, /canonical repository dist directory/);
  assert.match(driver, /OrdinalIgnoreCase/);
  assert.match(driver, /ReparsePoint/);
  assert.match(driver, /Remove-Item\s+-LiteralPath\s+\$distPath/);
  assert.doesNotMatch(driver, /Remove-Item\s+-LiteralPath\s+\$DistDir/);
});

test('Windows packaging verifier binds fresh deterministic artifacts to an exact clean source SHA', () => {
  const script = read('scripts/verify-windows-package.ps1');
  assert.match(script, /ExpectedCodeSha/);
  assert.match(script, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(script, /git\s+rev-parse\s+HEAD/);
  assert.match(script, /git\s+status\s+--porcelain/);
  assert.match(script, /SOURCE_SHA\.txt/);
  assert.doesNotMatch(script, /--untracked-files=no/);
  assert.match(script, /BuildStartedAtUtc/);
  assert.match(script, /LastWriteTimeUtc/);
  assert.match(script, /SHA256SUMS\.txt[\s\S]+LastWriteTimeUtc/);
  assert.match(script, /Get-ChildItem[^\n]+Voice-Practice-Setup/);
  assert.match(script, /Count -ne 1/);
  assert.doesNotMatch(script, /Get-ChildItem[^\n]+\|\s*Select-Object\s+-First\s+1/);
  assert.match(script, /GetRelativePath/);
  assert.match(script, /\.StartsWith\('\.\.'\)/);
  assert.match(script, /Get-RelativePathCompat/);
  assert.match(script, /MakeRelativeUri/);
});

test('Windows packaging verifier path containment logic strictly rejects escaping paths', () => {
  // Unit test the path containment algorithm used in Get-RelativePathCompat
  function computeRelative(fromPath, toPath) {
    const fromUri = new URL('file:///' + fromPath.replace(/\\/g, '/').replace(/\/?$/, '/'));
    const toUri = new URL('file:///' + toPath.replace(/\\/g, '/'));
    if (fromUri.origin !== toUri.origin) return toPath;
    const fromParts = fromUri.pathname.split('/').filter(Boolean);
    const toParts = toUri.pathname.split('/').filter(Boolean);
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common].toLowerCase() === toParts[common].toLowerCase()) {
      common++;
    }
    const up = fromParts.slice(common).map(() => '..');
    const down = toParts.slice(common);
    return [...up, ...down].join('\\');
  }

  function isContained(tempRoot, candidate) {
    const rel = computeRelative(tempRoot, candidate);
    return !(rel === '' || rel === '.' || rel.startsWith('..') || rel.includes(':'));
  }

  const temp = 'C:\\Users\\User\\AppData\\Local\\Temp';
  assert.equal(isContained(temp, 'C:\\Users\\User\\AppData\\Local\\Temp\\isolated-123'), true);
  assert.equal(isContained(temp, 'C:\\Users\\User\\AppData\\Local\\Temp\\sub\\dir'), true);
  assert.equal(isContained(temp, 'C:\\Users\\User\\AppData\\Local\\Temp'), false);
  assert.equal(isContained(temp, 'C:\\Users\\User\\AppData\\Local'), false);
  assert.equal(isContained(temp, 'C:\\Windows\\System32'), false);
  assert.equal(isContained(temp, 'D:\\other-drive'), false);
});
