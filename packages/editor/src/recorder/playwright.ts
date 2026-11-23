/**
 * The project's own Playwright, resolved from the folder of its config: the first of its packages Node finds in a
 * `node_modules` folder there or above it, the test runner's package first, so the CLI that reads the config's
 * options and the library the launcher opens the browser with are the same Playwright. A package such a folder holds
 * as a link to elsewhere (`npm link`, a store outside the project) is the project's; a Playwright Node would only find
 * in a global folder (`NODE_PATH`, `~/.node_modules`) is not.
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

/** The package a module id names: `@playwright/test` for `@playwright/test/cli`, `playwright` for `playwright/cli`. */
function packageOf(id: string): string {
  const parts = id.split('/');
  return parts.slice(0, id.startsWith('@') ? 2 : 1).join('/');
}

/**
 * The real paths of the folders of package `name` in the `node_modules` folder of `dir` and of each folder above it,
 * each found by its path before following links, as Node looks for it there.
 */
function installedIn(dir: string, name: string): string[] {
  const found: string[] = [];
  for (let folder = path.resolve(dir); ; folder = path.dirname(folder)) {
    try {
      found.push(fs.realpathSync.native(path.join(folder, 'node_modules', name)));
    } catch {
      // not in this folder
    }
    if (path.dirname(folder) === folder) return found;
  }
}

function resolveFirst(from: string, ids: string[]): string | null {
  const dir = canonicalPath(from);
  const require = createRequire(path.join(dir, 'noop.js'));
  for (const id of ids) {
    const packages = installedIn(dir, packageOf(id));
    if (packages.length === 0) continue;
    try {
      const file = canonicalPath(require.resolve(id));
      const inProject = packages.some((root) => {
        const relative = path.relative(root, file);
        return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      });
      if (inProject) return file;
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
