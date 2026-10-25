// Bundle the language server into one file both editor clients ship: dist/piwi-language-server.cjs, CommonJS for
// Node 20 and later. Beside it, the files a recording needs: the launcher the service forks, the reporter that reads
// a config's resolved options, and the recorder's IDE bundle with its catalogs, which the browser extension's build
// makes from its own sources (`buildIdeBundle`), stamped with the extension manifest's version.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildIdeBundle } from '../../apps/extension/scripts/build.mjs';

/** The service's version, which its discovery file and the hub's welcome name. */
const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));

const bundles = [
  ['src/main.ts', 'piwi-language-server.cjs'],
  ['src/recorder/launcher.ts', 'piwi-recorder-launcher.cjs'],
  ['src/recorder/use-reporter.ts', 'piwi-use-reporter.cjs'],
];

for (const [entry, file] of bundles) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: `dist/${file}`,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
    define: { __PIWI_EDITOR_VERSION__: JSON.stringify(version) },
  });
}

await buildIdeBundle({
  outDir: fileURLToPath(new URL('dist/', import.meta.url)),
  release: true,
});
