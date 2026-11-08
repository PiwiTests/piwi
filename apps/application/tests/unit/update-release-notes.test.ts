import { describe, test, expect } from 'vitest';
import { parseReleaseNotes } from '#shared/changelog';
import {
  compareUrl,
  releaseNoteHtml,
  releasePageUrl,
  summarizeReleaseNotes,
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
  expect(compareUrl('0.64.0', '0.67.0')).toBe('https://github.com/PiwiTests/piwi/compare/v0.64.0...v0.67.0');
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
  expect(releasePageUrl({ ...note, url: 'javascript:alert(1)' })).toBe('https://github.com/PiwiTests/piwi/releases');
});
