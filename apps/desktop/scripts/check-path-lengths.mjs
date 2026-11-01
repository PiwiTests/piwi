#!/usr/bin/env node
// Fail when a file of the built server sits too deep for the Windows installers.
//
// A Windows program that is not long-path aware opens a path of at most 259
// characters (MAX_PATH): makensis and WiX's light stop on a longer one while
// they build the installers, and the installers are held to it while they
// write the files. The server lands deepest in one of two folders: the
// per-user install (the .exe) of a user whose name is as long as Windows
// allows (20 characters), and the Microsoft Store package's folder under
// WindowsApps, named after the package, its version (up to 9.99.99.0) and its
// publisher's 13-character id. Every path under .output must fit in what the
// deeper one leaves. A dependency
// installed in two versions nests one under the other and is the usual cause;
// `npm ls <package>` shows which.
//
// Usage: node scripts/check-path-lengths.mjs [path to .output]
//        (default: ../application/.output)
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_PATH = 259;
const SERVER = ['resources', 'app-server', '.output', ''];
const PER_USER_OUTPUT = ['C:', 'Users', 'u'.repeat(20), 'AppData', 'Local', 'Piwi Dashboard', ...SERVER].join('\\');
const PACKAGE_OUTPUT = [
  'C:',
  'Program Files',
  'WindowsApps',
  `PiwiTests.PiwiDashboard_9.99.99.0_x64__${'p'.repeat(13)}`,
  ...SERVER,
].join('\\');
const INSTALLED_OUTPUT = [PER_USER_OUTPUT, PACKAGE_OUTPUT].reduce((a, b) => (b.length > a.length ? b : a));
const BUDGET = MAX_PATH - INSTALLED_OUTPUT.length;

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? resolve(here, '../../application/.output'));

const paths = readdirSync(output, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(output, join(entry.parentPath, entry.name)).split(sep).join('\\'))
  .sort((a, b) => b.length - a.length);

if (paths.length === 0) {
  console.error(`[paths] No files under ${output}: build the server first`);
  process.exit(1);
}

const tooLong = paths.filter((path) => path.length > BUDGET);
if (tooLong.length > 0) {
  console.error(
    `[paths] ${tooLong.length} file(s) under .output are longer than ${BUDGET} characters, too long for the Windows installers once installed under ${INSTALLED_OUTPUT}:`,
  );
  for (const path of tooLong.slice(0, 10)) console.error(`  ${path.length}  ${path}`);
  process.exit(1);
}

console.log(`[paths] The longest path under .output is ${paths[0].length} of ${BUDGET} characters: ${paths[0]}`);
