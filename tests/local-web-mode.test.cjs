const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const policy = require('../apps/web/runtime/local-endpoint-policy.js');

const ROOT = path.resolve(__dirname, '..');

test('hosted HTTPS browser allows an HTTP loopback endpoint through Local Network Access', () => {
  const result = policy.classifyEndpointAccess({
    pageUrl: 'https://voice-practice.example/app',
    apiBaseUrl: 'http://127.0.0.1:8000/v1',
    runtimeKind: 'browser',
  });
  assert.equal(result.allowed, true);
  assert.equal(result.mode, 'hosted-loopback');
  assert.match(result.message, /本機網路/);
});

test('hosted HTTPS allows LAN HTTP endpoints through Local Network Access with a warning', () => {
  for (const apiBaseUrl of [
    'http://10.0.0.8:8000/v1',
    'http://172.16.0.8:8000/v1',
    'http://172.31.255.8:8000/v1',
    'http://192.168.1.20:8000/v1',
    'http://169.254.1.8:8000/v1',
    'http://model.local:8000/v1',
    'http://[fd00::8]:8000/v1',
    'http://[fe80::8]:8000/v1',
  ]) {
    const result = policy.classifyEndpointAccess({
      pageUrl: 'https://voice-practice.example/app',
      apiBaseUrl,
      runtimeKind: 'browser',
    });
    assert.equal(result.allowed, true, apiBaseUrl);
    assert.equal(result.mode, 'hosted-lan');
    assert.match(result.message, /明文/);
  }
});

test('hosted HTTPS still blocks public HTTP endpoints', () => {
  for (const apiBaseUrl of [
    'http://8.8.8.8:8000/v1',
    'http://172.32.0.8:8000/v1',
    'http://public.example/v1',
    'http://model.internal.example/v1',
    'http://fd00.example/v1',
  ]) {
    const result = policy.classifyEndpointAccess({
      pageUrl: 'https://voice-practice.example/app', apiBaseUrl, runtimeKind: 'browser',
    });
    assert.equal(result.allowed, false, apiBaseUrl);
    assert.equal(result.code, 'HOSTED_HTTPS_HTTP_REQUIRES_LOCAL_NETWORK');
  }
});

test('loopback Local Web Mode allows an HTTP local-model endpoint', () => {
  const result = policy.classifyEndpointAccess({
    pageUrl: 'http://127.0.0.1:8765/',
    apiBaseUrl: 'http://127.0.0.1:8000/v1',
    runtimeKind: 'browser',
  });
  assert.equal(result.allowed, true);
  assert.equal(result.mode, 'local-web');
});

test('hosted browser accepts HTTPS providers and Electron delegates HTTP safely', () => {
  assert.equal(policy.classifyEndpointAccess({
    pageUrl: 'https://voice-practice.example/',
    apiBaseUrl: 'https://api.openai.com/v1',
    runtimeKind: 'browser',
  }).allowed, true);
  assert.equal(policy.classifyEndpointAccess({
    pageUrl: 'file:///Applications/Voice%20Practice/index.html',
    apiBaseUrl: 'http://127.0.0.1:8000/v1',
    runtimeKind: 'electron',
  }).allowed, true);
});

