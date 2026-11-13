import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { IDE_CHROME_GLOBAL as CORE_IDE_CHROME_GLOBAL } from '@piwitests/core/ide-recorder';
import { buildIdeBundle, IDE_CHROME_GLOBAL } from '../../scripts/build.mjs';
import { readCatalog } from './setup-i18n.js';

/**
 * The IDE bundle as `buildIdeBundle` writes it for the editor service: the
 * recorder reading its `chrome` from the host's global alone, so the page's
 * own `chrome` is never touched, and the catalogs the launcher hands it.
 */

const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'piwi-ide-bundle-'));

beforeAll(() => buildIdeBundle({ outDir }), 120_000);
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

/**
 * Every place `code` reaches a `chrome` of its own: the identifier `chrome`
 * anywhere but as a property name or an object key, and `chrome` read off the
 * global object.
 */
function chromeReferences(code: string): string[] {
  const source = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: string[] = [];
  const named = (node: ts.Node) => (node.parent ? code.slice(node.parent.getStart(source), node.parent.end) : '');
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'chrome') {
      const parent = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node);
      const onGlobal =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        ts.isIdentifier(parent.expression) &&
        GLOBAL_OBJECTS.has(parent.expression.text);
      if (!isName || onGlobal) found.push(named(node).slice(0, 80));
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'chrome'
    ) {
      found.push(code.slice(node.getStart(source), node.end));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the IDE bundle', () => {
  it('reads its chrome from the global the build names, which is the one core names', () => {
    expect(IDE_CHROME_GLOBAL).toBe(CORE_IDE_CHROME_GLOBAL);
  });

  it('holds the recorder and its catalogs, and nothing else of the extension', () => {
    expect(readdirSync(outDir).sort()).toEqual(['record-ide-messages.json', 'record-ide.js']);
  });

  it('finds every chrome of its own in a bundle', () => {
    expect(
      chromeReferences(
        'chrome.storage.local.get(); window.chrome.runtime; globalThis["chrome"]; ({ chrome: 1 }); a.chrome; f({ chrome });',
      ),
    ).toEqual(['chrome.storage', 'window.chrome', 'globalThis["chrome"]', 'chrome']);
  });

  it('leaves no chrome of its own: every reference reads the host’s global', () => {
    const bundle = readFileSync(path.join(outDir, 'record-ide.js'), 'utf8');
    expect(chromeReferences(bundle)).toEqual([]);
    expect(bundle).toContain(`globalThis.${CORE_IDE_CHROME_GLOBAL}.storage.local.get(`);
    expect(bundle).toContain(`globalThis.${CORE_IDE_CHROME_GLOBAL}.runtime.sendMessage(`);
  });

  it('ships every catalog, each message with its text and its placeholders’ contents alone', () => {
    const shipped = JSON.parse(readFileSync(path.join(outDir, 'record-ide-messages.json'), 'utf8')) as Record<
      string,
      Record<string, { message: string; placeholders?: Record<string, { content: string }> }>
    >;
    const languages = readdirSync(path.join(root, 'public', '_locales')).sort();
    expect(Object.keys(shipped).sort()).toEqual(languages);
    for (const code of languages) {
      const catalog = readCatalog(code);
      expect(Object.keys(shipped[code]!), code).toEqual(Object.keys(catalog));
      for (const [key, entry] of Object.entries(catalog)) {
        const placeholders = entry.placeholders
          ? Object.fromEntries(Object.entries(entry.placeholders).map(([name, { content }]) => [name, { content }]))
          : undefined;
        expect(shipped[code]![key], `${code}: ${key}`).toEqual(
          placeholders ? { message: entry.message, placeholders } : { message: entry.message },
        );
      }
    }
  });
});
