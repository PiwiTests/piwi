import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The editor extensions' listings say what a reader needs before installing, in the same words: the JetBrains
 * Marketplace description (`plugin.xml`), both READMEs (the VS Code Marketplace page and the plugin's repository page)
 * and the docs' Editor extensions page.
 */

const repo = path.resolve(__dirname, '../../../..');

const LISTINGS = [
  'apps/jetbrains/src/main/resources/META-INF/plugin.xml',
  'apps/jetbrains/README.md',
  'apps/vscode/README.md',
  'apps/docs/features/editors.md',
];

/** The sentences every listing holds, read without their markup. */
const SAID = [
  'You need a Piwi instance: the desktop app, npx @piwitests/server or the Docker image. Recording needs none.',
  'Piwi reads Playwright Test suites in JavaScript and TypeScript.',
  'Self-hosted, zero telemetry. Nothing from your workspace is sent to the instance',
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
  for (const file of LISTINGS) {
    test(`${file} says what Piwi needs, reads and sends`, () => {
      const text = plain(fs.readFileSync(path.join(repo, file), 'utf8'));
      for (const sentence of SAID) expect(text, sentence).toContain(sentence);
    });
  }

  test('the JetBrains listing claims no click its tool window lacks', () => {
    for (const file of LISTINGS.slice(0, 2)) {
      expect(fs.readFileSync(path.join(repo, file), 'utf8'), file).not.toContain('in one click');
    }
  });
});
