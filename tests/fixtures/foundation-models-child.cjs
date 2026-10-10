// Controlled protocol child ONLY in tests; no Foundation Models / native claims.
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const mode = process.argv[2] || 'normal';
let held;
function reply(request, success = true, done) {
  const result = !success ? { code: 'FM_GENERATION_FAILED' } : request.method === 'availability' ? { reason: 'available' } : { text: 'Controlled English reply.' };
  process.stdout.write(JSON.stringify({ protocol: 1, id: request.id, success, result }) + '\n', done);
}
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'quit') {
    if (mode === 'hang') return;
    if (held) { reply(held, mode !== 'late-error', () => process.exit(0)); return; }
    process.exit(0); return;
  }
  if (request.method === 'generate') {
    process.send?.({ event: 'dispatched', id: request.id });
    if (mode === 'exit') { process.exit(17); return; }
    if (mode === 'stderr') { process.stderr.write(Buffer.alloc(65537, 120)); return; }
    if (mode === 'hang' || mode.startsWith('late-')) { held = request; return; }
  }
  reply(request);
});
