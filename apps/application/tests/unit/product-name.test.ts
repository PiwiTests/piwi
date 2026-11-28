import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The product is called Piwi. "Piwi Dashboard" stays only where something matches on it: the reporter's
 * `[Piwi Dashboard]` log prefix, which its readers and docs quote, and the names below.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** What people read: the dashboard, the docs site, the reporter's own words, the packages and the landing pages. */
const SCANNED = [
  'apps/application/app',
  'apps/application/server',
  'apps/application/shared',
  'apps/application/nuxt.config.ts',
  'apps/docs',
  'packages/reporter/README.md',
  'packages/reporter/src',
  'packages/reporter/templates',
  'packages/server',
  'packages/core',
  'integrations',
  'README.md',
  'DOCKER_HUB.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
  'docker-compose.yml',
];

/** The other mentions that stay, each by the text around it. */
const KEPT = [
  // The folder releases before the rename installed the desktop app in.
  { file: 'apps/docs/operate/upgrading.md', text: '%LOCALAPPDATA%\\Piwi Dashboard' },
  // The name search engines may still know the project by.
  { file: 'apps/docs/.vitepress/config.mts', text: "alternateName: ['Piwi Dashboard'" },
];

const files = execFileSync('git', ['ls-files', '-z', '--', ...SCANNED], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && !/\.(png|jpe?g|gif|webp|ico|mp4|webm|zip|woff2?|ttf)$/.test(file));

describe('the product name', () => {
  test('is Piwi wherever people read it', () => {
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      let text = readFileSync(join(repoRoot, file), 'utf8').replaceAll('[Piwi Dashboard]', '');
      for (const kept of KEPT) if (kept.file === file) text = text.replaceAll(kept.text, '');
      text.split('\n').forEach((line, index) => {
        if (line.includes('Piwi Dashboard')) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found, 'say Piwi, or add the mention to KEPT when something matches on it').toEqual([]);
  });

  test('keeps only mentions that are still there', () => {
    for (const kept of KEPT) {
      expect(readFileSync(join(repoRoot, kept.file), 'utf8'), kept.file).toContain(kept.text);
    }
  });
});
