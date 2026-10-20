import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Purity boundary for @piwitests/core: the package stays clean enough to be
 * safely bundled into the reporter and inlined into the browser/server app —
 * zero dependencies, and no imports of Node built-ins or the consuming
 * packages.
 */

const coreRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const srcDir = join(coreRoot, 'src');
const pkg = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf-8'));

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

// Captures the specifier of `import ... from 'x'`, `export ... from 'x'`, and bare `import 'x'` at the start of a line,
// so a string literal such as `'import'`, or `'from'` in a word list, is not read as one.
const IMPORT_RE = /(?<!['"\w])from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

describe('@piwitests/core boundary', () => {
  test('declares no dependencies or devDependencies', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies ?? {}).toEqual({});
    expect(pkg.private).toBe(true);
  });

  test('the import scan reads statements, not string literals', () => {
    const specs = (text: string) => [...text.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]);
    expect(specs(`import { a } from './a';\nexport * from "./b";\nimport './c';`)).toEqual(['./a', './b', './c']);
    expect(specs(`const words = ['to', 'from', 'with'];\nconst kind = 'import';`)).toEqual([]);
  });

  test('src imports only relative paths — no node:, no app/reporter, no third-party', () => {
    const offenders: string[] = [];
    for (const file of srcFiles(srcDir)) {
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2]!;
        if (!spec.startsWith('.')) offenders.push(`${file.slice(coreRoot.length + 1)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every exports subpath points at a file that exists', () => {
    for (const target of Object.values(pkg.exports as Record<string, string>)) {
      expect(existsSync(join(coreRoot, target)), `missing ${target}`).toBe(true);
    }
  });

  test('the barrel loads and exposes the shared helpers', async () => {
    const core = await import('../src/index.ts');
    expect(typeof core.generateAlternatives).toBe('function');
    expect(typeof core.textSimilarity).toBe('function');
    expect(typeof core.matchRenamedElement).toBe('function');
    expect(Array.isArray(core.LOCATOR_BUILDER_METHODS)).toBe(true);
  });
});
