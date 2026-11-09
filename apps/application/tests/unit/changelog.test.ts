import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  changelogSectionKind,
  cleanChangelogEntry,
  parseChangelog,
  parseReleaseNotes,
  splitEntryScope,
} from '#shared/changelog';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('cleanChangelogEntry', () => {
  test('drops commit, pull-request and closes links', () => {
    expect(
      cleanChangelogEntry(
        '**app:** add a thing ([c44db96](https://x/commit/c44db96)), closes [#581](https://x/issues/581)',
      ),
    ).toBe('**app:** add a thing');
    expect(cleanChangelogEntry('audit ([#200](https://x/pull/200)), warmup ([#203](https://x/pull/203))')).toBe(
      'audit, warmup',
    );
  });
});

describe('changelogSectionKind', () => {
  test.each([
    ['Features', 'features'],
    ['Improvements', 'features'],
    ['Bug Fixes', 'fixes'],
    ['Improvements & fixes', 'fixes'],
    ['⚠ BREAKING CHANGES', 'breaking'],
    ['✨ Highlights', 'highlights'],
    ['Performance Improvements', 'performance'],
    ['Reverts', 'other'],
  ])('%s → %s', (heading, kind) => {
    expect(changelogSectionKind(heading)).toBe(kind);
  });
});

