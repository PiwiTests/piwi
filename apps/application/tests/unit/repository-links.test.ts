import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { PROJECT_LINKS } from '#shared/piwi-ecosystem';

/**
 * Repository links are spelled `https://github.com/PiwiTests/piwi` (the root `AGENTS.md`, Documentation): every link
 * to the project's GitHub owner in the app's sources spells it `PiwiTests`.
 */

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_ROOTS = ['app', 'server', 'shared', 'scripts', 'tests', 'types', 'nuxt.config.ts'];
const SOURCE = /\.(?:ts|mts|mjs|js|vue|json|md|html)$/;
const SKIPPED_DIRS = new Set(['node_modules']);
const CANONICAL_OWNER = 'PiwiTests';
const OWNER_LINK = /github\.com\/(piwitests)\b/gi;

function sourceFiles(path: string): string[] {
  const full = join(APP_ROOT, path);
  if (SOURCE.test(path)) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(join(path, entry.name));
    return SOURCE.test(entry.name) ? [join(full, entry.name)] : [];
  });
}

describe('repository links', () => {
  const files = SCAN_ROOTS.flatMap(sourceFiles);

  test('the shared repository link is the canonical one', () => {
    expect(PROJECT_LINKS.repository).toBe('https://github.com/PiwiTests/piwi');
  });

  test('scans the app sources', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  test("every link to the project's GitHub owner spells it PiwiTests", () => {
    const misspelled = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(OWNER_LINK)]
        .filter((match) => match[1] !== CANONICAL_OWNER)
        .map((match) => `${relative(APP_ROOT, file).replaceAll('\\', '/')}: ${match[0]}`),
    );
    expect(misspelled, 'Spell repository links https://github.com/PiwiTests/piwi').toEqual([]);
  });
});
