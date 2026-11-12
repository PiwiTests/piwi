import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import {
  buildDocsCorpus,
  docsMarkdown,
  docsPageUrl,
  docsSectionItems,
  findDocsPage,
  parseDocsRef,
  parseHeadingText,
  plainText,
  queryTerms,
  searchDocs,
  slugifyHeading,
} from '#shared/docs-corpus';
import { QUOTED_DOCS_SECTIONS } from '#shared/piwi-ecosystem';
import { GENERATED_DOCS_PAGES } from '#shared/docs-generated-pages';

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');

/** The docs tree as the server bundles it: every file, keyed by its path relative to apps/docs. */
function docsFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'public') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(docsRoot, path)] = readFileSync(path, 'utf8');
    }
  })(docsRoot);
  return files;
}

const corpus = buildDocsCorpus(docsFiles());

describe('slugifyHeading', () => {
  test.each([
    ["What it isn't", 'what-it-isn-t'],
    ['Backup & restore', 'backup-restore'],
    ['Why Piwi? (comparison & FAQ)', 'why-piwi-comparison-faq'],
    ['PIWI_API_KEY', 'piwi-api-key'],
    ['3 steps', '_3-steps'],
    ['Café crème', 'cafe-creme'],
  ])('%s → %s', (heading, anchor) => {
    expect(slugifyHeading(heading)).toBe(anchor);
  });

  test('a heading keeps the text of its code spans and links, and its explicit anchor', () => {
    expect(parseHeadingText('`select` / `run` {#select-run}')).toEqual({
      text: 'select / run',
      explicitAnchor: 'select-run',
    });
    expect(parseHeadingText('The [reporter](/guide/reporter) <Badge text="new" />').text).toBe('The reporter');
  });
});

