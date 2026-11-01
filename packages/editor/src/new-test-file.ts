/**
 * Where Record a new test file creates its spec, for both editors: the folder, from the file or folder at hand and the
 * test folders of the Playwright config holding it, and a name the folder does not hold, with the suffix the suite's
 * specs use.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A Playwright test file's name: `.spec` or `.test`, then a JavaScript or TypeScript extension. */
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

/** The name a recorded spec takes, before its suffix and number. */
const RECORDED = 'recorded';

/** How many files of a folder are read for a spec whose suffix the new one takes. */
const MAX_READ = 200;

/** What the place of a new spec is read from. */
export interface NewTestFileInput {
  /** The file or folder at hand (the active file, the folder selected); null for none. */
  at: string | null;
  /** The folder of the Playwright config holding `at`, else of the workspace's first config. */
  root: string;
  /** The config file, whose extension says a JavaScript suite when no spec does. */
  configFile: string | null;
  /** The test folders of the config's projects, as Playwright resolves them (`testDir`); empty when unknown. */
  testDirs: readonly string[];
}

/** The new spec's path: in `folder`, named `name`. */
export interface NewTestFile {
  folder: string;
  name: string;
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The `testDir` a Playwright config names as a string literal, resolved from its folder; null when it names none so. */
export function configTestDir(configFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch {
    return null;
  }
  const named = /\btestDir\s*:\s*(['"`])([^'"`]+)\1/.exec(text)?.[2];
  return named ? path.resolve(path.dirname(configFile), named) : null;
}

/** The suffix of the first spec found under `folder`, its own files first, then its subfolders' (breadth first). */
function suiteSuffix(folder: string): string | null {
  const queue = [folder];
  let read = 0;
  while (queue.length && read < MAX_READ) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      read++;
      if (entry.isFile() && TEST_FILE.test(entry.name)) return TEST_FILE.exec(entry.name)![0];
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        queue.push(path.join(dir, entry.name));
      }
    }
  }
  return null;
}

/**
 * Where a new spec goes: beside the spec at hand; in the folder at hand when a config's test folder holds it; else in
 * the test folder of the config's project holding the file at hand, or its first project's, or the config's folder.
 * Named `recorded` with the suffix of the spec at hand, else of the first spec of that test folder, else `.spec.js`
 * beside a JavaScript config, else `.spec.ts`; then `recorded-2`, and so on, until the folder does not hold it.
 */
export function newTestFile(input: NewTestFileInput): NewTestFile {
  const { at, root, configFile } = input;
  const testDirs = input.testDirs.length ? input.testDirs : [configFile ? configTestDir(configFile) : null];
  const known = testDirs.filter((dir): dir is string => !!dir);
  const owning = at ? known.find((dir) => inside(dir, at)) : undefined;
  const testDir = owning ?? known[0] ?? root;
  let folder = testDir;
  let suffix: string | null = null;
  if (at && TEST_FILE.test(at) && !isDirectory(at)) {
    folder = path.dirname(at);
    suffix = TEST_FILE.exec(at)![0];
  } else if (at && isDirectory(at) && known.some((dir) => inside(dir, at))) {
    folder = at;
  }
  suffix ??=
    suiteSuffix(folder) ??
    suiteSuffix(testDir) ??
    (configFile && /\.[cm]?js$/.test(configFile) ? '.spec.js' : '.spec.ts');
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${RECORDED}${suffix}` : `${RECORDED}-${n}${suffix}`;
    if (!fs.existsSync(path.join(folder, name))) return { folder, name };
  }
}
