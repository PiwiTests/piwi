import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { canonicalPath, resolvePlaywrightCli, resolvePlaywrightLibrary } from '../src/recorder/playwright';

let dir = '';

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-playwright-')));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A folder whose `node_modules` holds packages made of an `index.js`, and of a `cli.js` when listed in `cli`. */
function project(name: string, packages: string[], cli: string[] = []): string {
  const root = path.join(dir, name);
  for (const id of packages) {
    const folder = path.join(root, 'node_modules', id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: id, main: 'index.js' }));
    fs.writeFileSync(path.join(folder, 'index.js'), 'module.exports = {};\n');
    if (cli.includes(id)) fs.writeFileSync(path.join(folder, 'cli.js'), '\n');
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

describe('the project’s Playwright', () => {
  test('the test runner’s package first, then playwright, then playwright-core', () => {
    const all = project(
      'all',
      ['@playwright/test', 'playwright', 'playwright-core'],
      ['@playwright/test', 'playwright'],
    );
    expect(resolvePlaywrightLibrary(all)).toBe(path.join(all, 'node_modules', '@playwright', 'test', 'index.js'));
    expect(resolvePlaywrightCli(all)).toBe(path.join(all, 'node_modules', '@playwright', 'test', 'cli.js'));
    const library = project('library', ['playwright', 'playwright-core'], ['playwright']);
    expect(resolvePlaywrightLibrary(library)).toBe(path.join(library, 'node_modules', 'playwright', 'index.js'));
    expect(resolvePlaywrightCli(library)).toBe(path.join(library, 'node_modules', 'playwright', 'cli.js'));
    const core = project('core', ['playwright-core']);
    expect(resolvePlaywrightLibrary(core)).toBe(path.join(core, 'node_modules', 'playwright-core', 'index.js'));
  });

  test('a playwright-core another dependency hoists does not come before the test runner’s own', () => {
    const root = project('hoisted', ['playwright-core', '@playwright/test']);
    const nested = path.join(root, 'packages', 'shop');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolvePlaywrightLibrary(nested)).toBe(path.join(root, 'node_modules', '@playwright', 'test', 'index.js'));
  });

  test('a node_modules folder that links elsewhere is the project’s too', () => {
    const store = project('store', ['@playwright/test'], ['@playwright/test']);
    const linked = path.join(dir, 'linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(store, 'node_modules'), path.join(linked, 'node_modules'), 'dir');
    expect(resolvePlaywrightLibrary(linked)).toBe(path.join(store, 'node_modules', '@playwright', 'test', 'index.js'));
    expect(resolvePlaywrightCli(linked)).toBe(path.join(store, 'node_modules', '@playwright', 'test', 'cli.js'));
  });

  test('a package the project’s node_modules folder links from elsewhere is the project’s too', () => {
    const store = project('package-store', ['@playwright/test', 'playwright'], ['@playwright/test', 'playwright']);
    const linked = path.join(dir, 'package-linked');
    fs.mkdirSync(path.join(linked, 'node_modules', '@playwright'), { recursive: true });
    for (const id of ['@playwright/test', 'playwright']) {
      fs.symlinkSync(path.join(store, 'node_modules', id), path.join(linked, 'node_modules', id), 'dir');
    }
    expect(resolvePlaywrightCli(linked)).toBe(path.join(store, 'node_modules', '@playwright', 'test', 'cli.js'));
    expect(resolvePlaywrightLibrary(linked)).toBe(path.join(store, 'node_modules', '@playwright', 'test', 'index.js'));
  });

  test('the real path of a linked folder, and the path as given when it does not exist', () => {
    const root = project('canonical', ['@playwright/test'], ['@playwright/test']);
    const link = path.join(dir, 'canonical-link');
    fs.symlinkSync(root, link, 'dir');
    expect(canonicalPath(link)).toBe(root);
    expect(resolvePlaywrightCli(link)).toBe(path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'));
    expect(canonicalPath(path.join(dir, 'nowhere'))).toBe(path.join(dir, 'nowhere'));
  });

  test('none without Playwright in the project, whatever a global folder holds', () => {
    const bare = project('bare', []);
    expect(resolvePlaywrightLibrary(bare)).toBeNull();
    expect(resolvePlaywrightCli(bare)).toBeNull();
  });
});