describe('buildDocsCorpus', () => {
  test('parses every hand-written page, and leaves out the blog, agent guides and generated pages', () => {
    const paths = corpus.pages.map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining(['index', 'guide/reporter', 'operate/deployment', 'recipes/mass-failure']),
    );
    expect(paths.some((p) => p.startsWith('blog/'))).toBe(false);
    expect(paths).not.toContain('AGENTS');
    for (const generated of Object.keys(GENERATED_DOCS_PAGES)) expect(paths).not.toContain(generated);
  });

  test.each(corpus.pages.map((p) => [p.path, p] as const))('%s has a title and a summary', (_path, page) => {
    expect(page.title).not.toBe('');
    expect(page.summary.length).toBeGreaterThan(20);
  });

  test('renders snippet includes and components as text', () => {
    for (const page of corpus.pages) {
      const markdown = docsMarkdown(page);
      expect(markdown, page.path).not.toMatch(/^\s*<<<\s+@\//m);
      // Inline code may name a tag (`<div>`); only markup outside it counts.
      expect(markdown.replace(/`[^`\n]*`/g, ''), page.path).not.toMatch(
        /<Needs\b|<DemoExamples\b|<DownloadApps\b|<div\b|<figure\b|<img\b/,
      );
    }
    expect(docsMarkdown(findDocsPage(corpus, 'operate/deployment')!)).toContain('docker run');
    expect(docsMarkdown(findDocsPage(corpus, 'features/mcp')!)).toMatch(/^\*\*Needs:\*\* the reporter$/m);
    expect(docsMarkdown(findDocsPage(corpus, 'features/ai-diagnosis')!)).toContain(
      '](https://piwitests.dev/demo/failure-clusters/10): ',
    );
    const started = docsMarkdown(findDocsPage(corpus, 'guide/getting-started')!);
    expect(started).toMatch(
      /^- Piwi Desktop: \[Windows, per user \(\.exe\)\]\(https:\/\/github\.com\/PiwiTests\/piwi\/releases\/latest\/download\/Piwi-Desktop_x64-setup\.exe\)/m,
    );
    expect(started).toMatch(/^- Piwi Runner: /m);
    const runner = docsMarkdown(findDocsPage(corpus, 'features/piwi-runner')!);
    expect(runner).toMatch(/^- Piwi Runner: /m);
    expect(runner).not.toMatch(/^- Piwi Desktop: /m);
  });

  test('gives every heading of a page a distinct anchor', () => {
    for (const page of corpus.pages) {
      const anchors = page.sections.map((s) => s.anchor);
      expect(new Set(anchors).size, page.path).toBe(anchors.length);
    }
  });

  test('numbers a repeated heading the way VitePress does', () => {
    const repeated = buildDocsCorpus({ 'guide/x.md': '# X\n\n## Setup\n\na\n\n## Setup\n\nb\n\n## Setup\n\nc\n' });
    expect(repeated.pages[0]!.sections.map((s) => s.anchor)).toEqual(['setup', 'setup-1', 'setup-2']);
  });

  test('ignores headings inside code fences', () => {
    const fenced = buildDocsCorpus({ 'guide/x.md': '# X\n\n```bash\n# not a heading\n```\n\n## Real\n\ntext\n' });
    expect(fenced.pages[0]!.sections.map((s) => s.text)).toEqual(['Real']);
  });
});

describe('addressing', () => {
  test.each([
    ['guide/ci', 'guide/ci', null],
    ['/guide/ci.md', 'guide/ci', null],
    ['guide/ci#Sharding', 'guide/ci', 'sharding'],
    ['https://piwitests.dev/operate/storage#data-retention', 'operate/storage', 'data-retention'],
    ['/recipes/', 'recipes/index', null],
    ['', 'index', null],
  ])('%s → %s #%s', (ref, path, anchor) => {
    expect(parseDocsRef(ref)).toEqual({ path, anchor });
  });

  test('finds a page by a unique path suffix', () => {
    expect(findDocsPage(corpus, 'reporter')?.path).toBe('guide/reporter');
    expect(findDocsPage(corpus, 'no-such-page')).toBeNull();
  });

  test('builds the public URL, index pages at their folder', () => {
    expect(docsPageUrl('guide/ci', 'sharding')).toBe('https://piwitests.dev/guide/ci#sharding');
    expect(docsPageUrl('recipes/index')).toBe('https://piwitests.dev/recipes/');
    expect(docsPageUrl('index')).toBe('https://piwitests.dev/');
  });
});

describe('sections', () => {
  const page = buildDocsCorpus({
    'guide/x.md': '# X\n\nLead.\n\n## A\n\na text\n\n### A.1\n\nnested\n\n## B\n\nb text\n',
  }).pages[0]!;

  test('a section read carries its sub-sections and stops at the next sibling', () => {
    const a = page.sections.find((s) => s.anchor === 'a')!;
    expect(docsMarkdown(page, a)).toBe('## A\n\na text\n\n### A.1\n\nnested');
  });

  test('the summary is the lead paragraph', () => {
    expect(page.summary).toBe('Lead.');
  });

  test.each(Object.entries(QUOTED_DOCS_SECTIONS))('the quoted "%s" list reads from the docs', (_name, ref) => {
    expect(docsSectionItems(corpus, ref).length).toBeGreaterThanOrEqual(2);
  });
});

describe('searchDocs', () => {
  test('ranks the section holding every term first', () => {
    const [first] = searchDocs(corpus, 'retention days');
    expect(first).toMatchObject({ page: 'operate/storage', anchor: 'data-retention' });
  });

  test('returns at most two hits per page', () => {
    const hits = searchDocs(corpus, 'shard', 20);
    const perPage = new Map<string, number>();
    for (const hit of hits) perPage.set(hit.page, (perPage.get(hit.page) ?? 0) + 1);
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2);
  });

  test('drops stop words unless nothing else is left', () => {
    expect(queryTerms('How do I set up the reporter?')).toEqual(['set', 'up', 'reporter']);
    expect(queryTerms('how to')).toEqual(['how', 'to']);
    expect(searchDocs(corpus, '  ')).toEqual([]);
  });
});

describe('plainText', () => {
  test('keeps code spans verbatim while stripping markup', () => {
    expect(plainText('Set **`PIWI_API_KEY`** in [the reporter](/guide/reporter) — `<your-piwi-url>/mcp`')).toBe(
      'Set PIWI_API_KEY in the reporter — <your-piwi-url>/mcp',
    );
  });
});
