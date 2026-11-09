import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, TEST_PROJECT_NAMES } from '#shared/test-project-names';

/**
 * The cleanup endpoint deletes every project whose name the registry holds, before and after the E2E suite, on the
 * server it runs against: a local dev database or the desktop app's data folder as well as CI's.
 */
const TESTS_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPORTER_ENV = fileURLToPath(
  new URL('../../../../packages/reporter/src/internal/config/env.ts', import.meta.url),
);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(path);
    return /\.(ts|mts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('the test project names', () => {
  test('are each used by a test, so the cleanup deletes no name nothing creates', () => {
    const sources = testFiles(TESTS_DIR)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const unused = Object.keys(PROJECT).filter((key) => !new RegExp(`\\bPROJECT\\.${key}\\b`).test(sources));
    expect(unused).toEqual([]);
  });

  test("hold neither the reporter's default project name, which a real project carries, nor a name twice", () => {
    const defaultName = readFileSync(REPORTER_ENV, 'utf8').match(/const DEFAULTS[^{]*\{\s*projectName: '([^']+)'/)?.[1];
    expect(defaultName).toBeTruthy();
    expect(TEST_PROJECT_NAMES).not.toContain(defaultName);
    expect(new Set(TEST_PROJECT_NAMES).size).toBe(TEST_PROJECT_NAMES.length);
  });
});
