import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  clipDescription,
  openingParagraph,
  pageDescription,
  pageUrl,
  toPlainText,
} from '../../../docs/.vitepress/page-meta.mts';

// The agent guide of a directory and the file that loads it for Claude Code: not docs pages.
const AGENT_GUIDES = ['AGENTS.md', 'CLAUDE.md'];

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');

describe('openingParagraph', () => {
  test('skips the frontmatter, headings, components, code and containers', () => {
    const markdown = [
      '---',
      'title: Flaky tests',
      '---',
      '',
      '<script setup>',
      "import { data } from './posts.data'",
      '',
      '</script>',
      '',
      '# Flaky tests',
      '',
      '<Needs reporter />',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '::: tip',
      'Inside a container.',
      ':::',
      '',
      '| a | b |',
      '',
      'A single run tells you what failed.',
      'A few dozen runs tell you what is unreliable.',
      '',
      'The second paragraph.',
    ].join('\n');
    expect(openingParagraph(markdown)).toBe(
      'A single run tells you what failed. A few dozen runs tell you what is unreliable.',
    );
  });

  test('is empty when the page has no prose', () => {
    expect(openingParagraph('# Title\n\n```bash\nnpm i\n```\n')).toBe('');
  });
});

describe('toPlainText', () => {
  test('keeps the text of links, emphasis and code, including markup inside code', () => {
    expect(toPlainText('The **fix plan** for [a cluster](./x), not a `<select>` or *other* thing.')).toBe(
      'The fix plan for a cluster, not a <select> or other thing.',
    );
  });

  test('drops images and HTML tags', () => {
    expect(toPlainText('![shot](/a.png) Plain <kbd>text</kbd>')).toBe('Plain text');
  });
});

describe('clipDescription', () => {
  test('keeps whole sentences up to the limit', () => {
    const first = 'A'.repeat(120) + '.';
    const second = 'B'.repeat(120) + '.';
    expect(clipDescription(`${first} ${second}`)).toBe(first);
  });

  test('does not split on a period inside a word or version', () => {
    expect(clipDescription('Piwi is pre-1.0. Deploy it on Fly.io.')).toBe('Piwi is pre-1.0. Deploy it on Fly.io.');
  });

  test('cuts an over-long first sentence at a word', () => {
    const clipped = clipDescription('word '.repeat(60));
    expect(clipped.length).toBeLessThanOrEqual(200);
    expect(clipped.endsWith('word…')).toBe(true);
  });

  test('ends a paragraph that leads into a list with a period', () => {
    expect(clipDescription('It opens one of four things:')).toBe('It opens one of four things.');
  });
});

describe('pageDescription', () => {
  test('prefers the frontmatter description, then the excerpt', () => {
    expect(pageDescription({ description: 'Written.', excerpt: 'Excerpt.' }, 'Opening.')).toBe('Written.');
    expect(pageDescription({ excerpt: 'Excerpt.' }, 'Opening.')).toBe('Excerpt.');
    expect(pageDescription({}, 'Opening.')).toBe('Opening.');
  });
});

describe('pageUrl', () => {
  test('maps a source path to the URL the sitemap lists', () => {
    expect(pageUrl('https://x.dev', 'index.md', false)).toBe('https://x.dev/');
    expect(pageUrl('https://x.dev', 'blog/index.md', false)).toBe('https://x.dev/blog/');
    expect(pageUrl('https://x.dev', 'guide/ci.md', false)).toBe('https://x.dev/guide/ci.html');
    expect(pageUrl('https://x.dev', 'guide/ci.md', true)).toBe('https://x.dev/guide/ci');
  });
});

describe('every docs page', () => {
  const pages = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.md') && !AGENT_GUIDES.includes(entry.name) ? [path] : [];
    });
  })(docsRoot);

  // The single-line `key: value` form every page's frontmatter uses.
  const frontmatter = (markdown: string) => {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? '';
    return Object.fromEntries(
      [...block.matchAll(/^(\w+):\s*(.*)$/gm)].map(([, key, value]) => [key, value.replace(/^(['"])(.*)\1$/, '$2')]),
    );
  };

  test.each(pages.map((path) => relative(docsRoot, path)))('%s has a search description', (page) => {
    const markdown = readFileSync(join(docsRoot, page), 'utf8');
    const fields = frontmatter(markdown);
    // The landing page uses the site-wide description.
    if (fields.layout === 'home') return;
    const description = pageDescription(fields, markdown);
    expect(
      description.length,
      `${page} opens with "${description}" — give it a frontmatter description (apps/docs/AGENTS.md)`,
    ).toBeGreaterThanOrEqual(50);
  });
});
