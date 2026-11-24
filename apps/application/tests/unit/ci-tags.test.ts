import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { splitRerunArgs } from '@piwitests/core/rerun-args';
import { MAX_TEST_TAG_CHARS } from '@piwitests/core/test-meta';
import {
  ciTagOptions,
  ciTagProblem,
  ciTagsArgs,
  ciTagsGrep,
  ciTagsOfArgs,
  ciTagsPhrase,
  MAX_CI_TAGS,
  parseCiTags,
  type CiTagMatch,
} from '#shared/ci-tags';

/** The text Playwright matches a grep against: the title path and the tags, joined by spaces. */
const grepTitle = (titlePath: string[], tags: string[] = []) => [...titlePath, ...tags].join(' ');

/** Whether `playwright test --grep <pattern>` runs a test, as Playwright compiles a pattern given without slashes. */
const runs = (pattern: string, title: string) => new RegExp(pattern, 'gi').test(title);

/** The pattern a `--grep="…"` argument hands Playwright once its quotes are read. */
const patternOf = (args: string) => {
  const [word] = splitRerunArgs(args);
  expect(word?.startsWith('--grep=')).toBe(true);
  return word!.slice('--grep='.length);
};

describe('the tags of a dispatch', () => {
  test('are read without their @, kept once ignoring case', () => {
    expect(parseCiTags(['@smoke', 'checkout', ' @@Smoke ', 'SMOKE'])).toEqual({
      ok: true,
      tags: ['smoke', 'checkout'],
    });
    expect(parseCiTags('@smoke')).toEqual({ ok: true, tags: ['smoke'] });
    expect(parseCiTags('')).toEqual({ ok: true, tags: [] });
    expect(parseCiTags([])).toEqual({ ok: true, tags: [] });
  });

  test('refuse a tag no grep can name safely, an empty one, a long one, and too many', () => {
    for (const tag of ['my tag', 'a$b', 'a`b', 'a"b', 'a\\b', '50%', 'go!', 'a“b', 'a\tb']) {
      expect(ciTagProblem(tag), tag).toMatch(/cannot be sent to CI/);
    }
    expect(ciTagProblem('')).toBe('A tag is empty.');
    expect(ciTagProblem('x'.repeat(MAX_TEST_TAG_CHARS))).toBeNull();
    expect(ciTagProblem('x'.repeat(MAX_TEST_TAG_CHARS + 1))).toMatch(/at most 60/);
    expect(parseCiTags(['smoke', '@'])).toEqual({ ok: false, message: 'A tag is empty.' });
    expect(parseCiTags([1])).toMatchObject({ ok: false, message: /list of tag names/ });
    expect(parseCiTags({ smoke: true })).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_CI_TAGS + 1 }, (_, i) => `t${i}`);
    expect(parseCiTags(many)).toEqual({ ok: false, message: 'A dispatch names at most 10 tags.' });
    expect(parseCiTags(many.slice(1)).ok).toBe(true);
  });

  test('to pick from leave out the tags no grep can name, and count the spellings of one tag together', () => {
    expect(
      ciTagOptions([
        { value: 'smoke', count: 5 },
        { value: 'checkout', count: 4 },
        { value: 'Smoke', count: 2 },
        { value: 'my tag', count: 9 },
        { value: 'price$', count: 1 },
        { value: 'CHECKOUT', count: 6 },
      ]),
    ).toEqual({
      options: [
        { value: 'CHECKOUT', count: 10 },
        { value: 'smoke', count: 7 },
      ],
      refused: 2,
    });
    expect(ciTagOptions([{ value: 'a$b', count: 1 }])).toEqual({ options: [], refused: 1 });
  });

  test('read as a phrase', () => {
    expect(ciTagsPhrase(['smoke'], 'all')).toBe('@smoke');
    expect(ciTagsPhrase(['smoke', 'checkout'], 'any')).toBe('@smoke or @checkout');
    expect(ciTagsPhrase(['a', 'b', 'c'], 'all')).toBe('@a, @b and @c');
  });
});

