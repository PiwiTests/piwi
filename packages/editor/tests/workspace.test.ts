import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { findPlaywrightRoots, playwrightConfigFile } from '../src/workspace';

let dir = '';

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-workspace-')));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the Playwright configs of a workspace', () => {
  test('are found under every name Playwright reads one from, skipping dependencies and build output', () => {
    const extensions = ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts'];
    for (const extension of extensions) {
      fs.mkdirSync(path.join(dir, extension), { recursive: true });
      fs.writeFileSync(path.join(dir, extension, `playwright.config.${extension}`), 'export default {};\n');
    }
    for (const skipped of ['node_modules/pkg', 'dist', '.cache']) {
      fs.mkdirSync(path.join(dir, skipped), { recursive: true });
      fs.writeFileSync(path.join(dir, skipped, 'playwright.config.ts'), 'export default {};\n');
    }
    expect(findPlaywrightRoots(dir).sort()).toEqual(extensions.map((e) => path.join(dir, e)).sort());
    expect(playwrightConfigFile(path.join(dir, 'mts'))).toBe(path.join(dir, 'mts', 'playwright.config.mts'));
    expect(playwrightConfigFile(path.join(dir, 'cts'))).toBe(path.join(dir, 'cts', 'playwright.config.cts'));
    expect(playwrightConfigFile(dir)).toBe(null);
  });
});
