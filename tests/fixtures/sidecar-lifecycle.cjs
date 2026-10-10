// Controlled protocol child only: no Python, models, audio, or external services.
const readline = require('node:readline');
const mode = process.argv[2];
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const keepAlive = setInterval(() => {}, 1000);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  process.stderr.write(`REQUEST_STARTED:${message.id}:${message.method}\n`);
  if (message.method === 'hang') return;
  send({ id: message.id, success: true, result: { pid: process.pid, params: message.params } });
});
lines.on('close', () => {
  if (mode !== 'ignore-term') { clearInterval(keepAlive); process.exit(0); }
});
if (mode !== 'no-ready') send({ event: 'ready', pid: process.pid });
