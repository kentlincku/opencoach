// Public test entry: the same product gates the maintainers run locally.
// macOS/Linux -> scripts/run-mac-tests.mjs, Windows -> scripts/run-win-tests.mjs.
// Private acceptance/evidence suites are not part of the public repository.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const gate = process.platform === 'win32' ? 'run-win-tests.mjs' : 'run-mac-tests.mjs';
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const env = { ...process.env, PYTHON: python };
delete env.PYTHONPATH; // a stray PYTHONPATH shadows the repo's `tests` package
const result = spawnSync(process.execPath, [path.join(root, 'scripts', gate)], { cwd: root, stdio: 'inherit', env });
if (result.error) {
  console.error(`Unable to run ${gate}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
