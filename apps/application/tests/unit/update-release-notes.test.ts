import { describe, test, expect } from 'vitest';
import { changelogPage, parseChangelog, parseReleaseNotes } from '#shared/changelog';
import { PROJECT_LINKS } from '#shared/piwi-ecosystem';
import {
  changelogReleaseItem,
  compareUrl,
  formatReleaseDate,
  releaseNoteHtml,
  releasePageUrl,
  summarizeReleaseNotes,
  updateReleaseItem,
} from '../../app/utils/update-release-notes';

const release = (version: string, body: string) =>
  parseReleaseNotes({ version, date: null, url: `https://github.com/PiwiTests/piwi/releases/tag/v${version}`, body });

describe('summarizeReleaseNotes', () => {
  test("gathers every release's breaking changes with their version, newest first", () => {
    const summary = summarizeReleaseNotes([
      release('0.67.0', '### ⚠ BREAKING CHANGES\n\n* **app:** rename a field\n\n### Features\n\n* **app:** add a\n'),
      release('0.66.0', '### Features\n\n* **app:** add b\n'),
      release('0.65.0', '### ⚠ BREAKING CHANGES\n\n* **reporter:** drop an option\n* **app:** move a route\n'),
    ]);
    expect(summary.count).toBe(3);
    expect(summary.breaking).toEqual([
      { version: '0.67.0', text: '**app:** rename a field' },
      { version: '0.65.0', text: '**reporter:** drop an option' },
      { version: '0.65.0', text: '**app:** move a route' },
    ]);
  });

  test('previews up to three highlight titles of the newest release that has some', () => {
    const summary = summarizeReleaseNotes([
      release('0.67.0', '### Features\n\n* **app:** add a\n'),
      release(
        '0.66.0',
        [
          'Intro.',
          '',
          '## ✨ Highlights',
          '',
          '- **🌿 Branches** — Branch as a dimension.',
          '- **🎯 Test selections** — Save a set.',
          '- **🔍 Impact** — From a diff.',
          '- **🧩 Editors** — More.',
        ].join('\n'),
      ),
    ]);
    expect(summary.preview).toEqual(['🌿 Branches', '🎯 Test selections', '🔍 Impact']);
  });

  test("previews the newest release's intro when no release has highlights", () => {
    const summary = summarizeReleaseNotes([
      release('0.67.0', 'This release adds selections.\n\n## Features\n\n- **app:** add a\n'),
    ]);
    expect(summary.preview).toEqual(['This release adds selections.']);
  });

  test("previews the newest release's first three features, without their scope, otherwise", () => {
    const summary = summarizeReleaseNotes([
      release('0.67.0', '### Features\n\n* **app:** add a\n* **ui:** add `b`\n* add c\n* **app:** add d\n'),
    ]);
    expect(summary.preview).toEqual(['add a', 'add `b`', 'add c']);
  });

  test('summarizes no release as nothing to preview', () => {
    expect(summarizeReleaseNotes([])).toEqual({ count: 0, breaking: [], preview: [] });
  });
});

test('compareUrl compares the two version tags', () => {
  expect(compareUrl('0.64.0', '0.67.0')).toBe('https://github.com/piwitests/piwi/compare/v0.64.0...v0.67.0');
});

describe('releaseNoteHtml', () => {
  test("escapes HTML and draws links in the sentence's color", () => {
    const html = releaseNoteHtml('<img src=x onerror=alert(1)> see [the docs](https://piwitests.dev)');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('href="https://piwitests.dev"');
    expect(html).toContain('decoration-dotted');
    expect(html).not.toContain('text-primary');
  });

  test('leaves a script link as text', () => {
    expect(releaseNoteHtml('[x](javascript:alert(1))')).not.toContain('<a');
  });
});

test('releasePageUrl keeps an http(s) release page, else points at the releases page', () => {
  const note = { version: '1.0.0', date: null, body: '' };
  expect(releasePageUrl({ ...note, url: 'https://github.com/PiwiTests/piwi/releases/tag/v1.0.0' })).toBe(
    'https://github.com/PiwiTests/piwi/releases/tag/v1.0.0',
  );
  expect(releasePageUrl({ ...note, url: 'javascript:alert(1)' })).toBe('https://github.com/piwitests/piwi/releases');
});

describe('release items', () => {
  test('an update release keeps its version as key, and the releases page for a URL that is not http(s)', () => {
    const item = updateReleaseItem({
      version: '0.67.0',
      date: '2026-11-05T10:00:00Z',
      url: 'javascript:alert(1)',
      body: '',
    });
    expect(item).toMatchObject({ key: '0.67.0', label: 'v0.67.0', date: '2026-11-05T10:00:00Z' });
    expect(item.pageUrl).toBe(PROJECT_LINKS.releases);
  });

  test("a changelog release marks the running version's release, a grouped one keeps its span as label", () => {
    const { releases } = changelogPage(
      parseChangelog(
        [
          '## [0.36.0](https://x/compare) (2026-09-22)\n\n* **app:** add a\n',
          '## [0.4.0 – 0.4.4](https://github.com/PiwiTests/platform/compare/v0.3.0...v0.4.4) (2026-06-23 – 2026-06-28)\n\n* add b\n',
        ].join('\n'),
      ),
      { runningVersion: '0.4.2' },
    );
    const [newest, grouped] = releases.map((release) => changelogReleaseItem(release, '0.4.2'));
    expect(newest).toMatchObject({ key: '0.36.0', label: 'v0.36.0', date: '2026-09-22', current: false });
    expect(newest!.pageUrl).toBe(`${PROJECT_LINKS.releases}/tag/v0.36.0`);
    expect(grouped).toMatchObject({
      key: '0.4.4',
      label: '0.4.0 – 0.4.4',
      date: '2026-06-23 – 2026-06-28',
      current: true,
    });
    expect(changelogReleaseItem(releases[0]!, '').current).toBe(false);
  });
});

describe('formatReleaseDate', () => {
  test('reads a day as the calendar day it names, whatever the time zone', () => {
    expect(formatReleaseDate('2026-11-15', 'en-US')).toBe('11/15/2026');
    expect(formatReleaseDate('2026-11-15', 'fr-FR')).toBe('15/11/2026');
    const zone = process.env.TZ;
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Auckland', 'Pacific/Pago_Pago']) {
      process.env.TZ = tz;
      expect(formatReleaseDate('2026-11-15', 'en-US'), tz).toBe('11/15/2026');
    }
    process.env.TZ = zone;
  });

  test('formats each end of a span, a month as a month, and leaves another shape as written', () => {
    expect(formatReleaseDate('2026-06-23 – 2026-06-28', 'en-US')).toBe('6/23/2026 – 6/28/2026');
    expect(formatReleaseDate('2025-12 – 2026-04', 'en-US')).toBe('12/2025 – 4/2026');
    expect(formatReleaseDate('soon', 'en-US')).toBe('soon');
  });
});
