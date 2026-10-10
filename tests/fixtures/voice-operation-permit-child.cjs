// Bounded real Node child: no Python, model, installer or platform simulation.
const fs = require('node:fs');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lifetime = setTimeout(() => process.exit(90), 4000);
const heldStop = process.env.PERMIT_HELD_STOP === '1';
if (heldStop) process.on('SIGTERM', () => {});
const gate = process.env.PERMIT_READY_GATE;
const ready = () => send({ event: 'ready', pid: process.pid });
if (gate) {
  const poll = setInterval(() => {
    if (fs.existsSync(gate)) { clearInterval(poll); ready(); }
  }, 5);
} else ready();
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.PERMIT_REQUEST_LOG, line + '\n');
  const { id, method } = request;
  process.stderr.write(`REQUEST_STARTED:${id}:${method}\n`);
  if (method === 'hang') return;
  if (method === 'error') return send({ id, success: false, error: { code: 'BACKEND_FIXTURE', message: 'backend failed' } });
  if (method === 'wrong-first') {
    send({ id: 'wrong-id', success: false, error: { message: 'WRONG' } });
    setTimeout(() => send({ id, success: true, result: { pid: process.pid, id } }), 40);
    return;
  }
  send({ id, success: true, result: { pid: process.pid, id } });
  if (method === 'duplicate') send({ id, success: false, error: { message: 'DUPLICATE' } });
}).on('close', () => { if (!heldStop) { clearTimeout(lifetime); process.exit(0); } });