import { describe, test, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { PROJECT_LINKS } from '#shared/piwi-ecosystem';

/**
 * Repository links are spelled `https://github.com/PiwiTests/piwi` (the root `AGENTS.md`, Documentation): every link to
 * the project's GitHub owner (a page, a raw file, the API) spells it `PiwiTests`, and its repository `piwi`, in the
 * app, the docs, the repository-level pages, the package metadata and the desktop app's updater endpoints.
 * `CHANGELOG.md` keeps the links release-please wrote, and the container image keeps its name.
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const SURFACES = [
  'apps/application/app',
  'apps/application/server',
  'apps/application/shared',
  'apps/application/scripts',
  'apps/application/tests',
  'apps/application/types',
  'apps/application/nuxt.config.ts',
  'apps/docs',
  'README.md',
  'DOCKER_HUB.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
  'package.json',
  'apps',
  'packages',
  'integrations',
  'examples',
];
/** Every file of the app and the docs; elsewhere, the package metadata and the desktop app's updater files. */
const SOURCE = /\.(?:ts|mts|mjs|js|vue|json|md|html)$/;
const METADATA = /(?:^package\.json|\.csproj|^Directory\.Build\.props|\.conf\.json|\.rs)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'cache', 'build', 'out', 'target', 'bin', 'obj', 'public']);
const OWNER_LINK = /(?:github\.com|raw\.githubusercontent\.com|api\.github\.com\/repos)\/(piwitests)\/([\w.-]+)/gi;

/** The files of a surface: the file named, or what a folder holds, its metadata alone outside the app and the docs. */
function surfaceFiles(path: string, onlyMetadata: boolean): string[] {
  const full = join(repoRoot, path);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      const skipped = SKIPPED_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.vitepress');
      return skipped ? [] : surfaceFiles(join(path, entry.name), onlyMetadata);
    }
    const kept = onlyMetadata ? METADATA.test(entry.name) : SOURCE.test(entry.name);
    return kept && entry.name !== 'CHANGELOG.md' ? [join(full, entry.name)] : [];
  });
}

describe('repository links', () => {
  const files = [
    ...new Set(
      SURFACES.flatMap((path) => surfaceFiles(path, !path.startsWith('apps/application') && path !== 'apps/docs')),
    ),
  ];
  const rel = (file: string) => relative(repoRoot, file).replaceAll('\\', '/');

  test('the shared repository link is the canonical one', () => {
    expect(PROJECT_LINKS.repository).toBe('https://github.com/PiwiTests/piwi');
  });

  test('scans every surface', () => {
    const scanned = files.map(rel);
    expect(scanned.filter((file) => file.startsWith('apps/application/')).length).toBeGreaterThan(500);
    expect(scanned.filter((file) => file.startsWith('apps/docs/')).length).toBeGreaterThan(100);
    expect(scanned).toEqual(
      expect.arrayContaining([
        'README.md',
        'packages/reporter/package.json',
        'apps/desktop/src-tauri/tauri.updater.conf.json',
        'integrations/serilog/PiwiTests.Instrumentation.Serilog/PiwiTests.Instrumentation.Serilog.csproj',
      ]),
    );
  });

  test("every link to the project's GitHub owner spells it PiwiTests, and its repository piwi", () => {
    const misspelled = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(OWNER_LINK)]
        .filter(
          ([, owner, repository]) => owner !== 'PiwiTests' || (/^piwi$/i.test(repository!) && repository !== 'piwi'),
        )
        .map(([link]) => `${rel(file)}: ${link}`),
    );
    expect(misspelled, 'Spell repository links https://github.com/PiwiTests/piwi').toEqual([]);
  });
});
