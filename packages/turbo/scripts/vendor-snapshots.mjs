// Writes src/vendor/differential-snapshots.ts from the differential DOM snapshot script of a Playwright checkout:
//   node scripts/vendor-snapshots.mjs <path to playwright>/packages/playwright-core/src/server/trace/recorder/snapshotterInjected.ts <commit>
import { readFileSync, writeFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const [source, commit] = process.argv.slice(2);
if (!source || !commit) {
  console.error('Usage: node scripts/vendor-snapshots.mjs <snapshotterInjected.ts> <commit>');
  process.exit(1);
}
const typescript = readFileSync(source, 'utf8');
const header = typescript.slice(0, typescript.indexOf('*/') + 2);
if (!header.includes('Licensed under the Apache License, Version 2.0')) throw new Error('The source has no Apache-2.0 header');
const { code } = transformSync(typescript, { loader: 'ts', format: 'esm', target: 'es2022', legalComments: 'none' });
const start = code.indexOf('function frameSnapshotStreamer(');
const end = code.lastIndexOf('export {');
if (start < 0 || end < start) throw new Error('No frameSnapshotStreamer function in the source');
const fn = code.slice(start, end).trim();
const rest = code.slice(0, start) + code.slice(end).replace(/export \{\s*frameSnapshotStreamer\s*\};?/, '');
if (rest.replace(/\/\/.*$/gm, '').trim()) throw new Error('The source has code besides frameSnapshotStreamer');

writeFileSync(
  new URL('../src/vendor/differential-snapshots.ts', import.meta.url),
  `${header.replace('/**', '/**\n * @license Apache-2.0\n *')}

// Changed from Playwright's snapshotterInjected.ts in PhenX/playwright at ${commit}: differential DOM snapshots for
// traces, where a snapshot visits only the nodes that changed since the previous one, with the same result as a full
// walk. Compiled to JavaScript by scripts/vendor-snapshots.mjs. Do not edit: run the script again.

/** The source of the differential \`frameSnapshotStreamer\`, injected in place of Playwright's own. */
export const DIFFERENTIAL_STREAMER = ${JSON.stringify(fn)};
`,
);
console.log(`wrote src/vendor/differential-snapshots.ts (${fn.length} characters)`);
