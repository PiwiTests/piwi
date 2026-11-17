// Serves the window `npm run runner:window` built (`.output/public`) on 127.0.0.1 for the window's specs, any path
// that names no file answering with its page, as a single-page app's host does. Usage: node serve-window.mjs <port>.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '.output', 'public');
const port = Number(process.argv[2] ?? 7595);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (!existsSync(path.join(root, 'index.html'))) {
  console.error(`No window in ${root}: run \`npm run runner:window\` first.`);
  process.exit(1);
}

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  let file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(root, 'index.html');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1');
