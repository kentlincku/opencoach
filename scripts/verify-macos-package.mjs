import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { checkPackagedMacOsRuntime } from './check-macos-runtime.mjs';

function fail(code) { throw new Error(code); }
function valueAfter(flag) { const index = process.argv.indexOf(flag); return index < 0 ? '' : process.argv[index + 1]; }

function artifactRecord(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('INVALID_PACKAGE_ARTIFACT');
  }
  return Object.freeze({
    artifact: path.basename(file),
    bytes: Number(stat.size),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    mtime: new Date(Number(stat.mtimeMs)).toISOString(),
    mtimeNs: stat.mtimeNs.toString(),
    file,
  });
}

function appInRoot(root, missingCode) {
  const apps = fs.readdirSync(root).filter(name => name.endsWith('.app'));
  if (apps.length !== 1) fail(missingCode);
  const appPath = path.join(root, apps[0]);
  const stat = fs.lstatSync(appPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(missingCode);
  return appPath;
}

function assertSameRuntime(expected, actual, mismatchCode) {
  if (actual.treeSha256 !== expected.treeSha256
      || actual.fileCount !== expected.fileCount
      || actual.sha256 !== expected.sha256
      || actual.bytes !== expected.bytes) {
    fail(mismatchCode);
  }
}

function verifyZipRuntime(zipFile, expectedRuntime) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-practice-zip-'));
  try {
    execFileSync('ditto', ['-x', '-k', zipFile, root], { stdio: 'pipe' });
    const runtime = checkPackagedMacOsRuntime(appInRoot(root, 'ZIP_EXACTLY_ONE_APP_REQUIRED'));
    assertSameRuntime(expectedRuntime, runtime, 'ZIP_RUNTIME_MISMATCH');
    return runtime;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function verifyDmgRuntime(dmgFile, expectedRuntime) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-practice-dmg-'));
  let attached = false;
  try {
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgFile], { stdio: 'pipe' });
    attached = true;
    const runtime = checkPackagedMacOsRuntime(appInRoot(mountPoint, 'DMG_EXACTLY_ONE_APP_REQUIRED'));
    assertSameRuntime(expectedRuntime, runtime, 'DMG_RUNTIME_MISMATCH');
    return runtime;
  } finally {
    if (attached) execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'pipe' });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

export function verifyMacPackage({ distDir, expectedCodeSha, buildStartedNs }) {
  if (process.platform !== 'darwin') fail('MACOS_HOST_REQUIRED');
  if (!/^[0-9a-f]{40}$/.test(expectedCodeSha)) fail('INVALID_EXPECTED_CODE_SHA');
  const dist = path.resolve(distDir);
  const distStat = fs.lstatSync(dist);
  if (!distStat.isDirectory() || distStat.isSymbolicLink()) fail('INVALID_DIST_DIRECTORY');
  const sourceShaPath = path.join(dist, 'SOURCE_SHA.txt');
  const sourceShaStat = fs.lstatSync(sourceShaPath);
  if (!sourceShaStat.isFile() || sourceShaStat.isSymbolicLink()) fail('INVALID_SOURCE_SHA_FILE');
  const sourceSha = fs.readFileSync(sourceShaPath, 'utf8');
  if (sourceSha !== expectedCodeSha) fail('SOURCE_SHA_MISMATCH');

  const names = fs.readdirSync(dist);
  const dmgs = names.filter(name => name.endsWith('.dmg'));
  const zips = names.filter(name => name.endsWith('.zip'));
  if (dmgs.length !== 1) fail('EXACTLY_ONE_DMG_REQUIRED');
  if (zips.length !== 1) fail('EXACTLY_ONE_ZIP_REQUIRED');

  const unpackedApp = path.join(dist, 'mac-arm64', 'Voice Practice.app');
  const unpackedStat = fs.lstatSync(unpackedApp);
  if (!unpackedStat.isDirectory() || unpackedStat.isSymbolicLink()) fail('INVALID_UNPACKED_APP');
  const runtime = checkPackagedMacOsRuntime(unpackedApp);

  let started;
  try { started = BigInt(buildStartedNs); } catch { fail('INVALID_BUILD_START_TIME'); }
  if (started <= 0n) fail('INVALID_BUILD_START_TIME');
  const artifacts = [...dmgs, ...zips].map(name => artifactRecord(path.join(dist, name)));
  for (const artifact of artifacts) {
    if (BigInt(artifact.mtimeNs) < started) fail('STALE_PACKAGE_ARTIFACT');
  }

  const zipRuntime = verifyZipRuntime(artifacts.find(item => item.artifact.endsWith('.zip')).file, runtime);
  const dmgRuntime = verifyDmgRuntime(artifacts.find(item => item.artifact.endsWith('.dmg')).file, runtime);
  return Object.freeze({ sourceSha, runtime, zipRuntime, dmgRuntime, artifacts });
}

if (process.argv[1]?.endsWith('verify-macos-package.mjs')) {
  try {
    const result = verifyMacPackage({
      distDir: valueAfter('--dist'), expectedCodeSha: valueAfter('--expected-code-sha'),
      buildStartedNs: valueAfter('--build-started-ns'),
    });
    console.log(`SOURCE_SHA=${result.sourceSha}`);
    console.log(`APP_RUNTIME_TREE sha256=${result.runtime.treeSha256} files=${result.runtime.fileCount}`);
    console.log(`ZIP_RUNTIME_TREE sha256=${result.zipRuntime.treeSha256} files=${result.zipRuntime.fileCount}`);
    console.log(`DMG_RUNTIME_TREE sha256=${result.dmgRuntime.treeSha256} files=${result.dmgRuntime.fileCount}`);
    for (const artifact of result.artifacts) {
      console.log(`ARTIFACT artifact=${artifact.artifact} sha256=${artifact.sha256} bytes=${artifact.bytes} mtime=${artifact.mtime}`);
    }
  } catch (error) {
    console.error(`MACOS_PACKAGE_VERIFY_FAILED:${error.message}`);
    process.exit(1);
  }
}
