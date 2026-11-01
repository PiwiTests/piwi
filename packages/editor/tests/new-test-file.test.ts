import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { configTestDir, newTestFile } from '../src/new-test-file';

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

  test('reads the config’s testDir when Playwright did not say it', () => {
    expect(configTestDir(path.join(root, 'playwright.config.ts'))).toBe(path.join(root, 'e2e'));
    expect(at(null, [])).toEqual({ folder: path.join(root, 'e2e'), name: 'recorded-2.test.ts' });
  });
});
