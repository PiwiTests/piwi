import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CI runs the unit tests that need a PostgreSQL server once, as `tests/unit/*-pg.test.ts` with
 * `PIWI_POSTGRES_TEST_URL` set (the E2E job of `.github/workflows/ci.yml`); every other run has no server. So only a
 * file of that name reads the URL: a helper module takes it as an argument.
 */
const UNIT_DIR = fileURLToPath(new URL('.', import.meta.url));
const READS_URL = /process\.env(?:\.PIWI_POSTGRES_TEST_URL\b|\[\s*['"`]PIWI_POSTGRES_TEST_URL['"`]\s*\])/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|mts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('the unit tests that need PostgreSQL', () => {
  test('read PIWI_POSTGRES_TEST_URL only in a *-pg.test.ts file of tests/unit, the files CI runs with a server', () => {
    const misplaced = sourceFiles(UNIT_DIR)
      .map((path) => relative(UNIT_DIR, path).split('\\').join('/'))
      .filter((file) => READS_URL.test(readFileSync(join(UNIT_DIR, file), 'utf8')))
      .filter((file) => !/^[^/]+-pg\.test\.ts$/.test(file));
    expect(misplaced).toEqual([]);
  });

  test('finds the files that read the URL', () => {
    const readers = sourceFiles(UNIT_DIR).filter((path) => READS_URL.test(readFileSync(path, 'utf8')));
    expect(readers.length).toBeGreaterThan(5);
  });
});
