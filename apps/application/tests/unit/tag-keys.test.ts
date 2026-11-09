import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAG_KEY_PATTERNS,
  MAX_TAG_KEY_PATTERN_LENGTH,
  MAX_TAG_KEY_TEXT_LENGTH,
  makeTagKeyMatcher,
  matchTagKeys,
  overlappingTagKeys,
  parseTagKeyPatterns,
  resolveTagKeyPatterns,
  validateTagKeyPattern,
} from '#shared/integrations/tag-keys';

const TEST_CASE = '^SHOP-T[0-9]+$';
const ISSUE = '^[A-Z][A-Z0-9]+-[0-9]+$';

describe('matchTagKeys', () => {
  it('matches a test case key and not a story key', () => {
    expect(matchTagKeys(['SHOP-1234', 'SHOP-T123', 'smoke'], TEST_CASE)).toEqual(['SHOP-T123']);
  });

  it('keeps the declaration order', () => {
    expect(matchTagKeys(['SHOP-T9', 'smoke', 'SHOP-T2', 'SHOP-T5'], TEST_CASE)).toEqual([
      'SHOP-T9',
      'SHOP-T2',
      'SHOP-T5',
    ]);
  });

  it('reads a tag without its @', () => {
    expect(matchTagKeys(['@SHOP-T7'], TEST_CASE)).toEqual(['@SHOP-T7']);
  });

  it('matches nothing for a pattern that is off, empty or does not compile', () => {
    expect(matchTagKeys(['SHOP-T1'], null)).toEqual([]);
    expect(matchTagKeys(['SHOP-T1'], undefined)).toEqual([]);
    expect(matchTagKeys(['SHOP-T1'], '')).toEqual([]);
    expect(matchTagKeys(['SHOP-T1'], '([')).toEqual([]);
    expect(matchTagKeys(['SHOP-T1'], '(SHOP-T1)+')).toEqual([]);
    expect(matchTagKeys(['SHOP-T1'], `^${'S'.repeat(MAX_TAG_KEY_PATTERN_LENGTH)}$`)).toEqual([]);
  });

  it('returns nothing for no tags and gives the same answer on every call', () => {
    expect(matchTagKeys([], TEST_CASE)).toEqual([]);
    expect(matchTagKeys(['SHOP-T1'], TEST_CASE)).toEqual(['SHOP-T1']);
    expect(matchTagKeys(['SHOP-T1'], TEST_CASE)).toEqual(['SHOP-T1']);
  });

  it('is case sensitive and unflagged', () => {
    expect(matchTagKeys(['shop-t1'], TEST_CASE)).toEqual([]);
  });
});

describe('validateTagKeyPattern', () => {
  it('accepts an anchored pattern', () => {
    expect(validateTagKeyPattern(TEST_CASE)).toEqual({ ok: true });
    expect(validateTagKeyPattern(ISSUE)).toEqual({ ok: true });
  });

  it('refuses a pattern that is not a regular expression', () => {
    const check = validateTagKeyPattern('^[z-a]+$');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toMatch(/valid regular expression/);
  });

  it('refuses an empty pattern', () => {
    expect(validateTagKeyPattern('').ok).toBe(false);
    expect(validateTagKeyPattern('   ').ok).toBe(false);
  });

  it('refuses a pattern that matches the empty string', () => {
    for (const pattern of ['^$', '^a*$', '^a?b*$', '^[A-Z]{0,3}$']) {
      const check = validateTagKeyPattern(pattern);
      expect(check.ok, pattern).toBe(false);
      if (!check.ok) expect(check.message).toMatch(/empty tag/);
    }
  });

  it('refuses a pattern over the length cap and accepts one at it', () => {
    expect(validateTagKeyPattern(`^${'a'.repeat(MAX_TAG_KEY_PATTERN_LENGTH - 2)}$`).ok).toBe(true);
    const check = validateTagKeyPattern(`^${'a'.repeat(MAX_TAG_KEY_PATTERN_LENGTH - 1)}$`);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain(String(MAX_TAG_KEY_PATTERN_LENGTH));
  });
});

