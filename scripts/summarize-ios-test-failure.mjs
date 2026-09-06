import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function sanitize(value) {
  return String(value)
    .replace(/\/Users\/[^/\s]+\/work\/opencoach\/opencoach\//g, '$REPO/')
    .replace(/\/Users\/[^/\s]+\//g, '$HOME/');
}

function bounded(value, limit = 2900) {
  let output = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) return output + '\n[truncated]';
    output += char;
    bytes += size;
  }
  return output;
}

function boundedTail(value, limit = 2400) {
  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - limit);
  // Skip continuation bytes so the retained suffix starts at a complete code point.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export function summarizeIosFailure(log, result = null) {
  const structured = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'testFailureSummaries' || key === 'errorSummaries') {
        for (const issue of value?._values || []) {
          const message = issue.message?._value;
          if (message) structured.push([issue.testCaseName?._value, message].filter(Boolean).join(': '));
        }
      } else visit(value);
    }
  }
  visit(result);
  const lines = String(log).split(/\r?\n/);
  const failures = lines.filter(line => /(?:\berror:|\bfatal error:|Test (?:case|suite).*failed|Testing failed|Failed to (?:launch|install|start)|Unable to .*test|Timed out|Lost connection|connection interrupted)/i.test(line));
  const crashes = lines.filter(line => /\bcrash(?:ed|ing)?\b/i.test(line));
  // Structured issues and recent actionable failures precede secondary crash context.
  const details = [...new Set([...structured, ...failures.reverse(), ...crashes.reverse()].map(sanitize))];
  // Unknown failure formats still retain the terminal output, not earlier build noise.
  const body = details.length ? details.join('\n') : boundedTail(sanitize(lines.slice(-35).join('\n')));
  return bounded(`iOS test failure:\n${body || 'No diagnostic output was captured.'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = fs.readFileSync(process.argv[2], 'utf8');
  let result = null;
  let parseNote = '';
  if (process.argv[3] && fs.existsSync(process.argv[3])) {
    try { result = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); }
    catch { parseNote = '\nxcresult JSON unavailable; using command output.'; }
  }
  console.log(summarizeIosFailure(log + parseNote, result));
}
