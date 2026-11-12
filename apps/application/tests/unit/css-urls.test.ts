import { describe, expect, test } from 'vitest';
import { cssImports, cssUrls, replaceCssUrls } from '#shared/css-urls';

/**
 * The `url(...)` references and `@import` rules of a CSS text, read as the patterns they stand for read them, on
 * texts made of the characters that matter to them, and in time linear in the text's length.
 */

const URL_RE = /url\(\s*(?:(['"])(.*?)\1|([^)\s'"]+))\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)|"[^"]*"|'[^']*')[^;]*;?/gi;

/** A text of `length` pieces drawn from `pieces`, the same for the same `seed`. */
function text(seed: number, length: number, pieces: readonly string[]): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += pieces[state % pieces.length];
  }
  return out;
}

const PIECES = ['url(', 'URL(', '"', "'", ')', ' ', '\n', 'a', 'b.png', '@import', ';', 'data:x,y', '\t'];

describe('cssUrls and cssImports', () => {
  test('read what their patterns read, on 5,000 texts of the characters that matter', () => {
    for (let seed = 1; seed <= 5000; seed++) {
      const css = text(seed, 2 + (seed % 24), PIECES);
      const urls = [...css.matchAll(URL_RE)].map((m) => ({
        start: m.index,
        end: m.index + m[0].length,
        target: m[2] ?? m[3],
      }));
      expect(cssUrls(css), css).toEqual(urls);
      const imports = [...css.matchAll(IMPORT_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
      expect(cssImports(css), css).toEqual(imports);
    }
  });

  test('replace the references a replacement is named for alone', () => {
    const css = 'a{x:url(a.png)} b{x:url("b.png")} c{x:url(c.png)}';
    expect(replaceCssUrls(css, (url) => (url.target === 'c.png' ? null : `url(${url.target.toUpperCase()})`))).toBe(
      'a{x:url(A.PNG)} b{x:url(B.PNG)} c{x:url(c.png)}',
    );
    expect(replaceCssUrls(css, () => null)).toBe(css);
  });

  test('read 400,000 characters that never close a reference well under a second', () => {
    for (const css of [
      'url("'.repeat(80_000),
      'url('.repeat(100_000),
      `url(${' '.repeat(400_000)}`,
      '@import url('.repeat(33_000),
      `@import ${'url( '.repeat(80_000)}`,
    ]) {
      const started = performance.now();
      cssUrls(css);
      cssImports(css);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