/** Patterns the validator accepts, among them the shapes the integrations use. */
const ACCEPTED = [
  '^SHOP-T[0-9]+$',
  '^[A-Z][A-Z0-9]+-[0-9]+$',
  '^SHOP-[A-Z]?[0-9]+$',
  '^SHOP-\\d{1,6}$',
  '^[^@\\s]+-[0-9]+$',
  '^ABC\\.T[0-9]+$',
];

describe('validateTagKeyPattern syntax', () => {
  const refused = (pattern: string, message?: RegExp) => {
    const check = validateTagKeyPattern(pattern);
    expect(check.ok, pattern).toBe(false);
    if (!check.ok && message) expect(check.message, pattern).toMatch(message);
  };

  it('accepts the shapes the integrations use', () => {
    for (const pattern of [...ACCEPTED, '  ^SHOP-T[0-9]+$  ']) {
      expect(validateTagKeyPattern(pattern), pattern).toEqual({ ok: true });
    }
  });

  it('refuses nested quantifiers and alternations that backtrack without end', () => {
    refused('^(a+)+$', /no groups or \|/);
    refused('^(a|a)*$', /no groups or \|/);
    refused('^(a*)*$');
    refused('^(?:a+)+$');
    refused('^a|b$');
    refused('^(a)\\1$');
    refused('^a\\1$');
  });

  it('refuses a pattern that is not anchored at both ends', () => {
    for (const pattern of ['.', '.+', 'SHOP-T[0-9]+', '^SHOP-T[0-9]+', 'SHOP-T[0-9]+$', '^SHOP-T\\$']) {
      refused(pattern, /Anchor it with \^ and \$/);
    }
  });

  it('refuses the slash form and flags', () => {
    refused('/^X$/i', /without slashes or flags/);
    refused('/^SHOP-T[0-9]+$/', /without slashes or flags/);
  });

  it('refuses a dot, assertions, lazy and stacked quantifiers', () => {
    for (const pattern of [
      '^.+$',
      '^a.b$',
      '^a+?$',
      '^a**$',
      '^a{2}{3}$',
      '^\\bA$',
      '^(?=a)a$',
      '^*a$',
      '^a{,3}$',
      '^[]$',
    ]) {
      refused(pattern, /groups or \||Use letters/);
    }
  });

  it('refuses a repeat count over 32', () => {
    refused('^a{0,33}x$', /32 at most/);
    refused('^a{33}x$', /32 at most/);
    expect(validateTagKeyPattern('^a{0,32}x$')).toEqual({ ok: true });
  });

  it('matches a 128-character tag in under 50 ms for every pattern that took seconds under backtracking', () => {
    const rep = (atom: string, count: number) => atom.repeat(count);
    const slow = [
      `^${rep('a?', 21)}${rep('a{16}', 6)}b$`,
      `^${rep('a?', 21)}${rep('a{32}', 3)}b$`,
      `^${rep('\\S?', 21)}${rep('\\S{32}', 3)}!$`,
      `^${rep('a{0,32}', 4)}${rep('a{16}', 3)}b$`,
      `^${rep('a?', 21)}${rep('a{8}', 13)}b$`,
      `^${rep('a?', 21)}${rep('aaaa', 25)}b$`,
      `^a*a*a*${rep('a{32}', 3)}b$`,
      '^a*a*a*a{0,32}a{0,32}b$',
      '^[a\\w]*[\\w]*\\w*\\w{0,32}a{0,32}!$',
      '^a{0,32}a{0,32}a{0,32}a{0,32}a{0,32}b$',
      '^a*a*a*a*a*a*a*a*b$',
      `^${rep('\\S*', 65)}!$`,
      `^${rep('[^!]*', 38)}!$`,
      `^${rep('\\w{0,32}', 21)}!$`,
      ...ACCEPTED,
      '^a*a*a*b$',
      '^a+a+a+b$',
    ];
    const tags = [
      'a'.repeat(MAX_TAG_KEY_TEXT_LENGTH),
      `${'a'.repeat(MAX_TAG_KEY_TEXT_LENGTH - 1)}!`,
      'a'.repeat(117),
      'x'.repeat(MAX_TAG_KEY_TEXT_LENGTH),
      `SHOP-T${'1'.repeat(MAX_TAG_KEY_TEXT_LENGTH - 7)}!`,
    ];
    for (const pattern of slow) {
      expect(validateTagKeyPattern(pattern).ok, pattern).toBe(true);
      const matches = makeTagKeyMatcher(pattern);
      for (const tag of tags) {
        const started = performance.now();
        matches(tag);
        expect(performance.now() - started, `${pattern.slice(0, 40)} on ${tag.length} characters`).toBeLessThan(50);
      }
    }
  });

  it('agrees with the regular expression engine on every accepted pattern and a spread of tags', () => {
    const patterns = [
      ...ACCEPTED,
      '^a*a*a*b$',
      '^a+a+a+b$',
      '^a?a?a?a?aaaa$',
      '^a{2,4}b{0,3}$',
      '^[a-c]{2}[^a-c]+$',
      '^\\d+\\.\\d+$',
      '^\\w\\W\\s\\S\\D$',
      '^[A-Z]{2,3}-\\d{1,4}$',
      '^[\\]x]+$',
      '^\\$a\\^$',
      '^a{0}b$',
      '^a{3,}$',
      '^[-a]+x?$',
      '^x?$y',
      '^a{2,}b?a{1,3}$',
      '^\\S*a\\S+$',
      '^[a!]*!{2}a?$',
    ].filter((pattern) => validateTagKeyPattern(pattern).ok);
    const tags = [
      'SHOP-1234',
      'SHOP-T123',
      'SHOP-T',
      'SHOP-',
      'SHOP-A1',
      'ABC.T9',
      'ABCxT9',
      'AB-12',
      'ABC-12345',
      'a',
      'aa',
      'aaa',
      'aaaa',
      'a'.repeat(MAX_TAG_KEY_TEXT_LENGTH),
      `${'a'.repeat(MAX_TAG_KEY_TEXT_LENGTH - 1)}b`,
      `${'a'.repeat(30)}b`,
      'aab',
      'aabbb',
      'aabbbb',
      'abx',
      'a-',
      '-a',
      'x',
      '12.5',
      '12.',
      'a b',
      'a-1 ',
      'a1 b',
      'a$a',
      '$a^',
      ']x]',
      'b',
      '',
      ' ',
      'é-1',
      'ü',
      '\u{1F600}',
      'a\nb',
      'ab\n',
    ];
    let compared = 0;
    for (const pattern of patterns) {
      const regex = new RegExp(pattern);
      const matches = makeTagKeyMatcher(pattern);
      for (const tag of tags) {
        expect(matches(tag), `${pattern} on ${JSON.stringify(tag)}`).toBe(regex.test(tag));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(300);
  });

  it('matches nothing in a tag longer than the longest it reads', () => {
    const matches = makeTagKeyMatcher('^a+$');
    expect(matches('a'.repeat(MAX_TAG_KEY_TEXT_LENGTH))).toBe(true);
    expect(matches('a'.repeat(MAX_TAG_KEY_TEXT_LENGTH + 1))).toBe(false);
  });
});

describe('makeTagKeyMatcher', () => {
  it('matches the same tags as matchTagKeys and nothing for a pattern that is off or not valid', () => {
    const tags = ['SHOP-T1', '@SHOP-T2', 'SHOP-9'];
    expect(tags.filter(makeTagKeyMatcher(TEST_CASE))).toEqual(matchTagKeys(tags, TEST_CASE));
    expect(tags.filter(makeTagKeyMatcher(null))).toEqual([]);
    expect(tags.filter(makeTagKeyMatcher('^(a+)+$'))).toEqual([]);
  });
});

describe('overlappingTagKeys', () => {
  it('reports no overlap between a story key pattern and a test case pattern anchored on its project', () => {
    expect(overlappingTagKeys(['SHOP-T123', 'SHOP-1234', 'smoke'], ISSUE, TEST_CASE)).toEqual([]);
  });

  it('reports a tag both patterns match', () => {
    expect(overlappingTagKeys(['SHOP-T123', 'SHOP-1234'], ISSUE, '^SHOP-[A-Z0-9]+$')).toEqual(['SHOP-1234']);
    expect(overlappingTagKeys(['smoke', 'SHOP-9'], ISSUE, '^SHOP-9$')).toEqual(['SHOP-9']);
  });

  it('reports nothing while either pattern is off', () => {
    expect(overlappingTagKeys(['SHOP-9'], null, '^SHOP-9$')).toEqual([]);
    expect(overlappingTagKeys(['SHOP-9'], ISSUE, null)).toEqual([]);
    expect(overlappingTagKeys(['SHOP-9'], null, null)).toEqual([]);
  });
});

describe('resolveTagKeyPatterns', () => {
  it('reads a stored value and turns a pattern that is not valid off', () => {
    expect(resolveTagKeyPatterns({ issue: ISSUE, testCase: TEST_CASE })).toEqual({ issue: ISSUE, testCase: TEST_CASE });
    expect(resolveTagKeyPatterns({ issue: '([', testCase: '^(a+)+$' })).toEqual({ issue: null, testCase: null });
    expect(resolveTagKeyPatterns({ issue: 4 })).toEqual({ issue: null, testCase: null });
  });

  it('reads nothing as both off', () => {
    expect(resolveTagKeyPatterns(null)).toEqual(DEFAULT_TAG_KEY_PATTERNS);
    expect(resolveTagKeyPatterns(undefined)).toEqual(DEFAULT_TAG_KEY_PATTERNS);
    expect(resolveTagKeyPatterns('x')).toEqual(DEFAULT_TAG_KEY_PATTERNS);
  });
});

describe('parseTagKeyPatterns', () => {
  it('keeps both patterns', () => {
    expect(parseTagKeyPatterns({ issue: ISSUE, testCase: TEST_CASE })).toEqual({
      ok: true,
      tagKeys: { issue: ISSUE, testCase: TEST_CASE },
    });
  });

  it('turns a pattern left out, null or blank off', () => {
    expect(parseTagKeyPatterns({ testCase: TEST_CASE })).toEqual({
      ok: true,
      tagKeys: { issue: null, testCase: TEST_CASE },
    });
    expect(parseTagKeyPatterns({ issue: '  ', testCase: TEST_CASE })).toEqual({
      ok: true,
      tagKeys: { issue: null, testCase: TEST_CASE },
    });
  });

  it('stores null when both patterns are off', () => {
    expect(parseTagKeyPatterns(null)).toEqual({ ok: true, tagKeys: null });
    expect(parseTagKeyPatterns({})).toEqual({ ok: true, tagKeys: null });
    expect(parseTagKeyPatterns({ issue: null, testCase: '' })).toEqual({ ok: true, tagKeys: null });
  });

  it('refuses a pattern that is not valid, naming the field', () => {
    const result = parseTagKeyPatterns({ issue: ISSUE, testCase: '([' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^tagKeys\.testCase: /);
  });

  it('stores a pattern trimmed', () => {
    expect(parseTagKeyPatterns({ issue: `  ${ISSUE}\n`, testCase: TEST_CASE })).toEqual({
      ok: true,
      tagKeys: { issue: ISSUE, testCase: TEST_CASE },
    });
  });

  it('refuses a pattern that backtracks without end, naming the field', () => {
    const result = parseTagKeyPatterns({ issue: '^(a+)+$' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/^tagKeys\.issue: .*no groups or \|/);
  });

  it('refuses a value that is not an object of strings', () => {
    expect(parseTagKeyPatterns('x').ok).toBe(false);
    expect(parseTagKeyPatterns([ISSUE]).ok).toBe(false);
    expect(parseTagKeyPatterns({ issue: 5 }).ok).toBe(false);
  });
});
