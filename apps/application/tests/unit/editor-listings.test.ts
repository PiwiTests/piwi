import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { headingAnchor } from '../../../docs/.vitepress/navigation';

/**
 * The editor extensions' listings say what a reader needs before installing, in the same words: the JetBrains
 * Marketplace description (`plugin.xml`'s `<description>`), both READMEs (the VS Code Marketplace page and the plugin's
 * repository page) and the docs' Editor extensions page.
 */

const repo = path.resolve(__dirname, '../../../..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');

const PLUGIN_XML = 'apps/jetbrains/src/main/resources/META-INF/plugin.xml';
const JETBRAINS_README = 'apps/jetbrains/README.md';
const VSCODE_README = 'apps/vscode/README.md';
const EDITORS_PAGE = 'apps/docs/features/editors.md';

/** The text a listing shows: the plugin's `<description>` alone, every other file whole. */
function listing(file: string): string {
  const text = read(file);
  if (file !== PLUGIN_XML) return text;
  const description = /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(text);
  expect(description, 'plugin.xml has a <description>').not.toBeNull();
  return description![1]!;
}

/** The sentences every listing holds, read without their markup. */
const SAID = [
  'You need a Piwi instance: the desktop app, npx @piwitests/server or the Docker image. Recording needs none.',
  'Piwi reads Playwright Test suites in JavaScript and TypeScript.',
  'Self-hosted, zero telemetry. No file of your workspace is sent to the instance',
];

/** A listing's text without HTML tags, Markdown links, emphasis and code marks, its spaces collapsed. */
function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ');
}

describe('the editor listings', () => {
  for (const file of [PLUGIN_XML, JETBRAINS_README, VSCODE_README, EDITORS_PAGE]) {
    test(`${file} says what Piwi needs, reads and sends`, () => {
      const text = plain(listing(file));
      for (const sentence of SAID) expect(text, sentence).toContain(sentence);
    });
  }

  test('the JetBrains listings claim no click the tool window lacks: its actions are in a right-click menu', () => {
    for (const file of [PLUGIN_XML, JETBRAINS_README]) expect(listing(file), file).not.toMatch(/\bone[- ]click\b/i);
  });

  test('the plugin links only to docs pages and headings that exist', () => {
    const linked = [PLUGIN_XML, 'apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/Glue.kt'].flatMap((file) =>
      [...read(file).matchAll(/https:\/\/piwitests\.dev\/([\w/-]+?)(?:#([\w-]+))?["\s<)]/g)].map((m) => ({
        file,
        page: m[1]!,
        anchor: m[2],
      })),
    );
    expect(linked.length).toBeGreaterThan(0);
    for (const { file, page, anchor } of linked) {
      const doc = path.join('apps/docs', `${page}.md`);
      expect(fs.existsSync(path.join(repo, doc)), `${file} links ${page}`).toBe(true);
      if (!anchor) continue;
      const headings = [...read(doc).matchAll(/^#{2,6} (.+)$/gm)].map((m) => headingAnchor(m[1]!));
      expect(headings, `${file} links ${page}#${anchor}`).toContain(anchor);
    }
  });
});
