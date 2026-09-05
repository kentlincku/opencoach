import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const defaultWinPython = existsSync(path.join(root, '.venv-runtime-build/Scripts/python.exe'))
  ? path.join(root, '.venv-runtime-build/Scripts/python.exe')
  : 'python';
const python = process.env.PYTHON || (process.platform === 'win32' ? defaultWinPython : 'python3');
const pythonPath = process.env.PYTHONPATH
  ? `${path.join(root, 'native/python')}${path.delimiter}${process.env.PYTHONPATH}`
  : path.join(root, 'native/python');
const childEnv = { ...process.env, PYTHON: python, PYTHONPATH: pythonPath };
const nodeTests = readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.cjs'))
  .sort()
  .map(name => path.join('tests', name));
const syntaxTargets = [
  ...readdirSync(path.join(root, 'apps/desktop'))
    .filter(name => name.endsWith('.cjs'))
    .sort()
    .map(name => path.join('apps/desktop', name)),
  ...readdirSync(path.join(root, 'scripts'))
    .filter(name => name.endsWith('.mjs'))
    .sort()
    .map(name => path.join('scripts', name)),
];

const steps = [
  [python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']],
  [process.execPath, ['--test', ...nodeTests]],
  ...syntaxTargets.map(target => [process.execPath, ['--check', target]]),
];

for (const [command, args] of steps) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: childEnv });
  if (result.error) {
    console.error(`Unable to execute ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
