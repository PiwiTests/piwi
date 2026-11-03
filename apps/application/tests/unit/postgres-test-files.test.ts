import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CI runs the unit tests that need a PostgreSQL server once, as `tests/unit/*-pg.test.ts` with
 * `PIWI_POSTGRES_TEST_URL` set (the E2E job of `.github/workflows/ci.yml`); every other run has no server. So only a
 * file of that name reads the URL, in any form (`process.env`, `process.env?.`, destructured, `import.meta.env`): a
 * helper module takes it as an argument.
 */
const UNIT_DIR = fileURLToPath(new URL('.', import.meta.url));
const NAME = 'PIWI_POSTGRES_TEST_URL';
/** Files that name the variable without reading it: the env var registry's test, which lists it as test-only, and this one. */
const NAME_ONLY = new Set(['piwi-env-vars.test.ts', 'postgres-test-files.test.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|mts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const naming = sourceFiles(UNIT_DIR)
  .map((path) => relative(UNIT_DIR, path).split('\\').join('/'))
  .filter((file) => readFileSync(join(UNIT_DIR, file), 'utf8').includes(NAME));

describe('the unit tests that need PostgreSQL', () => {
  test('name PIWI_POSTGRES_TEST_URL only in a *-pg.test.ts file of tests/unit, the files CI runs with a server', () => {
    const misplaced = naming.filter((file) => !NAME_ONLY.has(file) && !/^[^/]+-pg\.test\.ts$/.test(file));
    expect(misplaced).toEqual([]);
  });

  test('finds the files that read the URL', () => {
    expect(naming.filter((file) => file.endsWith('-pg.test.ts')).length).toBeGreaterThan(5);
  });
});