test('invalid endpoint is rejected deterministically', () => {
  const result = policy.classifyEndpointAccess({
    pageUrl: 'https://voice-practice.example/',
    apiBaseUrl: 'not a URL',
    runtimeKind: 'browser',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID_API_BASE_URL');
});

test('Local Web HTTP exception is limited to loopback endpoints including IPv6', () => {
  const pageUrl = 'http://127.0.0.1:8765/';
  for (const apiBaseUrl of ['http://localhost:8000/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1']) {
    assert.equal(policy.classifyEndpointAccess({ pageUrl, apiBaseUrl }).allowed, true);
  }
  const lan = policy.classifyEndpointAccess({ pageUrl, apiBaseUrl: 'http://192.168.1.20:8000/v1' });
  assert.equal(lan.allowed, true);
  assert.equal(lan.mode, 'local-web-lan');
  assert.match(lan.message, /明文/);
});

test('browser HTTP endpoints fail closed outside Local Web Mode', () => {
  for (const pageUrl of [
    'file:///Applications/Voice%20Practice/index.html',
    'http://192.168.1.30:8765/',
    'http://public.example/',
    'ftp://127.0.0.1/app',
  ]) {
    const result = policy.classifyEndpointAccess({
      pageUrl,
      apiBaseUrl: 'http://127.0.0.1:8000/v1',
      runtimeKind: 'browser',
    });
    assert.equal(result.allowed, false, pageUrl);
    assert.equal(result.code, 'BROWSER_HTTP_ENDPOINT_BLOCKED');
  }
});

test('endpoint URLs reject embedded credentials, queries, and fragments', () => {
  const pageUrl = 'http://127.0.0.1:8765/';
  for (const apiBaseUrl of [
    'http://user:pass@127.0.0.1:8000/v1',
    'http://127.0.0.1:8000/v1?target=other',
    'http://127.0.0.1:8000/v1#fragment',
  ]) {
    const result = policy.classifyEndpointAccess({ pageUrl, apiBaseUrl });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'UNSAFE_API_BASE_URL');
  }
});

test('local web server binds loopback and serves the built app without proxying API routes', async t => {
  const { createLocalWebServer } = await import('../scripts/start-local-web.mjs');
  const server = createLocalWebServer({ root: path.join(ROOT, 'apps/web') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;

  const home = await fetch(`${origin}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /OpenCoach/);

  const api = await fetch(`${origin}/v1/models`);
  assert.equal(api.status, 404);
  assert.equal(api.headers.get('access-control-allow-origin'), null);
});

test('local web server rejects a symlink or junction that escapes the static root', async t => {
  const { createLocalWebServer } = await import('../scripts/start-local-web.mjs');
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'voice-local-web-'));
  const root = path.join(temporary, 'web');
  const outside = path.join(temporary, 'outside');
  const secret = path.join(outside, 'secret.txt');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(secret, 'must-not-be-served');
  // A directory junction exercises the same realpath containment boundary and
  // does not require Windows Developer Mode or Administrator privileges.
  symlinkSync(outside, path.join(root, 'escape'), 'junction');
  t.after(() => rmSync(temporary, { recursive: true, force: true }));

  const server = createLocalWebServer({ root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/escape/secret.txt`);
  assert.equal(response.status, 404);
  assert.notEqual(await response.text(), 'must-not-be-served');
});

test('local web server rejects a non-loopback Host header', async t => {
  const { createLocalWebServer } = await import('../scripts/start-local-web.mjs');
  const server = createLocalWebServer({ root: path.join(ROOT, 'apps/web') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();

  const response = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: address.port, path: '/', headers: { Host: 'rebound.example' } }, resolve);
    request.on('error', reject);
  });
  assert.equal(response.statusCode, 421);
  response.resume();
});

test('Host authority parser accepts only loopback names with an optional valid numeric port', async () => {
  const { isLoopbackHostHeader } = await import('../scripts/start-local-web.mjs');
  for (const value of ['localhost', 'LOCALHOST:8765', '127.0.0.1', '127.0.0.1:65535']) {
    assert.equal(isLoopbackHostHeader(value), true, value);
  }
  for (const value of [
    'user@localhost', 'localhost/path', 'localhost?evil', 'localhost#evil',
    ' localhost', 'localhost ', 'localhost:abc', 'localhost:0', 'localhost:65536',
    'localhost:80:90', '127.0.0.1.evil', '',
  ]) {
    assert.equal(isLoopbackHostHeader(value), false, value);
  }
});

test('local web server handles a stream-open failure without crashing', async t => {
  const { EventEmitter } = require('node:events');
  const { createLocalWebServer } = await import('../scripts/start-local-web.mjs');
  const failedStreamFactory = () => {
    const stream = new EventEmitter();
    stream.destroy = () => {};
    process.nextTick(() => stream.emit('error', new Error('simulated open failure')));
    return stream;
  };
  const server = createLocalWebServer({ root: path.join(ROOT, 'apps/web'), createReadStreamImpl: failedStreamFactory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/index.html`);
  assert.equal(response.status, 404);
});
