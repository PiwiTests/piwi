/**
 * The project's own Playwright, resolved from the folder of its config: the first of its packages Node finds in a
 * `node_modules` folder there or above it, that folder or the package a link to elsewhere or not, the test runner's
 * package first, so the CLI that reads the config's options and the library the launcher opens the browser with are
 * the same Playwright. A Playwright Node would only find in a global folder (`NODE_PATH`, `~/.node_modules`) is not
 * the project's.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

/**
 * A path as the file system spells it: the real path, with the case of each name as stored on disk (`C:\\Users\\Me`
 * for `c:\\users\\me`), so that Node loads each module of a project once, whatever the case the editor gave; the path
 * as given when it does not exist.
 */
export function canonicalPath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

/** The real paths of the `node_modules` folders in `dir` and in each folder above it. */
function nodeModulesOf(dir: string): string[] {
  const found: string[] = [];
  for (let folder = path.resolve(dir); ; folder = path.dirname(folder)) {
    try {
      found.push(fs.realpathSync.native(path.join(folder, 'node_modules')));
    } catch {
      // none in this folder
    }
    if (path.dirname(folder) === folder) return found;
  }
}

/** The package a module id names: `@playwright/test` of `@playwright/test/cli`, `playwright` of `playwright/cli`. */
function packageOf(id: string): string {
  return id
    .split('/')
    .slice(0, id.startsWith('@') ? 2 : 1)
    .join('/');
}

/**
 * The real paths of the package `name` in the `node_modules` folders of `dir` and above it: a package such a folder
 * holds as a link to elsewhere (`npm link`, a store outside the project) is the project's too.
 */
function packageFoldersOf(dir: string, name: string): string[] {
  const found: string[] = [];
  for (let folder = path.resolve(dir); ; folder = path.dirname(folder)) {
    try {
      found.push(fs.realpathSync.native(path.join(folder, 'node_modules', name)));
    } catch {
      // none in this folder
    }
    if (path.dirname(folder) === folder) return found;
  }
}

function resolveFirst(from: string, ids: string[]): string | null {
  const dir = canonicalPath(from);
  const require = createRequire(path.join(dir, 'noop.js'));
  const roots = nodeModulesOf(dir);
  const inProject = (file: string, id: string) =>
    [...roots, ...packageFoldersOf(dir, packageOf(id))].some((root) => {
      const relative = path.relative(root, file);
      return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
  for (const id of ids) {
    try {
      const file = canonicalPath(require.resolve(id));
      if (inProject(file, id)) return file;
    } catch {
      // the next candidate
    }
  }
  return null;
}

/** The project's Playwright CLI; null when Playwright is not installed there. */
export function resolvePlaywrightCli(dir: string): string | null {
  return resolveFirst(dir, ['@playwright/test/cli', 'playwright/cli', 'playwright/lib/cli/cli']);
}

/** The module of the project's Playwright library (`chromium`, `firefox`, `webkit`, `selectors`); null when none. */
export function resolvePlaywrightLibrary(dir: string): string | null {
  return resolveFirst(dir, ['@playwright/test', 'playwright', 'playwright-core']);
}
