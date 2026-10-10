// Inert controlled child: no Python/model/audio/network operations.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = process.env.MAIN_FIXTURE_ROOT;
process.on('SIGTERM', () => {});
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  fs.writeFileSync(path.join(root, `request-${process.pid}.json`), JSON.stringify(message));
  // Remain busy until the test releases actual exit.
});
setInterval(() => {
  if (fs.existsSync(path.join(root, 'release'))) process.exit(0);
}, 10);
fs.writeFileSync(path.join(root, `spawn-${process.pid}`), 'spawned');
if (!process.env.MAIN_FIXTURE_NO_READY) process.stdout.write('{"event":"ready"}\n');
