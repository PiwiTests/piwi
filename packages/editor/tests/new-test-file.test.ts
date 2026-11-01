import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { configTestDirs, newTestFile } from '../src/new-test-file';

let root: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-new-test-file-')));
  const write = (file: string, text = '') => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('playwright.config.ts', "export default defineConfig({ testDir: './e2e' });");
  write('e2e/cart/cart.test.ts');
  write('e2e/checkout.test.ts');
  write('e2e/recorded.test.ts');
  write('src/app.ts');
  write('tests-examples/demo-todo-app.spec.ts');
  write(
    'projects/playwright.config.ts',
    [
      "// testDir: './commented',",
      '/* testDir: "./also-commented" */',
      "export default defineConfig({ use: { baseURL: 'http://localhost:3000' }, projects: [",
      "  { name: 'api', testDir: './api' },",
      "  { name: 'ui', testDir: './ui' },",
      "  { name: 'ui-admin', testDir: './ui/admin' },",
      "  { name: 'built', testDir: `${__dirname}/built` },",
      ']});',
    ].join('\n'),
  );
  write('projects/ui/pages/cart.page.ts');
  write('projects/ui/admin/users.spec.ts');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const at = (file: string | null, testDirs: string[] = [path.join(root, 'e2e')]) =>
  newTestFile({
    at: file === null ? null : path.join(root, file),
    root,
    configFile: path.join(root, 'playwright.config.ts'),
    testDirs,
  });

describe('where Record a new test file creates its spec', () => {
  test('in the test folder, with the suffix its specs use, under a name it does not hold', () => {
    expect(at(null)).toEqual({ folder: path.join(root, 'e2e'), name: 'recorded-2.test.ts' });
    // The project root, or a file outside the test folder, at hand: the same.
    expect(at('.')).toEqual({ folder: path.join(root, 'e2e'), name: 'recorded-2.test.ts' });
    expect(at('src/app.ts')).toEqual({ folder: path.join(root, 'e2e'), name: 'recorded-2.test.ts' });
  });

  test('beside the spec at hand, and in a subfolder of the test folder at hand', () => {
    expect(at('e2e/cart/cart.test.ts')).toEqual({ folder: path.join(root, 'e2e/cart'), name: 'recorded.test.ts' });
    expect(at('e2e/cart')).toEqual({ folder: path.join(root, 'e2e/cart'), name: 'recorded.test.ts' });
  });

  test('never beside a spec no test folder holds', () => {
    expect(at('tests-examples/demo-todo-app.spec.ts')).toEqual({
      folder: path.join(root, 'e2e'),
      name: 'recorded-2.test.ts',
    });
    expect(at('tests-examples')).toEqual({ folder: path.join(root, 'e2e'), name: 'recorded-2.test.ts' });
  });

  test('reads the config’s test folders when Playwright did not say them, outside comments', () => {
    expect(configTestDirs(path.join(root, 'playwright.config.ts'))).toEqual([path.join(root, 'e2e')]);
    expect(at(null, [])).toEqual({ folder: path.join(root, 'e2e'), name: 'recorded-2.test.ts' });
    const projects = path.join(root, 'projects');
    expect(configTestDirs(path.join(projects, 'playwright.config.ts'))).toEqual([
      path.join(projects, 'api'),
      path.join(projects, 'ui'),
      path.join(projects, 'ui/admin'),
    ]);
  });

  test('takes the deepest test folder holding the file at hand', () => {
    const projects = path.join(root, 'projects');
    const place = (file: string) =>
      newTestFile({
        at: path.join(projects, file),
        root: projects,
        configFile: path.join(projects, 'playwright.config.ts'),
        testDirs: [],
      });
    expect(place('ui/pages/cart.page.ts')).toEqual({ folder: path.join(projects, 'ui'), name: 'recorded.spec.ts' });
    expect(place('ui/admin/users.spec.ts')).toEqual({
      folder: path.join(projects, 'ui/admin'),
      name: 'recorded.spec.ts',
    });
  });

  test('names the folder as the editor does when the project is opened through a link', () => {
    const link = `${root}-link`;
    fs.symlinkSync(root, link);
    try {
      expect(
        newTestFile({
          at: path.join(link, 'e2e/cart'),
          root: link,
          configFile: path.join(link, 'playwright.config.ts'),
          testDirs: [path.join(root, 'e2e')],
        }),
      ).toEqual({ folder: path.join(link, 'e2e/cart'), name: 'recorded.test.ts' });
    } finally {
      fs.rmSync(link);
    }
  });
});
