import { test, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative, sep } from 'node:path';

// `.claude/skills/playwright-cli/` is a copy of the skill Playwright ships for `npx playwright cli`, whose commands
// come from the installed Playwright. The copy matches the installed one, but for the lines in LOCAL_EDITS.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const committedDir = join(repoRoot, '.claude', 'skills', 'playwright-cli');

/** The `playwright-core` that `npx playwright` loads: `@playwright/test` → `playwright` → `playwright-core`. */
function playwrightCoreDir(): string {
  const testPackage = createRequire(import.meta.url).resolve('@playwright/test/package.json');
  const playwrightPackage = createRequire(testPackage).resolve('playwright/package.json');
  return dirname(createRequire(playwrightPackage).resolve('playwright-core/package.json'));
}

const coreDir = playwrightCoreDir();
const shippedDir = join(coreDir, 'lib', 'tools', 'skills', 'playwright-cli');
const coreVersion: string = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8')).version;

/** The repository's own edits to the copy, by file: each shipped line and the line the copy has instead. */
const LOCAL_EDITS: Record<string, Array<{ shipped: string; committed: string }>> = {
  // The dashboard's dev server port.
  'references/pr-attachments.md': [
    {
      shipped: 'playwright-cli open http://localhost:3000/settings',
      committed: 'playwright-cli open http://localhost:7494/settings',
    },
  ],
};

/** Every file under `dir`, as a `/`-separated path from it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join(posix.sep))
    .sort();
}

/** The shipped file as the copy should hold it: with the local edits applied. */
function expectedCopy(file: string): string {
  let text = readFileSync(join(shippedDir, file), 'utf8');
  for (const { shipped, committed } of LOCAL_EDITS[file] ?? []) text = text.replace(shipped, committed);
  return text;
}

test('finds both copies of the skill', () => {
  expect(filesUnder(shippedDir)).toContain('SKILL.md');
  expect(filesUnder(committedDir)).toContain('SKILL.md');
});

test('the committed playwright-cli skill matches the one the installed Playwright ships', () => {
  const shipped = filesUnder(shippedDir);
  const committed = filesUnder(committedDir);
  const drift = [...new Set([...shipped, ...committed])].sort().flatMap((file) => {
    if (!committed.includes(file)) return [`${file}: copy it over`];
    if (!shipped.includes(file)) return [`${file}: delete it, Playwright does not ship it`];
    if (readFileSync(join(committedDir, file), 'utf8') !== expectedCopy(file)) {
      return [`${file}: copy it over${LOCAL_EDITS[file] ? ', then redo its edits from LOCAL_EDITS' : ''}`];
    }
    return [];
  });
  expect(
    drift,
    `.claude/skills/playwright-cli/ differs from the skill playwright-core ${coreVersion} ships in ${relative(repoRoot, shippedDir)}`,
  ).toEqual([]);
});
