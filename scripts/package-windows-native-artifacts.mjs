import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yazl from 'yazl';
import { scanFiles, digestFiles } from '../apps/desktop/tree-integrity.cjs';
import { checkWindowsRuntime } from '../apps/desktop/windows-runtime-checker.cjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const ARTIFACTS_DIR = path.join(DIST_DIR, 'artifacts');

if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function createZip(sourceDir, destZipPath) {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    const files = [];

    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(sourceDir, full).replace(/\\/g, '/');
          files.push({ full, rel });
        }
      }
    };
    walk(sourceDir);
    files.sort((a, b) => a.rel.localeCompare(b.rel));

    for (const file of files) {
      zipfile.addFile(file.full, file.rel, { mtime: new Date(0), mode: 0o644 });
    }

    const outStream = fs.createWriteStream(destZipPath);
    zipfile.outputStream.pipe(outStream);
    outStream.on('close', resolve);
    zipfile.outputStream.on('error', reject);
    outStream.on('error', reject);
    zipfile.end();
  });
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  console.log('=== Packaging Windows Native Voice Canonical Artifacts ===\n');

  // 1. Package voice-runtime-windows-x64.zip
  const runtimeSource = path.join(DIST_DIR, 'voice-runtime');
  const runtimeZip = path.join(ARTIFACTS_DIR, 'voice-runtime-windows-x64.zip');
  console.log('Packaging voice-runtime-windows-x64.zip from dist/voice-runtime...');
  await createZip(runtimeSource, runtimeZip);

  const runtimeCheck = checkWindowsRuntime(runtimeSource);
  const runtimeZipBytes = fs.statSync(runtimeZip).size;
  const runtimeZipSha256 = sha256File(runtimeZip);
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeSource, 'runtime-manifest.json'), 'utf8'));

  console.log(`  Archive bytes: ${runtimeZipBytes}`);
  console.log(`  Archive sha256: ${runtimeZipSha256}`);
  console.log(`  Total files in zip: ${runtimeManifest.files.length + 1}`);
  console.log(`  Tree fileCount: ${runtimeCheck.fileCount}`);
  console.log(`  Tree digest: ${runtimeCheck.treeDigest}\n`);

  // 2. Package whisper-base-en.zip
  const whisperSource = path.join(DIST_DIR, 'artifacts-staging', 'whisper-base-en');
  const whisperZip = path.join(ARTIFACTS_DIR, 'whisper-base-en.zip');
  console.log('Packaging whisper-base-en.zip from dist/artifacts-staging/whisper-base-en...');
  await createZip(whisperSource, whisperZip);

  const whisperFiles = scanFiles(whisperSource);
  const whisperTreeDigest = digestFiles(whisperFiles);
  const whisperZipBytes = fs.statSync(whisperZip).size;
  const whisperZipSha256 = sha256File(whisperZip);

  console.log(`  Archive bytes: ${whisperZipBytes}`);
  console.log(`  Archive sha256: ${whisperZipSha256}`);
  console.log(`  Tree fileCount: ${whisperFiles.length}`);
  console.log(`  Tree digest: ${whisperTreeDigest}\n`);

  // 3. Package kokoro-v1.0-onnx.zip
  const kokoroSource = path.join(DIST_DIR, 'artifacts-staging', 'kokoro-v1.0-onnx');
  const kokoroZip = path.join(ARTIFACTS_DIR, 'kokoro-v1.0-onnx.zip');
  console.log('Packaging kokoro-v1.0-onnx.zip from dist/artifacts-staging/kokoro-v1.0-onnx...');
  await createZip(kokoroSource, kokoroZip);

  const kokoroFiles = scanFiles(kokoroSource);
  const kokoroTreeDigest = digestFiles(kokoroFiles);
  const kokoroZipBytes = fs.statSync(kokoroZip).size;
  const kokoroZipSha256 = sha256File(kokoroZip);

  console.log(`  Archive bytes: ${kokoroZipBytes}`);
  console.log(`  Archive sha256: ${kokoroZipSha256}`);
  console.log(`  Tree fileCount: ${kokoroFiles.length}`);
  console.log(`  Tree digest: ${kokoroTreeDigest}\n`);

  // 4. Build artifacts-manifest.json
  const manifest = {
    canonicalRelease: 'windows-native-voice-r5',
    runtime: {
      archiveName: 'voice-runtime-windows-x64.zip',
      archiveBytes: runtimeZipBytes,
      archiveSha256: runtimeZipSha256,
      totalFilesInZip: runtimeManifest.files.length + 1,
      fileCount: runtimeCheck.fileCount,
      treeDigest: runtimeCheck.treeDigest,
      files: runtimeManifest.files,
      entrypoint: runtimeManifest.entrypoint,
      platform: runtimeManifest.platform,
      schemaVersion: runtimeManifest.schemaVersion,
    },
    whisper: {
      archiveName: 'whisper-base-en.zip',
      archiveBytes: whisperZipBytes,
      archiveSha256: whisperZipSha256,
      totalFilesInZip: whisperFiles.length,
      fileCount: whisperFiles.length,
      treeDigest: whisperTreeDigest,
      files: whisperFiles,
      revision: '3d3d5dee26484f91867d81cb899cfcf72b96be6c',
      upstream: 'https://huggingface.co/Systran/faster-whisper-base.en',
      license: {
        spdx: 'MIT',
        url: 'https://huggingface.co/Systran/faster-whisper-base.en/blob/main/LICENSE'
      }
    },
    kokoro: {
      archiveName: 'kokoro-v1.0-onnx.zip',
      archiveBytes: kokoroZipBytes,
      archiveSha256: kokoroZipSha256,
      totalFilesInZip: kokoroFiles.length,
      fileCount: kokoroFiles.length,
      treeDigest: kokoroTreeDigest,
      files: kokoroFiles,
      revision: 'model-files-v1.0',
      upstream: 'https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0',
      license: {
        spdx: 'Apache-2.0',
        url: 'https://github.com/thewh1teagle/kokoro-onnx/blob/main/LICENSE'
      }
    }
  };

  const manifestPath = path.join(ARTIFACTS_DIR, 'artifacts-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const manifestSha = sha256File(manifestPath);
  console.log(`Wrote artifacts summary manifest: ${manifestPath}`);
  console.log(`Manifest SHA-256: ${manifestSha}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