describe('the grep of tagged tests', () => {
  test('runs a test whose title or tags hold the tag up to a space, ignoring case', () => {
    const pattern = ciTagsGrep(['smoke'], 'any');
    expect(runs(pattern, grepTitle(['login.spec.ts', 'signs in'], ['@smoke']))).toBe(true);
    expect(runs(pattern, grepTitle(['login.spec.ts', 'signs in @smoke']))).toBe(true);
    expect(runs(pattern, grepTitle(['@smoke', 'login.spec.ts', 'signs in']))).toBe(true);
    expect(runs(pattern, grepTitle(['login.spec.ts', 'signs in @Smoke', 'more']))).toBe(true);
    // Playwright reads a tag from any `@` in a title, whatever comes before it.
    expect(runs(pattern, grepTitle(['login.spec.ts', 'a@smoke']))).toBe(true);
    expect(runs(pattern, grepTitle(['login.spec.ts', 'signs in'], ['@smoke-slow']))).toBe(false);
    expect(runs(pattern, grepTitle(['login.spec.ts', 'signs in'], ['@smokes']))).toBe(false);
    expect(runs(pattern, grepTitle(['smoke.spec.ts', 'smoke test']))).toBe(false);
  });

  test('runs the tests Playwright reads a tag from, whatever comes before its @', () => {
    expect(runs(ciTagsGrep(['example.com'], 'any'), grepTitle(['a.spec.ts', 'emails user@example.com']))).toBe(true);
    expect(runs(ciTagsGrep(['smoke)'], 'any'), grepTitle(['a.spec.ts', 'login (@smoke)']))).toBe(true);
    expect(runs(ciTagsGrep(['example'], 'any'), grepTitle(['a.spec.ts', 'emails user@example.com']))).toBe(false);
  });

  test('matches a tag as long as a stored tag gets as the start of a tag, since storing may have cut it', () => {
    const cut = 'x'.repeat(MAX_TEST_TAG_CHARS);
    const pattern = ciTagsGrep([cut], 'any');
    expect(pattern).toBe(`@${cut}`);
    expect(runs(pattern, grepTitle(['a.spec.ts', 't'], [`@${'x'.repeat(70)}`]))).toBe(true);
    expect(runs(pattern, grepTitle(['a.spec.ts', 't'], [`@${cut}`]))).toBe(true);
    expect(runs(ciTagsGrep(['x'.repeat(MAX_TEST_TAG_CHARS - 1)], 'any'), grepTitle(['a', 't'], [`@${cut}`]))).toBe(
      false,
    );
  });

  test('runs a test carrying any of the tags, or every one of them', () => {
    const tagged = (...tags: string[]) => grepTitle(['cart.spec.ts', 'adds an item'], tags);
    const any = ciTagsGrep(['smoke', 'checkout'], 'any');
    const all = ciTagsGrep(['smoke', 'checkout'], 'all');
    expect(
      [tagged('@smoke'), tagged('@checkout'), tagged('@smoke', '@checkout'), tagged('@slow')].map((t) => runs(any, t)),
    ).toEqual([true, true, true, false]);
    expect(
      [tagged('@smoke'), tagged('@checkout'), tagged('@checkout', '@smoke'), tagged('@slow')].map((t) => runs(all, t)),
    ).toEqual([false, false, true, false]);
    // A newline in a title does not hide a tag after it.
    expect(runs(all, grepTitle(['cart.spec.ts', 'adds\nan item @checkout'], ['@smoke']))).toBe(true);
    expect(ciTagsGrep(['smoke'], 'all')).toBe(ciTagsGrep(['smoke'], 'any'));
  });

  test('escapes a tag’s regular expression characters, so it matches only itself', () => {
    for (const tag of [
      'issue:SHOP-12',
      'a.b',
      'slow(2x)',
      'a+b',
      'a|b',
      'x[1]',
      'a?',
      'a^b',
      'v{2}',
      'user@host',
      'a*',
    ]) {
      const pattern = ciTagsGrep([tag], 'any');
      expect(runs(pattern, grepTitle(['a.spec.ts', 't'], [`@${tag}`])), tag).toBe(true);
      expect(runs(pattern, grepTitle(['a.spec.ts', 't'], ['@other'])), tag).toBe(false);
    }
    expect(runs(ciTagsGrep(['a.b'], 'any'), grepTitle(['a.spec.ts', 't'], ['@axb']))).toBe(false);
    expect(runs(ciTagsGrep(['a|b'], 'any'), grepTitle(['a.spec.ts', 't'], ['@a']))).toBe(false);
  });
});

