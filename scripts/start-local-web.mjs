import { createReadStream, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '../apps/web');
const DEFAULT_PORT = 8765;
const LOOPBACK_HOST = '127.0.0.1';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

function sendText(response, status, text) {
  const body = Buffer.from(text);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function resolveStaticPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const absolute = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (absolute !== path.resolve(root) && !absolute.startsWith(rootPrefix)) return null;
  return absolute;
}

export function isLoopbackHostHeader(value) {
  const match = /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/i.exec(String(value || ''));
  if (!match) return false;
  if (!match[2]) return true;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535;
}

export function createLocalWebServer({ root = DEFAULT_ROOT, createReadStreamImpl = createReadStream } = {}) {
  const staticRoot = realpathSync(path.resolve(root));
  return http.createServer((request, response) => {
    if (!isLoopbackHostHeader(request.headers.host)) {
      return sendText(response, 421, 'Misdirected Request');
    }
    if (!['GET', 'HEAD'].includes(request.method || '')) {
      response.setHeader('Allow', 'GET, HEAD');
      return sendText(response, 405, 'Method Not Allowed');
    }

    const filePath = resolveStaticPath(staticRoot, request.url || '/');
    if (!filePath) return sendText(response, 404, 'Not Found');

    let realFilePath;
    let stat;
    try {
      realFilePath = realpathSync(filePath);
      const rootPrefix = `${staticRoot}${path.sep}`;
      if (realFilePath !== staticRoot && !realFilePath.startsWith(rootPrefix)) {
        return sendText(response, 404, 'Not Found');
      }
      stat = statSync(realFilePath);
    } catch {
      return sendText(response, 404, 'Not Found');
    }
    if (!stat.isFile()) return sendText(response, 404, 'Not Found');

    const headers = {
      'Cache-Control': 'no-store',
      'Content-Type': MIME_TYPES.get(path.extname(realFilePath).toLowerCase()) || 'application/octet-stream',
      'Content-Length': stat.size,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.method === 'HEAD') {
      response.writeHead(200, headers);
      return response.end();
    }

    const stream = createReadStreamImpl(realFilePath);
    stream.once('error', () => {
      if (!response.headersSent) sendText(response, 404, 'Not Found');
      else response.destroy();
    });
    stream.once('open', () => {
      if (response.writableEnded) return;
      response.writeHead(200, headers);
      stream.pipe(response);
    });
  });
}

function parsePort(value) {
  const port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('VOICE_LOCAL_WEB_PORT must be an integer between 1024 and 65535');
  }
  return port;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = parsePort(process.env.VOICE_LOCAL_WEB_PORT);
  const server = createLocalWebServer();
  server.listen(port, LOOPBACK_HOST, () => {
    console.log(`Voice Practice Local Web Mode: http://${LOOPBACK_HOST}:${port}`);
    console.log('This server is loopback-only and does not proxy model requests or credentials.');
  });
}
