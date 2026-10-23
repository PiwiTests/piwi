/**
 * Serves the built demo SPA (`npm run app:generate:demo`, written to
 * `.output/public`) the way GitHub Pages serves it: from its `/demo/`
 * sub-path, the scope its service worker takes, with a deep link answered by
 * the SPA shell. `check-demo-runtime.mjs` and the screenshot harness's `demo`
 * mode drive it.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where `app:generate:demo` writes the demo. */
export const BUILT_DEMO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.output', 'public');

/** The sub-path the demo is deployed under. */
export const BUILT_DEMO_BASE = '/demo/';

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.sql': 'text/plain',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** Serves `root` under `base` on `port`; resolves with the listening server. */
export function serveBuiltDemo({ root = BUILT_DEMO_ROOT, base = BUILT_DEMO_BASE, port }) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const path = decodeURIComponent(req.url.split('?')[0]);
      if (!path.startsWith(base)) {
        res.writeHead(404).end('outside the demo base path');
        return;
      }
      let file = join(root, path.slice(base.length) || 'index.html');
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      } catch {
        // Deep links have no static file; the SPA shell resolves them client-side.
        file = join(root, 'index.html');
      }
      try {
        const data = await readFile(file);
        res.writeHead(200, {
          'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
          'Service-Worker-Allowed': base,
        });
        res.end(data);
      } catch {
        // Headers are only written once the read succeeds, so a missing file
        // can still answer 404 (on Windows a read can fail after a successful
        // stat, e.g. a locked file, and a second writeHead would crash the server).
        if (!res.headersSent) res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(port, () => resolve(server));
  });
}