describe('the arguments of tagged tests', () => {
  const cases: Array<[string[], CiTagMatch]> = [
    [['smoke'], 'any'],
    [['smoke', 'checkout'], 'any'],
    [['smoke', 'checkout'], 'all'],
    [['slow(2x)', 'a.b', 'user@host', 'x[1]|y'], 'all'],
    [['x'.repeat(MAX_TEST_TAG_CHARS), 'smoke)'], 'any'],
    [['smoke', 'x'.repeat(MAX_TEST_TAG_CHARS)], 'all'],
  ];

  test('are one double-quoted --grep, which `piwi rerun` reads as one word', () => {
    expect(ciTagsArgs(['smoke'], 'any')).toBe('--grep="@smoke(?=\\s|$)"');
    expect(ciTagsArgs(['smoke', 'checkout'], 'any')).toBe('--grep="@smoke(?=\\s|$)|@checkout(?=\\s|$)"');
    expect(ciTagsArgs(['smoke', 'checkout'], 'all')).toBe(
      '--grep="^(?=[^]*@smoke(?=\\s|$))(?=[^]*@checkout(?=\\s|$))"',
    );
    expect(ciTagsArgs([], 'any')).toBe('');
    for (const [tags, match] of cases) {
      expect(splitRerunArgs(ciTagsArgs(tags, match))).toEqual([`--grep=${ciTagsGrep(tags, match)}`]);
    }
  });

  test('hold no character a shell expands, but `$` before `)` and `\\` before `s` or an escaped character', () => {
    for (const [tags, match] of cases) {
      const pattern = patternOf(ciTagsArgs(tags, match));
      expect(pattern).not.toMatch(/[`"%!“”„\p{Cc}]/u);
      expect(pattern.replace(/\$\)/g, '')).not.toContain('$');
      expect(pattern.replace(/\\[s.*+?^${}()|[\]\\]/g, '')).not.toContain('\\');
    }
  });

  test.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0)('reach Playwright through bash as written', () => {
    for (const [tags, match] of cases) {
      const args = ciTagsArgs(tags, match);
      const words = spawnSync('bash', ['-c', `printf '%s\\n' ${args}`], { encoding: 'utf8' }).stdout;
      expect(words).toBe(`--grep=${ciTagsGrep(tags, match)}\n`);
    }
  });

  test('stay under 1,500 characters with the most tags, each as long as a tag gets', () => {
    const longest = Array.from({ length: MAX_CI_TAGS }, (_, i) => `${i}`.padEnd(MAX_TEST_TAG_CHARS, '.'));
    for (const match of ['any', 'all'] as const) expect(ciTagsArgs(longest, match).length).toBeLessThan(1500);
  });

  test('read back as the tags and the match they were written from', () => {
    for (const [tags, match] of cases) {
      expect(ciTagsOfArgs(ciTagsArgs(tags, match))).toEqual({ tags, match: tags.length > 1 ? match : 'any' });
    }
    expect(ciTagsOfArgs('"tests/a.spec.ts:3" --project="chromium"')).toBeNull();
    expect(ciTagsOfArgs(`${ciTagsArgs(['smoke'], 'any')} --headed`)).toBeNull();
    expect(ciTagsOfArgs('')).toBeNull();
  });
});
