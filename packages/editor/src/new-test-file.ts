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

/**
 * The test folders a Playwright config names as string literals (`testDir: './e2e'`, its projects' too), outside
 * comments, resolved from its folder; a name built at run time (`` `${__dirname}/e2e` ``) is left out.
 */
export function configTestDirs(configFile: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch {
    return [];
  }
  // Block comments, then line comments: a `//` after a `:` is a URL's (`'http://localhost'`), kept.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const dirs = [...code.matchAll(/\btestDir\s*:\s*(['"`])([^'"`$]+)\1/g)].map((m) =>
    path.resolve(path.dirname(configFile), m[2]!),
  );
  return [...new Set(dirs)];
}

/** `dir` in the spelling of `root`: Playwright resolves real paths, the editor may name the folder through a link. */
function spelledAs(root: string, realRoot: string, dir: string): string {
  return realRoot !== root && inside(realRoot, dir) ? path.join(root, path.relative(realRoot, dir)) : dir;
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
 * Where a new spec goes: beside the spec at hand, or in the folder at hand, when a test folder of the config holds it;
 * else in the deepest test folder holding the file at hand, or the first one, or the config's folder. The test folders
 * are Playwright's (`testDirs`), else the config's literals (`configTestDirs`), else the config's folder, as Playwright
 * reads a config without one. Named `recorded` with the suffix of the spec at hand, else of the first spec of that
 * test folder, else `.spec.js` beside a JavaScript config, else `.spec.ts`; then `recorded-2`, and so on, until the
 * folder does not hold it.
 */
export function newTestFile(input: NewTestFileInput): NewTestFile {
  const { at, root, configFile } = input;
  let realRoot = root;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    // A folder that is gone: its spelling stands.
  }
  const named = input.testDirs.length ? input.testDirs : configFile ? configTestDirs(configFile) : [];
  const known = named.length ? [...new Set(named.map((dir) => spelledAs(root, realRoot, dir)))] : [root];
  const holding = at ? known.filter((dir) => inside(dir, at)).sort((a, b) => b.length - a.length) : [];
  const testDir = holding[0] ?? known[0]!;
  let folder = testDir;
  let suffix: string | null = null;
  if (at && holding.length && TEST_FILE.test(at) && !isDirectory(at)) {
    folder = path.dirname(at);
    suffix = TEST_FILE.exec(at)![0];
  } else if (at && holding.length && isDirectory(at)) {
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
