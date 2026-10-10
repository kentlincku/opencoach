'use strict';
// Inert owned Node protocol helper. NOT Apple inference; never persists input/output text.
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'quit') { process.exit(0); return; }
  const result = request.method === 'availability' ? { reason: process.argv.includes('--unavailable') ? 'model-not-ready' : 'available' } : { text: 'Connection OK' };
  process.stdout.write(JSON.stringify({ protocol: 1, id: request.id, success: true, result }) + '\n');
});