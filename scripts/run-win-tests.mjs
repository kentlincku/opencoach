#!/usr/bin/env node
// Windows product test gate: the App-behaviour suites that must be fully green on a
// Windows x64 developer machine (counterpart of run-mac-tests.mjs). Excluded below are
// suites/tests whose fixtures are POSIX- or Darwin-specific (python3/`/usr/bin/git`,
// symlinks, POSIX file modes, Darwin profile/MLX, POSIX signal semantics); each entry
// states why. They are NOT Windows passes: they still fail on unmodified main on Windows
// and are tracked as known Windows test-portability gaps.
import { readdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

if (process.platform !== 'win32') { console.error('run-win-tests.mjs is the Windows gate; use run-mac-tests.mjs on macOS'); process.exit(2); }
const root = path.resolve(import.meta.dirname, '..');
const python = process.env.PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vp-win-tests-'))) + path.sep;
const env = { ...process.env, PYTHON: python, PYTHONUTF8: '1', TMPDIR: tmp };

// Same acceptance/evidence exclusions as the Mac gate.
const EXCLUDED_NODE = [
  /^acceptance-r23/, /^r\d+-/, /^r\d+[a-z]?-/, /^fm-ui-/, /^e1-/, /^e2-/,
  /^browser-runtime-script-order\./, /^foundation-models-/,
  /^desktop-voice-stop\./, /^desktop-voice-operation-contract\./, /^main-shutdown\./,
  /^darwin-/,                       // Darwin candidate producer: POSIX modes, symlinks, hardlinks
  /^main-runtime-health\./,         // executes server.py through `python3` with a Darwin registry fixture
  // Real child-process lifecycle with 10-150 ms fixture deadlines tuned for POSIX spawn;
  // on Windows a different test in this file misses its deadline in ~1 of 5 runs.
  // Reported separately (informational) by the Windows evidence run, not gated here.
  /^main-voice-operations\./,
  /^macos-model-packs-pack\./,     // macOS App packaging: Darwin codesign/lipo, POSIX modes and paths
  /^hybrid-managed-assets\./,      // Darwin hybrid profile: POSIX temp roots rejected by the win32 path policy
  /^hybrid-release-retry\./,       // same Darwin-bound hybrid lease fixtures
];
const SKIP_TESTS = [
  ['^Mac ', 'Darwin speech profile through Main (MLX roles, POSIX temp roots)'],
  ['^held real copy excludes concurrent install', "fixture hooks a '/snapshots/' POSIX path spelling"],
  ['^Main uses independent verified bundle', 'asserts distinct inode numbers; NTFS ino via libuv is not a stable identity'],
  ['^real POSIX leader termination', 'POSIX-only by definition'],
  ['^a live child error during termination', 'mocks a POSIX kill() returning false; Windows termination is taskkill tree'],
  ['^MEMORY signal failure: new permit cannot adopt', 'same POSIX kill() mock'],
  ['^original unused permit cannot upgrade after natural exit', 'POSIX natural-exit signal timing'],
  ['^snapshot opt-out and immutable original identity', "expects coverage 'leader-only'; Windows reports 'windows-tree' by design"],
  ['^symlinked inventory JSON is refused', 'symlink creation needs Developer Mode on Windows'],
  ['^disk refusal counts unknown sparse legacy bytes', 'creates a sparse multi-GB file; hosted Windows disks report ENOSPC'],
  ['^win32: a link inside the owned tree is refused', 'asserts POSIX mode bits (0o400); NTFS reports 0o444'],
  ['^darwin: unchanged single fs.rmSync', 'asserts POSIX mode bits on NTFS'],
  ['^raw final inventory refuses extra files, directories, links and hardlinks', 'hardlink/link fixtures need Developer Mode'],
  ['^raw scratch keeps its exclusive non-executable inode', 'POSIX mode bits / inode identity'],
  ['^raw rename refuses an occupied data-file destination', 'POSIX link fixture'],
  ['^two raw files commit one typed activation', 'asserts POSIX metadata mode 0o600; NTFS reports 0o666'],
];
const nodeTests = readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.cjs') && !EXCLUDED_NODE.some(re => re.test(name)))
  .sort().map(name => path.join('tests', name));
const PYTHON_TESTS = [
  'test_launcher_contract', 'test_runtime_server', 'test_backend_registry', 'test_web_contract',
  'test_local_first_web', 'test_desktop_provider_security', 'test_accelerator', 'test_windows_cpu_runtime', 'test_stt_cpu_threads', 'test_tts_text_resilience', 'test_documentation_contract', 'test_packaging_contract',
];
const steps = [
  ['node', [process.execPath, ['--test', ...SKIP_TESTS.flatMap(([p]) => ['--test-skip-pattern', p]), ...nodeTests]]],
  ['python', [python, ['-m', 'unittest', ...PYTHON_TESTS.map(t => `tests.${t}`)]]],
  ...readdirSync(path.join(root, 'apps/desktop')).filter(n => n.endsWith('.cjs')).sort()
    .map(n => ['syntax', [process.execPath, ['--check', path.join('apps/desktop', n)]]]),
];
console.log(`Windows gate: ${nodeTests.length} Node files (${SKIP_TESTS.length} POSIX/Darwin test patterns skipped), ${PYTHON_TESTS.length} Python modules`);
for (const [label, [command, args]] of steps) {
  const result = spawnSync(command, args, { cwd: root, stdio: label === 'syntax' ? 'pipe' : 'inherit', env });
  if (result.error || result.status !== 0) {
    if (label === 'syntax') process.stderr.write(result.stderr || '');
    console.error(`Windows gate FAILED at ${label}`);
    process.exit(result.status || 1);
  }
}
console.log('Windows gate PASSED');
