// Packs a release build of dist/ into two archives, run via `npm run extension:zip`
// (which does the release build first):
//
// - piwi-picker-v<version>.zip: the add-on for the Chrome Web Store and Edge
//   Add-ons (dist/), and piwi-picker-v<version>-firefox.zip the same files with
//   Firefox's manifest (dist-firefox/), for AMO (see PUBLISHING.md).
//   Sourcemaps are excluded: useful locally, not meant to ship.
// - piwi-picker-v<version>-source.zip: the sources that build came from, for
//   AMO, which requires them for bundled or minified code. Its reviewers
//   rebuild it and diff the result against the add-on, so it holds exactly the
//   files the build reads, with SOURCE-BUILD.md as its README.
// - piwi-picker-v<version>-amo-metadata.json: the AMO listing fields the add-on
//   cannot carry itself, for `web-ext sign --amo-metadata` (see amo-metadata.mjs).
import { createWriteStream, readFileSync, unlinkSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { buildAmoMetadata } from './amo-metadata.mjs';
import { isReleaseBuild } from './build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(root, '..', '..');
const distDir = path.join(root, 'dist');
const firefoxDistDir = path.join(root, 'dist-firefox');
const { version } = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/**
 * What the build reads, relative to the repository root: this workspace, the
 * three workspaces it bundles from source, and the npm root that installs them.
 */
const SOURCE_PATHS = [
  'package.json',
  'package-lock.json',
  '.npmrc',
  'tsconfig.json',
  'LICENSE',
  'apps/extension',
  'packages/core',
  'packages/picker-dom',
  'packages/run-model',
];

async function writeZip(fileName, fill) {
  const outPath = path.join(root, fileName);
  if (existsSync(outPath)) unlinkSync(outPath);

  const output = createWriteStream(outPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });

  archive.pipe(output);
  fill(archive);
  await archive.finalize();
  await done;
  console.log(`Zipped ${path.relative(process.cwd(), outPath)}`);
}

/** The files git lists under `SOURCE_PATHS` with `args`, relative to the repository root. */
function gitFiles(args) {
  const output = execFileSync('git', ['ls-files', '-z', ...args, '--', ...SOURCE_PATHS], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output.split('\0').filter(Boolean);
}

/**
 * The tracked files, read from the working tree; a file git does not track
 * stays out. A tracked file deleted from the working tree is still listed by
 * git, and left out too.
 */
function listSourceFiles() {
  return gitFiles(['--cached']).filter((file) => existsSync(path.join(repoRoot, file)));
}

// The store zips are the release build: a dev build, stamped with its build time, never ships.
for (const dir of [distDir, firefoxDistDir]) {
  if (!isReleaseBuild(dir, version)) {
    console.error(
      `${path.relative(process.cwd(), dir)} does not hold the release build of v${version}: run \`npm run extension:zip\`, which builds it first.`,
    );
    process.exit(1);
  }
}
const untracked = gitFiles(['--others', '--exclude-standard']);
if (untracked.length) console.warn(`Left out of the source zip, as git does not track them: ${untracked.join(', ')}`);

// `false` as the second arg: zip the contents of dist/ directly at the
// archive root (manifest.json at the top level), not nested in a dist/ folder
// — stores expect the manifest at the zip root.
await writeZip(`piwi-picker-v${version}.zip`, (archive) =>
  archive.directory(distDir, false, (entry) => (entry.name.endsWith('.map') ? false : entry)),
);
await writeZip(`piwi-picker-v${version}-firefox.zip`, (archive) =>
  archive.directory(firefoxDistDir, false, (entry) => (entry.name.endsWith('.map') ? false : entry)),
);

await writeZip(`piwi-picker-v${version}-source.zip`, (archive) => {
  for (const file of listSourceFiles()) archive.file(path.join(repoRoot, file), { name: file });
  archive.file(path.join(root, 'SOURCE-BUILD.md'), { name: 'README.md' });
});

const metadataPath = path.join(root, `piwi-picker-v${version}-amo-metadata.json`);
writeFileSync(metadataPath, `${JSON.stringify(buildAmoMetadata(), null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), metadataPath)}`);
