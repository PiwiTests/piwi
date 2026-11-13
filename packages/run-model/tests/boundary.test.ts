import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The run model stays framework-free, for every surface to import: its source imports only its own modules and
 * `@piwitests/core`, its one dependency, and touches no browser, extension or editor API.
 */

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const srcDir = join(root, 'src');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sources = readdirSync(srcDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: readFileSync(join(srcDir, name), 'utf8') }));

const IMPORT_RE = /(?<!['"\w])from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

describe('@piwitests/run-model boundary', () => {
  test('is FSL, private, and depends on @piwitests/core alone', () => {
    expect(pkg.license).toBe('FSL-1.1-MIT');
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toEqual({ '@piwitests/core': '*' });
    expect(pkg.devDependencies ?? {}).toEqual({});
  });

  test('src imports its own modules and @piwitests/core alone', () => {
    const offenders = sources.flatMap(({ name, text }) =>
      [...text.matchAll(IMPORT_RE)]
        .map((m) => m[1] ?? m[2]!)
        .filter((spec) => !spec.startsWith('./') && !spec.startsWith('@piwitests/core/'))
        .map((spec) => `${name} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  test('src reads no global of a browser, an extension or an editor', () => {
    const globals = /\b(?:window|document|navigator|chrome|browser|acquireVsCodeApi|localStorage)\s*[.(]/;
    const offenders = sources.filter(({ text }) => globals.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
    expect(offenders.map(({ name }) => name)).toEqual([]);
  });

  test('every exports subpath points at a file that exists', () => {
    for (const target of Object.values(pkg.exports as Record<string, string>)) {
      expect(existsSync(join(root, target)), `missing ${target}`).toBe(true);
    }
  });
});
