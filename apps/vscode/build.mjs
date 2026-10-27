// Bundle the extension into dist/extension.cjs and ship the editor service beside it, so nothing is installed in the
// user's project: the language server, and the recorder's launcher and files it finds next to itself.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  outfile: 'dist/extension.cjs',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

// The service, and the files of the recorder it finds next to itself: the launcher, the reporter that reads the
// Playwright config, the recorder's bundle for pages of the browser it opens, and that bundle's messages.
const SERVICE = [
  'piwi-language-server.cjs',
  'piwi-recorder-launcher.cjs',
  'piwi-use-reporter.cjs',
  'record-ide.js',
  'record-ide-messages.json',
];
const from = dirname(createRequire(import.meta.url).resolve('@piwitests/editor/server'));
const missing = SERVICE.filter((name) => !existsSync(join(from, name)));
if (missing.length) {
  throw new Error(
    `The editor service's build in ${from} lacks ${missing.join(', ')}: run npm run editor:build -w @piwitests/editor.`,
  );
}
mkdirSync('dist', { recursive: true });
for (const name of SERVICE) copyFileSync(join(from, name), join('dist', name));
