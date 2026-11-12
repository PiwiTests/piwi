/**
 * Piwi Runner's Node host, on `node:http`: what the Tauri shell starts as its sidecar and the window talks to.
 * It answers the shell's readiness probe (`/api/health`, proving it holds the access token), the run-target routes, the
 * window's session and its two event streams (`serveRunTarget` of `@piwitests/editor`, the same routes and guard the
 * dashboard's desktop build serves), the hub of the runs the shell starts (`serveShellRuns`: the run channel the shell
 * names in each run, the window's stream and commands, and the runs' picks), and the window's own files. It has no database, no account and no other route.
 */
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { challengeAnswer, headersOf } from '@piwitests/editor/host-guard';
import { serveRunTarget } from '@piwitests/editor/run-target-http';
import type { ShellRuns } from '@piwitests/editor/shell-runs';
import { serveShellRuns } from '@piwitests/editor/shell-runs-http';

/** The readiness probe the shell sends before it loads the window's session. */
export const HEALTH_PATH = '/api/health';

export interface RunnerHostOptions {
  /** The access token the shell holds: the window's cookie and the shell's calls carry it. */
  token: string;
  /** The folder of the window's built files, with its `index.html`. */
  root: string;
  /** The hub of the runs the shell starts, once open; none until then. */
  runs?: () => ShellRuns | null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Whether a `Host` header names this machine: the window and the shell reach the host on a loopback address alone. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const name = new URL(`http://${host}`).hostname;
    return name === 'localhost' || name === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(name);
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** The file a request path names under `root`: null outside it, for a directory or for a file that is not there. */
function fileOf(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.join(root, decoded);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * The window's files: a file the build made, or `index.html` for a path with no extension (a page of the window, which
 * the window's router answers). `HEAD` and `GET` alone; anything else is a 404, as is a missing file with an extension.
 */
function serveWindow(req: IncomingMessage, res: ServerResponse, root: string): void {
  req.resume();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 404, { message: 'Not found' });
    return;
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const asked = fileOf(root, pathname);
  const file = asked ?? (path.extname(pathname) === '' ? fileOf(root, '/index.html') : null);
  if (!file) {
    sendJson(res, 404, { message: 'Not found' });
    return;
  }
  const extension = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    // The build names its scripts and styles by content, so they are kept; the page is read again each time.
    'Cache-Control': pathname.startsWith('/_nuxt/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** The request listener of the host. Never rejects: a route that fails answers 500. */
export function runnerHandler(options: RunnerHostOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const root = path.resolve(options.root);
  return (req, res) => {
    void (async () => {
      if (!isLoopbackHost(req.headers.host)) {
        req.resume();
        sendJson(res, 421, { message: 'Misdirected request' });
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
        req.resume();
        const proof = await challengeAnswer(headersOf(req.headers), options.token, req.socket.localPort);
        sendJson(res, 200, { status: 'ok' }, proof);
        return;
      }
      if (await serveRunTarget(req, res, options.token)) return;
      const runs = options.runs?.() ?? null;
      if (await serveShellRuns(req, res, options.token, runs, req.socket.localPort ?? 0)) return;
      if (pathname.startsWith('/api/') || pathname.startsWith('/__piwi/')) {
        req.resume();
        sendJson(res, 404, { message: 'Not found' });
        return;
      }
      serveWindow(req, res, root);
    })().catch(() => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { message: 'The host failed' });
    });
  };
}
