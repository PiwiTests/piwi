// Bundle the Node host into one file, dist/server.cjs, stamped with the app's version. The window's files
// (`nuxt generate`) are copied beside it as dist/public by the staging step that bundles the app.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: [fileURLToPath(new URL('../server/main.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: fileURLToPath(new URL('../dist/server.cjs', import.meta.url)),
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  define: { __PIWI_RUNNER_VERSION__: JSON.stringify(version) },
});
