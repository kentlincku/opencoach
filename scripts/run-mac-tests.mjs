#!/usr/bin/env node
// Mac product test gate: the App-behaviour suites that must be fully green on
// a developer Mac. Acceptance/evidence toolchains (r7..r52 runners, fm-ui
// acceptance, e1/e2 launch revalidation, R22 build admission) depend on pinned
// build receipts, clean git state and private fixtures; run those through
// `npm test` / their own packets, not as the per-change gate.
import { readdirSync, realpathSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const python = process.env.PYTHON || path.join(root, '.venv/bin/python');
// macOS $TMPDIR lives under /var -> /private/var; tests that compare real paths
// must see a symlink-free temp root.
const tmp = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), 'vp-mac-tests-'))) + path.sep;
const env = { ...process.env, PYTHON: python, TMPDIR: tmp };

const EXCLUDED_NODE = [
  /^acceptance-r23-/, /^r\d+-/, /^r\d+[a-z]?-/, /^fm-ui-/, /^e1-/, /^e2-/,
  /^browser-runtime-script-order\./, /^foundation-models-(engineering|integrity)\./,
  /^desktop-voice-stop\./, /^desktop-voice-operation-contract\./, /^main-shutdown\./,
];
// On Linux (public CI) the macOS App packaging suite cannot run: it needs Darwin
// codesign/lipo and fs.lchmodSync. It stays fully gated on macOS.
if (process.platform !== 'darwin') EXCLUDED_NODE.push(/^macos-model-packs-pack\./);
const nodeTests = readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.cjs') && !EXCLUDED_NODE.some(re => re.test(name)))
  .sort().map(name => path.join('tests', name));

const PYTHON_TESTS = [
  'test_launcher_contract', 'test_runtime_server', 'test_backend_registry', 'test_web_contract',
  'test_local_first_web', 'test_desktop_provider_security', 'test_windows_cpu_runtime', 'test_stt_cpu_threads', 'test_tts_text_resilience', 'test_documentation_contract', 'test_packaging_contract', 'test_mac_package_slim',
];

const steps = [
  ['node', [process.execPath, ['--test', ...nodeTests]]],
  ['python', [python, ['-m', 'unittest', ...PYTHON_TESTS.map(t => `tests.${t}`)]]],
  ...readdirSync(path.join(root, 'apps/desktop')).filter(n => n.endsWith('.cjs')).sort()
    .map(n => ['syntax', [process.execPath, ['--check', path.join('apps/desktop', n)]]]),
];

console.log(`Mac gate: ${nodeTests.length} Node files, ${PYTHON_TESTS.length} Python modules (TMPDIR=${tmp})`);
for (const [label, [command, args]] of steps) {
  const result = spawnSync(command, args, { cwd: root, stdio: label === 'syntax' ? 'pipe' : 'inherit', env });
  if (result.error || result.status !== 0) {
    if (label === 'syntax') process.stderr.write(result.stderr || '');
    console.error(`Mac gate FAILED at ${label}: ${args.at(-1)}`);
    process.exit(result.status || 1);
  }
}
console.log('Mac gate PASSED');