describe('parseChangelog', () => {
  test('collapses the repeats release-please writes for squash and cherry-pick', () => {
    const [release] = parseChangelog(
      [
        '## [1.2.0](https://x/compare/v1.1.0...v1.2.0) (2026-09-22)',
        '',
        '### Features',
        '',
        '* **app:** add a thing ([aaaaaaa](https://x/commit/aaaaaaa))',
        '* **app:** add a thing ([bbbbbbb](https://x/commit/bbbbbbb)), closes [#1](https://x/issues/1)',
        '',
        '### Bug Fixes',
        '',
        '* **ui:** fix a thing ([ccccccc](https://x/commit/ccccccc))',
      ].join('\n'),
    );
    expect(release).toMatchObject({ version: '1.2.0', from: '1.2.0', to: '1.2.0', date: '2026-09-22', intro: null });
    expect(release!.entries.features).toEqual(['**app:** add a thing']);
    expect(release!.entries.fixes).toEqual(['**ui:** fix a thing']);
  });

  test('reads polished notes: intro, highlights and grouped `-` bullets', () => {
    const [release] = parseChangelog(
      [
        '## [1.3.0](https://x/compare/v1.2.0...v1.3.0) (2026-09-23)',
        '',
        'This release adds a dashboard.',
        '',
        '**Full diff:** [v1.2.0…v1.3.0](https://x)',
        '',
        '### ✨ Highlights',
        '',
        '- **📊 Dashboard** — tracks growth.',
        '',
        '### Features',
        '',
        '#### Storage',
        '- **admin:** a dashboard ([aaaaaaa](https://x/commit/aaaaaaa), [bbbbbbb](https://x/commit/bbbbbbb))',
        '',
        '<!-- notes:polished -->',
      ].join('\n'),
    );
    expect(release!.intro).toBe('This release adds a dashboard.');
    expect(release!.entries.highlights).toEqual(['**📊 Dashboard** — tracks growth.']);
    expect(release!.entries.features).toEqual(['**admin:** a dashboard']);
  });

  test('reads a backfilled span and its unsectioned bullets', () => {
    const [release] = parseChangelog(
      ['## [0.1.0 – 0.2.1](https://x/compare) (2026-04-26 – 2026-06-22)', '', '* multi-report support'].join('\n'),
    );
    expect(release).toMatchObject({ from: '0.1.0', to: '0.2.1', date: '2026-04-26 – 2026-06-22' });
    expect(release!.entries.features).toEqual(['multi-report support']);
  });

  test('the repository changelog parses, newest release first, matching the app version', () => {
    const releases = parseChangelog(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'));
    const appVersion = JSON.parse(readFileSync(join(repoRoot, 'apps/application/package.json'), 'utf8')).version;
    expect(releases.length).toBeGreaterThan(10);
    expect(releases[0]!.to).toBe(appVersion);
    for (const release of releases) {
      const entries = Object.values(release.entries).flat();
      expect(entries.length > 0 || release.intro !== null, release.version).toBe(true);
      expect(
        entries.some((e) => /\]\(https?:[^)]*\/commit\//.test(e)),
        release.version,
      ).toBe(false);
    }
  });
});

const RELEASE = {
  version: '0.67.0',
  date: '2026-11-05T10:12:00Z',
  url: 'https://github.com/PiwiTests/piwi/releases/tag/v0.67.0',
};

describe('parseReleaseNotes', () => {
  test('reads a raw release body: breaking changes, repeats and closes links', () => {
    const release = parseReleaseNotes({
      ...RELEASE,
      body: [
        '### ⚠ BREAKING CHANGES',
        '',
        "* **app:** the run insights endpoint's `workerImbalance` entries are `{ worker, count }`",
        '',
        '### Features',
        '',
        '* **reporter:** add piwi rerun ([7a1ebeb](https://github.com/PiwiTests/piwi/commit/7a1ebeb))',
        '* **reporter:** add piwi rerun ([b18500d](https://github.com/PiwiTests/piwi/commit/b18500d)), closes [#1083](https://github.com/PiwiTests/piwi/issues/1083)',
        '',
        '',
        '### Bug Fixes',
        '',
        '* **app:** keep a reported history ([da47453](https://github.com/PiwiTests/piwi/commit/da47453))',
      ].join('\r\n'),
    });
    expect(release).toMatchObject({ version: '0.67.0', date: '2026-11-05', url: RELEASE.url, intro: null });
    expect(release.entries.breaking).toEqual([
      "**app:** the run insights endpoint's `workerImbalance` entries are `{ worker, count }`",
    ]);
    expect(release.entries.features).toEqual(['**reporter:** add piwi rerun']);
    expect(release.entries.fixes).toEqual(['**app:** keep a reported history']);
  });

  test('reads a polished release body, its headings one level up', () => {
    const release = parseReleaseNotes({
      ...RELEASE,
      body: [
        'This release adds test selections and reads impact from a diff.',
        '',
        '**Full diff:** [v0.66.0…v0.67.0](https://github.com/PiwiTests/piwi/compare/v0.66.0...v0.67.0)',
        '',
        '## ✨ Highlights',
        '',
        '- **🎯 Test selections** — Save a set of tests and run it again.',
        '',
        '## Features',
        '',
        '### Selections',
        '',
        '- **app:** save a test selection ([4c6fc6d](https://github.com/PiwiTests/piwi/commit/4c6fc6d))',
        '',
        '<details>',
        '<summary>Everything else</summary>',
        '',
        '- **ui:** tidy the run header',
        '',
        '</details>',
        '',
        '## Bug Fixes',
        '',
        '- **app:** keep the filter',
        '',
        '<!-- notes:polished -->',
      ].join('\n'),
    });
    expect(release.intro).toBe('This release adds test selections and reads impact from a diff.');
    expect(release.entries.highlights).toEqual(['**🎯 Test selections** — Save a set of tests and run it again.']);
    expect(release.entries.features).toEqual(['**app:** save a test selection', '**ui:** tidy the run header']);
    expect(release.entries.fixes).toEqual(['**app:** keep the filter']);
  });

  test('leaves a heading inside a code block alone', () => {
    const release = parseReleaseNotes({
      ...RELEASE,
      body: ['## Features', '', '- **app:** a feature', '', '```md', '## Not a section', '```'].join('\n'),
    });
    expect(release.entries.features).toEqual(['**app:** a feature']);
    expect(release.entries.other).toEqual([]);
  });

  test('reads an empty body as a release with nothing in it', () => {
    const release = parseReleaseNotes({ ...RELEASE, date: null, body: '' });
    expect(release).toMatchObject({ version: '0.67.0', date: null, intro: null });
    expect(Object.values(release.entries).flat()).toEqual([]);
  });
});

describe('splitEntryScope', () => {
  test("separates a raw entry's scope from its sentence", () => {
    expect(splitEntryScope('**app:** add **bold** words')).toEqual({ scope: 'app', text: 'add **bold** words' });
  });

  test('leaves an entry without a scope whole', () => {
    expect(splitEntryScope('**🎯 Test selections** — Save a set')).toEqual({
      scope: null,
      text: '**🎯 Test selections** — Save a set',
    });
  });
});
